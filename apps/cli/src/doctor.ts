import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function probe(name: string, file: string, args: string[]): Promise<ProbeResult> {
  try {
    const { stdout } = await execFileAsync(file, args, { timeout: 20_000 });
    return { name, ok: true, detail: stdout.trim().split('\n')[0] ?? 'ok' };
  } catch (error) {
    return { name, ok: false, detail: (error as Error).message.split('\n')[0] ?? 'unknown error' };
  }
}

/** doctor：把「双轨环境是否就绪」一次性摊开，避免第一次跑命令就踩坑。 */
export async function collectDiagnostics(): Promise<ProbeResult[]> {
  return Promise.all([
    probe('node', process.execPath, ['-v']),
    probe('pnpm', 'pnpm', ['-v']),
    probe('uv', 'uv', ['--version']),
    probe('git', 'git', ['--version']),
  ]);
}
