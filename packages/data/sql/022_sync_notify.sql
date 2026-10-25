-- 022_sync_notify：「要通知哪些内容」多两种——**同步器自己的故障**。
--
-- 背景（2026-10-25 在目标机 192.168.1.90 实测）：
-- 同步守护进程此前**一个通知出口都没有**——`apps/sync` 里没有一行通知代码，
-- `NOTIFY_KINDS` 里也没有「同步失败」这一类内容。于是两件事只会写进日志：
--   * 某个标的连续失败到 `sync.maxConsecutiveErrors`（默认 5）被钉成 `error`，
--     停止自动重试（R-21.3），要人工 resume 才会再跑；
--   * 所有在跑的标的都被钉死 → 调度器选不出任何标的 → **一条数据都不再进**。
-- 第二种最危险：守护进程**还活着**，心跳照刷（心跳定时器与调度循环是分开的），
-- 控制面因此显示「在线」——而实际上一条数据都没进。实测那一次静默了 **5 小时 55 分**，
-- 期间没有任何一行日志（空批次直接返回、不打日志）。
--
-- 「最贵的故障不是报错，是没人知道」——这一层存在的理由就是它（core/notify.ts 文件头）。
--
-- 约束是**扩枚举**：旧的值一个不少，名字也不改（AGENTS.md §5-12：
-- 「扩枚举时保留旧名、把旧值也列进去」——那是「扩」，不是「换」）。
-- 语义没变（仍然是「每个元素都必须是已知的通知内容类型」），所以沿用同一个约束名。
--
-- ⚠️ **列的默认值也一起补上这两种**：它们是**默认勾上**的
-- （不在 `PROMPT_MIRROR_KINDS` 里，与 020 的那两种提示词镜像相反）。
-- 默认不勾的话，「同步停了没人知道」会变成默认行为——那正是本迁移要治的病。
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
        'sync-stopped'
    ]::text[]
  );

-- 列默认值：原来的 16 种（不含两种提示词镜像）+ 本次新增的两种。
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
      'sync-stopped'
  ]::text[];

-- **已经配好的那一份也把新类型补上**（与 016 / 018 同一套做法）：
-- 用户显式要求过「飞书要通知我」，而这两种不补勾的话，升级之后
-- 「同步停了」这件事仍然是**一声不吭地不发生**——那正是约定 9 忌讳的
-- 「看起来成功其实什么都没做」，也正是本迁移要治的病。
-- 补勾之后立刻生效；用户不想要可以在控制面取消勾选。
-- （改了勾选会让派发器的上一轮记账作废、按新设置从头开始——那是既有行为，
-- 见 AGENTS.md §6.9.1「改勾选 ≠ 问题解决」。）
UPDATE notify_settings
   SET kinds = (
         SELECT array_agg(DISTINCT k ORDER BY k)
           FROM unnest(kinds || ARRAY[
             'sync-symbol-error',
             'sync-stopped'
           ]::text[]) AS k
       ),
       updated_at = updated_at
 WHERE id = 1;
