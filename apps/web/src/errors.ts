import { SyncError, type SyncErrorCode } from '@trade-tool/core';

/**
 * 错误码 → HTTP 状态码。
 *
 * 用 `satisfies` 而不是普通类型注解：`SyncErrorCode` 将来新增成员而这里漏了，
 * 会在 `pnpm typecheck` 时报错，不会等到线上返回 500 才发现。
 */
const STATUS_BY_CODE = {
  // 目标不存在 / 状态不允许
  SYMBOL_NOT_FOUND: 404,
  NOT_PERPETUAL: 422,
  NOT_TRADING: 409,
  // 元数据与交易所边界
  METADATA_FETCH_FAILED: 502,
  EXCHANGE_ERROR: 502,
  NETWORK_ERROR: 502,
  BACKFILL_BOUNDARY_VIOLATION: 502,
  // 数据完整性：不是「你请求错了」，但也不是 500 的锅
  UNCLOSED_BAR_IN_STORE: 409,
  WATERMARK_MISMATCH: 409,
  NULL_NOT_ALLOWED: 500,
  GAP_ATTEMPTS_EXHAUSTED: 409,
  // 派生周期（v0.2.0 R-9.3）
  // AGGREGATION_FAILED 是 500：派生写失败是服务端数据层的问题，用户改请求也没用；
  // AGGREGATION_MISMATCH 是 409：库里的派生数据与 1m 已经对不上，属于「状态冲突」，
  // 处置方式是 --rebuild，而不是重试同一个请求。
  AGGREGATION_FAILED: 500,
  AGGREGATION_MISMATCH: 409,
  // 技术指标（v0.3.0 R-12.3）——与派生周期同构，因为它们的成因与处置方式完全一样：
  //   * INDICATOR_FAILED 物化失败是服务端数据层的问题（500），用户改请求没用；
  //   * INDICATOR_MISMATCH `--check` 发现库里与当前 K 线对不上（409），处置是 --rebuild；
  //   * INDICATOR_IMPL_STALE 实现版本不一致、已拒绝写入（409），同样要人工介入。
  INDICATOR_FAILED: 500,
  INDICATOR_MISMATCH: 409,
  INDICATOR_IMPL_STALE: 409,
  // 数据库
  DB_CONNECTION_FAILED: 503,
  DB_DEADLOCK: 503,
  DB_UNIQUE_VIOLATION: 409,
  DB_TRANSACTION_ROLLBACK: 500,
  SCHEMA_VERSION_MISMATCH: 409,
  // 配额
  RATE_LIMITED: 429,
  EXCHANGE_RATE_LIMITED: 429,
  // 单写者
  SYNC_ALREADY_RUNNING: 409,
  // 配置
  CONFIG_INVALID: 400,
  INTERNAL_ERROR: 500,
} satisfies Record<SyncErrorCode, number>;

export function statusForCode(code: SyncErrorCode): number {
  return STATUS_BY_CODE[code];
}

/**
 * 去掉 `SyncError` 在 message 里自带的那层 `[CODE] ` 前缀。
 *
 * `SyncError` 的构造函数把 message 存成 `"[CODE] 正文"`（CLI 靠它一行说清错误）；
 * HTTP 响应体若原样透传，页面再按 `[code] message` 拼一次就显示成 `[CODE] [CODE] 正文`。
 * 错误体已经把 code 放在**单独字段**里，message 只该是正文。
 */
function stripCodePrefix(code: string, message: string): string {
  const prefix = `[${code}] `;
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}

/** 未知异常一律 500，并保留原始信息——不吞异常，也不伪装成已知错误。 */
export function toErrorBody(error: unknown): { status: number; body: unknown } {
  if (error instanceof SyncError) {
    return {
      status: statusForCode(error.code),
      body: {
        error: {
          code: error.code,
          message: stripCodePrefix(error.code, error.message),
          details: error.details,
        },
      },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message } } };
}
