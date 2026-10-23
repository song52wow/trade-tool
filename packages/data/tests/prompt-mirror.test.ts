/**
 * 提示词镜像的**运行时**（`packages/data/src/prompt-mirror.ts`）。
 *
 * 锁住四条口径：
 *
 * 1. **没勾就一次都不发**——不是「发了但没勾的样子」；
 * 2. **推送失败不影响主流程**：飞书挂了、通道配坏了，分析 / 挂单照跑
 *    （抛错会让「飞书不可用」变成「分析也停了」）；
 * 3. **但失败必须看得见**：只记日志，不静默（AGENTS.md 约定 9）；
 * 4. **通道每条提示词解析一次**：控制面改完设置不必重启进程。
 *
 * 以及**归属**：不同来源的提示词归不同的勾选项——
 * executor 的档位决策提示词**不会**因为勾了 Agent 的那项而被发出去。
 */

import { AGENT_SYSTEM_MESSAGE, PROMPT_SOURCE_INFO } from '@trade-tool/core';
import { describe, expect, it, vi } from 'vitest';

import { createPromptMirror, type PromptMirrorChannel } from '../src/prompt-mirror.js';

const SYMBOL = 'TESTUSDT';

function fakeChannel(options: { kinds?: readonly string[]; fail?: string } = {}) {
  const sent: { title: string; body: string }[] = [];
  const channel: PromptMirrorChannel = {
    notifier: {
      enabled: true,
      notify: async (event) => {
        if (options.fail !== undefined) throw new Error(options.fail);
        sent.push({ title: event.title, body: (event.lines ?? []).join('\n') });
      },
    },
    kinds: options.kinds ?? [PROMPT_SOURCE_INFO['agent-analyst'].kind],
  };
  return { channel, sent };
}

const INPUT = {
  symbol: SYMBOL,
  source: 'agent-analyst' as const,
  messages: [AGENT_SYSTEM_MESSAGE, { role: 'user' as const, content: '提示词正文' }],
};

describe('提示词镜像', () => {
  it('勾上了：把那一组消息发出去', async () => {
    const { channel, sent } = fakeChannel();
    const mirror = createPromptMirror({ resolveChannel: () => channel });

    await mirror.mirror(INPUT);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.title).toContain(SYMBOL);
    expect(sent[0]?.body).toContain('提示词正文');
  });

  it('没勾这一项：一次都不发', async () => {
    const { channel, sent } = fakeChannel({ kinds: ['bracket-armed'] });
    const mirror = createPromptMirror({ resolveChannel: () => channel });

    await mirror.mirror(INPUT);

    expect(sent).toHaveLength(0);
  });

  it('**归属是分开的**：勾了 Agent 的那项，不影响 executor 的那项', async () => {
    const { channel, sent } = fakeChannel({
      kinds: [PROMPT_SOURCE_INFO['agent-analyst'].kind],
    });
    const mirror = createPromptMirror({ resolveChannel: () => channel });

    await mirror.mirror({
      symbol: SYMBOL,
      source: 'executor-decision',
      messages: [{ role: 'user', content: '档位决策提示词' }],
    });

    expect(sent).toHaveLength(0);
  });

  it('没有通道（通知没启用）：什么都不做，也不报错', async () => {
    const mirror = createPromptMirror({ resolveChannel: () => null });

    await expect(mirror.mirror(INPUT)).resolves.toBeUndefined();
  });

  it('推送失败：不抛错（镜像坏了不该让主流程停下来），但要记日志', async () => {
    const { channel } = fakeChannel({ fail: '飞书连不上' });
    // 缺省 logger 就写 stderr（core 的 `createLogger`），直接盯着它
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mirror = createPromptMirror({ resolveChannel: () => channel });

    await expect(mirror.mirror(INPUT)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('通道本身配坏了（取通道就报错）：同样只记日志，不抛', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mirror = createPromptMirror({
      resolveChannel: () => {
        throw new Error('通知开着却没地址');
      },
    });

    await expect(mirror.mirror(INPUT)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('通道每条提示词解析一次（控制面改完下一条就生效）', async () => {
    let calls = 0;
    const { channel, sent } = fakeChannel();
    const mirror = createPromptMirror({
      resolveChannel: () => {
        calls += 1;
        return channel;
      },
    });

    await mirror.mirror(INPUT);
    await mirror.mirror(INPUT);

    expect(calls).toBe(2);
    expect(sent).toHaveLength(2);
  });
});
