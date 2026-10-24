/**
 * 模型接入的**端到端**用例（v1.0.0）：控制面改设置 → agent 下一轮用新模型。
 *
 * 真 PG（真迁移，从空库跑到 019）+ 假模型 HTTP 服务（真 HTTP，OpenAI 兼容协议）。
 *
 * ⚠️ **这条走的是 agent 每轮真正调用的那个包装函数**（`createLlmResolver`），
 * 不是手工 `resolveAgentLlmSettings` + `createLlmClient` 拼一个客户端。
 * 区别在于：那个包装函数多做一步「生效的那一档是不是开着」的判断——
 * 它是「模型没启用时给一句说清的话」这条路径的唯一实现。
 * 只测底下那两半的话，这一层没人守。
 */

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  clearAgentLlmSettings,
  createTestSchema,
  readAgentLlmStatus,
  writeAgentLlmSettings,
  type TestSchema,
} from '@trade-tool/data';

import { createLlmResolver } from '../src/llm.js';

const MASTER_KEY = Buffer.from('a'.repeat(64), 'hex');

let schema: TestSchema;
let server: Server;
let baseUrl: string;
/** 假模型服务收到的请求。 */
const seen: { model: string; auth: string | undefined }[] = [];

beforeAll(async () => {
  schema = await createTestSchema('agent_llm_e2e');
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      seen.push({ model: payload.model, auth: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [
            { message: { content: JSON.stringify({ technical: { score: 0.1, notes: [] } }) } },
          ],
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('端口拿不到');
  baseUrl = `http://127.0.0.1:${addr.port}/v1`;
});

afterAll(async () => {
  await schema.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('agent 的模型解析器（每轮重新解析）', () => {
  it('控制面改完设置 → 下一轮就用新模型与新密钥（不必重启进程）', async () => {
    // 配置文件那一档：地址指向假服务，模型名是旧的
    const config = {
      enabled: true,
      baseUrl,
      model: '旧模型',
      apiKeyEnv: 'TRADE_TOOL_E2E_KEY',
      timeoutMs: 5_000,
    };
    process.env.TRADE_TOOL_E2E_KEY = 'config-secret';

    const resolveLlm = createLlmResolver({
      pool: schema.pool,
      masterKey: MASTER_KEY,
      config,
    });

    // 第一轮：生效的是配置文件那一档
    const first = await resolveLlm();
    await first.complete([{ role: 'user', content: '第一轮' }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.model).toBe('旧模型');
    expect(seen[0]?.auth).toBe('Bearer config-secret');

    // 控制面写入（模拟网页上改了地址 / 模型 / 密钥）
    await writeAgentLlmSettings(
      schema.pool,
      MASTER_KEY,
      {
        enabled: true,
        baseUrl,
        model: '新模型',
        apiKey: 'panel-secret',
        timeoutMs: 9_000,
        now: 1_760_000_000_000,
      },
      null,
    );

    // 下一轮：同一个解析器（进程没重启）就用新的那一份
    const second = await resolveLlm();
    await second.complete([{ role: 'user', content: '第二轮' }]);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.model).toBe('新模型');
    expect(seen[1]?.auth).toBe('Bearer panel-secret');

    // 控制面读路径**拿不到明文**
    const status = await readAgentLlmStatus({
      pool: schema.pool,
      masterKey: MASTER_KEY,
      config,
    });
    expect(status.source).toBe('panel');
    expect(JSON.stringify(status)).not.toContain('panel-secret');

    // 清空控制面那一份 → 退回配置文件
    await clearAgentLlmSettings(schema.pool);
    const third = await resolveLlm();
    await third.complete([{ role: 'user', content: '第三轮' }]);
    expect(seen).toHaveLength(3);
    expect(seen[2]?.model).toBe('旧模型');
  });

  it('生效的那一档没启用 → 报错并说清去哪儿开', async () => {
    const resolveLlm = createLlmResolver({
      pool: schema.pool,
      masterKey: MASTER_KEY,
      config: {
        enabled: false,
        baseUrl,
        model: '旧模型',
        apiKeyEnv: 'TRADE_TOOL_E2E_KEY',
        timeoutMs: 5_000,
      },
    });

    await expect(resolveLlm()).rejects.toThrow(/模型未启用/);
  });
});
