-- 019_agent_llm_settings：模型接入的运行期设置（v1.0.0）。
--
-- 这个迁移回答一个问题：**模型怎么接，凭据放哪**。
--
-- 背景：模型接入原先全在「配置文件 + 环境变量」里——`agent.llm.baseUrl` /
-- `model` / `timeoutMs` 写在配置文件里，API 密钥写在环境变量里。换一个模型、
-- 换一台机器都要手改文件并重启进程。
--
-- 而 v0.5.0 与 v0.8.0 已经证明过另一条路可行：**控制面录入 + 密文落库**
-- （`executor_credentials` 与 `notify_settings` 都是这么做的）。
--
-- 加密：AES-256-GCM，主密钥来自环境变量 `TRADE_TOOL_SECRET_KEY`，
-- 与那两张表同一套（`packages/core/src/secret.ts`）。
--
-- ⚠️ **本表是单行表**（`id = 1` 用 CHECK 钉住）：模型接入是全局的，
-- 不按交易所或标得分区。分成多行会让「哪一份在生效」重新变成一个问题
-- ——而那正是排障时第一个要回答的问题。
--
-- 约定沿用既有（R-1）：
--   * 时间戳一律 bigint（epoch 毫秒），不用 timestamptz；
--   * 本文件必须可重复执行（幂等）；
--   * 表结构的唯一来源就是本文件，TS 与 Python 都不得另持影子定义。
CREATE TABLE IF NOT EXISTS agent_llm_settings (
    -- 单行表：CHECK 把「只有一行」钉在 schema 里，而不是靠应用层自觉。
    id                  smallint        NOT NULL DEFAULT 1,
    -- 开关。关掉时地址与模型仍然留着——改开关不必重填。
    enabled             boolean        NOT NULL DEFAULT false,
    -- API 基址，如 `https://api.openai.com/v1`。末尾斜杠会被去掉。
    base_url            text            NOT NULL,
    -- 模型名。
    model               text            NOT NULL,
    -- 单次调用的硬超时（毫秒）。
    --
    -- 缺省 8000：一次正常的 chat completion 在 1–3 秒。给到 8 秒是留余量，
    -- 再长就说明网络或服务有问题——那种情况下**应该失败**，而不是继续等。
    timeout_ms          integer         NOT NULL DEFAULT 8000,
    -- AES-256-GCM 的 12 字节随机 IV。每次写入都重新生成——IV 复用会直接摧毁 GCM 的安全性。
    iv                  bytea           NOT NULL,
    auth_tag            bytea           NOT NULL,
    -- 加密后的 JSON：`{"apiKey":"…"}`
    ciphertext          bytea           NOT NULL,
    -- 密钥末 4 位，**纯展示用**，不是机密。
    -- 让人能分辨自己配的是哪一把，省得换了一把之后完全看不出来。
    -- 空串 = 用户主动清空了（与「从未配置」必须分开，见下）。
    key_hint            text            NOT NULL DEFAULT '',
    updated_at          bigint          NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT agent_llm_settings_singleton_check CHECK (id = 1),
    -- 超时必须为正：0 会让请求立刻超时（或者根本不超时，取决于运行时的计时器语义），
    -- 而这两种都不是「能正常用」。
    CONSTRAINT agent_llm_settings_timeout_check CHECK (timeout_ms > 0),
    CONSTRAINT agent_llm_settings_hint_len CHECK (char_length(key_hint) <= 4),
    -- 开着就必须把三件套填全。缺一项的「开着」在运行期必然失败，
    -- 而失败要等到第一轮分析才暴露——那太晚了。
    CONSTRAINT agent_llm_settings_enabled_complete_check CHECK (
        NOT enabled
        OR (base_url <> '' AND model <> '' AND char_length(key_hint) > 0)
    )
);
