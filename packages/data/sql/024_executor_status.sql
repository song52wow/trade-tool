-- 024_executor_status：止盈止损服务（executor）自己的状态行。
--
-- 背景（2026-11-06 在目标机 192.168.1.90 实测）：
--   币安把**私有接口**全部拒了（-2015 Invalid API-key, IP, or permissions），
--   executor 这条链于是整条死掉：
--     * 用户数据流拿不到 listenKey → 看不见成交 → **不挂止盈止损**；
--     * 周期对账也跑不通 → 一轮都跑不出来 → **连「仓位没有保护」这条告警都发不出来**
--       （对账失败就没有差异清单，而差异清单才是告警的原料）。
--   结果：止盈止损从 10-31 03:49 起彻底停摆，而**没有任何一条消息**告诉任何人。
--   与 2026-10-25 那次「同步停摆静默 5 小时 55 分」是同一类病
--   （022 的文件头把那一类讲全了）。
--
-- 为什么要有这张表：
--   `daemon_heartbeat` 只覆盖**同步守护进程**。executor 是另一个进程、另一种失效方式：
--     * 它可以**活着但瞎了**（私有接口全挂）：心跳照跳，可它一单都挂不出去；
--     * 它也可以压根没在跑（compose 里它在 `executor` profile 里，缺省不启动）。
--   控制面必须能回答「止盈止损服务现在到底能不能用」，而不是让人去翻容器日志。
--   「进程活着」与「服务能用」是**两件事**，合成一个「在线」就会骗人。
--
-- 语义：
--   * executor 启动时插入、优雅退出时删除 → 行不存在 = 确切地「没在跑」；
--   * `last_beat` 由**独立于任何业务动作**的定时器刷新 → 私有接口全挂时心跳照跳，
--     于是「活着」与「能用」在同一行里分成两组列，谁也不冒充谁；
--   * `private_api_ok` = 最近一次私有接口调用是否成功；`last_private_ok_at` = 最后一次
--     成功的时刻。这两列是「止盈止损还保不保得住仓位」的直接证据；
--   * `last_error_code` / `last_error_message` = 最近一次失败的**原话**
--     （排查的第一手线索：`-2015` 与 `-1021` 指向的根因完全不同）。
--
-- 与 `daemon_heartbeat` 一样按 exchange 一行：executor 是按交易所启停的，一个交易所一个。
--
-- 本文件必须可重复执行。

CREATE TABLE IF NOT EXISTS executor_status (
    exchange           text    PRIMARY KEY,
    pid                integer NOT NULL,
    started_at         bigint  NOT NULL,
    last_beat          bigint  NOT NULL,
    -- 最近一次私有接口调用是否成功。**NULL = 还没成功调用过（未知）**——
    -- 缺省填 true 等于把「不知道」说成「好的」，那正是本表要治的那种骗人。
    private_api_ok     boolean,
    -- 最近一次私有接口**成功**的时刻。刚起来还没成功过时为 NULL（而不是 0）。
    last_private_ok_at bigint,
    -- 最近一次私有接口失败的错误码与原话。恢复后要清空，否则控制面会一直显示旧的错。
    last_error_code    text,
    last_error_message text
);
