-- 018_agent_plan_execution：让「批准的方案」能变成真实订单（v1.0.0）。
--
-- 017 建了两张表，但方案当时只到「建议」为止——`trading_plan` 里没有任何一列
-- 记「这份方案到底下单了没有、单号是多少」。于是自动执行无从落地：
-- executor 捞出方案、下了单，却没法说清「这一单对应哪份方案」，
-- 而方案自己也不知道自己已经变成了真实的仓位。
--
-- 这个迁移补上那条链路：
--
--   * `trading_plan` 增执行态列（单号、尝试次数、认领时刻、下单失败原因）；
--   * `status` 的取值范围扩出 `executing`（已认领、下单中）与 `failed`（下单失败）；
--   * `risk_bracket.decision_source` 允许 `agent-plan`——让「这份止盈止损的档位
--     来自 Agent 方案」这件事**落进账本**，事后能回答「当时为什么止损在那个价」。
--
-- ⚠️ **为什么用「认领 → 下单 → 回填」三步，而不是「下单 → 回填」两步**：
-- 下单成功但回填前进程崩掉的话，那一单已经真实存在，而库里没有任何东西记着它。
-- 下一轮再跑一次就是**重复下单**——仓位翻倍，而日志与库里都看不出异常。
-- 认领（`approved → executing`）是**幂等锚点**：它先把「这一份方案归我了」写进库，
-- 崩在中间时方案停在 `executing`，**不会被自动重试**（那一单到底下没下只有交易所知道），
-- 页面把它显示成「状态未知、需要人工确认」。宁可停下来问，也不要重复下单。
--
-- 约定沿用既有（R-1）：
--   * 时间戳一律 bigint（epoch 毫秒）；
--   * 本文件必须可重复执行（幂等）；
--   * 表结构的唯一来源就是本文件，TS 与 Python 都不得另持影子定义。

-- ------------------------------------------------------- trading_plan：执行态
--
-- 列都是**可空**的：一份还没执行的方案（`advisory`）这些列就该是空的。
-- 不给默认值是有意的——「NULL = 还没走到那一步」比「0 = 还没走到那一步」诚实。

ALTER TABLE trading_plan ADD COLUMN IF NOT EXISTS entry_order_id bigint;
ALTER TABLE trading_plan ADD COLUMN IF NOT EXISTS client_order_id text;
-- 第几次尝试。每认领一次 +1。
--
-- 它存在的原因是**重试要用新号**：Binance 不允许两张 `clientOrderId` 相同的挂单
-- 同时存在（AGENTS.md §6.8.4 记录过同款坑：止损单号复用导致移动止损一次都挪不成）。
-- 进场单同理——沿用同一个号重试，必然撞「重复」，于是重试永远失败。
ALTER TABLE trading_plan ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 0;
-- 认领的时刻（epoch ms）。认领 = 这份方案开始归某个执行者所有。
ALTER TABLE trading_plan ADD COLUMN IF NOT EXISTS claimed_at_ms bigint;
-- 变成真实订单的时刻（epoch ms）。
ALTER TABLE trading_plan ADD COLUMN IF NOT EXISTS executed_at_ms bigint;
-- 下单失败的原因。`status = 'failed'` 时必须非空（约定 9：看得见的失败）。
ALTER TABLE trading_plan ADD COLUMN IF NOT EXISTS execution_failure_reason text;

-- `status` 的取值范围：多出 `executing`（认领中）与 `failed`（下单失败）。
ALTER TABLE trading_plan DROP CONSTRAINT IF EXISTS trading_plan_status_check;
ALTER TABLE trading_plan
  ADD CONSTRAINT trading_plan_status_check CHECK (
    status IN ('advisory', 'approved', 'executing', 'executed', 'rejected', 'expired', 'failed')
  );

-- 「已执行」必须有单号：没有单号的 `executed` 说明状态被写过而单子没下——
-- 那正是「看起来成功了，其实什么都没做」的形态。
ALTER TABLE trading_plan DROP CONSTRAINT IF EXISTS trading_plan_executed_has_order_check;
ALTER TABLE trading_plan
  ADD CONSTRAINT trading_plan_executed_has_order_check CHECK (
    status <> 'executed' OR (entry_order_id IS NOT NULL AND executed_at_ms IS NOT NULL)
  );

-- 下单失败必须留下原因。没原因的失败在页面上就是一行没有理由的 `failed`。
ALTER TABLE trading_plan DROP CONSTRAINT IF EXISTS trading_plan_failed_has_reason_check;
ALTER TABLE trading_plan
  ADD CONSTRAINT trading_plan_failed_has_reason_check CHECK (
    status <> 'failed' OR execution_failure_reason IS NOT NULL
  );

-- 只有「真能执行」的方案才谈得上执行：进了 `executing` / `executed` 的必须是
-- `action = 'enter'`，而且三件套齐全（进场价、止损价、数量缺一不可）。
--
-- 这条把「一份缺了价格的方案被推去下单」挡在库外面——那种方案在交易所侧
-- 必然被拒，而在库里若没有这条约束，它会一路走到「下单失败」才暴露。
ALTER TABLE trading_plan DROP CONSTRAINT IF EXISTS trading_plan_executing_needs_enter_check;
ALTER TABLE trading_plan
  ADD CONSTRAINT trading_plan_executing_needs_enter_check CHECK (
    status NOT IN ('executing', 'executed')
    OR (action = 'enter'
        AND side IS NOT NULL
        AND entry_type IS NOT NULL
        AND quantity IS NOT NULL
        AND stop_price IS NOT NULL
        AND take_profit_price IS NOT NULL)
  );

-- 「认领中」的行必须记着认领时刻与这一次的单号：
-- 没有它就分不出「认领了但还没下单」与「压根没被认领」。
ALTER TABLE trading_plan DROP CONSTRAINT IF EXISTS trading_plan_executing_has_claim_check;
ALTER TABLE trading_plan
  ADD CONSTRAINT trading_plan_executing_has_claim_check CHECK (
    status <> 'executing' OR (claimed_at_ms IS NOT NULL AND client_order_id IS NOT NULL)
  );

-- 捞「等着执行」的方案用。017 里那条部分索引只认 `approved`，
-- 而认领是 `UPDATE ... WHERE status = 'approved'`，索引正好对上。
CREATE INDEX IF NOT EXISTS trading_plan_approved_idx
  ON trading_plan (exchange, symbol, created_at_ms)
  WHERE status = 'approved';

-- ------------------------------------------- risk_bracket：档位来自 Agent 方案
--
-- `decision_source` 原本只有三个取值（配置 / 模型 / 模型降级）。
-- Agent 方案的档位是**第四种来源**：它既不是人配的档位，也不是 v0.9.0 那个
-- 「成交时问模型」的决策——它是分析师 + 交易员两个 Agent 在**成交之前**算好的。
--
-- 不落这个来源的后果很具体：事后查「当时为什么止损在那个价」时，
-- 库里只会看到 `config`，而人配的档位早就被改过了——于是**永远答不出来**。
ALTER TABLE risk_bracket DROP CONSTRAINT IF EXISTS risk_bracket_decision_source_check;
ALTER TABLE risk_bracket ADD CONSTRAINT risk_bracket_decision_source_check
    CHECK (decision_source IN ('llm', 'config', 'config-fallback', 'agent-plan'));

-- Agent 方案贡献的是**两个**倍数（止损、止盈），不是五个。
-- 因此这条约束与 v0.9.0 那条「LLM 决策的数必须齐全」**分开写**，
-- 语义也不同：方案只要那两个数齐全就算有效。
ALTER TABLE risk_bracket DROP CONSTRAINT IF EXISTS risk_bracket_decision_agent_params_check;
ALTER TABLE risk_bracket ADD CONSTRAINT risk_bracket_decision_agent_params_check
    CHECK (decision_source <> 'agent-plan'
        OR (decision_stop_atr_mult IS NOT NULL
            AND decision_take_profit_atr_mult IS NOT NULL));

-- ------------------------------------------------- 通知：自动下单的两件事
--
-- 「要通知哪些内容」从 14 种扩到 16 种：新增「Agent 方案已下单」与
-- 「Agent 方案下单失败」。
--
-- 为什么这两件事**必须能通知**：自动下单是**唯一**一个「程序自己决定要花钱」的动作。
-- 它成功时人需要知道钱花在哪了；它失败时人更需要知道——否则仓位可能没建、
-- 止损也可能没挂，而界面上只有一行没人看的状态。
ALTER TABLE notify_settings DROP CONSTRAINT IF EXISTS notify_settings_kinds_check;
ALTER TABLE notify_settings
  ADD CONSTRAINT notify_settings_kinds_check CHECK (
      kinds <@ ARRAY[
          'missing-stop-order',
          'unprotected-position',
          'position-without-record',
          'missing-take-profit-order',
          'unexpected-take-profit-order',
          'price-mismatch',
          'record-without-position',
          'orphan-algo-order',
          'trail-move-failed',
          'bracket-armed',
          'bracket-settled',
          'llm-fallback',
          'tp1-filled',
          'trail-moved',
          'agent-plan-executed',
          'agent-plan-failed'
      ]::text[]
  );
ALTER TABLE notify_settings
  ALTER COLUMN kinds SET DEFAULT ARRAY[
      'missing-stop-order',
      'unprotected-position',
      'position-without-record',
      'missing-take-profit-order',
      'unexpected-take-profit-order',
      'price-mismatch',
      'record-without-position',
      'orphan-algo-order',
      'trail-move-failed',
      'bracket-armed',
      'bracket-settled',
      'llm-fallback',
      'tp1-filled',
      'trail-moved',
      'agent-plan-executed',
      'agent-plan-failed'
  ]::text[];

-- **已经配好的那一份也把新类型补上**：与 016 同一理由——
-- 新类型默认不勾的话，升级之后这两条推送会**一声不吭地不发生**，
-- 那正是约定 9 忌讳的「看起来成功其实什么都没做」。
UPDATE notify_settings
   SET kinds = (
         SELECT array_agg(DISTINCT k ORDER BY k)
           FROM unnest(kinds || ARRAY[
             'agent-plan-executed',
             'agent-plan-failed'
           ]::text[]) AS k
       ),
       updated_at = updated_at
 WHERE id = 1;
