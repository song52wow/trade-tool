import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createLogger, SyncError, type SyncErrorCode } from '@trade-tool/core';

const execFileAsync = promisify(execFile);
const log = createLogger('data:bridge');

export type PythonRuntime = 'uv' | 'python3';

export interface RunPythonOptions {
  runtime: PythonRuntime;
  /** python 模块名，如 quant_data */
  module: string;
  /** 传给 python -m <module> 之后的参数 */
  args?: readonly string[];
  timeoutMs?: number;
  /** python workspace 目录，默认 <repo>/python */
  projectDir?: string;
  cwd?: string;
  /** 额外环境变量。PG DSN 等敏感值只走这里，不进 argv。 */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Python 侧失败时 stderr 最后一行的固定前缀，后跟一个紧凑 JSON。
 * 之所以用固定前缀而不是「解析整个 stderr」：stderr 混有日志行，
 * 固定标记让错误契约与日志内容解耦。
 */
const PYTHON_ERROR_PREFIX = 'QUANT_DATA_ERROR ';

/** maxBuffer 现在只承载**小摘要**（行数 / 时间范围 / 状态码），不再是数据量的约束（R-2.2）。 */
const SUMMARY_BUFFER_BYTES = 4 * 1024 * 1024;

export interface PythonErrorPayload {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

function parsePythonError(stderr: string): PythonErrorPayload | null {
  const lines = stderr.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? '').trim();
    if (!line.startsWith(PYTHON_ERROR_PREFIX)) continue;
    try {
      const parsed = JSON.parse(line.slice(PYTHON_ERROR_PREFIX.length)) as PythonErrorPayload;
      if (typeof parsed.code === 'string') return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

/** 自当前文件向上找到 pnpm-workspace.yaml，定位 monorepo 根目录。 */
export function findRepoRoot(from: string = fileURLToPath(import.meta.url)): string {
  let dir = from;
  for (let i = 0; i < 8; i += 1) {
    const parent = dirname(dir);
    if (existsSync(resolve(parent, 'pnpm-workspace.yaml'))) return parent;
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('未能定位 monorepo 根目录（未找到 pnpm-workspace.yaml）');
}

export function resolvePythonDir(options: Partial<RunPythonOptions> = {}): string {
  if (options.projectDir) return options.projectDir;
  const fromEnv = process.env.TRADE_TOOL_PYTHON_DIR;
  if (fromEnv && fromEnv.trim() !== '') return resolve(process.cwd(), fromEnv);
  return resolve(findRepoRoot(), 'python');
}

/** runtime -> 实际可执行命令。uv 负责装依赖，python3 用于已激活 venv 的场景。 */
function buildCommand(options: RunPythonOptions): { file: string; args: string[] } {
  const moduleArgs = ['-m', options.module, ...(options.args ?? [])];
  if (options.runtime === 'uv') {
    return {
      file: 'uv',
      args: ['run', '--project', resolvePythonDir(options), '--quiet', 'python', ...moduleArgs],
    };
  }
  return { file: 'python3', args: moduleArgs };
}

export interface PythonResult<T> {
  value: T;
  /** 子进程 stdout 原文，调试用 */
  stdout: string;
}

/**
 * 调用 python 侧模块并把 stdout 当作单个 JSON 文档解析。
 * 约定：python 侧只把结构化结果写 stdout，日志一律写 stderr。
 *
 * 失败时优先还原 Python 侧的结构化错误码（`QUANT_DATA_ERROR` 行），
 * 抛出的仍是 `SyncError`，因此错误码能一路传到 CLI 的 stderr 与控制面（R-22.4）。
 */
export async function runPython<T>(options: RunPythonOptions): Promise<PythonResult<T>> {
  const { file, args } = buildCommand(options);
  const cwd = options.cwd ?? findRepoRoot();
  log.debug(`spawn ${file} ${args.join(' ')}`);
  try {
    const { stdout } = await execFileAsync(file, args, {
      cwd,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: SUMMARY_BUFFER_BYTES,
      env: { ...process.env, ...options.env },
    });
    return { value: JSON.parse(stdout) as T, stdout };
  } catch (error) {
    const err = error as { stderr?: string; message: string; code?: unknown };
    const stderr = err.stderr ?? '';
    const payload = parsePythonError(stderr);

    if (payload) {
      throw new SyncError(payload.code as SyncErrorCode, payload.message, payload.details ?? {});
    }
    if (err.code === 'ETIMEDOUT' || err.code === 'SIGTERM') {
      throw new SyncError(
        'NETWORK_ERROR',
        `python 子进程超时（${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms）：${file} ${args.join(' ')}`,
        { argv: args },
      );
    }
    const trimmed = stderr.trim();
    throw new SyncError(
      'INTERNAL_ERROR',
      `python 调用失败 (${file} ${args.join(' ')})${trimmed ? `:\n${trimmed}` : `: ${err.message}`}`,
      { argv: args },
    );
  }
}
