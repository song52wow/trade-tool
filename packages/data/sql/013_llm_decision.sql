-- 013_llm_decision：v0.9.0 LLM 决策的留痕。
--
-- 这个迁移回答一个问题：**这次挂单用的档位，到底是模型定的还是人配的？**
--
-- 背景是 v0.4.0 起的既有设计：`risk_bracket` 存了 ATR 快照、止损价、止盈价，
-- 所以事后能回答「当时止损挂在多少钱」。但它**没存当时用的倍数**——
-- 而倍数才是「为什么是这个价」的直接依据。倍数来自 `risk_policy` 表，
-- 那张表是**可变**的：agent 改一次档位，旧成交对应的倍数就再也查不到了。
--
-- 于是当 LLM 参与决策后，「这笔单当时按什么档位挂的」变成一个必须留痕的问题：
--   * 模型定的 → 要记模型给的六个参数 + 它的理由；
--   * 人配的 → 要记当时那份（同样会被后续改动覆盖）；
--   * 模型说了但没说成 → 要记**降级的原因**。
--
-- 降级原因必须落库而不是只打日志：约定 9 要求「读取失败必须常驻可见」。
-- 只在日志里留一行，进程重启后就查不到了，而「模型连续三天没生效」这种事
-- 恰恰是要靠事后统计才发现的。
--
-- 约定沿用既有（R-1）：
--   * 时间戳一律 bigint（epoch 毫秒），不用 timestamptz；
--   * 本文件必须可重复执行（幂等）；
--   * 表结构的唯一来源就是本文件，TS 与 Python 都不得另持影子定义。

-- ------------------------------------------------------------------ risk_bracket
--
-- 决策来源。三个值，语义互斥且都要能查：
--   * 'llm'            —— 用的是模型给的档位；
--   * 'config'         —— 用的是 `risk_policy` 里那套（模型没参与或没开）；
--   * 'config-fallback'—— 模型参与了但失败/超时/越界，**降级**用了 `risk_policy`。
--
-- 为什么单独列一个 'config-fallback' 而不是合并进 'config'：
-- 两者挂出去的**价格**可能一样，但**性质**完全不同——前者是系统正常工作，
-- 后者是「模型这一轮没说出来，我们用兜底挡了一下」。后者是需要人知道的故障，
-- 合并进 'config' 就再也分不出来了。这正是 AGENTS.md 反复在治的那类分裂。
ALTER TABLE risk_bracket
    ADD COLUMN IF NOT EXISTS decision_source text NOT NULL DEFAULT 'config';

-- 决策时实际生效的六个参数。与 `risk_policy` 的列**逐字同名同义**：
-- 抄一份到 schema 里是 AGENTS.md 约定 3 禁止的「影子定义」，
-- 而这里不得不存一份——因为 `risk_policy` 是**可变**的，而 `risk_bracket` 是
-- **不可变的历史**。这不是第二份真相，是快照。
--
-- 取值范围与 `risk_policy` 的 CHECK 完全一致（照抄 executorSchema，AGENTS.md §6.4 第 4 条）。
-- 三者的关系：页面校验 / schema CHECK / 纯函数校验不许各写各的。
ALTER TABLE risk_bracket
    ADD COLUMN IF NOT EXISTS decision_stop_atr_mult        double precision,
    ADD COLUMN IF NOT EXISTS decision_take_profit_atr_mult double precision,
    ADD COLUMN IF NOT EXISTS decision_take_profit1_ratio    double precision,
    ADD COLUMN IF NOT EXISTS decision_take_profit1_atr_mult double precision,
    ADD COLUMN IF NOT EXISTS decision_trail_atr_mult        double precision,
    ADD COLUMN IF NOT EXISTS decision_breakeven_after_tp1  boolean;

-- 模型给的理由（人可读）。降级时为空。
ALTER TABLE risk_bracket
    ADD COLUMN IF NOT EXISTS decision_rationale text;

-- 降级原因（人可读）。正常决策时为空。
ALTER TABLE risk_bracket
    ADD COLUMN IF NOT EXISTS decision_fallback_reason text;

-- 模型原始返回的正文。**原样存**，不做加工。
--
-- 为什么存原文而不仅存解析后的参数：模型说了什么与它最终被解析成什么
-- 可能不一致（围栏、额外字段、越界值）。只存解析结果就丢掉了「它到底说了什么」，
-- 而排查「模型为什么老给越界值」时，原文是唯一的第一手证据。
ALTER TABLE risk_bracket
    ADD COLUMN IF NOT EXISTS decision_raw text;

-- 决策发生在什么时候（epoch ms）。与 `updated_at` 不同：后者是这一行最后一次
-- 被写的时间，前者是「模型做决定」的时刻。
ALTER TABLE risk_bracket
    ADD COLUMN IF NOT EXISTS decision_at bigint;

-- source 的取值钉在 schema 里。
ALTER TABLE risk_bracket DROP CONSTRAINT IF EXISTS risk_bracket_decision_source_check;
ALTER TABLE risk_bracket ADD CONSTRAINT risk_bracket_decision_source_check
    CHECK (decision_source IN ('llm', 'config', 'config-fallback'));

-- 'llm' 必须带上模型给的参数——否则「模型定的」这句话是空的，
-- 而查档位时恰好要靠这些列。
ALTER TABLE risk_bracket DROP CONSTRAINT IF EXISTS risk_bracket_decision_llm_params_check;
ALTER TABLE risk_bracket ADD CONSTRAINT risk_bracket_decision_llm_params_check
    CHECK (decision_source <> 'llm'
        OR (decision_stop_atr_mult IS NOT NULL
            AND decision_take_profit_atr_mult IS NOT NULL
            AND decision_take_profit1_ratio IS NOT NULL
            AND decision_take_profit1_atr_mult IS NOT NULL
            AND decision_trail_atr_mult IS NOT NULL
            AND decision_breakeven_after_tp1 IS NOT NULL));

-- 降级必须留下原因。降级是**故障**，故障不许只有状态没有原因
-- （AGENTS.md 约定 9：看得见的失败）。
ALTER TABLE risk_bracket DROP CONSTRAINT IF EXISTS risk_bracket_decision_fallback_check;
ALTER TABLE risk_bracket ADD CONSTRAINT risk_bracket_decision_fallback_check
    CHECK (decision_source <> 'config-fallback' OR decision_fallback_reason IS NOT NULL);

-- 参数的取值范围与 `risk_policy` 的 CHECK 保持一致。
-- 存的是**生效值**，它可能来自模型，因此必须与来自人配置的走同一道闸。
ALTER TABLE risk_bracket DROP CONSTRAINT IF EXISTS risk_bracket_decision_stop_mult_check;
ALTER TABLE risk_bracket ADD CONSTRAINT risk_bracket_decision_stop_mult_check
    CHECK (decision_stop_atr_mult IS NULL
        OR (decision_stop_atr_mult > 0 AND decision_stop_atr_mult <= 20));

ALTER TABLE risk_bracket DROP CONSTRAINT IF EXISTS risk_bracket_decision_tp_mult_check;
ALTER TABLE risk_bracket ADD CONSTRAINT risk_bracket_decision_tp_mult_check
    CHECK (decision_take_profit_atr_mult IS NULL
        OR (decision_take_profit_atr_mult > 0 AND decision_take_profit_atr_mult <= 50));

ALTER TABLE risk_bracket DROP CONSTRAINT IF EXISTS risk_bracket_decision_tp1_ratio_check;
ALTER TABLE risk_bracket ADD CONSTRAINT risk_bracket_decision_tp1_ratio_check
    CHECK (decision_take_profit1_ratio IS NULL
        OR (decision_take_profit1_ratio >= 0 AND decision_take_profit1_ratio <= 1));

ALTER TABLE risk_bracket DROP CONSTRAINT IF EXISTS risk_bracket_decision_tp1_mult_check;
ALTER TABLE risk_bracket ADD CONSTRAINT risk_bracket_decision_tp1_mult_check
    CHECK (decision_take_profit1_atr_mult IS NULL
        OR (decision_take_profit1_atr_mult > 0 AND decision_take_profit1_atr_mult <= 50));

ALTER TABLE risk_bracket DROP CONSTRAINT IF EXISTS risk_bracket_decision_trail_mult_check;
ALTER TABLE risk_bracket ADD CONSTRAINT risk_bracket_decision_trail_mult_check
    CHECK (decision_trail_atr_mult IS NULL
        OR (decision_trail_atr_mult > 0 AND decision_trail_atr_mult <= 20));
