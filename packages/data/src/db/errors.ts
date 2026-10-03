import { SyncError, type SyncErrorCode } from '@trade-tool/core';

/**
 * PG 错误分类（R-21.6）。
 *
 * 分类的意义在于**重试策略不同**：
 *   - 连接失败 → 退避重试，且不消耗交易所配额
 *   - 死锁     → PG 已回滚其中一个事务，属可恢复，有限重试即可
 *   - 唯一冲突 → 幂等写入的正常结果，通常可当作成功或直接放弃该批
 *   - schema 不匹配 → 立即停止，**不得重试**
 */

interface PgLikeError {
  code?: unknown;
  message?: unknown;
}

function codeOf(error: unknown): string | undefined {
  const code = (error as PgLikeError | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function messageOf(error: unknown): string {
  const message = (error as PgLikeError | null)?.message;
  return typeof message === 'string' ? message : String(error);
}

/** 依赖 `pg` 包的错误结构，这里只取需要的字段，避免把 pg 的类型引入本模块。 */
export interface ClassifiedPgError {
  code: SyncErrorCode;
  /** 是否值得重试 */
  retryable: boolean;
  /** 是否应立即停止整个进程（不重试） */
  fatal: boolean;
  original: unknown;
}

/** PG SQLSTATE：唯一约束冲突。 */
const UNIQUE_VIOLATION = '23505';
/** PG SQLSTATE：序列化失败。 */
const SERIALIZATION_FAILURE = '40001';
/** PG SQLSTATE：死锁。 */
const DEADLOCK_DETECTED = '40P01';
/** 驱动层：连接类错误。 */
const CONNECTION_ERRORS = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
]);

export function classifyPgError(error: unknown): ClassifiedPgError {
  const raw = codeOf(error);

  if (raw === DEADLOCK_DETECTED) {
    return { code: 'DB_DEADLOCK', retryable: true, fatal: false, original: error };
  }
  if (raw === SERIALIZATION_FAILURE) {
    return { code: 'DB_TRANSACTION_ROLLBACK', retryable: true, fatal: false, original: error };
  }
  if (raw === UNIQUE_VIOLATION) {
    return { code: 'DB_UNIQUE_VIOLATION', retryable: false, fatal: false, original: error };
  }
  if (raw !== undefined && CONNECTION_ERRORS.has(raw)) {
    return { code: 'DB_CONNECTION_FAILED', retryable: true, fatal: false, original: error };
  }

  const message = messageOf(error);
  if (
    /connection terminated|connection closed|timeout expired|no response from server|Client has encountered a connection error|server closed the connection/i.test(
      message,
    )
  ) {
    return { code: 'DB_CONNECTION_FAILED', retryable: true, fatal: false, original: error };
  }

  return { code: 'INTERNAL_ERROR', retryable: false, fatal: false, original: error };
}

/** 把任意异常归一化成 SyncError。已经是 SyncError 的原样透传。 */
export function toSyncError(error: unknown, fallbackMessage?: string): SyncError {
  if (error instanceof SyncError) return error;
  const classified = classifyPgError(error);
  if (classified.code === 'INTERNAL_ERROR' && !fallbackMessage) {
    return new SyncError('INTERNAL_ERROR', messageOf(error), { pgCode: codeOf(error) });
  }
  return new SyncError(
    classified.code,
    fallbackMessage ? `${fallbackMessage}: ${messageOf(error)}` : messageOf(error),
    { pgCode: codeOf(error) },
  );
}

/**
 * 「不得静默兜底」：查询层抛出的错误必须保留可读原因。
 * 这个断言让「连接失败」在调用链上任何一层都不会退化成空值。
 */
export function assertNonNull<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new SyncError('INTERNAL_ERROR', message);
  return value;
}
