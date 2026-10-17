-- 010_risk_trailing：v0.7.0 两段止盈 + Chandelier 移动止损的阶段与档位。
--
-- 存在的理由只有两条：
--   1. `state` 原本五个值装不下「第一段已成交、剩余仓位在移动止损中」这个中间阶段；
--   2. 移动止损必须记住**持仓期极值**与**当前生效的那一档**，否则进程重启即丢档，
--      等于「移动止损在重启后失效」——而它恰恰是最不该悄悄失效的那种保护。
--
-- 刻意**没有** `stage` 列：阶段由 `state` 表达。再加一列阶段就是第二套状态，
-- 与 AGENTS.md §6.1 第 2 条禁止的形态同型（两处各有一份真相，行为随数据量而变）。
--
-- 掉队的那份保证要写在注释里（AGENTS.md §10.1 的要求）：带数量的第一段止盈单
-- **不再享有**「仓位归零时由交易所自动撤销」，改由 executor 在净额归零时本地撤，
-- 且进程不在时无人撤。对账新增 `unexpected-take-profit-order` 把它暴露出来（只报告）。
-- 止损单**仍然是** `closePosition` 形态，所以减仓之后它继续有效，不需要重挂。
--
-- 约定沿用既有（R-1）：
--   * 时间戳一律 bigint（epoch 毫秒），不用 timestamptz；
--   * 本文件必须可重复执行（幂等）：每个入口启动都会跑一遍；
--   * 表结构的唯一来源就是本文件，TS 与 Python 都不得另持影子定义。

-- ------------------------------------------------------------------ risk_bracket
ALTER TABLE risk_bracket
    -- 第一段止盈（带数量的条件单）。takeProfit1Ratio = 0 或 1 时这五列恒为 NULL：
    -- 那两种形态的第一段仍然是 `closePosition` 单，没有数量可言。
    ADD COLUMN IF NOT EXISTS tp1_algo_id    bigint,
    ADD COLUMN IF NOT EXISTS tp1_qty        double precision,
    ADD COLUMN IF NOT EXISTS tp1_price      double precision,
    ADD COLUMN IF NOT EXISTS tp1_filled_qty double precision,
    ADD COLUMN IF NOT EXISTS tp1_filled_at  bigint,
    -- 移动止损的当前状态。NULL 的语义是「未进入 trailing 阶段」，
    -- 与 quote_volume / trades 的「交易所未提供」**不是一回事**（AGENTS.md §5 第 2 条），
    -- 不要用同一套判据去解释两者。
    -- atr / stop_price / take_profit 三列**保持入场时的值不变**——它们记的是
    -- 「第一段为什么这么算」；移动中的那一档写在 trail_stop_price，两者互不覆盖。
    ADD COLUMN IF NOT EXISTS trail_extreme    double precision,
    ADD COLUMN IF NOT EXISTS trail_stop_price double precision,
    ADD COLUMN IF NOT EXISTS trail_atr        double precision,
    ADD COLUMN IF NOT EXISTS trail_atr_from   bigint,
    ADD COLUMN IF NOT EXISTS trail_atr_to     bigint,
    ADD COLUMN IF NOT EXISTS trail_updated_at bigint,
    -- 本轮没有移动的原因。常驻可见：极值取不到、止损位越过现价、撤旧失败
    -- 都写在这里，而不是只打一行日志就过去（AGENTS.md 约定 9）。
    ADD COLUMN IF NOT EXISTS trail_last_error text;

-- state 追加两个值，既有五个值语义不变。
-- 先 DROP 再 ADD 的组合重复执行仍幂等（每次执行都先摘掉旧约束再挂新的）。
ALTER TABLE risk_bracket DROP CONSTRAINT IF EXISTS risk_bracket_state_check;
ALTER TABLE risk_bracket ADD CONSTRAINT risk_bracket_state_check CHECK (
    state IN ('armed', 'partial_armed', 'trailing',
              'take_profit', 'stop_loss', 'cancelled', 'failed')
);

-- partial_armed 必须有第一段的量与价；trailing 必须有当前那一档。
-- 钉在 schema 里而不是靠应用层自觉：漏写的那一行会让「账面在移动、实际没有档位」
-- 安静地存在，而它要到价格反向运行时才显形。
ALTER TABLE risk_bracket DROP CONSTRAINT IF EXISTS risk_bracket_staged_check;
ALTER TABLE risk_bracket ADD CONSTRAINT risk_bracket_staged_check CHECK (
    (state <> 'partial_armed'
        OR (tp1_algo_id IS NOT NULL AND tp1_qty IS NOT NULL AND tp1_price IS NOT NULL))
    AND (state <> 'trailing'
        OR (trail_stop_price IS NOT NULL AND trail_stop_price > 0))
);

-- 数量必须落在 (0, 持仓量]：0 或超过持仓量都意味着这张单挂出来就是错的。
ALTER TABLE risk_bracket DROP CONSTRAINT IF EXISTS risk_bracket_tp1_qty_check;
ALTER TABLE risk_bracket ADD CONSTRAINT risk_bracket_tp1_qty_check CHECK (
    tp1_qty IS NULL OR (tp1_qty > 0 AND tp1_qty <= filled_qty)
);

-- 移动止损的当前那一档必须为正（已包含在 staged_check 的 trailing 分支里）。
--
-- 这里**刻意没有**「止损必须在入场价内侧」这类约束：第一段兑现后止损上移到保本位，
-- 而保本位按口径就落在入场价附近（`breakevenOffsetAtr = 0` 时恰好等于入场价），
-- 任何「必须在某一侧」的 CHECK 都会把自己写的正常状态判成非法。
-- 真正要拦的是「挂上去立刻触发」，而那取决于**现价**——现价不是表里的列，
-- 因此它只能由纯函数 `deriveTrailingPlan` 的 `beyond-price` 分支拦，并留下可见原因。

-- ------------------------------------------------------------------ risk_policy
-- 取值范围照抄 executorSchema（AGENTS.md §6.4 第 4 条：页面校验、schema CHECK、
-- 纯函数校验三处不许各写各的）。DEFAULT 必须与 executorSchema 的缺省**逐字相同**——
-- 两处不一致时，库里旧行读出来的行为会与新建行不同，而这种差异只在数据量大时才显形。
ALTER TABLE risk_policy
    -- 0 = 关闭分批；1 = 一次性全平（用 take_profit1_atr_mult）；(0,1) = 减仓该比例。
    ADD COLUMN IF NOT EXISTS take_profit1_ratio    double precision NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS take_profit1_atr_mult double precision NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS trail_atr_mult         double precision NOT NULL DEFAULT 2,
    ADD COLUMN IF NOT EXISTS breakeven_after_tp1    boolean          NOT NULL DEFAULT true;

ALTER TABLE risk_policy DROP CONSTRAINT IF EXISTS risk_policy_tp1_ratio_check;
ALTER TABLE risk_policy ADD CONSTRAINT risk_policy_tp1_ratio_check
    CHECK (take_profit1_ratio >= 0 AND take_profit1_ratio <= 1);

ALTER TABLE risk_policy DROP CONSTRAINT IF EXISTS risk_policy_tp1_mult_check;
ALTER TABLE risk_policy ADD CONSTRAINT risk_policy_tp1_mult_check
    CHECK (take_profit1_atr_mult > 0 AND take_profit1_atr_mult <= 50);

ALTER TABLE risk_policy DROP CONSTRAINT IF EXISTS risk_policy_trail_mult_check;
ALTER TABLE risk_policy ADD CONSTRAINT risk_policy_trail_mult_check
    CHECK (trail_atr_mult > 0 AND trail_atr_mult <= 20);
