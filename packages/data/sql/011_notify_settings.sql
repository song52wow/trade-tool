-- 011_notify_settings：v0.8.0 飞书通知通道的运行期设置。
--
-- 这张表回答一个问题：为什么**通知的凭据也走控制面**，而不是一直只走环境变量。
--
-- 背景：通知的开关、webhook 地址、签名密钥、冷却时长原先全在「配置文件 + 环境变量」里，
-- 换一台机器、改一个地址都要手改文件。而 webhook 地址本身就是凭据（拿到就能往群里发消息），
-- 按 AGENTS.md 硬性约定 2「密钥类配置一律只写环境变量名」，它不能进配置文件——
-- 于是 v0.5.0 那套「控制面录入 + 密文落库」的做法被原样搬了过来。
--
-- 加密：AES-256-GCM，主密钥来自环境变量 `TRADE_TOOL_SECRET_KEY`，与 `executor_credentials`
-- 同一套（packages/core/src/secret.ts）。webhook 地址与签名密钥打包成**一个** JSON 明文
-- 再整体加密：它们永远是一起填的，认证标签覆盖整段就够，不必各存一份元数据。
--
-- ⚠️ **本表是单行表**（`id = 1` 用 CHECK 钉住）：通知通道是全局的，
-- 不按交易所或标得分区。分成多行会让「哪一份在生效」重新变成一个问题。
--
-- 约定沿用既有（R-1）：
--   * 时间戳一律 bigint（epoch 毫秒），不用 timestamptz；
--   * 本文件必须可重复执行（幂等）；
--   * 表结构的唯一来源就是本文件，TS 与 Python 都不得另持影子定义。
CREATE TABLE IF NOT EXISTS notify_settings (
    -- 单行表：CHECK 把「只有一行」钉在 schema 里，而不是靠应用层自觉。
    id                  smallint        NOT NULL DEFAULT 1,
    -- 推送开关。关掉时地址仍然留着——改开关不必重填地址。
    enabled             boolean        NOT NULL DEFAULT false,
    -- AES-256-GCM 的 12 字节随机 IV。每次写入都重新生成——IV 复用会直接摧毁 GCM 的安全性。
    iv                  bytea           NOT NULL,
    auth_tag            bytea           NOT NULL,
    -- 加密后的 JSON：`{"webhookUrl":"…","secret":"…"}`
    ciphertext          bytea           NOT NULL,
    -- webhook 地址末 4 位，**纯展示用**，不是机密。让人能分辨自己配的是哪一个机器人，
    -- 代价是泄露了地址的后 4 位（token 前半段仍然不可知）。
    -- 空串 = 用户主动清空了通知配置（与「从未配置」必须分开，见下）。
    key_hint            text            NOT NULL DEFAULT '',
    -- 低于这个严重度的告警不推。取值范围照抄 `notifySchema`（packages/core/src/config.ts），
    -- 不在这里另立一套：页面能填、schema 存得下、纯函数算得出，三处必须一致。
    min_severity        text            NOT NULL DEFAULT 'warning',
    -- 同一条告警的重复推送冷却时间（毫秒）。0 = 每轮都推。
    repeat_cooldown_ms  integer         NOT NULL DEFAULT 1800000,
    updated_at          bigint          NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT notify_settings_singleton_check CHECK (id = 1),
    CONSTRAINT notify_settings_min_severity_check CHECK (min_severity IN ('critical', 'warning', 'info')),
    CONSTRAINT notify_settings_cooldown_check CHECK (repeat_cooldown_ms >= 0),
    CONSTRAINT notify_settings_hint_len CHECK (char_length(key_hint) <= 4)
);
