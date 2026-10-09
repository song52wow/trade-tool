/**
 * 交易所凭据的读写（v0.5.0）。
 *
 * 这个模块**故意不对称**：写进去是密文，取出来的路径被拆成两种，调用方必须想清楚
 * 要哪一种——
 *
 *   * `readCredentialStatus()` —— **给控制面**。只回「配没配」与末 4 位，
 *     连密文都不往外带。控制面永远没有能力把密钥显示出来，这是有意的：
 *     一旦有 GET 能拿到明文，任何一次 XSS、一个误开的日志、一张截图就都成了
 *     凭据泄露，而「配没配」已经足够让人确认状态。
 *   * `readCredentials()` —— **只给 executor**。返回明文，因此调用点要显眼。
 *
 * 表结构在 `sql/007_executor_settings.sql`，本模块不另持影子定义。
 */

import { SyncError, keyHint, openCredentials, sealCredentials } from '@trade-tool/core';

import { toSyncError } from './errors.js';
import type { Pool } from './pool.js';

const TABLE = 'executor_credentials';

/** 控制面能看到的全部信息。**没有 secret，也没有密文**——见模块注释。 */
export interface CredentialStatus {
  exchange: string;
  configured: boolean;
  /** api_key 末 4 位；未配置时为 null。纯展示用。 */
  hint: string | null;
  updatedAt: number | null;
}

/** 写侧入参。明文只在写入口与解密后短暂存在。 */
export interface CredentialWrite {
  exchange: string;
  apiKey: string;
  apiSecret: string;
  now: number;
}

interface Row {
  exchange: string;
  iv: Buffer;
  auth_tag: Buffer;
  ciphertext: Buffer;
  key_hint: string;
  updated_at: string | number;
}

function asBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  // node-postgres 把 bytea 默认当 Buffer 出，但走类型化客户端时可能是 Uint8Array。
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new SyncError('NULL_NOT_ALLOWED', '凭据密文的二进制列类型不对', { type: typeof value });
}

function asTimestamp(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

/** 状态查询。**控制面唯一的读路径**，永不返回明文或密文。 */
export async function readCredentialStatus(
  pool: Pool,
  exchange: string,
): Promise<CredentialStatus> {
  try {
    const result = await pool.query<{ key_hint: string; updated_at: string | number }>(
      `SELECT key_hint, updated_at FROM ${TABLE} WHERE exchange = $1`,
      [exchange],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return { exchange, configured: false, hint: null, updatedAt: null };
    }
    // 被清空的行留着 key_hint = ''（tombstone）。它**不算已配置**——
    // 否则页面会显示「已配置」而 executor 其实拿不到任何凭据，那正是本项目
    // 反复在治的「界面显示的和实际发生的不一致」。
    return {
      exchange,
      configured: row.key_hint !== '',
      hint: row.key_hint === '' ? null : row.key_hint,
      updatedAt: asTimestamp(row.updated_at),
    };
  } catch (error) {
    throw toSyncError(error, `读取 ${exchange} 凭据状态失败`);
  }
}

/**
 * 写入（或覆盖）凭据。
 *
 * `ON CONFLICT DO UPDATE` 而不是 DO NOTHING：这是一次**明确的用户操作**，
 * 「改密钥」就必须真的改掉，静默保留旧值会让用户以为已经换过了。
 * 幂等在这里没有意义——调用方是页面的提交按钮，不是重放的事件流。
 */
export async function writeCredential(
  pool: Pool,
  masterKey: Buffer,
  input: CredentialWrite,
): Promise<CredentialStatus> {
  if (input.apiKey.trim() === '' || input.apiSecret.trim() === '') {
    throw new SyncError('CONFIG_INVALID', 'apiKey 与 apiSecret 都不能为空');
  }
  const sealed = sealCredentials(
    { apiKey: input.apiKey.trim(), apiSecret: input.apiSecret.trim() },
    masterKey,
  );
  try {
    const result = await pool.query<{ key_hint: string; updated_at: string | number }>(
      `INSERT INTO ${TABLE} (exchange, iv, auth_tag, ciphertext, key_hint, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (exchange) DO UPDATE
         SET iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag, ciphertext = EXCLUDED.ciphertext,
             key_hint = EXCLUDED.key_hint, updated_at = EXCLUDED.updated_at
       RETURNING key_hint, updated_at`,
      [
        input.exchange,
        sealed.iv,
        sealed.authTag,
        sealed.ciphertext,
        keyHint(input.apiKey.trim()),
        input.now,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new SyncError('CONFIG_INVALID', '写入凭据后没有拿到回写行');
    }
    return {
      exchange: input.exchange,
      configured: true,
      hint: row.key_hint,
      updatedAt: asTimestamp(row.updated_at),
    };
  } catch (error) {
    if (error instanceof SyncError) throw error;
    throw toSyncError(error, `写入 ${input.exchange} 凭据失败`);
  }
}

/**
 * 清空凭据。留下 tombstone 行而不是 DELETE，
 * 这样 `updatedAt` 变新、控制面能显示「已清空」，不会退回「从未配置」那种含糊状态。
 */
export async function clearCredential(pool: Pool, exchange: string, now: number): Promise<void> {
  try {
    await pool.query(
      `UPDATE ${TABLE} SET iv = ''::bytea, auth_tag = ''::bytea,
       ciphertext = ''::bytea, key_hint = '', updated_at = $2 WHERE exchange = $1`,
      [exchange, now],
    );
  } catch (error) {
    throw toSyncError(error, `清空 ${exchange} 凭据失败`);
  }
}

/**
 * 读出**明文**。**只给 executor**。
 *
 * 调用点必须能说清「我为什么需要明文」——目前唯一的合法理由是要拿它去签名
 * 交易所请求。任何控制面路径走到这里都是设计错误。
 */
export async function readCredentials(
  pool: Pool,
  masterKey: Buffer,
  exchange: string,
): Promise<{ apiKey: string; apiSecret: string } | null> {
  try {
    const result = await pool.query<Row>(
      `SELECT exchange, iv, auth_tag, ciphertext, key_hint, updated_at FROM ${TABLE}
       WHERE exchange = $1`,
      [exchange],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    // 被清空的行（key_hint 为空）视为「没有凭据」，否则会拿着空 IV 去解密然后抛一个
    // 让人摸不着头脑的认证标签错误。
    if (row.key_hint === '') return null;
    return openCredentials(
      {
        iv: asBuffer(row.iv),
        authTag: asBuffer(row.auth_tag),
        ciphertext: asBuffer(row.ciphertext),
      },
      masterKey,
    );
  } catch (error) {
    if (error instanceof SyncError) throw error;
    throw toSyncError(error, `读取 ${exchange} 凭据密文失败`);
  }
}
