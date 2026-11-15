-- 023 · 趋势档位决策的来源值（v1.1.0）
--
-- 这个迁移只做一件事：让 `risk_bracket.decision_source` 能记下
-- 「这一笔的档位是**模型按趋势**给的」。
--
-- ## 为什么必须单独记一个来源值
--
-- v0.9.0 那条链路里，模型定档位时只看到 **ATR 与最近若干根 K 线的收益率数列**。
-- v1.1.0 把分析师那套趋势上下文（程序算好的客观倾向 + 均线 / 指标 / 情绪面）
-- 接进同一条链路之后，**模型看到的是两批不同的输入**。
--
-- 而「模型当时看到了什么」正是事后复盘要回答的第一个问题：
-- 「上周那笔为什么止损在那个价？」——答不上来的话，复盘就只剩「模型不稳定」这一句空话。
-- 所以两种来源**必须能分开查**：
--
--   * `llm`       —— 模型只看到收益率数列（v0.9.0）；
--   * `llm-trend` —— 模型看到完整的趋势上下文（v1.1.0）。
--
-- 并进 `llm` 的后果很具体：库里会留下一批「说不清模型当时看到了什么」的行，
-- 而它们的止损价是真的挂出去的、真的会被扫掉的。
--
-- ## 约束怎么改（AGENTS.md §5 第 12 条）
--
-- ⚠️ **扩枚举，不是换枚举**。因此：
--
--   * **保留约束名** `risk_bracket_decision_source_check`——它的语义没变，
--     仍然是「决策来源的取值范围」。换了名字就等于多出一条语义不同的约束，
--     而旧的那条会被 `DROP` 顺带删掉；
--   * **旧值全部保留**（`llm` / `config` / `config-fallback` / `agent-plan`），
--     一个都不能少——少一个就等于「换」而不是「扩」，那些值对应的历史行会当场写不进去。
--
-- 同理，`risk_bracket_decision_llm_params_check`（「LLM 决策的数必须齐全」）
-- 也要把 `llm-trend` 纳进来：它守的是**模型给的档位不能残缺**，
-- 而 `llm-trend` 正是模型给的档位。少了它，一条残缺的趋势决策能被静默写进库。
--
-- 约定沿用既有（R-1）：
--   * 时间戳一律 bigint（epoch 毫秒）；
--   * 本文件必须可重复执行（幂等）；
--   * 表结构的唯一来源就是本文件，TS 与 Python 都不得另持影子定义。

-- ---------------------------------------------------------------------------
-- 1) 决策来源：加一个 `llm-trend`。
-- ---------------------------------------------------------------------------
ALTER TABLE risk_bracket DROP CONSTRAINT IF EXISTS risk_bracket_decision_source_check;
ALTER TABLE risk_bracket ADD CONSTRAINT risk_bracket_decision_source_check
    CHECK (decision_source IN ('llm', 'llm-trend', 'config', 'config-fallback', 'agent-plan'));

-- ---------------------------------------------------------------------------
-- 2) 「LLM 决策的数必须齐全」：两种模型来源一视同仁。
--
-- 五个数与 v0.9.1 之后的样子一致（`decision_take_profit1_atr_mult` 已在 014 退役，
-- 015 把这条约束补成了 5 个字段版——**不要**把那列加回来）。
-- ---------------------------------------------------------------------------
ALTER TABLE risk_bracket DROP CONSTRAINT IF EXISTS risk_bracket_decision_llm_params_check;
ALTER TABLE risk_bracket ADD CONSTRAINT risk_bracket_decision_llm_params_check
    CHECK (decision_source NOT IN ('llm', 'llm-trend')
        OR (decision_stop_atr_mult IS NOT NULL
            AND decision_take_profit_atr_mult IS NOT NULL
            AND decision_take_profit1_ratio IS NOT NULL
            AND decision_trail_atr_mult IS NOT NULL
            AND decision_breakeven_after_tp1 IS NOT NULL));
