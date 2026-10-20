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
  readNotifyStatus,
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

/**
 * 通知探针。
 *
 * 它回答一个很具体的问题：「我以为告警在推，真的在推吗？」
 * `notify.enabled = true` 却没配 webhook 地址 = 告警**从来没发出去过**，
 * 而对账与止盈止损照跑不误，日志里也一切正常——这正是要靠一个显式探针挡住的。
 *
 * 它读的是**真实生效的那一档**（控制面录入优先，配置文件 + 环境变量兜底），
 * 因此控制面改过设置之后，doctor 说的仍然是现在真正在用的那一份。
 */
async function probeNotify(): Promise<ProbeResult> {
  loadProjectEnv();
  let pool: ReturnType<typeof createPool> | undefined;
  try {
    const config = await loadConfigOrDefault();
    pool = createPool(config.database);
    // 主密钥没注入就读不到控制面录入的那一份——如实按「读不到」处理，不当成「没配」。
    const masterKey = (() => {
      try {
        return parseSecretKey(process.env[SECRET_KEY_ENV]);
      } catch {
        return null;
      }
    })();
    const status = await readNotifyStatus({ pool, masterKey, config: config.notify });
    const from = status.source === 'panel' ? '控制面录入' : `配置文件 + 环境变量`;
    const address = status.configured ? `末 4 位 ${status.hint ?? '—'}` : '无地址';
    if (status.enabled && !status.configured) {
      return {
        name: 'notify',
        ok: false,
        detail: `已启用但没有 webhook 地址（来源：${from}）——告警发不出去`,
      };
    }
    return {
      name: 'notify',
      ok: true,
      detail: `${status.enabled ? '已启用' : '未启用'}（来源：${from}，${address}）`,
    };
  } catch (error) {
    return {
      name: 'notify',
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
    probeNotify(),
  ]);
}
