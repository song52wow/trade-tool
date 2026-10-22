-- 014 · 止盈倍数合并成一个（v0.9.1）
--
-- 为什么要动 schema：页面上「止盈倍数」和「第一段止盈倍数」两个框，
-- 背后是两个止盈价概念（整段价 / 第一段价）。但**只有一种会变成真实的订单**：
--
--   * 不分批（比例 = 0）→ 挂一张全平止盈单，价 = 整段倍数算的；
--   * 分批（0 < 比例 < 1）→ 挂一张带数量的第一段止盈单，价 = 第一段倍数算的，
--     剩下的仓位交给移动止损，**根本没有整段止盈单**。
--
-- 于是「整段价」在分批形态下是**虚构的**：它被写进 `risk_bracket.take_profit`，
-- 页面显示的「止盈价」因此是一个从没挂出去过的价，对账每轮报一次
-- `price-mismatch` 假警报。
--
-- 这次把两个倍数合并成一个 `take_profit_atr_mult`：它是「这次要卖的那部分，
-- 涨到离入场多远就卖」——不分批时卖全部，分批时先卖一部分。
-- 比例 = 1 与 0 逐字等价（都是一次全平、都用同一个倍数），因此 1 归一到 0。
--
-- 数据不需要搬迁：全库 `take_profit1_ratio > 0` 的策略为 0 行，
-- `take_profit_atr_mult` 保持原值即可。

-- ---------------------------------------------------------------------------
-- 1) 退役「第一段止盈倍数」这一列。
--
-- DROP COLUMN 会自动带走依赖它的 CHECK 约束；`IF EXISTS` 保证重复执行安全
-- （每个进程入口启动时都会跑一遍迁移）。
-- ---------------------------------------------------------------------------
ALTER TABLE risk_policy DROP COLUMN IF EXISTS take_profit1_atr_mult;
ALTER TABLE risk_bracket DROP COLUMN IF EXISTS decision_take_profit1_atr_mult;

-- ---------------------------------------------------------------------------
-- 2) 比例不再允许 1（它已归一到 0）。
--
-- 先摘掉旧约束再挂新的：重复执行仍幂等。旧约束允许 [0, 1]。
-- ---------------------------------------------------------------------------
ALTER TABLE risk_policy DROP CONSTRAINT IF EXISTS risk_policy_tp1_ratio_check;
ALTER TABLE risk_policy ADD CONSTRAINT risk_policy_tp1_ratio_check
    CHECK (take_profit1_ratio >= 0 AND take_profit1_ratio < 1);

-- ---------------------------------------------------------------------------
-- 3) 决策留痕（v0.9.0）里的比例同样禁 1。
--
-- 决策在**落库前**就归一（`clampLlmDecision`），所以这里钉死 < 1 是一道
-- 兜底：它保证库里不可能出现「留痕记 1、实际按 0 算」的错位。
-- ---------------------------------------------------------------------------
ALTER TABLE risk_bracket DROP CONSTRAINT IF EXISTS risk_bracket_decision_tp1_ratio_check;
ALTER TABLE risk_bracket ADD CONSTRAINT risk_bracket_decision_tp1_ratio_check
    CHECK (decision_take_profit1_ratio IS NULL
        OR (decision_take_profit1_ratio >= 0 AND decision_take_profit1_ratio < 1));

-- ---------------------------------------------------------------------------
-- `risk_bracket.tp1_price` **保留**：它记的是「第一段那张单的触发价」，
-- 与 `take_profit`（「这个仓位的止盈价」）在概念上不同——现在两者数值相同
-- （合并后只有一种止盈价），但将来分批若变成真两段止盈，这两列立刻各有用处。
-- `partial_armed` 的 staged_check 因此不动（它要求 tp1_price 非空）。
-- ---------------------------------------------------------------------------
