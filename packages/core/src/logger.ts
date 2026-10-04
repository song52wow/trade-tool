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
  // 日志**一律**走 stderr：stdout 只放命令结果，`--json` 时必须是纯 JSON
  // （AGENTS.md 与 apps/cli/README.md 都写明「日志走 stderr」，Python 侧 quant_core.io.log 也是这么做的）。
  // 早期把 info/debug 走 console.log 会让 `data fetch` 这类命令的 stdout 先出现一行日志，
  // `... --json | jq` 直接解析失败——日志污染了机器可读输出。
  console.error(line, ...args);
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
