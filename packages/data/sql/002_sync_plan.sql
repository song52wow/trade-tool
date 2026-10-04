-- 002_sync_plan：首次全量的规模预估落库（R-8.3 / R-8.6）。
--
-- 为什么需要它：
--   * R-8.3 要求常驻模式下把「首次全量规模」（约 N 根 / 约 M 次请求 / 约 S 分钟）
--     **写入 sync_state** 并由 `sync status` 暴露，让控制面在决定是否开启之前
--     就能看到代价（一次全量 ≈ 数百~上千次请求）；
--   * R-8.6 要求首次全量的进度可查询：**已入库行数 / 目标行数**——此前只有分子
--     （sync_state.rows，每批推进），分母只存在于一次性返回值与日志里。
--
-- 列语义（全部可空：非首次拉取、或尚未预估时没有计划）：
--   plan_bars         目标 bar 数（进度分母）
--   plan_requests     预估请求数
--   plan_weight       预估权重
--   plan_estimated_ms 按限速预算折算的预估耗时
--   plan_from/plan_to 预估区间（闭区间，epoch 毫秒）
--   plan_at           预估计算时刻
--
-- 本文件必须可重复执行（ADD COLUMN IF NOT EXISTS）。

ALTER TABLE sync_state
    ADD COLUMN IF NOT EXISTS plan_bars         bigint,
    ADD COLUMN IF NOT EXISTS plan_requests     bigint,
    ADD COLUMN IF NOT EXISTS plan_weight       bigint,
    ADD COLUMN IF NOT EXISTS plan_estimated_ms bigint,
    ADD COLUMN IF NOT EXISTS plan_from         bigint,
    ADD COLUMN IF NOT EXISTS plan_to           bigint,
    ADD COLUMN IF NOT EXISTS plan_at           bigint;
