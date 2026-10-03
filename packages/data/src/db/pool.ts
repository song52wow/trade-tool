import pg from 'pg';

import { SyncError, type DatabaseConfig } from '@trade-tool/core';

import { toSyncError } from './errors.js';

/**
 * PG 连接池（R-20.7）。
 *
 * - 密码**只从环境变量读取**，配置文件里只存变量名（R-13 database 段）。
 * - 池上限与并发标的数、批大小一并配置：多标的并发时连接耗尽是常见故障。
 * - 所有时间戳按 **毫秒** 往返：pg 默认把 int8 当字符串返回，这里统一转成 number，
 *   让「跨语言契约 = 毫秒」在读侧也成立。
 */

const { Pool } = pg;
export type { PoolClient, QueryResult, QueryResultRow } from 'pg';
export type Pool = pg.Pool;

/** 环境变量名可覆盖（测试用），默认 TRADE_TOOL_PG_PASSWORD。 */
export function resolvePassword(
  config: DatabaseConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[config.passwordEnv];
  if (value === undefined || value === '') {
    throw new SyncError(
      'CONFIG_INVALID',
      `数据库密码缺失：请通过环境变量 ${config.passwordEnv} 注入（不得写入配置文件）`,
      { passwordEnv: config.passwordEnv },
    );
  }
  return value;
}

export interface ConnectionOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  max: number;
  connectionTimeoutMillis: number;
  ssl?: boolean;
  /** 测试隔离用：限定 search_path 到指定 schema */
  searchPath?: string | undefined;
}

/**
 * 合并默认连接参数与覆盖项。
 *
 * 密码解析是**惰性**的：只有当调用方没有显式提供 `password` 时才去读环境变量。
 * 否则「程序化传密码」的用法（测试、嵌入式）会被一个它并不需要的环境变量卡住。
 */
export function connectionOptions(
  config: DatabaseConfig,
  overrides: Partial<ConnectionOptions> = {},
  env: NodeJS.ProcessEnv = process.env,
): ConnectionOptions {
  const base: Omit<ConnectionOptions, 'password'> = {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    max: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    ssl: config.ssl,
  };
  const password = overrides.password ?? resolvePassword(config, env);
  return { ...base, ...overrides, password };
}

/**
 * libpq 连接串的值转义。
 *
 * 值里出现空格、`=` 或引号时必须用单引号包起来（反斜杠转义单引号），
 * 否则 libpq 会把 `-c search_path=foo` 拆成两个选项而报「requires a value」。
 */
function quoteValue(value: string): string {
  if (!/[\s'"\\]/.test(value)) return value;
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * 构造 libpq 连接串，供 Python 侧经 `TRADE_TOOL_PG_DSN` 环境变量使用。
 * 不作为命令行参数传递，避免密码出现在进程列表里。
 */
export function buildDsn(options: ConnectionOptions): string {
  const parts = [
    `host=${quoteValue(options.host)}`,
    `port=${options.port}`,
    `dbname=${quoteValue(options.database)}`,
    `user=${quoteValue(options.user)}`,
    `password=${quoteValue(options.password)}`,
  ];
  if (options.ssl) parts.push('sslmode=require');
  if (options.searchPath) {
    // options 需要整体作为一个值，内部的空格必须靠引号保护。
    parts.push(`options=${quoteValue(`-c search_path=${options.searchPath}`)}`);
  }
  return parts.join(' ');
}

export interface CreatePoolOptions {
  /** 覆盖默认连接参数（测试用临时库 / 临时 schema） */
  overrides?: Partial<ConnectionOptions>;
  env?: NodeJS.ProcessEnv;
}

export function createPool(config: DatabaseConfig, options: CreatePoolOptions = {}): pg.Pool {
  const resolved = connectionOptions(config, options.overrides ?? {}, options.env ?? process.env);
  const pool = new Pool({
    host: resolved.host,
    port: resolved.port,
    database: resolved.database,
    user: resolved.user,
    password: resolved.password,
    max: resolved.max,
    connectionTimeoutMillis: resolved.connectionTimeoutMillis,
    ...(resolved.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    ...(resolved.searchPath ? { options: `-c search_path=${resolved.searchPath}` } : {}),
  });
  // 池自身的错误（如空闲连接被服务端断开）必须有监听器，否则会变成 unhandled rejection。
  pool.on('error', (error) => {
    // eslint-disable-next-line no-console
    console.error(`[data:pg] idle client error: ${error.message}`);
  });
  return pool;
}

/** 探活。连不上必须抛 `DB_CONNECTION_FAILED`，不得静默继续（R-14.5）。 */
export async function assertConnected(pool: pg.Pool): Promise<void> {
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    const classified = toSyncError(error, 'PostgreSQL 连接失败');
    throw classified;
  }
}

/** 把 pg 的 unknown 形状规整成 `Record<string, unknown>`，便于往 SyncError.details 里塞。 */
export function rowToRecord(row: pg.QueryResultRow): Record<string, unknown> {
  return { ...row };
}
