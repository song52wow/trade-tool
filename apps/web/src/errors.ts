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

/** 未知异常一律 500，并保留原始信息——不吞异常，也不伪装成已知错误。 */
export function toErrorBody(error: unknown): { status: number; body: unknown } {
  if (error instanceof SyncError) {
    return {
      status: statusForCode(error.code),
      body: { error: { code: error.code, message: error.message, details: error.details } },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message } } };
}
