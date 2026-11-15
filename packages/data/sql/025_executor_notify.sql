-- 025_executor_notify：「要通知哪些内容」多一种——**止盈止损服务自己不可用**。
--
-- 背景（2026-11-06 在目标机 192.168.1.90 实测）：
--   币安把私有接口全拒了（-2015），executor 于是既挂不出单、也跑不出对账。
--   而对账正是「仓位没有保护」这类告警的**唯一原料来源**——对账一挂，
--   告警链整条断掉：不是「告警说一切正常」，而是**一条都发不出来**。
--   那 6 天里没有任何一条消息，等于「看起来在跑，其实在裸奔」。
--
--   同一类病在 2026-10-25 出现过一次（同步停摆静默 5 小时 55 分，022 的文件头有完整叙述）。
--   治它的办法是一样的：**给「自己不可用」这件事一个出口**，而不是指望日志被人盯着。
--
-- 约束是**扩枚举**：旧的值一个不少，名字也不改（AGENTS.md §5-12：
-- 「扩枚举时保留旧名、把旧值也列进去」——那是「扩」，不是「换」）。
-- 语义没变（仍然是「每个元素都必须是已知的通知内容类型」），所以沿用同一个约束名。
--
-- ⚠️ **列的默认值与存量行都要补上这一种**：它与 022 新增的两种同性质——
-- 「最贵的故障不是报错，是没人知道」。默认不勾的话，升级之后
-- 「止盈止损瞎了没人知道」会变成默认行为，那正是本迁移要治的病。

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
        'executor-unavailable'
    ]::text[]
  );

-- 列默认值：原来的 18 种（不含两种提示词镜像）+ 本次新增的一种。
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
      'executor-unavailable'
  ]::text[];

-- **已经配好的那一份也把新类型补上**（与 016 / 018 / 022 同一套做法）：
-- 用户显式要求过「飞书要通知我」，而这一种不补勾的话，升级之后
-- 「止盈止损瞎了」仍然是**一声不吭地不发生**——那正是约定 9 忌讳的
-- 「看起来成功其实什么都没做」，也正是本迁移要治的病。
-- 补勾之后立刻生效；用户不想要可以在控制面取消勾选。
-- （改了勾选会让派发器的上一轮记账作废、按新设置从头开始——那是既有行为，
-- 见 AGENTS.md §6.9.1「改勾选 ≠ 问题解决」。）
UPDATE notify_settings
   SET kinds = (
         SELECT array_agg(DISTINCT k ORDER BY k)
           FROM unnest(kinds || ARRAY[
             'executor-unavailable'
           ]::text[]) AS k
       ),
       updated_at = updated_at
 WHERE id = 1;
