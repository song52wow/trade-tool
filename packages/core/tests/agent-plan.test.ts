/**
 * 执行方案的可执行性判据（`packages/core/src/agent-plan.ts`）。
 *
 * 这条判据要出现在**四个地方**：agent 的自动批准、控制面的人工批准、
 * 命令行的人工批准、executor 的兜底检查。四处各写一遍的话，迟早有一处忘了改，
 * 而那一处恰好就是「批了一份永远执行不了的方案」的地方——
 * 它会永远卡在「已批准」，每轮被捞出来又跳过，而页面上显示「等 executor 消费」，
 * 看上去像是有一单在等着下。
 *
 * 所以判据只有这一份，四处共用（§5 第 5 条：同一概念只有一个名字）。
 * **这里就是它的守门人**：四处任何一处改了口径，这里就该红。
 */

import { describe, expect, it } from 'vitest';

import {
  assertApprovable,
  autoExecutableProblem,
  isAutoExecutable,
  LIMIT_ENTRY_UNSUPPORTED,
} from '../src/index.js';

describe('可执行性判据', () => {
  it('市价进场 → 能执行', () => {
    expect(isAutoExecutable('market')).toBe(true);
    expect(autoExecutableProblem('market')).toBeNull();
  });

  it('限价进场 → 不能执行，且说清为什么、怎么办', () => {
    expect(isAutoExecutable('limit')).toBe(false);
    const problem = autoExecutableProblem('limit');
    expect(problem).toBe(LIMIT_ENTRY_UNSUPPORTED);
    // 原因必须说清**后果**（不成交 → 没止损保护）与**怎么办**（改市价 / 手动下单）。
    expect(problem).toContain('不成交');
    expect(problem).toContain('止损保护');
    expect(problem).toContain('市价');
  });

  it('没有进场方式 → 不能执行（残缺的方案）', () => {
    expect(isAutoExecutable(null)).toBe(false);
    expect(autoExecutableProblem(null)).not.toBeNull();
  });

  it('「这一轮不做」/「出不了方案」→ 不能执行', () => {
    expect(isAutoExecutable('market', 'hold')).toBe(false);
    expect(isAutoExecutable('market', 'failed')).toBe(false);
    expect(autoExecutableProblem('market', 'hold')).toContain('这一轮不做');
    expect(autoExecutableProblem('market', 'failed')).toContain('出不了方案');
  });

  it('四处共用的是同一句话（措辞不会各写一份而漂移）', () => {
    // 这条锁的是「同一个概念只有一个名字」（§5 第 5 条）：
    // 四处拿到的必须是**同一个字符串**，不是四个意思相近但措辞不同的版本。
    expect(autoExecutableProblem('limit')).toBe(LIMIT_ENTRY_UNSUPPORTED);
  });
});

describe('人工批准的检查（控制面与命令行共用）', () => {
  it('市价方案 → 放行', () => {
    expect(() =>
      assertApprovable({ planId: '1', entryType: 'market', action: 'enter' }),
    ).not.toThrow();
  });

  it('限价方案 → 拒绝，并说清为什么', () => {
    // 这是「该修 3」要守住的那条：把限价判断删掉，这条用例就该红。
    expect(() =>
      assertApprovable({ planId: '42', entryType: 'limit', action: 'enter' }),
    ).toThrowError(/限价进场暂不支持自动执行/);
  });

  it('「这一轮不做」/「出不了方案」→ 拒绝', () => {
    expect(() =>
      assertApprovable({ planId: '1', entryType: 'market', action: 'hold' }),
    ).toThrowError(/这一轮不做/);
    expect(() =>
      assertApprovable({ planId: '1', entryType: 'market', action: 'failed' }),
    ).toThrowError(/出不了方案/);
  });

  it('错误码是 CONFIG_INVALID（控制面据此回 400）', () => {
    try {
      assertApprovable({ planId: '42', entryType: 'limit', action: 'enter' });
      throw new Error('不该通过');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('CONFIG_INVALID');
    }
  });
});
