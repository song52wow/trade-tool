-- 027_chain_notify：「要通知哪些内容」多一种——**链上仓位异动**（v1.2.0）。
--
-- 背景（2026-11-11 实测）：
--   控制面把「要通知哪些内容」存成**一份勾选清单**（notify_settings.kinds）。
--   新增一种通知种类时，库里那一份**不会自动多出这一项**——于是
--   链上监控的判据说「该推」、通道说「没勾」，**两边都没错，一条也没发出去**，
--   而监控那侧只留下 `sent = false` 的记录。
--   这正是约定 9 忌讳的「看起来成功其实什么都没做」：
--   监控在跑、采样在落库、判定在触发，唯独消息没出去。
--
--   这次是迁移把它治掉的（与 016 / 018 / 022 / 025 同一套做法）：
--   **扩枚举 + 补默认值 + 给存量行补勾**。
--
-- 约束是**扩枚举**：旧的值一个不少，名字也不改（AGENTS.md §5-12：
-- 「扩枚举时保留旧名、把旧值也列进去」——那是「扩」，不是「换」）。
-- 语义没变（仍然是「每个元素都必须是已知的通知内容类型」），所以沿用同一个约束名。
--
-- ⚠️ **只补这一种，不补两种提示词镜像**：agent-prompt / decision-prompt
--   **默认不勾**（带着行情与账户权益，默认发等于自动把仓位信息发给第三方群），
--   补勾它们会把「默认关闭」的约定反过来。

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
        'decision-prompt',
        'sync-symbol-error',
        'sync-stopped',
        'executor-unavailable',
        'chain-position-alert'
    ]::text[]
  );

-- 列默认值：原来的 20 种（不含两种提示词镜像）+ 本次新增的一种。
ALTER TABLE notify_settings
  ALTER COLUMN kinds SET DEFAULT ARRAY[
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
      'sync-symbol-error',
      'sync-stopped',
      'executor-unavailable',
      'chain-position-alert'
  ]::text[];

-- **已经配好的那一份也把新类型补上**（与 016 / 018 / 022 / 025 同一套做法）：
-- 用户显式要求过「飞书要通知我」，而这一种不补勾的话，升级之后
-- 「链上仓位出了事」仍然是**一声不吭地不发生**——那正是本迁移要治的病。
-- 补勾之后立刻生效；用户不想要可以在控制面取消勾选。
-- （改了勾选会让派发器的上一轮记账作废、按新设置从头开始——那是既有行为，
-- 见 AGENTS.md §6.9.1「改勾选 ≠ 问题解决」。）
UPDATE notify_settings
   SET kinds = (
         SELECT array_agg(DISTINCT k ORDER BY k)
           FROM unnest(kinds || ARRAY[
             'chain-position-alert'
           ]::text[]) AS k
       ),
       updated_at = updated_at
 WHERE id = 1;
