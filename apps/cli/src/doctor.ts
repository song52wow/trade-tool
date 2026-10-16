import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  describeClockSkew,
  loadConfigOrDefault,
  loadProjectEnv,
  parseSecretKey,
  SECRET_KEY_ENV,
} from '@trade-tool/core';
import {
  BinancePrivateClient,
  buildContext,
  createPool,
  exchangeEndpointsFromEnv,
  resolveActiveCredentials,
} from '@trade-tool/data';

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

/**
 * 时钟探针。
 *
 * 它与前四个工具链探针**性质不同**：那四个坏掉只是「不能开发」，这一个坏掉是
 * 「所有私有接口调用都会 -1021」——挂单、撤单、对账全在里面，而且报错长得
 * 跟网络故障一模一样。所以单独列出来，并且**即使探不到也算失败**：
 * 缺凭据 / 缺库 与「时钟偏了」同样意味着现在不该下单。
 */
async function probeClock(): Promise<ProbeResult> {
  loadProjectEnv();
  let pool: ReturnType<typeof createPool> | undefined;
  try {
    const config = await loadConfigOrDefault();
    pool = createPool(config.database);
    const ctx = buildContext(pool, config);
    const credentials = await resolveActiveCredentials({
      pool,
      masterKey: parseSecretKey(process.env[SECRET_KEY_ENV] ?? ''),
      exchange: ctx.exchange,
      apiKeyEnv: config.executor.apiKeyEnv,
      apiSecretEnv: config.executor.apiSecretEnv,
    });
    const client = new BinancePrivateClient({
      credentials,
      ...exchangeEndpointsFromEnv(config.executor),
      recvWindowMs: config.executor.recvWindowMs,
    });
    const skew = await client.measureClockSkew();
    return { name: 'clock', ok: true, detail: describeClockSkew(skew) };
  } catch (error) {
    return {
      name: 'clock',
      ok: false,
      detail: (error as Error).message.split('\n')[0] ?? 'unknown',
    };
  } finally {
    await pool?.end().catch(() => undefined);
  }
}

/** doctor：把「双轨环境是否就绪」一次性摊开，避免第一次跑命令就踩坑。 */
export async function collectDiagnostics(): Promise<ProbeResult[]> {
  return Promise.all([
    probe('node', process.execPath, ['-v']),
    probe('pnpm', 'pnpm', ['-v']),
    probe('uv', 'uv', ['--version']),
    probe('git', 'git', ['--version']),
    probeClock(),
  ]);
}
