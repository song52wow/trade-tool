import { SyncError } from '@trade-tool/core';
import { describe, expect, it } from 'vitest';

import { JobRegistry, type JobRunnerOptions } from '../src/jobs.js';

const T0 = 1_760_000_000_000;

/**
 * sleep 必须让出**宏任务**（setTimeout），不能只 resolve 一个微任务：
 * 进度轮询是 `while(true) { await sample(); await sleep(); }`，若 sleep 只走微任务，
 * 事件循环永远轮不到定时器，整个进程（连测试的等待）都会被饿死。
 * 反过来也不能是 0ms 的热循环——那会把事件循环挤满，测试自身的定时器也排不上。
 */
const TEST_POLL_MS = 5;

function harness(overrides: Partial<JobRunnerOptions> = {}): {
  registry: JobRegistry;
  calls: string[];
  ticks: { count: number };
} {
  const calls: string[] = [];
  const ticks = { count: 0 };
  const registry = new JobRegistry({
    runFull: async (symbol) => {
      calls.push(`runFull:${symbol}`);
      return { added: 3 };
    },
    runVerify: async (symbol) => {
      calls.push(`runVerify:${symbol}`);
      return { scanned: 10 };
    },
    runAggregate: async (symbol) => {
      calls.push(`runAggregate:${symbol}`);
      return { upserted: 5 };
    },
    readProgress: async () => ({ rows: 42, pendingGaps: 1 }),
    isDaemonOwned: async () => false,
    now: () => T0,
    sleep: () => {
      ticks.count += 1;
      return new Promise((r) => setTimeout(r, TEST_POLL_MS));
    },
    pollIntervalMs: TEST_POLL_MS,
    idFactory: (() => {
      let n = 0;
      return () => `job-${(n += 1)}`;
    })(),
    ...overrides,
  });
  return { registry, calls, ticks };
}

/**
 * 等作业走完整个收尾流程。判据用 `finishedAt !== null` 而不是 `status !== 'running'`：
 * 作业是先释放占用、最后才翻 status 的，所以 finishedAt 才是「彻底可复用」的信号。
 */
async function settle(registry: JobRegistry, id: string): Promise<ReturnType<JobRegistry['get']>> {
  for (let i = 0; i < 600; i += 1) {
    const job = registry.get(id);
    if (job && job.finishedAt !== null) return job;
    await new Promise((r) => setTimeout(r, TEST_POLL_MS));
  }
  throw new Error(`作业 ${id} 未在预期时间内结束`);
}

describe('JobRegistry', () => {
  it('start 立即返回，作业在后台跑', async () => {
    const { registry, calls } = harness();

    const job = await registry.start({ kind: 'full', symbol: 'AAAUSDT', target: 100 });

    expect(job.status).toBe('running');
    expect(job.progress.target).toBe(100);
    // 返回时作业可能还没跑完，但登记已经生效
    expect(calls).toContain('runFull:AAAUSDT');
    const done = await settle(registry, job.id);
    expect(done?.status).toBe('succeeded');
    expect(done?.result).toEqual({ added: 3 });
  });

  it('verify 走另一个执行体', async () => {
    const { registry, calls } = harness();

    const job = await registry.start({ kind: 'verify', symbol: 'AAAUSDT' });
    const done = await settle(registry, job.id);

    expect(calls).toEqual(['runVerify:AAAUSDT']);
    expect(done?.result).toEqual({ scanned: 10 });
  });

  it('进度从 sync_state 重读，而不是内存计数', async () => {
    let rows = 0;
    const { registry } = harness({
      readProgress: async () => {
        rows += 10;
        return { rows, pendingGaps: 0 };
      },
    });

    const job = await registry.start({ kind: 'full', symbol: 'AAAUSDT', target: 100 });
    const done = await settle(registry, job.id);

    // 结束时至少采过一次，且末值是最新一次读到的
    expect(done?.progress.rows).toBeGreaterThan(0);
    expect(done?.progress.target).toBe(100);
  });

  it('同一标的已有作业时拒绝再开，并报 SYNC_ALREADY_RUNNING', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { registry } = harness({
      runFull: async () => {
        await gate;
        return {};
      },
    });

    const first = await registry.start({ kind: 'full', symbol: 'AAAUSDT' });

    await expect(registry.start({ kind: 'full', symbol: 'AAAUSDT' })).rejects.toMatchObject({
      code: 'SYNC_ALREADY_RUNNING',
    });

    release();
    await settle(registry, first.id);
  });

  it('标的归守护进程所有时拒绝接管，并提示先 pause', async () => {
    const { registry } = harness({ isDaemonOwned: async () => true });

    await expect(registry.start({ kind: 'full', symbol: 'AAAUSDT' })).rejects.toThrow(/pause/);
  });

  it('不同标的可以并行', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { registry } = harness({
      runFull: async () => {
        await gate;
        return {};
      },
    });

    const a = await registry.start({ kind: 'full', symbol: 'AAAUSDT' });
    const b = await registry.start({ kind: 'full', symbol: 'BBBUSDT' });

    expect(registry.activeCount()).toBe(2);
    release();
    await settle(registry, a.id);
    await settle(registry, b.id);
  });

  it('执行体抛 SyncError 时作业记为 failed 并保留错误码', async () => {
    const { registry } = harness({
      runFull: async () => {
        throw new SyncError('GAP_ATTEMPTS_EXHAUSTED', '缺口回补超限', { symbol: 'AAAUSDT' });
      },
    });

    const job = await registry.start({ kind: 'full', symbol: 'AAAUSDT' });
    const done = await settle(registry, job.id);

    expect(done?.status).toBe('failed');
    expect(done?.error).toEqual({
      code: 'GAP_ATTEMPTS_EXHAUSTED',
      message: '[GAP_ATTEMPTS_EXHAUSTED] 缺口回补超限',
    });
    expect(done?.finishedAt).toBe(T0);
  });

  it('未知异常也记为 failed，不吞掉', async () => {
    const { registry } = harness({
      runFull: async () => {
        throw new TypeError('boom');
      },
    });

    const job = await registry.start({ kind: 'full', symbol: 'AAAUSDT' });
    const done = await settle(registry, job.id);

    expect(done?.status).toBe('failed');
    expect(done?.error?.code).toBe('INTERNAL_ERROR');
    expect(done?.error?.message).toBe('boom');
  });

  it('读进度失败不拖垮作业', async () => {
    const { registry } = harness({
      readProgress: async () => {
        throw new Error('pg 抖了一下');
      },
    });

    const job = await registry.start({ kind: 'full', symbol: 'AAAUSDT' });
    const done = await settle(registry, job.id);

    expect(done?.status).toBe('succeeded');
    expect(done?.progress.rows).toBeNull();
  });

  it('结束后释放该标的的占用，可以再开新作业', async () => {
    const { registry } = harness();

    const first = await registry.start({ kind: 'full', symbol: 'AAAUSDT' });
    await settle(registry, first.id);

    const second = await registry.start({ kind: 'full', symbol: 'AAAUSDT' });
    expect(second.status).toBe('running');
    await settle(registry, second.id);
  });

  it('list 按新到旧排列', async () => {
    const { registry } = harness();

    const a = await registry.start({ kind: 'full', symbol: 'AAAUSDT' });
    await settle(registry, a.id);
    const b = await registry.start({ kind: 'verify', symbol: 'BBBUSDT' });
    await settle(registry, b.id);

    expect(registry.list().map((j) => j.id)).toEqual([b.id, a.id]);
  });

  it('历史只保留最近若干条', async () => {
    const { registry } = harness({ historyLimit: 2 });

    for (const symbol of ['AAAUSDT', 'BBBUSDT', 'CCUSDT']) {
      const job = await registry.start({ kind: 'verify', symbol });
      await settle(registry, job.id);
    }

    expect(registry.list()).toHaveLength(2);
    expect(registry.get('job-1')).toBeNull();
  });
});
