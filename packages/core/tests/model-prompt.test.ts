/**
 * 提示词镜像的纯函数（`packages/core/src/model-prompt.ts`）。
 *
 * 锁住三件事：
 *
 * 1. **逐字**：镜像出来的正文就是**真正发出去的那一组消息**，不是重新拼的。
 * 2. **截断要看得见**：超长时必须写明截了多少——悄悄截掉一半，比不发更坏
 *    （人会以为那就是模型看见的全貌）。
 * 3. **默认不勾**：两种提示词镜像是全部通知内容里**唯二默认关闭**的
 *    （提示词里带着行情与账户权益）。
 */

import { describe, expect, it } from 'vitest';

import {
  AGENT_SYSTEM_MESSAGE,
  DEFAULT_NOTIFY_KINDS,
  MAX_AGENT_PROMPT_CHARS,
  NOTIFY_KINDS,
  PROMPT_MIRROR_KINDS,
  PROMPT_SOURCE_INFO,
  buildPromptEvent,
  truncateAgentPrompt,
} from '../src/index.js';

describe('提示词截断', () => {
  it('没超长：原样返回，不加任何标记', () => {
    const prompt = '短提示词';
    const result = truncateAgentPrompt(prompt);
    expect(result.text).toBe(prompt);
    expect(result.truncated).toBe(false);
    expect(result.originalChars).toBe(prompt.length);
  });

  it('超长：截断后总长不超过上限，且**写明**截了多少', () => {
    const prompt = '甲'.repeat(MAX_AGENT_PROMPT_CHARS + 500);
    const result = truncateAgentPrompt(prompt);
    expect(result.truncated).toBe(true);
    expect(result.originalChars).toBe(prompt.length);
    // 总长不许超：飞书卡片请求体有 30 KB 上限
    expect(result.text.length).toBeLessThanOrEqual(MAX_AGENT_PROMPT_CHARS);
    // **必须看得见**：不然人以为那就是模型看见的全貌
    expect(result.text).toContain('已截断');
    expect(result.text).toContain(String(prompt.length));
  });

  it('超长：正文真的是原文的前缀（不是重排或改写）', () => {
    const prompt = `头${'甲'.repeat(9000)}尾`;
    const result = truncateAgentPrompt(prompt);
    expect(result.text.startsWith('头')).toBe(true);
    expect(result.text.startsWith(prompt.slice(0, 50))).toBe(true);
    // 结尾那句「原文共 N 字」是**后加的**，不在原文里
    expect(result.text.endsWith('）')).toBe(true);
  });

  it('切在代理对中间也不发乱码：不会留下落单的高位代理元', () => {
    // 前面放一个汉字，让 emoji 的起点落在**奇数**下标上——
    // 于是切点（偶数长度）大概率落在某个代理对的中间。
    const prompt = `甲${'😀'.repeat(MAX_AGENT_PROMPT_CHARS)}`;
    const result = truncateAgentPrompt(prompt);
    expect(result.truncated).toBe(true);
    const head = result.text.split('\n…（已截断')[0] ?? '';
    // 落单的高位代理元（后面没有配对的低位代理元）
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(head)).toBe(false);
    // 落单的低位代理元（前面没有配对的高位代理元）
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(head)).toBe(false);
  });
});

describe('提示词 → 通知', () => {
  const messages = [AGENT_SYSTEM_MESSAGE, { role: 'user' as const, content: '用户提示正文' }];

  it('标题说清「哪个标的、谁发的」——飞书只显示标题', () => {
    const event = buildPromptEvent({
      source: 'agent-analyst',
      symbol: 'TESTUSDT',
      messages,
    });
    expect(event.title).toContain('TESTUSDT');
    expect(event.title).toContain(PROMPT_SOURCE_INFO['agent-analyst'].label);
  });

  it('正文是**真正发出去的那一组消息**，逐字不差', () => {
    const event = buildPromptEvent({
      source: 'agent-trader',
      symbol: 'TESTUSDT',
      messages,
    });
    const body = event.lines?.[0] ?? '';
    expect(body).toContain(AGENT_SYSTEM_MESSAGE.content);
    expect(body).toContain('用户提示正文');
    // 两段之间要有分隔，不能糊成一段
    expect(body).toContain('\n\n');
  });

  it('脚注写明原文多少字', () => {
    const event = buildPromptEvent({
      source: 'agent-analyst',
      symbol: 'TESTUSDT',
      messages,
    });
    expect(event.footer).toContain('字');
  });

  it('超长时正文里带「已截断」', () => {
    const long = [{ role: 'user' as const, content: '甲'.repeat(MAX_AGENT_PROMPT_CHARS * 2) }];
    const event = buildPromptEvent({
      source: 'agent-analyst',
      symbol: 'TESTUSDT',
      messages: long,
    });
    expect(event.lines?.[0] ?? '').toContain('已截断');
  });

  it('三种来源各归属一种勾选项', () => {
    // Agent 的两条都归 'agent-prompt'，executor 的那条归 'decision-prompt'
    expect(PROMPT_SOURCE_INFO['agent-analyst'].kind).toBe('agent-prompt');
    expect(PROMPT_SOURCE_INFO['agent-trader'].kind).toBe('agent-prompt');
    expect(PROMPT_SOURCE_INFO['executor-decision'].kind).toBe('decision-prompt');
  });
});

describe('提示词镜像是唯二默认不勾的', () => {
  it('在可选清单里，但不在默认集合里', () => {
    for (const kind of PROMPT_MIRROR_KINDS) {
      expect(NOTIFY_KINDS).toContain(kind);
      expect(DEFAULT_NOTIFY_KINDS).not.toContain(kind);
    }
  });

  it('默认集合的其余部分与可选清单一致（只差这两种）', () => {
    expect([...DEFAULT_NOTIFY_KINDS].sort()).toEqual(
      NOTIFY_KINDS.filter((kind) => !PROMPT_MIRROR_KINDS.includes(kind as never)).sort(),
    );
  });
});
