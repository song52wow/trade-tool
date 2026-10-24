/**
 * 守护进程的测试（v1.0.0）。
 *
 * 锁的是三条**刻意的选择**（写在 `src/daemon.ts` 的文件头里，
 * 写在那儿就是为了「改的时候别顺手改掉」）：
 *
 *   1. **标的集合每轮重读** —— 控制面随时可能加标的。启动时读一次就固化，
 *      会让「刚加的标的永远没人分析」变成一件没人发现的事。
 *   2. **单个标的出错不影响其它标的** —— 一个标的的上下文取不到，
 *      不该让整轮剩下的人都不分析。
 *   3. **不并发** —— 一轮里按标的顺序跑，模型调用不会同时打出去。
 *
 * 外加两条停止语义：收到停止信号后不再开始新标的；循环能干净退出。
 */

import { agentSchema, type AgentConfig } from '@trade-tool/core';
import { describe, expect, it } from 'vitest';

import { createAgentDaemon, type AgentDaemon } from '../src/daemon.js';
import type { AgentRoundResult, AgentService } from '../src/service.js';

const CONFIG: AgentConfig = agentSchema.parse({ enabled: true, intervalMs: 60_000 });

/** 一条「成功」的轮次结果。 */
function ok(symbol: string): AgentRoundResult {
  return {
    symbol,
    report: null,
    reportId: '1',
    plan: null,
    planId: '2',
    failure: null,
  };
}

/**
 * 假服务：记录被分析的标的，可以指定某个标的抛错。
 */
function fakeService(options: { failing?: string[] } = {}): {
  service: AgentService;
  analyzed: string[];
} {
  const analyzed: string[] = [];
  const failing = new Set(options.failing ?? []);
  const service: AgentService = {
    analyzeSymbol: async (symbol: string) => {
      analyzed.push(symbol);
      if (failing.has(symbol)) throw new Error(`${symbol} 的上下文取不到`);
      return ok(symbol);
    },
  };
  return { service, analyzed };
}

describe('Agent 守护进程', () => {
  it('一轮按顺序跑完所有标的（不并发）', async () => {
    const { service, analyzed } = fakeService();
    const daemon = createAgentDaemon({
      service,
      config: CONFIG,
      listSymbols: async () => ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'],
    });

    const results = await daemon.tick();

    expect(results.map((r) => r.symbol)).toEqual(['AAAUSDT', 'BBBUSDT', 'CCCUSDT']);
    // 顺序跑：调用次序就是标的次序，不是一个 Promise.all
    expect(analyzed).toEqual(['AAAUSDT', 'BBBUSDT', 'CCCUSDT']);
  });

  it('标的集合每轮重读：第二轮能看见新加的标的', async () => {
    const { service, analyzed } = fakeService();
    let round = 0;
    const daemon = createAgentDaemon({
      service,
      config: CONFIG,
      listSymbols: async () => {
        round += 1;
        return round === 1 ? ['AAAUSDT'] : ['AAAUSDT', 'NEWUSDT'];
      },
    });

    await daemon.tick();
    await daemon.tick();

    expect(analyzed).toEqual(['AAAUSDT', 'AAAUSDT', 'NEWUSDT']);
  });

  it('单个标的出错不影响其它标的', async () => {
    const { service, analyzed } = fakeService({ failing: ['BBBUSDT'] });
    const daemon = createAgentDaemon({
      service,
      config: CONFIG,
      listSymbols: async () => ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'],
    });

    const results = await daemon.tick();

    // 出错的标的没产出结果，**其余两个照跑完了**
    expect(results.map((r) => r.symbol)).toEqual(['AAAUSDT', 'CCCUSDT']);
    expect(analyzed).toEqual(['AAAUSDT', 'BBBUSDT', 'CCCUSDT']);
  });

  it('一个标的都没有：返回空数组并留下警告（不是静默跳过）', async () => {
    const { service, analyzed } = fakeService();
    const daemon = createAgentDaemon({
      service,
      config: CONFIG,
      listSymbols: async () => [],
    });

    const results = await daemon.tick();

    expect(results).toEqual([]);
    expect(analyzed).toEqual([]);
  });

  it('stop() 之后不再开始新的标的', async () => {
    const { service, analyzed } = fakeService();
    let daemon: AgentDaemon;
    daemon = createAgentDaemon({
      service,
      config: CONFIG,
      // 第一个标的跑完就请求停止
      listSymbols: async () => ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'],
      sleep: async () => {
        await daemon.stop();
      },
    });

    // 直接在 tick 之前停掉：整轮都不该开始
    await daemon.stop();
    const results = await daemon.tick();

    expect(results).toEqual([]);
    expect(analyzed).toEqual([]);
  });

  it('停止信号**不会砍断正在跑的那一轮**', async () => {
    // 这是进程退出路径上的关键保证：半轮（落了报告没落方案）是
    // 「看起来成功了，其实什么都没做」的一种——页面上会有一份报告，
    // 而与之对应的方案永远不会有。
    let analyzed: string[] = [];
    let daemon: AgentDaemon;
    // 不用 `let release: (() => void) | null = null`：赋值发生在回调里，
    // TypeScript 的控制流分析看不见，调用点会被收窄成 `never`。
    let releaseRound: () => void = () => undefined;
    const service: AgentService = {
      analyzeSymbol: async (symbol: string) => {
        analyzed.push(symbol);
        // 第一个标的卡住，直到用例放它走
        if (symbol === 'AAAUSDT') {
          await new Promise<void>((resolve) => {
            releaseRound = resolve;
          });
        }
        return ok(symbol);
      },
    };
    daemon = createAgentDaemon({
      service,
      config: CONFIG,
      listSymbols: async () => ['AAAUSDT', 'BBBUSDT'],
      sleep: async () => undefined,
    });

    const looping = daemon.start();
    // 等第一个标的真的开始跑
    await new Promise((r) => setTimeout(r, 10));
    await daemon.stop();
    // 放它走
    releaseRound();
    await looping;

    // 停信号之后**不再开始新标的**，但正在跑的那一个跑完了
    expect(analyzed).toEqual(['AAAUSDT']);
  });

  it('停止能打断休眠，不必等满 intervalMs', async () => {
    // 缺省 intervalMs 是 15 分钟：不打断的话，进程收到 SIGTERM 后
    // 要再等 15 分钟才退出，而进程管理器通常只给 10 秒宽限 → 实际被强杀。
    let daemon: AgentDaemon;
    let slept = 0;
    daemon = createAgentDaemon({
      service: fakeService().service,
      config: CONFIG,
      listSymbols: async () => ['AAAUSDT'],
      sleep: async () => {
        slept += 1;
        // 睡到天荒地老（测试里不等真的那么久）
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 3_600_000);
        });
      },
    });

    const looping = daemon.start();
    await new Promise((r) => setTimeout(r, 10));
    const stoppedAt = Date.now();
    await daemon.stop();
    await daemon.whenStopped();
    await looping;

    expect(slept).toBe(1);
    // 没有等满那一小时
    expect(Date.now() - stoppedAt).toBeLessThan(5_000);
  });

  it('whenStopped()：循环退出后才兑现', async () => {
    const { service } = fakeService();
    let daemon: AgentDaemon;
    let exited = false;
    daemon = createAgentDaemon({
      service,
      config: CONFIG,
      listSymbols: async () => ['AAAUSDT'],
      sleep: async () => {
        await daemon.stop();
      },
    });

    const looping = daemon.start();
    await daemon.whenStopped();
    exited = true;
    await looping;

    expect(exited).toBe(true);
  });

  it('循环按配置的间隔休眠，并能干净退出', async () => {
    const { service } = fakeService();
    const slept: number[] = [];
    let daemon: AgentDaemon;
    let rounds = 0;
    daemon = createAgentDaemon({
      service,
      config: CONFIG,
      listSymbols: async () => ['AAAUSDT'],
      sleep: async (ms: number) => {
        slept.push(ms);
        rounds += 1;
        // 跑两轮就停
        if (rounds >= 2) await daemon.stop();
      },
    });

    await daemon.start();

    // 两轮 → 两次休眠，间隔取自配置
    expect(slept).toEqual([CONFIG.intervalMs, CONFIG.intervalMs]);
  });
});
