/**
 * 周期任务装配（`startPeriodicTask`）。
 *
 * 它把三份复制品收成一份（移动止损 / 方案执行 / 对账）。这里锁的正是三份复制品
 * 曾经各自漂移的那几条：**启动即跑**、**防重入**、**失败不中断**、**stop 停表**、
 * **0 = 关闭**。
 */

import { describe, expect, it } from 'vitest';

import { startPeriodicTask } from '../src/periodic.js';

interface FakeTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

function fakeTimers(): { timers: FakeTimer[]; set: (fn: () => void, ms: number) => never } {
  const timers: FakeTimer[] = [];
  const set = (fn: () => void, ms: number): never => {
    timers.push({ fn, ms, cleared: false });
    return 0 as never;
  };
  return { timers, set };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('startPeriodicTask', () => {
  it('0 表示关闭：不建定时器、不跑首轮，stop 是空操作', async () => {
    const { timers, set } = fakeTimers();
    let ran = 0;
    const task = startPeriodicTask({
      intervalMs: 0,
      label: '测试',
      disabledMessage: '已关闭',
      enabledMessage: () => '已启用',
      tick: async () => {
        ran += 1;
      },
      setIntervalImpl: set,
    });

    await flush();
    expect(ran).toBe(0);
    expect(timers).toHaveLength(0);
    expect(() => task.stop()).not.toThrow();
  });

  it('启动立刻跑一次，之后按间隔跑', async () => {
    const { timers, set } = fakeTimers();
    let ran = 0;
    const task = startPeriodicTask({
      intervalMs: 1_000,
      label: '测试',
      disabledMessage: '已关闭',
      enabledMessage: () => '已启用',
      tick: async () => {
        ran += 1;
      },
      setIntervalImpl: set,
    });

    await flush();
    expect(ran).toBe(1);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(1_000);

    timers[0]?.fn();
    await flush();
    expect(ran).toBe(2);

    task.stop();
  });

  it('上一轮没跑完时跳过这一轮（不并发）', async () => {
    const { timers, set } = fakeTimers();
    let ran = 0;
    let release: (() => void) | undefined;
    startPeriodicTask({
      intervalMs: 1_000,
      label: '测试',
      disabledMessage: '已关闭',
      enabledMessage: () => '已启用',
      tick: async () => {
        ran += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      setIntervalImpl: set,
    });

    await flush();
    expect(ran).toBe(1);
    timers[0]?.fn();
    await flush();
    expect(ran).toBe(1); // 被跳过

    release?.();
    await flush();
    timers[0]?.fn();
    await flush();
    expect(ran).toBe(2);
  });

  it('一轮失败只记日志，下一轮照常跑', async () => {
    const { timers, set } = fakeTimers();
    let ran = 0;
    let failNext = true;
    startPeriodicTask({
      intervalMs: 1_000,
      label: '测试',
      disabledMessage: '已关闭',
      enabledMessage: () => '已启用',
      tick: async () => {
        ran += 1;
        if (failNext) {
          failNext = false;
          throw new Error('一次性抖动');
        }
      },
      setIntervalImpl: set,
    });

    await flush();
    timers[0]?.fn();
    await flush();
    expect(ran).toBe(2);
  });

  it('stop 调用的就是注入的 clearInterval', async () => {
    const cleared: unknown[] = [];
    const task = startPeriodicTask({
      intervalMs: 1_000,
      label: '测试',
      disabledMessage: '已关闭',
      enabledMessage: () => '已启用',
      tick: async () => undefined,
      setIntervalImpl: (() => 42 as unknown as NodeJS.Timeout) as never,
      clearIntervalImpl: ((handle: NodeJS.Timeout) => {
        cleared.push(handle);
      }) as never,
    });

    task.stop();
    expect(cleared).toEqual([42]);
  });
});
