-- 016：移动止损的档位序号 + 两类新通知（v0.9.2）。
--
-- 背景（2026-10-22 实测踩到）：移动止损**一次都挪不成**，而账面、交易所、对账三方全绿。
--
-- 成因是条件单的**自定义号**：`rsk-sl-<入场单号>` 只由入场单号派生，于是每次挪止损
-- 用的都是同一个号。而 Binance 不允许同时存在两张 `clientAlgoId` 相同的挂单
-- （重复直接被拒：`ClientOrderId is duplicated.`）——进场时挂的那张止损单用的也是这个号，
-- 且挪单是「先挂新、再撤旧」，旧单此刻还在交易所上。于是**第一次挪就被拒**，
-- 后面每一轮（默认 60 秒一次）都重试、都失败。
--
-- 症状：止损价永远停在入场那一档（`trail_stop_price` 恒等于 `stop_price`），
-- 而止损单确实在交易所上、价格也确实对得上——**没有任何一处会报异常**。
--
-- 三件事一起改：
--   1. `trail_step`：止损单的**档位序号**。每一次挪单先占一个号，号永不复用，
--      于是「先挂新、再撤旧」得以保留（撤旧会造出无保护窗口，见 AGENTS.md §6.8 第 3 条）。
--   2. `trail_moves`：**成功换过几档**。它是「挪过几次」这个问题的答案。
--   3. `trail_status`：**最近一轮的结果**（idle / moved / not-moved / failed）。
--      对账据此判定「移动止损接管失败」——这类故障此前**没有任何一处能看见**。
--
-- ⚠️ 为什么第 3 条不能用「尝试次数 − 成功次数」代替：那是个**累计差**，
-- 一次失败之后它永远不归零——移动止损早就修好了，对账却还在报「换档失败」。
-- 「现在坏着吗」只能由**最近一轮的状态**回答。
--   4. 通知内容类型扩容：多「第一段止盈成交」「移动止损换档」两类事件，
--      以及「移动止损换档失败」这一类对账差异。
--
-- 约定沿用既有（R-1）：时间戳一律 bigint；本文件必须可重复执行（幂等）；
-- 表结构的唯一来源就是本文件，TS 与 Python 都不得另持影子定义。

-- ------------------------------------------------------- 移动止损的档位序号

ALTER TABLE risk_bracket
  ADD COLUMN IF NOT EXISTS trail_step integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS trail_moves integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS trail_status text NOT NULL DEFAULT 'idle';

-- 两列都是「只增不减的计数」：出现负数意味着被减了两次，而那会让「挪过几次」
-- 算出一个比真实更小的数——于是「有尝试没成功」这条判据被悄悄抹掉。
ALTER TABLE risk_bracket DROP CONSTRAINT IF EXISTS risk_bracket_trail_counts_check;
ALTER TABLE risk_bracket
  ADD CONSTRAINT risk_bracket_trail_counts_check CHECK (
      trail_step >= 0 AND trail_moves >= 0 AND trail_moves <= trail_step
  );

-- `trail_status` 的取值只有四个，写死在 schema 里。
-- `idle` = 还没进过移动止损（或刚进、还没跑过一轮）；
-- `moved` = 最近一轮挪成了；`not-moved` = 最近一轮决定不挪（行情没走出来 / 极值取不到）；
-- `failed` = 最近一轮想挪但没挪成（挂单或撤单出错）——**只有它会被对账报成差异**。
ALTER TABLE risk_bracket DROP CONSTRAINT IF EXISTS risk_bracket_trail_status_check;
ALTER TABLE risk_bracket
  ADD CONSTRAINT risk_bracket_trail_status_check CHECK (
      trail_status IN ('idle', 'moved', 'not-moved', 'failed')
  );

-- ⚠️ `trail_moves <= trail_step` 是**不变量**：成功换过几档不可能超过尝试过几档。
-- 它同时把「挪过一次」这件事钉死——`trail_moves = 1` 必然意味着至少挂过一张新的止损单，
-- 于是「止损价从未变过」与「挂单从来没成功过」在库里再也分不开。

-- ------------------------------------------------------- 通知内容类型扩容

-- 「要通知哪些内容」从 11 种扩到 14 种：
--   * 新增对账差异「移动止损换档失败」；
--   * 新增事件「第一段止盈成交」「移动止损换档」。
-- CHECK 约束与列默认值都一起换，否则会存进一个读不出来的取值。
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
          'trail-moved'
      ]::text[]
  );
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
      'trail-moved'
  ]::text[];

-- **已经配好的那一份也把新类型补上**：用户显式要求过「第一段止盈成交要通知、
-- 移动止损要通知」，而新类型默认不勾的话，升级之后这两条推送会**一声不吭地不发生**——
-- 那正是约定 9 忌讳的「看起来成功其实什么都没做」。
-- 补勾之后它们立刻生效；用户不想要可以在控制面取消勾选。
-- （改了勾选会让派发器的上一轮记账作废、按新设置从头开始——那是既有行为，
-- 见 AGENTS.md §6.9.1「改勾选 ≠ 问题解决」。）
UPDATE notify_settings
   SET kinds = (
         SELECT array_agg(DISTINCT k ORDER BY k)
           FROM unnest(kinds || ARRAY[
             'trail-move-failed',
             'tp1-filled',
             'trail-moved'
           ]::text[]) AS k
       ),
       updated_at = updated_at
 WHERE id = 1;
