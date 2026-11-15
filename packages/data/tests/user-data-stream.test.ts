/**
 * 用户数据流的连接纪律测试。**不出网**：WebSocket 是本地假实现。
 *
 * 锁三件事（2026-10-26 实测踩到的那次故障）：
 *
 * 1. **出错必须收口成「断开」**：Node 的 `WebSocket` 在代理掐断隧道时可能**只派发
 *    `error`、不派发 `close`**。重连若只挂在 `onClose` 上，那个 `await` 就永远不返回——
 *    进程活着、日志干净，但一个成交事件都收不到，新开的仓从此裸奔。
 * 2. **错误信息要能查**：`JSON.stringify(event)` 对 `ErrorEvent` 得到 `{}`，
 *    断在哪、为什么断一点线索都没有。
 * 3. **续期失败 = 这条流活不过 30 分钟**：它「看起来」还连着，因此必须主动收口。
 */

import { openUserDataStream } from '@trade-tool/data';
import { describe, expect, it } from 'vitest';

/** 假 WebSocket：只实现流真正用到的那几个成员。 */
class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  /** 被 close() 调过几次。 */
  closeCalls = 0;

  close(): void {
    this.closeCalls += 1;
  }
}

/** 起一条流，返回假 socket 与各种回调收到的记录。 */
function openStream(options?: {
  onKeepAlive?: () => Promise<void> | void;
  onEvent?: (payload: Record<string, unknown>) => void | Promise<void>;
}): {
  socket: FakeSocket;
  errors: Error[];
  closes: string[];
  events: Record<string, unknown>[];
} {
  const socket = new FakeSocket();
  const errors: Error[] = [];
  const closes: string[] = [];
  const events: Record<string, unknown>[] = [];

  openUserDataStream({
    listenKey: 'key-1',
    url: 'wss://stream.test/ws',
    webSocketFactory: () => socket as unknown as WebSocket,
    onEvent: (payload) => {
      events.push(payload);
      return options?.onEvent?.(payload);
    },
    onError: (error) => errors.push(error),
    onClose: (reason) => closes.push(reason),
    ...(options?.onKeepAlive === undefined
      ? {}
      : { onKeepAlive: async () => options.onKeepAlive?.() }),
    // 定时器**立刻跑一次**：keepalive 的默认周期是 20 分钟，
    // 等真周期等于让这条用例永远跑不完。这里只验「续期失败会收口」。
    setIntervalImpl: (fn) => {
      fn();
      return 1 as unknown as NodeJS.Timeout;
    },
    clearIntervalImpl: () => undefined,
  });

  return { socket, errors, closes, events };
}

describe('用户数据流：出错也必须收口', () => {
  it('只派发 error（不派发 close）时，也必须回调 onClose——否则重连永远等不到', () => {
    const { socket, closes } = openStream();

    // 代理掐断隧道：只来了 error，没有 close。
    socket.onerror?.({ message: 'read ECONNRESET' });

    // 这是整条纪律的要害：不回调 onClose，重连循环就永远停在那个 await 上。
    expect(closes).toHaveLength(1);
    expect(closes[0]).toBe('error');
  });

  it('出错时把 socket 关掉：留着它就会与新连接同时收事件', () => {
    const { socket } = openStream();

    socket.onerror?.({ message: 'read ECONNRESET' });

    expect(socket.closeCalls).toBeGreaterThanOrEqual(1);
  });

  it('onClose 只通知一次：error 与随后的 close 会都发生', () => {
    const { socket, closes } = openStream();

    socket.onerror?.({ message: 'boom' });
    socket.onclose?.();

    expect(closes).toHaveLength(1);
  });

  it('错误信息里能查到原因，而不是只剩一个 {}', () => {
    const { socket, errors } = openStream();

    socket.onerror?.({ message: 'read ECONNRESET', error: new Error('socket hang up') });

    expect(errors).toHaveLength(1);
    const message = errors[0]?.message ?? '';
    expect(message).toContain('用户数据流出错');
    // 关键：不能再是 '{}'（那是断因全丢的现场）
    expect(message).not.toContain('{}');
    expect(message).toContain('ECONNRESET');
  });

  it('事件里什么都没有时也给一句能读的话，而不是空串', () => {
    const { socket, errors } = openStream();

    socket.onerror?.({});

    expect(errors[0]?.message).toMatch(/未知错误/);
  });
});

describe('用户数据流：续期失败与正常断开', () => {
  it('keepalive 失败就收口——这条流活不过 30 分钟，不能装作还连着', async () => {
    const { socket, closes } = openStream({
      onKeepAlive: async () => {
        throw new Error('listenKey 已过期');
      },
    });

    socket.onopen?.();
    // 等 keepalive 那一轮跑完
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(closes).toHaveLength(1);
    expect(closes[0]).toBe('keepalive-failed');
  });

  it('服务端正常关闭时回调 onClose（重连靠它）', () => {
    const { socket, closes } = openStream();

    socket.onclose?.();

    expect(closes).toHaveLength(1);
    expect(closes[0]).toBe('closed');
  });

  it('单条消息处理失败**不**拆连接——一条坏消息不代表流坏了', async () => {
    const { socket, closes, errors } = openStream({
      onEvent: () => {
        throw new Error('这条消息处理不了');
      },
    });

    socket.onmessage?.({ data: JSON.stringify({ e: 'ORDER_TRADE_UPDATE' }) } as MessageEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 连接还在：只有连接级失败才收口。
    expect(closes).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('这条消息处理不了');
  });

  it('事件正常送达', async () => {
    const { socket, events } = openStream();

    socket.onmessage?.({ data: JSON.stringify({ e: 'ACCOUNT_UPDATE' }) } as MessageEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual([{ e: 'ACCOUNT_UPDATE' }]);
  });
});
