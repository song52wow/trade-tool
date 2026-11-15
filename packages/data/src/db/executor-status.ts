/**
 * 止盈止损服务（executor）自己的状态行（2026-11-06）。
 *
 * ## 为什么要有它
 *
 * `daemon_heartbeat`（003）只覆盖**同步守护进程**。executor 是另一个进程，
 * 而且它有一种同步器没有的失效方式：**活着，但瞎了**。
 *
 * 2026-11-06 在目标机 192.168.1.90 上实测到的那一次：
 * 币安把私有接口全拒了（`-2015`），于是 executor 既拿不到 listenKey（挂不出单），
 * 也跑不出对账（连「仓位没有保护」这条告警的原料都没有）。
 * 止盈止损从 10-31 03:49 起彻底停摆，而**没有任何一条消息**告诉任何人。
 *
 * 「进程活着」与「服务能用」是**两件事**。本模块把它们分开记：
 *   * `last_beat` —— 进程还活着（由独立于业务动作的定时器刷新）；
 *   * `private_api_ok` —— 私有接口还能用（由最近一次私有调用决定）。
 *
 * 合成一个「在线」就会骗人：2026-10-25 那次同步停摆就是这样静默了 5 小时 55 分
 * （心跳照跳，数据一条没进）。
 *
 * ## 边界
 *
 * * **只记状态，不做判定**：判定在两处，各有各的理由——
 *   控制面侧判「进程在不在 / 能不能用」（{@link readExecutorStatus}），
 *   executor 侧判「该不该推告警」（`apps/executor/src/health.ts`）。
 *   同一件事只有一个判据实现，两处共用同一份数据。
 * * **不写交易事实**：成交、保护、盈亏一律走 `risk_bracket`（见 §6.3）。
 */

import { SyncError } from '@trade-tool/core';

import { toSyncError } from './errors.js';
import type { Pool } from './pool.js';

/**
 * 心跳刷新间隔（毫秒）。
 *
 * **导出它，是因为读的一方必须按同一个节拍判超时**：控制面拿「心跳年龄」
 * 和这个间隔的 3 倍比较。两侧各写一个数字迟早会漂移，而漂移的表现是
 * 页面把活着的进程读成离线（或反过来），没人会想到去核对两个常量。
 *
 * （与同步守护进程的 `HEARTBEAT_INTERVAL_MS` 同一个值，但**各写各的**——
 * 两个进程的心跳不是一回事，共用一个常量会让「谁的心跳」这件事说不清。）
 */
export const EXECUTOR_HEARTBEAT_INTERVAL_MS = 10_000;

/** 心跳超过这个毫秒数即判「进程失联」（进程被强杀或卡死）。 */
export const EXECUTOR_STALE_AFTER_MS = Math.max(60_000, EXECUTOR_HEARTBEAT_INTERVAL_MS * 3);

/**
 * executor 的状态行（读出来用于展示与判定）。
 *
 * `privateApiOk` 与 `lastPrivateOkAt` 分开：**「现在能用」**与
 * **「上次能用是什么时候」**是两件都要看的事——前者说明此刻能不能挂单，
 * 后者说明它已经瞎了多久。
 */
export interface ExecutorStatus {
  exchange: string;
  pid: number;
  startedAt: number;
  lastBeatAt: number;
  /** 最近一次私有接口调用是否成功。 */
  privateApiOk: boolean;
  /** 最近一次私有接口**成功**的时刻；一次都没成功过时为 `null`。 */
  lastPrivateOkAt: number | null;
  /** 最近一次私有接口失败的错误码（`SyncErrorCode` 或交易所错误码）。 */
  lastErrorCode: string | null;
  /** 最近一次私有接口失败的原话。 */
  lastErrorMessage: string | null;
}

/**
 * 控制面看到的 executor 状态。
 *
 * 三种进程状态与 `daemon_heartbeat` 同一套口径（`running` / `stale` / `stopped`），
 * 但**多一个正交维度**：`privateApiOk`。
 *
 * 为什么多这一维：「进程在跑」与「服务能用」必须能分开看——
 * 合成一个「在线」正是这次静默 6 天的形状。
 */
export interface ExecutorStatusView {
  state: 'running' | 'stale' | 'stopped';
  pid: number | null;
  startedAt: number | null;
  lastBeatAt: number | null;
  ageMs: number | null;
  /** 超过这个毫秒数没心跳即判 stale。 */
  staleAfterMs: number;
  /** 私有接口能不能用。`null` = 进程没在跑，谈不上能不能用。 */
  privateApiOk: boolean | null;
  /** 最近一次私有接口成功的时刻。 */
  lastPrivateOkAt: number | null;
  /** 最近一次失败的错误码与原话。 */
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

function ms(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 写入 / 刷新 executor 的状态行（executor 侧）。
 *
 * `started_at` 用 COALESCE 保留首次启动时刻：定时器每轮都调它，若无脑覆盖，
 * 页面上的「已运行」就会永远是几秒。
 *
 * 私有接口的健康状态**只在变化时改**：`private_api_ok` 与两个 last_error 列
 * 由 {@link markExecutorPrivateApi} 单独更新——心跳刷新不该顺手把「上次失败的原因」
 * 冲掉，否则控制面永远显示不出「它最后一次是怎么坏的」。
 */
export async function upsertExecutorStatus(
  pool: Pool,
  exchange: string,
  nowMs: number = Date.now(),
  pid: number = process.pid,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO executor_status (exchange, pid, started_at, last_beat)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (exchange) DO UPDATE
         SET pid = EXCLUDED.pid,
             last_beat = EXCLUDED.last_beat,
             -- 只在进程身份变化时重置启动时刻，避免换进程后沿用旧的 started_at
             started_at = CASE WHEN executor_status.pid IS DISTINCT FROM EXCLUDED.pid
                               THEN EXCLUDED.started_at ELSE executor_status.started_at END`,
      [exchange, pid, nowMs],
    );
  } catch (error) {
    throw toSyncError(error, '写入 executor 状态失败');
  }
}

/**
 * 记一次私有接口调用的**结果**（executor 侧）。
 *
 * 成功：置 `private_api_ok = true`、刷新 `last_private_ok_at`、**清掉**错误列。
 * 失败：置 `private_api_ok = false`、把错误码与原话写进去。
 *
 * 为什么成功时要**清掉**错误列：控制面显示的是「现在怎么样」，
 * 一条三小时前的旧错误挂在那儿，会让人以为现在也是坏的。
 *
 * ⚠️ **这里是 upsert 而不是 update**：私有接口的第一次调用**可能早于**第一行状态
 * 的存在（启动时先播种、后写心跳；或者私有接口先坏了）。用 update 的话，
 * 那一次失败会被**静默丢掉**——行还不存在，UPDATE 影响 0 行，
 * 紧接着心跳把它建成「正常」，于是「它一开始就瞎了」这件事在状态行里看不见。
 */
export async function markExecutorPrivateApi(
  pool: Pool,
  exchange: string,
  outcome: { ok: true } | { ok: false; code: string; message: string },
  nowMs: number = Date.now(),
): Promise<void> {
  try {
    if (outcome.ok) {
      await pool.query(
        `INSERT INTO executor_status
           (exchange, pid, started_at, last_beat, private_api_ok, last_private_ok_at,
            last_error_code, last_error_message)
         VALUES ($1, $2, $3, $3, true, $4, NULL, NULL)
         ON CONFLICT (exchange) DO UPDATE
           SET private_api_ok = true,
               last_private_ok_at = EXCLUDED.last_private_ok_at,
               last_error_code = NULL,
               last_error_message = NULL`,
        [exchange, process.pid, nowMs, nowMs],
      );
      return;
    }
    await pool.query(
      `INSERT INTO executor_status
         (exchange, pid, started_at, last_beat, private_api_ok, last_private_ok_at,
          last_error_code, last_error_message)
       VALUES ($1, $2, $3, $3, false, NULL, $4, $5)
       ON CONFLICT (exchange) DO UPDATE
         SET private_api_ok = false,
             last_error_code = EXCLUDED.last_error_code,
             last_error_message = EXCLUDED.last_error_message`,
      [exchange, process.pid, nowMs, outcome.code, outcome.message],
    );
  } catch (error) {
    throw toSyncError(error, '记录 executor 私有接口状态失败');
  }
}

/**
 * 删除状态行（优雅退出时调用）。
 *
 * 删掉而不是只停止刷新：这样「行不存在」就是**确切**的「没在跑」，
 * 而不是「还得靠阈值猜」——和 `daemon_heartbeat` 同一套语义。
 */
export async function deleteExecutorStatus(pool: Pool, exchange: string): Promise<void> {
  try {
    await pool.query('DELETE FROM executor_status WHERE exchange = $1', [exchange]);
  } catch (error) {
    throw toSyncError(error, '删除 executor 状态失败');
  }
}

/**
 * 读状态并判定（控制面侧）。
 *
 * 三种进程状态：
 *   * `running` —— 心跳新鲜；
 *   * `stale`   —— 心跳超阈值（进程被强杀或卡死）；
 *   * `stopped` —— 没有状态行（从未启动或已优雅退出）。
 *
 * `privateApiOk` **独立于**进程状态：进程活着时它说明「服务能不能用」，
 * 进程不在时它是 `null`（不是 `false`——「没在跑」与「不能用」是两件事，
 * 合成一个会让人去查错方向）。
 */
export async function readExecutorStatus(
  pool: Pool,
  exchange: string,
  staleAfterMs: number = EXECUTOR_STALE_AFTER_MS,
  nowMs: number = Date.now(),
): Promise<ExecutorStatusView> {
  let row:
    | {
        pid: number;
        started_at: string;
        last_beat: string;
        private_api_ok: boolean | null;
        last_private_ok_at: string | null;
        last_error_code: string | null;
        last_error_message: string | null;
      }
    | undefined;
  try {
    const result = await pool.query(
      `SELECT pid, started_at, last_beat, private_api_ok, last_private_ok_at,
              last_error_code, last_error_message
         FROM executor_status WHERE exchange = $1`,
      [exchange],
    );
    row = result.rows[0];
  } catch (error) {
    throw toSyncError(error, '读 executor 状态失败');
  }

  if (row === undefined) {
    return {
      state: 'stopped',
      pid: null,
      startedAt: null,
      lastBeatAt: null,
      ageMs: null,
      staleAfterMs,
      privateApiOk: null,
      lastPrivateOkAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    };
  }

  const lastBeatAt = ms(row.last_beat);
  if (lastBeatAt === null) {
    throw new SyncError('INTERNAL_ERROR', 'executor_status.last_beat 期望为非空 bigint', {
      value: String(row.last_beat),
    });
  }
  const ageMs = Math.max(0, nowMs - lastBeatAt);
  const startedAt = ms(row.started_at);
  return {
    state: ageMs > staleAfterMs ? 'stale' : 'running',
    pid: row.pid,
    startedAt,
    lastBeatAt,
    ageMs,
    staleAfterMs,
    // NULL = 还没成功调用过私有接口（未知），**不是**「不可用」。
    privateApiOk: row.private_api_ok === null ? null : row.private_api_ok === true,
    lastPrivateOkAt: ms(row.last_private_ok_at),
    lastErrorCode: str(row.last_error_code),
    lastErrorMessage: str(row.last_error_message),
  };
}
