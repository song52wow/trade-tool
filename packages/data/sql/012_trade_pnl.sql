-- 012：交易盈亏的事实列 + 通知内容类型扩容（v0.8.0）。
--
-- 背景：通知要能说清「这一轮赚没赚、赚了多少」，就得把**平仓的事实**存下来——
-- 累计平了多少、累计成交额多少、累计手续费多少。
--
-- ⚠️ **盈亏金额本身不存**：它由 `packages/core/src/pnl.ts` 的 `realizedPnl()` 算。
-- 公式只有一份（AGENTS.md 硬性约定 4）；存两处就是两份口径，而「这一轮赚了多少」
-- 恰恰是最不能有两个答案的数。要看盈亏，随时用这三列现算。
--
-- 为什么是**累计**而不是「最后一笔」：v0.7.0 的两段模型里，一轮会平两段
-- （第一段止盈 + 移动止损了结）。成交额是**事实**，均价只是它的派生值——
-- 只平了一段的时候，「整轮的均价」根本不存在。
--
-- 约定沿用既有（R-1）：时间戳一律 bigint；本文件必须可重复执行（幂等）；
-- 表结构的唯一来源就是本文件，TS 与 Python 都不得另持影子定义。

-- ---------------------------------------------------------------- 盈亏事实

ALTER TABLE risk_bracket
  ADD COLUMN IF NOT EXISTS closed_qty double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS exit_notional double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fee_amount double precision NOT NULL DEFAULT 0;

-- 三列都是「累计量」，不许出现负数：负数意味着某一段被减了两次，
-- 而「算两遍手续费」正是实际盈亏最常见的一种错。
ALTER TABLE risk_bracket DROP CONSTRAINT IF EXISTS risk_bracket_pnl_nonneg_check;
ALTER TABLE risk_bracket
  ADD CONSTRAINT risk_bracket_pnl_nonneg_check CHECK (
      closed_qty >= 0 AND exit_notional >= 0 AND fee_amount >= 0
  );

-- ------------------------------------------------------- 通知内容类型扩容

-- 「要通知哪些内容」从 8 种（交易对账的差异类型）扩到 11 种：
-- 多了「止盈止损挂单成功」「一轮买卖完成」「LLM 决策降级」三类事件。
-- CHECK 约束与列默认值都一起换，否则会存进一个读不出来的取值。
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
          'bracket-armed',
          'bracket-settled',
          'llm-fallback'
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
      'bracket-armed',
      'bracket-settled',
      'llm-fallback'
  ]::text[];
