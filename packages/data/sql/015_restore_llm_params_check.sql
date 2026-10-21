-- 015 · 补回「LLM 决策的数必须齐全」这条约束（v0.9.1）
--
-- 为什么要单独一个迁移：014 用 `DROP COLUMN` 退役了
-- `risk_bracket.decision_take_profit1_atr_mult`，而 PostgreSQL 的 `DROP COLUMN`
-- 会**自动删掉引用该列的 CHECK 约束**——于是一条与「退役某个字段」毫无关系、
-- 只因为碰巧提到它而被顺带删掉的守门人，就此消失了：
--
--   risk_bracket_decision_llm_params_check
--     CHECK (decision_source <> 'llm'
--         OR (decision_stop_atr_mult IS NOT NULL
--             AND decision_take_profit_atr_mult IS NOT NULL
--             AND decision_take_profit1_ratio IS NOT NULL
--             AND decision_take_profit1_atr_mult IS NOT NULL   ← 这一列没了，约束也没了
--             AND decision_trail_atr_mult IS NOT NULL
--             AND decision_breakeven_after_tp1 IS NOT NULL))
--
-- 它守的是：**标成 `llm` 的决策，五个数一个都不能缺**。少了它，一条残缺的
-- LLM 决策能被静默写进库里，而事后没人能看出「当时用的到底是哪几个档位」。
--
-- 教训（顺手记在这里，别再踩）：**删列之前先看有没有约束提到它**。
-- 约束被顺带删掉时没有任何报错，schema 看起来还是「迁移过的样子」，
-- 只有等某条脏数据真的写进去才会发现。
--
-- 这次补的是**同一个约束的 5 个字段版**（少了已退役的那个），语义不变。
-- 库里当前没有 `decision_source = 'llm'` 的行，所以加约束不会撞到存量脏数据。
--
-- 幂等：先摘旧约束（若还在）再挂新的，重复执行安全。

-- ---------------------------------------------------------------------------
-- 1) 旧约束已经被 014 顺带删掉了；这里显式再摘一次，
--    是为了「意图写在 schema 的唯一来源里」，也为了覆盖那些
--    DROP COLUMN 没有级联到的库（例如约束挂在别的 schema 上时）。
-- ---------------------------------------------------------------------------
ALTER TABLE risk_bracket DROP CONSTRAINT IF EXISTS risk_bracket_decision_llm_params_check;

-- ---------------------------------------------------------------------------
-- 2) 挂回 5 个字段版的联合约束。
-- ---------------------------------------------------------------------------
ALTER TABLE risk_bracket ADD CONSTRAINT risk_bracket_decision_llm_params_check
    CHECK (decision_source <> 'llm'
        OR (decision_stop_atr_mult IS NOT NULL
            AND decision_take_profit_atr_mult IS NOT NULL
            AND decision_take_profit1_ratio IS NOT NULL
            AND decision_trail_atr_mult IS NOT NULL
            AND decision_breakeven_after_tp1 IS NOT NULL));
