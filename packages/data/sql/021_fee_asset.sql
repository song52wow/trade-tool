-- 021：手续费的**币种**与**折算汇率**（v0.9.3）。
--
-- 背景：币安的手续费**不一定**用计价币收——开了 BNB 抵扣就用 BNB 收。
-- 而 `risk_bracket.fee_amount` 的口径是「累计手续费（计价币）」，
-- 于是老代码把 `0.00009805 BNB` 直接当成 `0.00009805 USDT` 记了进去，
-- 差着 BNB 的汇率几百倍（2026-10-23 实测踩到：目标机上那笔 BNB 计价的手续费
-- 被当成 USDT 记，净盈亏因此虚高）。
--
-- 修法是「折算后再记」：金额按标记价折成计价币，**折算用的价也要留下来**——
-- 否则事后没人能回答「这个数是怎么来的」，而一个说不清来路的盈亏数字
-- 谁都不敢拿去做决策（这正是本仓库反复强调「事实要能追溯」的原因）。
--
-- 为什么是**两列**而不是把 `fee_amount` 改成多币种：
--   * `fee_amount` 是**累计**的。一轮里入场那笔可能用 BNB 收、出场那笔用 USDT 收，
--     拆成多币种就要多张表或数组列，而「这一轮总共花了多少计价币」这个问题
--     只有一个答案——就是 `fee_amount`；
--   * 币种与汇率是**折算的痕迹**，不是要参与加总的事实，所以单独记。
--
-- **为什么编号是 021 而不是 017**：`017` ~ `020` 已被另一条在研分支占用
-- （agent 相关的四张表），本地开发库也已经应用了它们。迁移编号是**外部锚点**
-- （AGENTS.md §5），撞号会让两条分支合并时同号不同名、文档表格也说不清。
-- 跳号是允许的：`schema_migrations` 记的是「应用过哪些版本」，不要求连续。
--
-- 约定沿用既有（R-1）：本文件必须可重复执行（幂等）；
-- 表结构的唯一来源就是本文件，TS 与 Python 都不得另持影子定义。

ALTER TABLE risk_bracket
  ADD COLUMN IF NOT EXISTS fee_asset text,
  ADD COLUMN IF NOT EXISTS fee_fx_rate double precision;

-- 汇率必须是正数：0 或负数意味着「折算时价格取错了」，而那会让这一轮的
-- 手续费变成负数或零——两样都是「看起来正常、其实错了」的数字。
ALTER TABLE risk_bracket DROP CONSTRAINT IF EXISTS risk_bracket_fee_fx_rate_check;
ALTER TABLE risk_bracket
  ADD CONSTRAINT risk_bracket_fee_fx_rate_check CHECK (fee_fx_rate IS NULL OR fee_fx_rate > 0);

-- 两列的组合语义（写在这里是为了让读代码的人不必去翻应用层）：
--   fee_asset IS NULL                     → 这一轮的手续费全是计价币，不需要折算
--   fee_asset = 'BNB' AND fee_fx_rate > 0 → BNB 计价的手续费已按该汇率折成计价币
--   fee_asset = 'BNB' AND fee_fx_rate IS NULL
--                                           → **折算失败**，那一笔手续费**没有**计入
--                                             `fee_amount`（宁可少算也不写成错的）
