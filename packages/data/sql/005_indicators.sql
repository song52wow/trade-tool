-- 005_indicators：v0.3.0 技术指标物化表（由**库内已收盘的派生 K 线**派生）。
--
-- 约定（R-3）：
--   * 幂等、可重复执行；空库可一路迁到最新（v0.1.0 R-1.1 / R-1.2 继续成立）。
--   * 时间列一律 bigint（epoch 毫秒），`time` 是**bar 起点**，与四张派生表同口径。
--   * 本文件是「指标 → 表 + 列集合」的**唯一来源**：`quant_data` 与 `packages/data`
--     各引用一次，三方一致性由 AC-2 的测试断言。
--
-- **参数是数据，不是 schema**（R-3.3）：
--   改 window 5→30、加一组 MACD(8,17,9) 都是**插新行、零 DDL**。因此
--   * **不得**出现 `ma_20 double precision` 这类「把参数写进列名」的形态；
--   * **不得**用不透明的 `params_hash` 代替可查的参数列——那会让 SQL 查不了
--     「所有 window = 20 的均线」，还引入一条跨语言 hash 一致性契约
--     （浮点格式化分歧即静默分叉）。
--
-- **`impl_version` 进主键**（R-3.4）：初值 1，定义在 `quant_core.INDICATOR_IMPL_VERSION`。
-- `params_hash` 式的参数身份只覆盖「参数」，覆盖不了「实现改了」——将来要**复现一个
-- 历史买点**，光有参数不够。实现行为变更必须递增该常量；纯重构不递增。
--
-- **预热期不落库**（R-4.3）：物化层只写越过预热期的行，因此这里**不设**「无效值」列、
-- 不用 NULL 表示缺失、更不用 0 冒充缺失（v0.1.0 R-4.3）。**每一行都是有效值**。
--
-- 指标表**没有水位列、也没有状态表**（R-3.5）：物化到哪由 K 线数据与 R-4 判据推导。
-- 新增第二套「同步到哪里」正是 v0.1.0 R-9.6 要避免的。

-- 本期物化的周期集合。**1m 不在其中**（N-2：单标的 1m 约 320 万行 × 缺省 10 个行集
-- 约 4.3 GB/标的），`5m` 在派生层就没有表（N-3）。这个 CHECK 与 `INTERVAL_TABLES`
-- 的派生周期集合一致，读侧据此拒绝 `1m` 而不是静默回落到某个周期（R-9.5 / AC-12）。

-- ------------------------------------------------------------------ MA（SMA / EMA）
-- 列名 `bars` 而不是规格里写的 `window`：`window` 是 PostgreSQL 的**完全保留字**
-- （`pg_get_keywords()` 的 `catcode = 'R'`），裸用会直接语法错误，逼得两侧每条 SQL 都要
-- 引号包裹——那正是「列名不可参数化」要消除的那类手工拼装。配置侧仍然叫 `window`
-- （JSON 不受 SQL 关键字约束，R-12.1 的配置手感不变），两者只经
-- `quant_data.indicators._CONFIG_KEYS` 一张表映射。
CREATE TABLE IF NOT EXISTS indicator_ma (
    symbol         text   NOT NULL,
    interval       text   NOT NULL,
    impl_version   integer NOT NULL,
    kind           text   NOT NULL,
    bars           integer NOT NULL,
    time           bigint NOT NULL,
    value          double precision NOT NULL,
    CONSTRAINT indicator_ma_pkey PRIMARY KEY (symbol, interval, impl_version, kind, bars, time),
    CONSTRAINT indicator_ma_interval_ck CHECK (interval IN ('15m', '1h', '4h', '1d')),
    CONSTRAINT indicator_ma_kind_ck CHECK (kind IN ('sma', 'ema')),
    CONSTRAINT indicator_ma_impl_version_ck CHECK (impl_version > 0),
    CONSTRAINT indicator_ma_bars_ck CHECK (bars > 0)
);

-- -------------------------------------------------------------------------- MACD
CREATE TABLE IF NOT EXISTS indicator_macd (
    symbol         text   NOT NULL,
    interval       text   NOT NULL,
    impl_version   integer NOT NULL,
    fast           integer NOT NULL,
    slow           integer NOT NULL,
    signal         integer NOT NULL,
    time           bigint NOT NULL,
    dif            double precision NOT NULL,
    dea            double precision NOT NULL,
    -- HIST = DIF − DEA（**国际口径**）。国内软件（通达信 / 同花顺）用的是 2×(DIF−DEA)，
    -- 本期**不**采用；读侧要国内口径自行 ×2。让读侧「自己乘 2」比库里存一个
    -- 说不清来源的数诚实（R-1.5 / A.6）。
    hist           double precision NOT NULL,
    CONSTRAINT indicator_macd_pkey
        PRIMARY KEY (symbol, interval, impl_version, fast, slow, signal, time),
    CONSTRAINT indicator_macd_interval_ck CHECK (interval IN ('15m', '1h', '4h', '1d')),
    CONSTRAINT indicator_macd_impl_version_ck CHECK (impl_version > 0),
    CONSTRAINT indicator_macd_fast_ck CHECK (fast > 0),
    CONSTRAINT indicator_macd_slow_ck CHECK (slow > 0),
    CONSTRAINT indicator_macd_signal_ck CHECK (signal > 0)
);

-- -------------------------------------------------------------------------- RSI
CREATE TABLE IF NOT EXISTS indicator_rsi (
    symbol         text   NOT NULL,
    interval       text   NOT NULL,
    impl_version   integer NOT NULL,
    period         integer NOT NULL,
    time           bigint NOT NULL,
    value          double precision NOT NULL,
    CONSTRAINT indicator_rsi_pkey PRIMARY KEY (symbol, interval, impl_version, period, time),
    CONSTRAINT indicator_rsi_interval_ck CHECK (interval IN ('15m', '1h', '4h', '1d')),
    CONSTRAINT indicator_rsi_impl_version_ck CHECK (impl_version > 0),
    CONSTRAINT indicator_rsi_period_ck CHECK (period > 0)
);

-- ------------------------------------------------------------------------- BOLL
CREATE TABLE IF NOT EXISTS indicator_boll (
    symbol         text   NOT NULL,
    interval       text   NOT NULL,
    impl_version   integer NOT NULL,
    period         integer NOT NULL,
    -- k 的**千分之一整数**（2000 表示 k = 2.0）。浮点参数**不得**进主键（R-1.4），
    -- 因此凡口径上需要小数的参数一律存为千分之一整数；这里允许 0（k = 0 时三轨重合）。
    k_milli        integer NOT NULL,
    time           bigint NOT NULL,
    upper          double precision NOT NULL,
    mid            double precision NOT NULL,
    lower          double precision NOT NULL,
    CONSTRAINT indicator_boll_pkey PRIMARY KEY (symbol, interval, impl_version, period, k_milli, time),
    CONSTRAINT indicator_boll_interval_ck CHECK (interval IN ('15m', '1h', '4h', '1d')),
    CONSTRAINT indicator_boll_impl_version_ck CHECK (impl_version > 0),
    CONSTRAINT indicator_boll_period_ck CHECK (period > 0),
    CONSTRAINT indicator_boll_k_milli_ck CHECK (k_milli >= 0)
);

-- ------------------------------------------------------------------------- KDJ
CREATE TABLE IF NOT EXISTS indicator_kdj (
    symbol         text   NOT NULL,
    interval       text   NOT NULL,
    impl_version   integer NOT NULL,
    n              integer NOT NULL,
    k_period       integer NOT NULL,
    d_period       integer NOT NULL,
    time           bigint NOT NULL,
    k              double precision NOT NULL,
    d              double precision NOT NULL,
    j              double precision NOT NULL,
    CONSTRAINT indicator_kdj_pkey
        PRIMARY KEY (symbol, interval, impl_version, n, k_period, d_period, time),
    CONSTRAINT indicator_kdj_interval_ck CHECK (interval IN ('15m', '1h', '4h', '1d')),
    CONSTRAINT indicator_kdj_impl_version_ck CHECK (impl_version > 0),
    CONSTRAINT indicator_kdj_n_ck CHECK (n > 0),
    CONSTRAINT indicator_kdj_k_period_ck CHECK (k_period > 0),
    CONSTRAINT indicator_kdj_d_period_ck CHECK (d_period > 0)
);

-- ------------------------------------------------------------------------- ATR
CREATE TABLE IF NOT EXISTS indicator_atr (
    symbol         text   NOT NULL,
    interval       text   NOT NULL,
    impl_version   integer NOT NULL,
    period         integer NOT NULL,
    time           bigint NOT NULL,
    value          double precision NOT NULL,
    CONSTRAINT indicator_atr_pkey PRIMARY KEY (symbol, interval, impl_version, period, time),
    CONSTRAINT indicator_atr_interval_ck CHECK (interval IN ('15m', '1h', '4h', '1d')),
    CONSTRAINT indicator_atr_impl_version_ck CHECK (impl_version > 0),
    CONSTRAINT indicator_atr_period_ck CHECK (period > 0)
);

-- ------------------------------------------------------------------------- OBV
CREATE TABLE IF NOT EXISTS indicator_obv (
    symbol         text   NOT NULL,
    interval       text   NOT NULL,
    impl_version   integer NOT NULL,
    time           bigint NOT NULL,
    -- OBV 是从**段首 0** 起累加的绝对量，**只有相对变化有意义**；段首一变，
    -- 该段全部值整体平移，不同段之间不可比（R-1.6 / A.7）。因此**没有** period 参数列——
    -- 它确实无参数（R-13.8 的「OBV 无预热」由写侧保证）。
    value          double precision NOT NULL,
    CONSTRAINT indicator_obv_pkey PRIMARY KEY (symbol, interval, impl_version, time),
    CONSTRAINT indicator_obv_interval_ck CHECK (interval IN ('15m', '1h', '4h', '1d')),
    CONSTRAINT indicator_obv_impl_version_ck CHECK (impl_version > 0)
);

-- 主键前缀索引：物化与按 (symbol, interval, 参数集, 时间) 的读取都走它。
-- 本期不建物化视图 / 分区（N-10）：总行数与派生表同量级（附录 B），先用主键前缀观察。
CREATE INDEX IF NOT EXISTS indicator_ma_scan_idx
    ON indicator_ma (symbol, interval, kind, bars, time);
CREATE INDEX IF NOT EXISTS indicator_macd_scan_idx
    ON indicator_macd (symbol, interval, fast, slow, signal, time);
CREATE INDEX IF NOT EXISTS indicator_rsi_scan_idx
    ON indicator_rsi (symbol, interval, period, time);
CREATE INDEX IF NOT EXISTS indicator_boll_scan_idx
    ON indicator_boll (symbol, interval, period, k_milli, time);
CREATE INDEX IF NOT EXISTS indicator_kdj_scan_idx
    ON indicator_kdj (symbol, interval, n, k_period, d_period, time);
CREATE INDEX IF NOT EXISTS indicator_atr_scan_idx
    ON indicator_atr (symbol, interval, period, time);
CREATE INDEX IF NOT EXISTS indicator_obv_scan_idx
    ON indicator_obv (symbol, interval, time);