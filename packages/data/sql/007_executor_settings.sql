-- 007_executor_settings：v0.5.0 控制面可写的两类运行期设置。
--
-- 这张迁移回答一个问题：为什么这次**允许密钥与策略从页面写进数据库**，
-- 以及为什么密钥**落库时必须是密文**。
--
-- 背景是仓库原本的规矩（AGENTS.md 硬性约定 2）：配置文件里不写密钥本身，
-- 只写环境变量名，凭据只从环境变量读。用户明确要求改成从控制面录入，
-- 于是约束从「不进数据库」变成「**进数据库但必须加密，且任何读取路径都不回显明文**」。
--
-- 加密：AES-256-GCM，主密钥来自环境变量 `TRADE_TOOL_SECRET_KEY`。
-- 选 GCM 而不是 CBC 是因为它自带认证标签——密文被改过会解密失败，
-- 而不是安静地解出一段垃圾去签名请求。
--
-- 约定沿用既有（R-1）：
--   * 时间戳一律 bigint（epoch 毫秒），不用 timestamptz；
--   * 本文件必须可重复执行（幂等）；
--   * 表结构的唯一来源就是本文件，TS 与 Python 都不得另持影子定义。

-- ---------------------------------------------------------------- 交易所凭据
--
-- 一行一个交易所。**只有 executor 进程会解密它**；控制面的读取路径只拿
-- `key_hint`（末 4 位）用来让人确认「配的是哪一把」，密文与明文都不出这条边界。
--
-- api_key 与 api_secret 打包成**一个** JSON 明文再整体加密：GCM 的认证标签
-- 覆盖整段密文，分开加密两份就多一份要各自校验的元数据，而它们永远是一起填的。
CREATE TABLE IF NOT EXISTS executor_credentials (
    exchange      text             NOT NULL,
    -- AES-256-GCM 的 12 字节随机 IV。每次写入都重新生成——IV 复用会直接摧毁 GCM 的安全性。
    iv            bytea            NOT NULL,
    auth_tag      bytea            NOT NULL,
    -- 加密后的 JSON：`{"apiKey":"…","apiSecret":"…"}`
    ciphertext    bytea            NOT NULL,
    -- api_key 的末 4 位，**纯展示用**，不是机密。让人能分辨自己配的是哪一把，
    -- 代价是泄露了一把 key 的后 4 位（可接受，交易所 key 前缀本来也是公开的）。
    key_hint      text             NOT NULL,
    -- 是否已配置。空串意味着「用户主动清空了凭据」，与「从未配置」必须分开。
    updated_at    bigint           NOT NULL,
    PRIMARY KEY (exchange),
    CONSTRAINT executor_credentials_hint_len CHECK (char_length(key_hint) <= 4)
);

-- ---------------------------------------------------------------- 止盈止损策略
--
-- 两个作用域：
--   * scope='global' —— 一套默认，对所有标的生效。symbol 必须是空串。
--   * scope='symbol' —— 单标的覆盖。symbol 必须非空。
--
-- 用 CHECK 把这两条钉在 schema 里，而不是靠应用层自觉：多写一行代码去保证
-- 「global 行的 symbol 一定是空的」很容易漏，而漏了之后查询会同时命中
-- 全局行和某个标的的行，行为随库里的数据量而变——正是本仓库反复在治的那种分裂。
--
-- 倍数与周期的取值范围直接照抄 `executorSchema`（packages/core/src/config.ts），
-- 不在这里另立一套：页面校验、schema 校验、纯函数校验三处一旦各写各的，
-- 就会出现「页面能填、库里存得下、纯函数算不出来」的组合。
CREATE TABLE IF NOT EXISTS risk_policy (
    scope                  text             NOT NULL,
    exchange               text             NOT NULL,
    -- global 行为空串，symbol 行必须非空（见下方 CHECK）
    symbol                 text             NOT NULL DEFAULT '',
    atr_period             integer          NOT NULL,
    atr_interval           text             NOT NULL,
    stop_atr_mult          double precision NOT NULL,
    take_profit_atr_mult   double precision NOT NULL,
    updated_at             bigint           NOT NULL,
    PRIMARY KEY (scope, exchange, symbol),
    CONSTRAINT risk_policy_scope_check CHECK (scope IN ('global', 'symbol')),
    -- global 与 symbol 两种作用域的「symbol 该不该有值」互斥，钉在 schema 里
    CONSTRAINT risk_policy_symbol_scope_check CHECK (
        (scope = 'global' AND symbol = '') OR (scope = 'symbol' AND symbol <> '')
    ),
    CONSTRAINT risk_policy_atr_period_check CHECK (atr_period > 0 AND atr_period <= 200),
    -- 只接受 quant_data 已实现的周期。与 parseIndicatorIndicatorInterval 同一份白名单；
    -- 未实现的周期必须在这里被拒，而不是留到取数时才报错（那会让页面上已经显示着
    -- 一个「已保存」的策略，实际永远算不出 ATR）。
    CONSTRAINT risk_policy_atr_interval_check CHECK (atr_interval IN ('1m', '15m', '1h', '4h', '1d')),
    -- ATR=0 或倍数为 0 会让止盈止损重合 / 止损落在入场价上，纯函数层会抛错；
    -- 这里先挡住，写进库的每一行都是能真的算出价的配置。
    CONSTRAINT risk_policy_stop_mult_check CHECK (stop_atr_mult > 0 AND stop_atr_mult <= 20),
    CONSTRAINT risk_policy_tp_mult_check CHECK (take_profit_atr_mult > 0 AND take_profit_atr_mult <= 50)
);