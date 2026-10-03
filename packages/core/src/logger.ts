export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  child(scope: string): Logger;
}

function threshold(): number {
  const raw = (process.env.LOG_LEVEL ?? 'info') as LogLevel;
  return ORDER[raw] ?? ORDER.info;
}

function emit(level: LogLevel, scope: string | undefined, message: string, args: unknown[]): void {
  if (ORDER[level] < threshold()) return;
  const prefix = scope ? `[${scope}]` : '';
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${prefix} ${message}`;
  // stderr 保持机器可读输出（CLI 的 stdout 用于 JSON 结果）
  if (level === 'error' || level === 'warn') console.error(line, ...args);
  else console.log(line, ...args);
}

export function createLogger(scope?: string): Logger {
  return {
    debug: (m, ...a) => emit('debug', scope, m, a),
    info: (m, ...a) => emit('info', scope, m, a),
    warn: (m, ...a) => emit('warn', scope, m, a),
    error: (m, ...a) => emit('error', scope, m, a),
    child: (child: string) => createLogger(scope ? `${scope}:${child}` : child),
  };
}

export const logger = createLogger('trade-tool');
