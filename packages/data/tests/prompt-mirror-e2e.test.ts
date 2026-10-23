/**
 * 提示词镜像的**端到端**用例（v1.0.0）。
 *
 * 真 PG（真迁移，从空库跑到 020）+ 假飞书 webhook（真 HTTP）。
 *
 * ⚠️ **这条走的是真正的那条路**：通知设置真的写进库（密文落库），
 * 通道真的按「库里优先、配置文件兜底」解析出来，提示词真的经由
 * `FeishuNotifier` 发到 webhook。前面那些用例守的是每一段，
 * 这条守的是「**它们接起来**」——接错了地方（比如忘了读库里的勾选）
 * 单元测试是发现不了的。
 *
 * 不出网：飞书那一头是本机起的一个假服务器。
 */

import { keyHint, sealNotifyTarget, PROMPT_SOURCE_INFO } from '@trade-tool/core';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestSchema, type TestSchema } from '../src/index.js';

import { createNotifyChannelResolver, createPromptMirror } from '../src/prompt-mirror.js';

const MASTER_KEY = Buffer.from('b'.repeat(64), 'hex');
/** 假 webhook 的形状——`assertWebhookUrl` 只认官方那一种。 */
const WEBHOOK_PATH = '/open-apis/bot/v2/hook/faketoken123456';

let schema: TestSchema;
let server: Server;
let webhookUrl: string;
/** 假飞书收到的每一次请求。 */
const received: { body: Record<string, unknown> }[] = [];

beforeAll(async () => {
  schema = await createTestSchema('prompt_mirror_e2e');
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      received.push({ body: JSON.parse(body || '{}') as Record<string, unknown> });
      res.setHeader('content-type', 'application/json');
      // 飞书的成功响应恒为 {"code":0,"msg":"success"}
      res.end(JSON.stringify({ code: 0, msg: 'success' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('端口拿不到');
  webhookUrl = `http://127.0.0.1:${String(addr.port)}${WEBHOOK_PATH}`;
});

afterAll(async () => {
  await schema.close();
  await new Promise<void>((r) => server.close(() => r()));
});

/**
 * 把「控制面那一档」写进库（**直接写**）。
 *
 * 为什么不用 `writeNotifySettings`：它会校验地址必须是 `https://` 的官方形状，
 * 而这里要打的是本机的假服务器（`http://127.0.0.1`）。
 * 那一层校验由 `packages/data` 的用例守着；这里要守的是
 * 「**读库里的那一份** + 按勾选决定发不发」。
 */
async function writePanelRow(kinds: readonly string[]): Promise<void> {
  const sealed = sealNotifyTarget({ webhookUrl, secret: '' }, MASTER_KEY);
  await schema.pool.query(
    `INSERT INTO notify_settings (id, enabled, iv, auth_tag, ciphertext, key_hint,
                                  kinds, repeat_cooldown_ms, updated_at)
       VALUES (1, true, $1, $2, $3, $4, $5, 1800000, 1)
     ON CONFLICT (id) DO UPDATE
       SET enabled = EXCLUDED.enabled, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag,
           ciphertext = EXCLUDED.ciphertext, key_hint = EXCLUDED.key_hint,
           kinds = EXCLUDED.kinds`,
    [sealed.iv, sealed.authTag, sealed.ciphertext, keyHint(webhookUrl), [...kinds]],
  );
}

/** 通知配置那一档（配置文件兜底档：全关，地址不在环境变量里）。 */
const CONFIG_OFF = {
  enabled: false,
  webhookEnv: 'TRADE_TOOL_FEISHU_WEBHOOK_URL',
  secretEnv: 'TRADE_TOOL_FEISHU_WEBHOOK_SECRET',
  kinds: [] as string[],
  repeatCooldownMs: 1_800_000,
};

function mirror(): ReturnType<typeof createPromptMirror> {
  return createPromptMirror({
    resolveChannel: createNotifyChannelResolver({
      pool: schema.pool,
      masterKey: MASTER_KEY,
      config: CONFIG_OFF,
    }),
  });
}

describe('提示词镜像：端到端', () => {
  it('控制面勾上「Agent 提示词」→ 提示词真的发到群里', async () => {
    received.length = 0;
    await writePanelRow(['bracket-armed', PROMPT_SOURCE_INFO['agent-analyst'].kind]);

    await mirror().mirror({
      symbol: 'TESTUSDT',
      source: 'agent-analyst',
      messages: [
        { role: 'system', content: '你只输出 JSON 对象。' },
        { role: 'user', content: '## 技术面\n最新收盘价：100' },
      ],
    });

    expect(received).toHaveLength(1);
    const payload = JSON.stringify(received[0]?.body ?? {});
    // 群里那条消息里真的有提示词正文
    expect(payload).toContain('最新收盘价');
    expect(payload).toContain('TESTUSDT');
  });

  it('没勾「Agent 提示词」→ 一条都不发（默认行为）', async () => {
    received.length = 0;
    await writePanelRow(['bracket-armed']);

    await mirror().mirror({
      symbol: 'TESTUSDT',
      source: 'agent-analyst',
      messages: [{ role: 'user', content: '不该发出去' }],
    });

    expect(received).toHaveLength(0);
  });

  it('勾的是 executor 那一项 → Agent 的提示词照样不发（归属是分开的）', async () => {
    received.length = 0;
    await writePanelRow([PROMPT_SOURCE_INFO['executor-decision'].kind]);

    await mirror().mirror({
      symbol: 'TESTUSDT',
      source: 'agent-analyst',
      messages: [{ role: 'user', content: '不该发出去' }],
    });

    expect(received).toHaveLength(0);
  });
});
