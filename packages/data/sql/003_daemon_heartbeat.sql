-- 003_daemon_heartbeat：常驻同步守护进程的心跳。
--
-- 为什么需要它：
--   控制面的「开始同步」只写 symbols.desired_state（R-19「先落库再生效」），真正
--   拉数据的是独立的 apps/sync 进程。于是页面必须能回答「现在有人在干活吗」——
--   否则按下按钮后状态会显示成 running、数据却一动不动，是个会骗人的界面。
--
-- 为什么不能靠 sync_state.last_run_at 推断：
--   * 没有 desired_state=running 的标的时它全是 NULL，守护进程在跑也看不出来；
--   * 一轮首次全量可达几十分钟，期间 last_run_at 不会更新，会被误判成离线；
--   * 多个标的的 last_run_at 混在一起，无法区分「守护进程没起」与「该标的退避中」。
--
-- 语义：
--   * 守护进程启动时插入，停止时删除 → 「行不存在」就是确切的离线（优雅退出）；
--   * last_beat 由**独立于同步轮次**的定时器刷新 → 长任务进行中依然在跳，
--     进程被 kill -9 时它会自然变旧，由读取方按阈值判离线（崩溃场景）。
--   * pid 只作展示与排查用，不参与任何判定（PID 会被复用）。
--
-- 本文件必须可重复执行。

CREATE TABLE IF NOT EXISTS daemon_heartbeat (
    exchange   text    PRIMARY KEY,
    pid        integer NOT NULL,
    started_at bigint  NOT NULL,
    last_beat  bigint  NOT NULL
);
