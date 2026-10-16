-- 009_reconcile_run：交易对账的**观测快照**（v0.6.0）。
--
-- 存在的理由只有一个：**让「自动对账」的结果能被界面看到**。
-- 对账本身是只读的（不下单、不撤单、不改 risk_bracket），但它必须周期自动跑——
-- 「有人在交易所 App 上手动开了仓」这类漂移是持续形成的，只靠人想起来跑一次命令
-- 等于没有。可自动跑之后，如果没有落库，控制面上就只剩下一个手动按钮，
-- 而真正的自动结果只进了日志：界面显示的东西与实际发生的事分叉，那比没有更糟。
--
-- 因此这里存的是**观测结果**，不是第二套状态：
--   * 它不参与任何判断——判据仍然只有 core 那一份纯函数；
--   * 它不驱动任何动作——对账绝不写它以外的任何表（尤其不改 risk_bracket）；
--   * 删掉这张表只会让界面重新变盲，不会让任何一笔止损消失。
-- 真正的「第二套状态」是那种被写侧读侧共同依赖的表（比如扣留表），
-- 而快照不是：没有任何代码路径会拿它去决定要不要下单。
--
-- 保留策略：只保留最近 N 次（按 exchange + scope 分组），避免无界增长。
-- 对账一天也才几百次，但它每次都带差异明细，不设上限总有一天会拖慢查询。

CREATE TABLE IF NOT EXISTS reconcile_run (
    id           bigserial       PRIMARY KEY,
    exchange     text            NOT NULL,
    -- 对账范围：'' = 全账户。界面上必须能把「全账户快照」和「单标的快照」分开。
    scope        text            NOT NULL DEFAULT '',
    checked_at   bigint          NOT NULL,
    healthy      boolean         NOT NULL,
    critical     integer         NOT NULL,
    warning      integer         NOT NULL,
    local_unsettled     integer NOT NULL,
    exchange_positions  integer NOT NULL,
    exchange_algo_orders integer NOT NULL,
    -- 差异明细整份存 JSON：它是给人看的报告，会随判据演进而变长，
    -- 而把它拆成列就等于把判据的形状又抄了一份到 schema 里（AGENTS.md 约定 3）。
    differences  jsonb           NOT NULL DEFAULT '[]'::jsonb,
    created_at   bigint          NOT NULL
);

-- 「这个范围最近一次对账是什么时候」是唯一的查询模式：
-- 控制面每次打开面板都读它，executor 每轮插一行。
CREATE INDEX IF NOT EXISTS reconcile_run_latest
    ON reconcile_run USING BTREE (exchange, scope, checked_at DESC);

COMMENT ON TABLE reconcile_run IS
    '交易对账的观测快照（只报告不动手）。不是判据来源，也不是任何写路径的依赖';
COMMENT ON COLUMN reconcile_run.differences IS
    'ReconcileDifference[]（core 的判据输出）。整份存 JSON，不拆列';