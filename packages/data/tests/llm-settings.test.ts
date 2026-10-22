/**
 * 模型接入设置的读写与「哪一份在生效」（v1.0.0）。
 *
 * 重点：
 *   * 控制面那条读路径**永远拿不到明文密钥**（与凭据、通知同一条安全线）；
 *   * 密文真的落进库里了（原始 SQL 里搜不到密钥原文）；
 *   * **控制面优先、配置文件兜底**这条优先级只有一份实现，两个出口给的答案必须一致；
 *   * 主密钥没注入时，面板那一档**读不到**——此时要说「不知道」而不是「没配」；
 *   * 「开着却缺三件套」必须报错，不能存进一个跑起来才失败的配置。
 *
 * 跑在随机命名的独立 schema 上（helpers/pg.ts），**绝不连生产库**。
 */

import { SyncError, type LlmEndpoint } from '@trade-tool/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearAgentLlmSettings,
  readAgentLlmPanelTarget,
  readAgentLlmStatus,
  resolveAgentLlmSettings,
  writeAgentLlmSettings,
} from '../src/index.js';

import { createTestSchema, type TestSchema } from './helpers/pg.js';

const T0 = 1_760_000_000_000;
const KEY = Buffer.from('c'.repeat(64), 'hex');
const OTHER_KEY = Buffer.from('d'.repeat(64), 'hex');
const SECRET = 'sk-test-abcdefghijklmnop';
const BASE_URL = 'https://api.example.invalid/v1';
const MODEL = 'test-model';

const CONFIG_OFF: LlmEndpoint = {
  enabled: false,
  baseUrl: '',
  model: '',
  apiKeyEnv: 'TRADE_TOOL_LLM_API_KEY',
  timeoutMs: 8_000,
};

const CONFIG_ON: LlmEndpoint = {
  enabled: true,
  baseUrl: 'https://config-file.invalid/v1',
  model: 'config-model',
  apiKeyEnv: 'TRADE_TOOL_LLM_API_KEY',
  timeoutMs: 8_000,
};

let schema: TestSchema;

beforeEach(async () => {
  schema = await createTestSchema('agentllm');
});

afterEach(async () => {
  await schema.close();
});

describe('模型设置：控制面读路径拿不到明文', () => {
  it('未配置时如实报「没配」，并说清生效来源是配置文件那一档', async () => {
    const status = await readAgentLlmStatus({
      pool: schema.pool,
      masterKey: KEY,
      config: CONFIG_OFF,
      env: {},
    });
    expect(status.source).toBe('config');
    expect(status.panel).toBeNull();
    expect(status.enabled).toBe(false);
  });

  it('写入后状态只有「配没配 + 末 4 位 + 来源」，没有明文密钥', async () => {
    await writeAgentLlmSettings(
      schema.pool,
      KEY,
      { enabled: true, baseUrl: BASE_URL, model: MODEL, apiKey: SECRET, timeoutMs: 5_000, now: T0 },
      null,
    );

    const status = await readAgentLlmStatus({
      pool: schema.pool,
      masterKey: KEY,
      config: CONFIG_OFF,
      env: {},
    });
    expect(status.source).toBe('panel');
    expect(status.enabled).toBe(true);
    expect(status.baseUrl).toBe(BASE_URL);
    expect(status.model).toBe(MODEL);
    expect(status.timeoutMs).toBe(5_000);
    expect(status.panel?.configured).toBe(true);
    expect(status.panel?.hint).toBe(SECRET.slice(-4));
    expect(status.panel?.keyConfigured).toBe(true);
    // 回包里**没有**明文密钥这个字段
    expect(JSON.stringify(status)).not.toContain(SECRET);
  });

  it('密钥真的加密落库了（原始 SQL 里搜不到原文）', async () => {
    await writeAgentLlmSettings(
      schema.pool,
      KEY,
      { enabled: true, baseUrl: BASE_URL, model: MODEL, apiKey: SECRET, timeoutMs: 5_000, now: T0 },
      null,
    );

    const raw = await schema.pool.query(`SELECT * FROM agent_llm_settings`);
    const row = raw.rows[0] as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(SECRET);
    // 密文列确实有内容
    expect(Buffer.isBuffer(row['ciphertext'])).toBe(true);
    expect((row['ciphertext'] as Buffer).length).toBeGreaterThan(0);
  });

  it('用错的主密钥 → 解不开时报错，不当成「没配」', async () => {
    await writeAgentLlmSettings(
      schema.pool,
      KEY,
      { enabled: true, baseUrl: BASE_URL, model: MODEL, apiKey: SECRET, timeoutMs: 5_000, now: T0 },
      null,
    );

    await expect(
      readAgentLlmStatus({ pool: schema.pool, masterKey: OTHER_KEY, config: CONFIG_OFF, env: {} }),
    ).rejects.toThrow();
  });
});

describe('模型设置：哪一份在生效', () => {
  it('控制面那一档填全了 → 用它（配置文件的值让位）', async () => {
    await writeAgentLlmSettings(
      schema.pool,
      KEY,
      { enabled: true, baseUrl: BASE_URL, model: MODEL, apiKey: SECRET, timeoutMs: 5_000, now: T0 },
      null,
    );

    const resolved = await resolveAgentLlmSettings({
      pool: schema.pool,
      masterKey: KEY,
      config: CONFIG_ON,
      env: { TRADE_TOOL_LLM_API_KEY: 'env-key' },
    });
    expect(resolved.source).toBe('panel');
    expect(resolved.settings.baseUrl).toBe(BASE_URL);
    expect(resolved.settings.model).toBe(MODEL);
    expect(resolved.settings.apiKey).toBe(SECRET);
  });

  it('控制面没配 → 用配置文件 + 环境变量', async () => {
    const resolved = await resolveAgentLlmSettings({
      pool: schema.pool,
      masterKey: KEY,
      config: CONFIG_ON,
      env: { TRADE_TOOL_LLM_API_KEY: 'env-key' },
    });
    expect(resolved.source).toBe('config');
    expect(resolved.settings.baseUrl).toBe('https://config-file.invalid/v1');
    expect(resolved.settings.model).toBe('config-model');
    expect(resolved.settings.apiKey).toBe('env-key');
  });

  it('主密钥没注入 → 读不到控制面那一档，如实说「不知道」', async () => {
    await writeAgentLlmSettings(
      schema.pool,
      KEY,
      { enabled: true, baseUrl: BASE_URL, model: MODEL, apiKey: SECRET, timeoutMs: 5_000, now: T0 },
      null,
    );

    const status = await readAgentLlmStatus({
      pool: schema.pool,
      masterKey: null,
      config: CONFIG_OFF,
      env: {},
    });
    // 生效的是配置文件那一档（主密钥没有就解不开）
    expect(status.source).toBe('config');
    // 但面板那一档的状态仍然看得见
    expect(status.panel?.configured).toBe(true);
    // 密钥有没有配：**读不到**就是「不知道」，不是「没配」
    expect(status.panel?.keyConfigured).toBeNull();
  });

  it('生效来源是配置文件那一档、而密钥读不到 → 报错并说清缺哪个变量', async () => {
    await expect(
      resolveAgentLlmSettings({
        pool: schema.pool,
        masterKey: KEY,
        config: CONFIG_ON,
        env: {},
      }),
    ).rejects.toThrow(/TRADE_TOOL_LLM_API_KEY/);
  });

  it('读状态时密钥读不到 → 不失败，如实报「读不到」（控制面要看得见）', async () => {
    // ⚠️ 这是**读状态**那条路：若它也抛错，控制面整个面板就取不到东西，
    // 页面只显示一句「设置操作失败」——用户连「生效的是哪一份」都看不到，
    // 更不知道该去补哪个环境变量。
    // 而**真要调模型时仍然抛错**（上一条用例守着）。
    const status = await readAgentLlmStatus({
      pool: schema.pool,
      masterKey: KEY,
      config: CONFIG_ON,
      env: {},
    });

    expect(status.source).toBe('config');
    expect(status.configKeyAvailable).toBe(false);
    expect(status.apiKeyEnv).toBe('TRADE_TOOL_LLM_API_KEY');
  });

  it('读状态时密钥在环境变量里 → configKeyAvailable 为 true', async () => {
    const status = await readAgentLlmStatus({
      pool: schema.pool,
      masterKey: KEY,
      config: CONFIG_ON,
      env: { TRADE_TOOL_LLM_API_KEY: 'env-secret' },
    });

    expect(status.source).toBe('config');
    expect(status.configKeyAvailable).toBe(true);
  });
});

describe('模型设置：写入', () => {
  it('「留空 = 保持原样」：只改开关时地址、模型、密钥都不丢', async () => {
    await writeAgentLlmSettings(
      schema.pool,
      KEY,
      { enabled: true, baseUrl: BASE_URL, model: MODEL, apiKey: SECRET, timeoutMs: 5_000, now: T0 },
      null,
    );
    // 第二次保存只填了开关
    await writeAgentLlmSettings(
      schema.pool,
      KEY,
      { enabled: false, baseUrl: '', model: '', timeoutMs: 9_000, now: T0 + 1 },
      { baseUrl: BASE_URL, model: MODEL, apiKey: SECRET },
    );

    const status = await readAgentLlmStatus({
      pool: schema.pool,
      masterKey: KEY,
      config: CONFIG_OFF,
      env: {},
    });
    expect(status.enabled).toBe(false);
    expect(status.baseUrl).toBe(BASE_URL);
    expect(status.model).toBe(MODEL);
    expect(status.timeoutMs).toBe(9_000);
    expect(status.panel?.keyConfigured).toBe(true);
  });

  it('开着却缺三件套 → 报错，不存一个跑起来才失败的配置', async () => {
    await expect(
      writeAgentLlmSettings(
        schema.pool,
        KEY,
        { enabled: true, baseUrl: '', model: '', timeoutMs: 5_000, now: T0 },
        null,
      ),
    ).rejects.toThrow(/API 地址/);
  });

  it('清空 → 退回配置文件 + 环境变量', async () => {
    await writeAgentLlmSettings(
      schema.pool,
      KEY,
      { enabled: true, baseUrl: BASE_URL, model: MODEL, apiKey: SECRET, timeoutMs: 5_000, now: T0 },
      null,
    );
    await clearAgentLlmSettings(schema.pool);

    const status = await readAgentLlmStatus({
      pool: schema.pool,
      masterKey: KEY,
      config: CONFIG_ON,
      env: { TRADE_TOOL_LLM_API_KEY: 'env-key' },
    });
    expect(status.source).toBe('config');
    expect(status.panel).toBeNull();
  });

  it('读面板当前存着的值（写入时的「原样」就是它）', async () => {
    await writeAgentLlmSettings(
      schema.pool,
      KEY,
      { enabled: true, baseUrl: BASE_URL, model: MODEL, apiKey: SECRET, timeoutMs: 5_000, now: T0 },
      null,
    );

    const target = await readAgentLlmPanelTarget({ pool: schema.pool, masterKey: KEY });
    expect(target?.baseUrl).toBe(BASE_URL);
    expect(target?.model).toBe(MODEL);
    expect(target?.apiKey).toBe(SECRET);
  });

  it('主密钥没注入 → 读不到面板当前值（返回 null）', async () => {
    await writeAgentLlmSettings(
      schema.pool,
      KEY,
      { enabled: true, baseUrl: BASE_URL, model: MODEL, apiKey: SECRET, timeoutMs: 5_000, now: T0 },
      null,
    );

    const target = await readAgentLlmPanelTarget({ pool: schema.pool, masterKey: null });
    expect(target).toBeNull();
  });

  it('错误码是 CONFIG_INVALID（控制面据此回 400）', async () => {
    try {
      await writeAgentLlmSettings(
        schema.pool,
        KEY,
        { enabled: true, baseUrl: '', model: '', timeoutMs: 5_000, now: T0 },
        null,
      );
      throw new Error('本该抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(SyncError);
      expect((error as SyncError).code).toBe('CONFIG_INVALID');
    }
  });
});
