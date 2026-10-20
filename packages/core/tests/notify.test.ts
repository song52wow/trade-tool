/**
 * 通知层（v0.8.0）。
 *
 * 这里锁的是**契约**，不是实现：
 *   * 发给飞书的请求体长什么样（`msg_type` / `content.text`）；
 *   * 签名怎么算（官方算法，不是「我这么算的」）；
 *   * 飞书回了错误码时我们怎么归类（限流 / 配置错 / 其它）；
 *   * 同一件事**不许反复刷屏**，而问题消失要有一条「已恢复」。
 *
 * 不出网：HTTP 客户端是替身。签名那条用例的期望值是**独立算出来的**
 * （Python 的 hmac 实现，见用例注释），不是本仓库自己算一遍再复述。
 */

import { describe, expect, it } from 'vitest';

import {
  AlertDispatcher,
  DISABLED_NOTIFIER,
  NOTIFY_KINDS,
  NOTIFY_KIND_INFO,
  type AlertChannel,
  FeishuNotifier,
  createNotifierFromEnv,
  feishuSign,
  formatFeishuText,
  redactWebhook,
  severityLabel,
  type FeishuFetch,
  type NotifyEvent,
} from '../src/notify.js';

const WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/abc123';

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

function stubFetch(
  response: { status?: number; ok?: boolean; body: string },
  captured: Captured[] = [],
): FeishuFetch {
  return (url, init) => {
    captured.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    return Promise.resolve({
      ok: response.ok ?? true,
      status: response.status ?? 200,
      text: () => Promise.resolve(response.body),
    });
  };
}

const OK_BODY = JSON.stringify({ code: 0, msg: 'success', data: {} });

describe('formatFeishuText', () => {
  it('第一行是标题，其余是正文行', () => {
    const text = formatFeishuText({
      title: 'BTCUSDT 仓位没有止损保护',
      severity: 'critical',
      lines: ['第一行', '第二行'],
    });
    const rows = text.split('\n');
    expect(rows[0]).toContain('BTCUSDT 仓位没有止损保护');
    expect(rows[0]).toContain(severityLabel('critical'));
    // 固定前缀：配了「自定义关键词」的群靠它放行
    expect(rows[0]).toContain('trade-tool');
    expect(rows.slice(1)).toEqual(['第一行', '第二行']);
  });
});

describe('feishuSign', () => {
  it('与官方算法一致（HMAC-SHA256，key = `timestamp\\nsecret`，对空串签名，再 base64）', () => {
    // 期望值由 Python 独立算出：
    //   hmac.new('1599360473\ndemo', digestmod=hashlib.sha256).digest() → base64
    expect(feishuSign(1599360473, 'demo')).toBe('l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=');
  });
});

describe('FeishuNotifier', () => {
  it('发的是文本消息体（官方 msg_type: text）', async () => {
    const captured: Captured[] = [];
    const notifier = new FeishuNotifier({
      webhookUrl: WEBHOOK,
      fetchImpl: stubFetch({ body: OK_BODY }, captured),
    });

    await notifier.notify({ title: '标题', severity: 'warning', lines: ['正文'] });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe(WEBHOOK);
    expect(captured[0]?.body['msg_type']).toBe('text');
    const content = captured[0]?.body['content'] as { text: string };
    expect(content.text).toContain('标题');
    expect(content.text).toContain('正文');
  });

  it('配了密钥就带上 timestamp 与 sign（都是秒级）', async () => {
    const captured: Captured[] = [];
    const notifier = new FeishuNotifier({
      webhookUrl: WEBHOOK,
      secret: 'demo',
      fetchImpl: stubFetch({ body: OK_BODY }, captured),
      now: () => 1599360473_000,
    });

    await notifier.notify({ title: '标题', severity: 'info' });

    expect(captured[0]?.body['timestamp']).toBe('1599360473');
    expect(captured[0]?.body['sign']).toBe('l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=');
  });

  it('没配密钥就不带签名字段', async () => {
    const captured: Captured[] = [];
    const notifier = new FeishuNotifier({
      webhookUrl: WEBHOOK,
      fetchImpl: stubFetch({ body: OK_BODY }, captured),
    });

    await notifier.notify({ title: '标题', severity: 'info' });

    expect(captured[0]?.body).not.toHaveProperty('sign');
    expect(captured[0]?.body).not.toHaveProperty('timestamp');
  });

  it('飞书回非 0 码时报错，并把码归到对应的错误类型', async () => {
    // 11232 = 限频；19021 = 签名不匹配 / 时间戳超 1 小时；两者处置完全不同
    const limited = new FeishuNotifier({
      webhookUrl: WEBHOOK,
      fetchImpl: stubFetch({ body: JSON.stringify({ code: 11232, msg: 'rate limited' }) }),
    });
    await expect(limited.notify({ title: '标题', severity: 'critical' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });

    const badSign = new FeishuNotifier({
      webhookUrl: WEBHOOK,
      fetchImpl: stubFetch({ body: JSON.stringify({ code: 19021, msg: 'sign match fail' }) }),
    });
    await expect(badSign.notify({ title: '标题', severity: 'critical' })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });

  it('HTTP 不通时报 NETWORK_ERROR', async () => {
    const notifier = new FeishuNotifier({
      webhookUrl: WEBHOOK,
      fetchImpl: stubFetch({ status: 500, ok: false, body: 'boom' }),
    });
    await expect(notifier.notify({ title: '标题', severity: 'info' })).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
  });

  it('响应里没有 code 时**不算成功**（不能把「看起来成功其实什么都没做」放过去）', async () => {
    const notifier = new FeishuNotifier({
      webhookUrl: WEBHOOK,
      fetchImpl: stubFetch({ body: JSON.stringify({ msg: 'success' }) }),
    });
    await expect(notifier.notify({ title: '标题', severity: 'info' })).rejects.toBeTruthy();
  });

  it('请求失败时错误详情里不出现 webhook 原文（它本身就是凭据）', async () => {
    const notifier = new FeishuNotifier({
      webhookUrl: WEBHOOK,
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    await expect(notifier.notify({ title: '标题', severity: 'info' })).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
    expect(redactWebhook(WEBHOOK)).toBe('https://open.feishu.cn/open-apis/bot/v2/hook/***');
    expect(redactWebhook(WEBHOOK)).not.toContain('abc123');
  });

  it('底层客户端把 URL 带进报错时，报错里也不能有 webhook 原文', async () => {
    // Node 的 fetch 报错常常是 "request to <完整 URL> failed"——那个 URL 就是凭据。
    const notifier = new FeishuNotifier({
      webhookUrl: WEBHOOK,
      fetchImpl: () => Promise.reject(new Error(`request to ${WEBHOOK} failed`)),
    });
    const error = await notifier
      .notify({ title: '标题', severity: 'info' })
      .catch((e: unknown) => e);
    expect(String(error)).not.toContain('abc123');
    expect(String(error)).toContain('/hook/***');
  });
});

describe('createNotifierFromEnv', () => {
  const settings = {
    enabled: true,
    webhookEnv: 'TRADE_TOOL_FEISHU_WEBHOOK_URL',
    secretEnv: 'TRADE_TOOL_FEISHU_WEBHOOK_SECRET',
  };

  it('关闭时不读环境变量、不发请求', async () => {
    const notifier = createNotifierFromEnv({ ...settings, enabled: false }, {});
    expect(notifier.enabled).toBe(false);
    await expect(notifier.notify({ title: '标题', severity: 'info' })).resolves.toBeUndefined();
  });

  it('开着却没配地址时抛 CONFIG_INVALID 并说清怎么配', () => {
    expect(() => createNotifierFromEnv(settings, {})).toThrow(/TRADE_TOOL_FEISHU_WEBHOOK_URL/);
    expect(() => createNotifierFromEnv(settings, { TRADE_TOOL_FEISHU_WEBHOOK_URL: '  ' })).toThrow(
      /CONFIG_INVALID|TRADE_TOOL_FEISHU_WEBHOOK_URL/,
    );
  });

  it('配齐了就启用', () => {
    const notifier = createNotifierFromEnv(settings, {
      TRADE_TOOL_FEISHU_WEBHOOK_URL: WEBHOOK,
    });
    expect(notifier.enabled).toBe(true);
  });

  it('关闭通道是一个真正的空实现（不是失败时的兜底）', async () => {
    expect(DISABLED_NOTIFIER.enabled).toBe(false);
    await expect(
      DISABLED_NOTIFIER.notify({ title: '标题', severity: 'critical' }),
    ).resolves.toBeUndefined();
  });
});

describe('AlertDispatcher', () => {
  interface Recorder {
    notifier: { enabled: boolean; notify(event: NotifyEvent): Promise<void> };
    events: NotifyEvent[];
  }

  function recorder(fail = false): Recorder {
    const events: NotifyEvent[] = [];
    return {
      events,
      notifier: {
        enabled: true,
        notify: (event: NotifyEvent) => {
          events.push(event);
          return fail ? Promise.reject(new Error('飞书不可达')) : Promise.resolve();
        },
      },
    };
  }

  /**
   * 组一个通道。地址、**要通知哪些内容**、冷却时间**一起**取——只换地址却留着
   * 旧的勾选，那种「半更新」比不改更难查。
   */
  function channelOf(
    notifier: { enabled: boolean; notify(event: NotifyEvent): Promise<void> },
    overrides: { kinds?: string[]; repeatCooldownMs?: number } = {},
  ): AlertChannel {
    return {
      notifier,
      kinds: overrides.kinds ?? ['missing-stop-order'],
      repeatCooldownMs: overrides.repeatCooldownMs ?? 30 * 60_000,
    };
  }

  const item = {
    fingerprint: 'reconcile|missing-stop-order|BTCUSDT|1',
    severity: 'critical' as const,
    title: 'BTCUSDT 仓位没有止损保护',
    lines: ['本地记着已挂上，交易所没有止损单'],
    resolvedTitle: '交易对账已恢复正常',
  };

  it('第一次推送；冷却期内同一件事不再推', async () => {
    const rec = recorder();
    let now = 1_000;
    const dispatcher = new AlertDispatcher({
      channel: channelOf(rec.notifier, { repeatCooldownMs: 60_000 }),
      now: () => now,
    });

    const first = await dispatcher.dispatch(() => [item]);
    expect(first.sent).toBe(1);

    const second = await dispatcher.dispatch(() => [item]);
    expect(second.sent).toBe(0);
    expect(second.suppressed).toBe(1);
    expect(rec.events).toHaveLength(1);
  });

  it('冷却期过了会再推一次（提醒「还没好」）', async () => {
    const rec = recorder();
    let now = 1_000;
    const dispatcher = new AlertDispatcher({
      channel: channelOf(rec.notifier, { repeatCooldownMs: 60_000 }),
      now: () => now,
    });

    await dispatcher.dispatch(() => [item]);
    now += 60_001;
    const again = await dispatcher.dispatch(() => [item]);
    expect(again.sent).toBe(1);
    expect(rec.events).toHaveLength(2);
  });

  it('严重度变了立刻重推（那是新情况）', async () => {
    const rec = recorder();
    const dispatcher = new AlertDispatcher({
      channel: channelOf(rec.notifier, { repeatCooldownMs: 60_000 }),
      now: () => 1_000,
    });

    await dispatcher.dispatch(() => [item]);
    const result = await dispatcher.dispatch(() => [{ ...item, severity: 'warning' }]);
    expect(result.sent).toBe(1);
  });

  it('问题消失时推一条「已恢复」', async () => {
    const rec = recorder();
    const dispatcher = new AlertDispatcher({
      channel: channelOf(rec.notifier, { repeatCooldownMs: 60_000 }),
      now: () => 1_000,
    });

    await dispatcher.dispatch(() => [item]);
    const result = await dispatcher.dispatch(() => []);
    expect(result.recovered).toBe(1);
    expect(rec.events[1]?.title).toBe('交易对账已恢复正常');
    expect(rec.events[1]?.severity).toBe('info');
  });

  it('推送失败不记账：下一轮会重试（不能把送不出去的告警当成「已经通知过了」）', async () => {
    const rec = recorder(true);
    const errors: unknown[] = [];
    const dispatcher = new AlertDispatcher({
      channel: channelOf(rec.notifier, { repeatCooldownMs: 60_000 }),
      now: () => 1_000,
      onError: (error) => errors.push(error),
    });

    const first = await dispatcher.dispatch(() => [item]);
    expect(first.failed).toBe(1);
    expect(first.sent).toBe(0);
    expect(errors).toHaveLength(1);

    const second = await dispatcher.dispatch(() => [item]);
    expect(second.failed).toBe(1);
    expect(second.suppressed).toBe(0);
  });

  it('用户改了勾选 → 不误报「已恢复」，并按新设置从头开始', async () => {
    // 取消勾选与「问题真的解决了」在派发器看来长得一样（上一轮的内容不见了）。
    // 不区分的话，用户只是取消了一个勾选就会收到一条莫名其妙的「已恢复」。
    const rec = recorder();
    let kinds = ['missing-stop-order'];
    const dispatcher = new AlertDispatcher({
      channel: () => channelOf(rec.notifier, { kinds }),
      now: () => 1_000,
    });

    await dispatcher.dispatch(() => [item]);
    expect(rec.events).toHaveLength(1);

    // 用户取消勾选 → 那一类不再推，也不该有「已恢复」
    kinds = [];
    const changed = await dispatcher.dispatch(() => []);
    expect(changed.recovered).toBe(0);
    expect(rec.events).toHaveLength(1);

    // 重新勾上：按新设置从头来（上一轮的记账已作废，不受冷却压制）
    kinds = ['missing-stop-order'];
    const again = await dispatcher.dispatch(() => [item]);
    expect(again.sent).toBe(1);
    expect(again.recovered).toBe(0);
    expect(rec.events).toHaveLength(2);
  });

  it('通道关着时什么都不发，也不记账（否则通道重新打开后要再等一个冷却期）', async () => {
    const rec = recorder();
    let enabled = true;
    const dispatcher = new AlertDispatcher({
      channel: () => ({
        notifier: {
          get enabled() {
            return enabled;
          },
          notify: rec.notifier.notify,
        },
        kinds: ['missing-stop-order'],
        repeatCooldownMs: 60_000,
      }),
      now: () => 1_000,
    });

    await dispatcher.dispatch(() => [item]);
    expect(rec.events).toHaveLength(1);

    // 通道关掉的那几轮：什么都不推，也不记账
    enabled = false;
    const off = await dispatcher.dispatch(() => [item]);
    expect(off.sent).toBe(0);
    expect(rec.events).toHaveLength(1);

    // 重新打开：同一件事要**立刻**推一次，而不是「刚才推过了」
    enabled = true;
    const on = await dispatcher.dispatch(() => [item]);
    expect(on.sent).toBe(1);
    expect(rec.events).toHaveLength(2);
  });

  it('每轮重新解析的通道：设置改了下一轮就生效（控制面改完不必重启）', async () => {
    const rec = recorder();
    let cooldownMs = 60_000;
    const dispatcher = new AlertDispatcher({
      channel: () => channelOf(rec.notifier, { repeatCooldownMs: cooldownMs }),
      now: () => 1_000,
    });

    await dispatcher.dispatch(() => [item]);
    // 冷却期内：被压下
    expect((await dispatcher.dispatch(() => [item])).suppressed).toBe(1);

    // 页面把冷却改成 0 → 下一轮就照新值走
    cooldownMs = 0;
    expect((await dispatcher.dispatch(() => [item])).sent).toBe(1);
  });

  it('事件型告警推过即忘：不参与「已恢复」判定', async () => {
    // 「止盈止损挂上了」「这一轮走完了」都是一次性事件，不是持续状态——
    // 下一轮它们不在了，不代表「问题恢复了」。
    const rec = recorder();
    const dispatcher = new AlertDispatcher({
      channel: channelOf(rec.notifier),
      now: () => 1_000,
    });

    const event = { ...item, oneShot: true };
    await dispatcher.dispatch(() => [event]);
    const result = await dispatcher.dispatch(() => []);

    expect(result.recovered).toBe(0);
    expect(rec.events).toHaveLength(1);
  });

  it('条目由通道参数构造：过滤用的就是这一轮生效的设置', async () => {
    // 构造条目的那一步必须拿到**这一轮**的设置（要通知哪些内容），
    // 否则过滤与发送会看到两份不同的「哪一份在生效」。
    const rec = recorder();
    let kinds = ['missing-stop-order'];
    const dispatcher = new AlertDispatcher({
      channel: () => channelOf(rec.notifier, { kinds }),
      now: () => 1_000,
    });

    const result = await dispatcher.dispatch((channel) => {
      expect(channel.kinds).toEqual(kinds);
      return channel.kinds.includes('missing-stop-order') ? [item] : [];
    });
    expect(result.sent).toBe(1);
  });
});

describe('通知内容类型的清单', () => {
  it('包含交易对账的差异类型，也包含两类交易事件', () => {
    // 清单只有一份（NOTIFY_KINDS）：用户在一个列表里勾，页面也只有一份可显示。
    expect(NOTIFY_KINDS).toContain('missing-stop-order');
    expect(NOTIFY_KINDS).toContain('bracket-armed');
    expect(NOTIFY_KINDS).toContain('bracket-settled');
    expect(new Set(NOTIFY_KINDS).size).toBe(NOTIFY_KINDS.length);
  });

  it('每一项都有中文名与说明（页面不自己编文案）', () => {
    for (const kind of NOTIFY_KINDS) {
      expect(NOTIFY_KIND_INFO[kind].label.length).toBeGreaterThan(0);
      expect(NOTIFY_KIND_INFO[kind].hint.length).toBeGreaterThan(0);
    }
  });
});
