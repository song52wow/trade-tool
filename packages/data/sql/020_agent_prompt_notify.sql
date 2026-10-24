-- 020_agent_prompt_notify：v1.0.0 「要通知哪些内容」多两种——模型提示词。
--
-- 背景：模型这一环是整个仓库里最黑的一环——输入是几千字提示词，输出是一段 JSON，
-- 中间没有任何东西落在日志或界面上。于是「模型为什么这么答」永远答不出来。
-- 把提示词同步发到飞书群，就是在补这条线索。
--
-- ⚠️ **这两种与其余那些不一样**：它们是**排障用的调试数据**，不是「发生了一件事」。
-- 其余那些（对账差异、挂单失败、成交）漏推了就没人知道出事了；而提示词漏推了
-- 只是「排障时少一条线索」。而且提示词里带着行情与账户权益——
-- 默认就发，等于装了这个包就自动把仓位信息发给了第三方群。
--
-- 分成**两种**而不是一种，因为频率差得远：
--   * `agent-prompt`     —— Agent 每个标的每轮两条（分析师 + 交易员），缺省 15 分钟一轮；
--   * `decision-prompt`  —— executor **每次成交**一条（v0.9.0 的 LLM 档位决策）。
-- 合成一种的话，勾了它就等于「每笔成交往群里发一条」——那是刷屏，
-- 而刷屏的告警等于没接（§6.9 第 2 条）。
--
-- 因此这两种是**唯二默认不勾**的：
--   * `DEFAULT_NOTIFY_KINDS`（core 侧）把它们排除在默认集合之外；
--   * 本迁移**不动**已经配好的那一份（不像 016 / 018 那样把新类型补进去）——
--     补进去就等于给存量用户自动打开了它，那是要用户自己决定的事。
--
-- 约束是**扩枚举**：旧的值一个不少，名字也不改（AGENTS.md §5.12：
-- 「扩枚举时保留旧名、把旧值也列进去」——那是「扩」，不是「换」）。
-- 语义没变（仍然是「每个元素都必须是已知的通知内容类型」），所以沿用同一个约束名。
ALTER TABLE notify_settings DROP CONSTRAINT IF EXISTS notify_settings_kinds_check;
ALTER TABLE notify_settings
  ADD CONSTRAINT notify_settings_kinds_check CHECK (
    kinds <@ ARRAY[
        'missing-stop-order',
        'unprotected-position',
        'position-without-record',
        'missing-take-profit-order',
        'unexpected-take-profit-order',
        'price-mismatch',
        'record-without-position',
        'orphan-algo-order',
        'trail-move-failed',
        'bracket-armed',
        'bracket-settled',
        'llm-fallback',
        'tp1-filled',
        'trail-moved',
        'agent-plan-executed',
        'agent-plan-failed',
        'agent-prompt',
        'decision-prompt'
    ]::text[]
  );

-- ⚠️ **列的默认值也保持原样**（16 种，不含那两种提示词）：
-- 新插入的行默认**不**勾提示词镜像。要发得显式勾上。
