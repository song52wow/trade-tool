-- 016_agent_decisions：分析师报告 + 交易员执行方案（v1.0.0）。
--
-- 这个迁移回答两个问题：
--   * 「这个标的当时**怎么看**的？」——分析师 Agent 的三面打分与合成结论；
--   * 「这一笔**怎么做**的？」——交易员 Agent 算出来的进场、仓位、止损。
--
-- 为什么必须留痕：Agent 的输出会变成真实的下单依据，而模型是不复现的
-- （同一份行情，下一次可能给出不同的分数）。事后没人能靠记忆回答
-- 「上周那笔为什么开在这里」——所以原始输出、分数、理由、调整记录全部落库。
--
-- ⚠️ **价格与数量不由模型给**：模型只给「比例」（风险占权益的百分之几、
-- 止损离几倍 ATR），价格与数量由 `packages/core/src/agent-trader.ts` 的纯函数算，
-- 与 `apps/executor` 挂单时用的是**同一份** `deriveBracketPlan`。因此这里存的是
-- 「算完的结果」，它与真正挂出去的那张单逐字一致。
--
-- 约定沿用既有（R-1）：
--   * 时间戳一律 bigint（epoch 毫秒），不用 timestamptz；
--   * 本文件必须可重复执行（幂等）；
--   * 表结构的唯一来源就是本文件，TS 与 Python 都不得另持影子定义。

-- ------------------------------------------------------------- analyst_report
--
-- 分析师 Agent 每一轮的报告。
--
-- `stance` / `confidence` / `bias` **不是模型给的**：模型给三个面的分数，
-- 立场由 `aggregateAnalystReport` 这个纯函数按权重合成。存的是**合成后的**结果，
-- 于是「报告里写着看多、库里记的是看空」不可能发生（判据只有一份实现）。
CREATE TABLE IF NOT EXISTS analyst_report (
  id            bigserial PRIMARY KEY,
  exchange      text        NOT NULL,
  symbol        text        NOT NULL,
  interval      text        NOT NULL,
  -- 数据的时刻（epoch ms）：这批行情是**什么时候**的。
  as_of_ms      bigint      NOT NULL,
  -- 报告生成的时刻（epoch ms）。
  created_at_ms bigint      NOT NULL,

  -- 合成结论
  stance        text        NOT NULL CHECK (stance IN ('bullish', 'bearish', 'neutral')),
  confidence    double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  bias          double precision NOT NULL CHECK (bias >= -1 AND bias <= 1),
  -- 三个面之间的一致性 `[0, 1]`。1 = 完全一致；0 = 互相抵消。
  agreement     double precision NOT NULL CHECK (agreement >= 0 AND agreement <= 1),

  -- 三个面的原始分数（模型的输出，原样保留）
  technical_score   double precision NOT NULL CHECK (technical_score >= -1 AND technical_score <= 1),
  sentiment_score   double precision NOT NULL CHECK (sentiment_score >= -1 AND sentiment_score <= 1),
  fundamental_score double precision NOT NULL CHECK (fundamental_score >= -1 AND fundamental_score <= 1),

  -- 三个面的理由（人可读，JSON 数组）
  technical_notes   jsonb NOT NULL DEFAULT '[]'::jsonb,
  sentiment_notes   jsonb NOT NULL DEFAULT '[]'::jsonb,
  fundamental_notes jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- 当时的行情刻度。留着是因为「ATR 占价格 0.7%」与「ATR 占价格 5%」
  -- 意味着完全不同的止损合理度，而这个比例事后无法从 K 线复原。
  atr               double precision,
  last_close        double precision,
  stop_atr_mult     double precision CHECK (stop_atr_mult IS NULL OR (stop_atr_mult > 0 AND stop_atr_mult <= 20)),
  take_profit_atr_mult double precision CHECK (take_profit_atr_mult IS NULL OR (take_profit_atr_mult > 0 AND take_profit_atr_mult <= 50)),

  rationale text NOT NULL,
  -- 喂给模型的完整上下文（技术面 / 情绪面 / 基本面）。留它是為了能回答
  -- 「模型当时看到了什么」——只存结论的话，模型改了提示词就再也复现不了。
  context    jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 模型原始返回的正文。**原样存**，不做加工。
  raw        text,
  -- 情绪面有接口没取到（`degraded`）。技术面缺失是**报错**，不进这张表。
  degraded   boolean NOT NULL DEFAULT false
);

-- 同一份数据时刻的同一标的只留一份报告：重复跑一轮不应该产生第二条。
CREATE UNIQUE INDEX IF NOT EXISTS analyst_report_symbol_asof_key
  ON analyst_report (exchange, symbol, as_of_ms);

CREATE INDEX IF NOT EXISTS analyst_report_list_idx
  ON analyst_report (exchange, symbol, created_at_ms DESC);

-- --------------------------------------------------------------- trading_plan
--
-- 交易员 Agent 每一轮的执行方案。
--
-- `action` 说「要做什么」，`status` 说「这份方案走到哪一步了」——两个维度不能混：
-- 一份「做多」的方案可能还只是 `advisory`（还没被执行），也可能已经 `executed`。
CREATE TABLE IF NOT EXISTS trading_plan (
  id            bigserial PRIMARY KEY,
  exchange      text        NOT NULL,
  symbol        text        NOT NULL,
  -- 来自哪份报告。外键：没有报告就不该有方案。
  report_id     bigint REFERENCES analyst_report (id),
  as_of_ms      bigint      NOT NULL,
  created_at_ms bigint      NOT NULL,

  -- 'enter' = 给出可执行的方案；'hold' = 这一轮不做；'failed' = 出不了方案。
  action        text        NOT NULL CHECK (action IN ('enter', 'hold', 'failed')),
  -- 方案的生命周期：
  --   'advisory' = 只是建议（缺省；自动执行关着时永远停在这里）
  --   'approved' = 人已认可，等执行
  --   'executed' = 已经变成真实订单
  --   'rejected' = 人否掉了
  --   'expired'  = 过期作废（依据的行情已经不新了）
  status        text        NOT NULL DEFAULT 'advisory'
                CHECK (status IN ('advisory', 'approved', 'executed', 'rejected', 'expired')),

  side          text CHECK (side IS NULL OR side IN ('BUY', 'SELL')),
  entry_type    text CHECK (entry_type IS NULL OR entry_type IN ('market', 'limit')),
  entry_price   double precision CHECK (entry_price IS NULL OR entry_price > 0),
  stop_price    double precision CHECK (stop_price IS NULL OR stop_price > 0),
  take_profit_price double precision CHECK (take_profit_price IS NULL OR take_profit_price > 0),
  quantity      double precision CHECK (quantity IS NULL OR quantity > 0),
  notional      double precision CHECK (notional IS NULL OR notional > 0),
  -- 这一笔最多亏多少（计价币）= 数量 × 止损距离。
  risk_amount   double precision CHECK (risk_amount IS NULL OR risk_amount >= 0),
  equity        double precision CHECK (equity IS NULL OR equity > 0),
  -- 权益的来源：'exchange' = 从交易所读的实时余额；'config' = 配置里写的。
  equity_source text CHECK (equity_source IS NULL OR equity_source IN ('exchange', 'config')),
  risk_fraction double precision CHECK (risk_fraction IS NULL OR (risk_fraction >= 0 AND risk_fraction <= 1)),
  atr           double precision CHECK (atr IS NULL OR atr > 0),
  stop_atr_mult double precision CHECK (stop_atr_mult IS NULL OR (stop_atr_mult > 0 AND stop_atr_mult <= 20)),
  take_profit_atr_mult double precision
                CHECK (take_profit_atr_mult IS NULL OR (take_profit_atr_mult > 0 AND take_profit_atr_mult <= 50)),
  risk_reward   double precision CHECK (risk_reward IS NULL OR risk_reward > 0),

  -- 分析师的结论（抄一份：报告可能被归档，但方案的结论要能单独读出来）
  stance        text        NOT NULL CHECK (stance IN ('bullish', 'bearish', 'neutral')),
  confidence    double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),

  rationale text NOT NULL,
  -- 为合规而做的调整（风险被夹住、止盈被抬高、量被缩小…）。**非空时页面必须显示**。
  adjustments jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 出不了方案的原因。`action = 'failed'` 时必须非空。
  failure_reason text,
  raw        text
);

CREATE INDEX IF NOT EXISTS trading_plan_list_idx
  ON trading_plan (exchange, symbol, created_at_ms DESC);

-- 待执行的方案（自动执行打开时，executor 按这个索引捞）。
CREATE INDEX IF NOT EXISTS trading_plan_pending_idx
  ON trading_plan (status, created_at_ms)
  WHERE status = 'approved';

-- --------------------------------------------------- 两张表之间的完整性约束
--
-- 「有方案就必须有完整的三件套」：进场价、止损价、数量缺一不可。
-- 少一个就意味着「这一笔没法执行」，而那应该是 `action = 'failed'`，
-- 而不是一条残缺的 `action = 'enter'`。
ALTER TABLE trading_plan DROP CONSTRAINT IF EXISTS trading_plan_enter_complete_check;
ALTER TABLE trading_plan
  ADD CONSTRAINT trading_plan_enter_complete_check CHECK (
    action <> 'enter'
    OR (side IS NOT NULL
        AND entry_type IS NOT NULL
        AND entry_price IS NOT NULL
        AND stop_price IS NOT NULL
        AND take_profit_price IS NOT NULL
        AND quantity IS NOT NULL
        AND notional IS NOT NULL
        AND risk_amount IS NOT NULL
        AND risk_fraction IS NOT NULL
        AND risk_reward IS NOT NULL)
  );

-- 止损与进场价必须**分居两侧**：否则「止损」会在进场的同时就把仓位平掉。
-- 方向随 side 变：多头是 stop < entry < tp，空头完全镜像。
ALTER TABLE trading_plan DROP CONSTRAINT IF EXISTS trading_plan_stop_straddle_check;
ALTER TABLE trading_plan
  ADD CONSTRAINT trading_plan_stop_straddle_check CHECK (
    action <> 'enter'
    OR (side = 'BUY'  AND stop_price < entry_price AND take_profit_price > entry_price)
    OR (side = 'SELL' AND stop_price > entry_price AND take_profit_price < entry_price)
  );

-- 「这一轮不做」是**决定**，不是**故障**：它不该有失败原因。
-- 而「出不了方案」是故障，必须写清为什么——否则页面只显示一行没有理由的失败，
-- 排障的人无从下手（约定 9：看得见的失败）。
ALTER TABLE trading_plan DROP CONSTRAINT IF EXISTS trading_plan_hold_no_failure_check;
ALTER TABLE trading_plan
  ADD CONSTRAINT trading_plan_hold_no_failure_check CHECK (
    action <> 'hold' OR failure_reason IS NULL
  );

ALTER TABLE trading_plan DROP CONSTRAINT IF EXISTS trading_plan_failed_has_reason_check;
ALTER TABLE trading_plan
  ADD CONSTRAINT trading_plan_failed_has_reason_check CHECK (
    action <> 'failed' OR failure_reason IS NOT NULL
  );

-- 「已执行」只可能来自一份真能执行的方案。
ALTER TABLE trading_plan DROP CONSTRAINT IF EXISTS trading_plan_executed_needs_enter_check;
ALTER TABLE trading_plan
  ADD CONSTRAINT trading_plan_executed_needs_enter_check CHECK (
    status <> 'executed' OR action = 'enter'
  );
