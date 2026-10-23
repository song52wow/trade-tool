/**
 * 飞书通知设置的读写与「哪一份在生效」（v0.8.0）。
 *
 * 重点：
 *   * 控制面那条读路径**永远拿不到明文地址**（与凭据同一条安全线）；
 *   * 密文真的落进库里了（原始 SQL 里搜不到地址原文）；
 *   * **库里优先、配置文件兜底**这条优先级只有一份实现，两个出口给的答案必须一致；
 *   * 「开着却没有地址」必须报错，不能安静地不推。
 *
 * 跑在随机命名的独立 schema 上（helpers/pg.ts），**绝不连生产库**。
 */

import { AGENT_PROMPT_KIND, NOTIFY_KINDS, SyncError, type NotifyConfig } from '@trade-tool/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearNotifySettings,
  readNotifyStatus,
  readNotifyTarget,
  resolveNotifySettings,
  writeNotifySettings,
} from '../src/index.js';

import { createTestSchema, type TestSchema } from './helpers/pg.js';

const T0 = 1_760_000_000_000;
const KEY = Buffer.from('c'.repeat(64), 'hex');
const OTHER_KEY = Buffer.from('d'.repeat(64), 'hex');
const WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdef123456';
const ENV_WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/envtoken9999';

const ALL_KINDS = [...NOTIFY_KINDS];

const CONFIG_OFF: NotifyConfig = {
  enabled: false,
  webhookEnv: 'TRADE_TOOL_FEISHU_WEBHOOK_URL',
  secretEnv: 'TRADE_TOOL_FEISHU_WEBHOOK_SECRET',
  kinds: ALL_KINDS,
  repeatCooldownMs: 1_800_000,
};

const CONFIG_ON: NotifyConfig = { ...CONFIG_OFF, enabled: true };

let schema: TestSchema;

beforeEach(async () => {
  schema = await createTestSchema('notify');
});

afterEach(async () => {
  await schema.close();
});

describe('通知设置：控制面读路径拿不到明文', () => {
  it('未配置时如实报「没配」，并说清生效来源是配置文件那一档', async () => {
    const status = await readNotifyStatus({
      pool: schema.pool,
      masterKey: KEY,
      config: CONFIG_OFF,
      env: {},
    });
    expect(status.configured).toBe(false);
    expect(status.source).toBe('config');
    expect(status.panel).toBeNull();
  });

  it('写入后状态只有「配没配 + 末 4 位 + 来源」', async () => {
    await writeNotifySettings(
      schema.pool,
      KEY,
      {
        enabled: true,
        webhookUrl: WEBHOOK,
        kinds: ALL_KINDS,
        repeatCooldownMs: 1_800_000,
        now: T0,
      },
      null,
    );

    const status = await readNotifyStatus({
      pool: schema.pool,
      masterKey: KEY,
      config: CONFIG_OFF,
      env: {},
    });
    expect(status.configured).toBe(true);
    expect(status.hint).toBe('3456');
    expect(status.source).toBe('panel');
    expect(status.enabled).toBe(true);
    expect(JSON.stringify(status)).not.toContain('abcdef');
  });

  it('密文真的落库了：原始 SQL 里搜不到地址原文', async () => {
    await writeNotifySettings(
      schema.pool,
      KEY,
      {
        enabled: true,
        webhookUrl: WEBHOOK,
        secret: 'sign-secret',
        kinds: ALL_KINDS,
        repeatCooldownMs: 1_800_000,
        now: T0,
      },
      null,
    );

    const raw = await schema.pool.query<{ ciphertext: Buffer }>(
      'SELECT ciphertext FROM notify_settings',
    );
    const blob = (raw.rows[0]?.ciphertext ?? Buffer.alloc(0)).toString('binary');
    expect(blob).not.toContain('abcdef123456');
    expect(blob).not.toContain('sign-secret');
  });
});

describe('通知设置：哪一份在生效', () => {
  it('没有面板那一档时用配置文件 + 环境变量', async () => {
    const resolved = await resolveNotifySettings({
      pool: schema.pool,
      masterKey: KEY,
      config: CONFIG_ON,
      env: { TRADE_TOOL_FEISHU_WEBHOOK_URL: ENV_WEBHOOK },
    });
    expect(resolved.source).toBe('config');
    expect(resolved.settings.webhookUrl).toBe(ENV_WEBHOOK);
    expect(resolved.settings.enabled).toBe(true);
  });

  it('面板那一档存在时**优先**于环境变量', async () => {
    await writeNotifySettings(
      schema.pool,
      KEY,
      {
        enabled: true,
        webhookUrl: WEBHOOK,
        kinds: ALL_KINDS,
        repeatCooldownMs: 60_000,
        now: T0,
      },
      null,
    );

    const resolved = await resolveNotifySettings({
      pool: schema.pool,
      masterKey: KEY,
      config: CONFIG_ON,
      env: { TRADE_TOOL_FEISHU_WEBHOOK_URL: ENV_WEBHOOK },
    });
    expect(resolved.source).toBe('panel');
    expect(resolved.settings.webhookUrl).toBe(WEBHOOK);
    // 面板那一档是**整体**的：参数也一起跟着走，不拆开用。
    expect(resolved.settings.kinds).toEqual(ALL_KINDS);
    expect(resolved.settings.repeatCooldownMs).toBe(60_000);
  });

  it('主密钥没注入就读不到面板那一档（此时用配置文件兜底）', async () => {
    await writeNotifySettings(
      schema.pool,
      KEY,
      {
        enabled: true,
        webhookUrl: WEBHOOK,
        kinds: ALL_KINDS,
        repeatCooldownMs: 1_800_000,
        now: T0,
      },
      null,
    );

    const resolved = await resolveNotifySettings({
      pool: schema.pool,
      masterKey: null,
      config: CONFIG_OFF,
      env: { TRADE_TOOL_FEISHU_WEBHOOK_URL: ENV_WEBHOOK },
    });
    expect(resolved.source).toBe('config');
    expect(resolved.settings.webhookUrl).toBe(ENV_WEBHOOK);
  });

  it('开着却没有地址时报 CONFIG_INVALID，不安静地不推', async () => {
    await expect(
      resolveNotifySettings({
        pool: schema.pool,
        masterKey: KEY,
        config: CONFIG_ON,
        env: {},
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('主密钥没注入时，面板那一份的签名状态是「读不到」而不是「没配」', async () => {
    await writeNotifySettings(
      schema.pool,
      KEY,
      {
        enabled: true,
        webhookUrl: WEBHOOK,
        secret: 'sign-secret',
        kinds: ALL_KINDS,
        repeatCooldownMs: 1_800_000,
        now: T0,
      },
      null,
    );

    const status = await readNotifyStatus({
      pool: schema.pool,
      masterKey: null,
      config: CONFIG_OFF,
      env: {},
    });
    expect(status.panel?.configured).toBe(true);
    // 解不开就是解不开——说「没配」是猜测，而页面会照着它显示。
    expect(status.panel?.secretConfigured).toBeNull();
  });

  it('清空之后回到「配置文件 + 环境变量」那一档', async () => {
    await writeNotifySettings(
      schema.pool,
      KEY,
      {
        enabled: true,
        webhookUrl: WEBHOOK,
        kinds: ALL_KINDS,
        repeatCooldownMs: 1_800_000,
        now: T0,
      },
      null,
    );
    await clearNotifySettings(schema.pool, T0 + 1);

    const status = await readNotifyStatus({
      pool: schema.pool,
      masterKey: KEY,
      config: CONFIG_OFF,
      env: {},
    });
    expect(status.source).toBe('config');
    expect(status.configured).toBe(false);
    // tombstone 行还在：用户能看到「清空过」，而不是退回「从未配置」那种含糊状态。
    expect(status.panel).not.toBeNull();
    expect(status.panel?.configured).toBe(false);
  });
});

describe('通知设置：写入语义', () => {
  it('留空 = 保持原样（地址与签名密钥都不动）', async () => {
    await writeNotifySettings(
      schema.pool,
      KEY,
      {
        enabled: true,
        webhookUrl: WEBHOOK,
        secret: 'sign-secret',
        kinds: ALL_KINDS,
        repeatCooldownMs: 1_800_000,
        now: T0,
      },
      null,
    );

    // 第二次只改开关与参数，地址留空
    await writeNotifySettings(
      schema.pool,
      KEY,
      {
        enabled: false,
        webhookUrl: '',
        kinds: ALL_KINDS,
        repeatCooldownMs: 60_000,
        now: T0 + 1,
      },
      { webhookUrl: WEBHOOK, secret: 'sign-secret' },
    );

    const resolved = await resolveNotifySettings({
      pool: schema.pool,
      masterKey: KEY,
      config: CONFIG_OFF,
      env: {},
    });
    expect(resolved.settings.enabled).toBe(false);
    expect(resolved.settings.kinds).toEqual(ALL_KINDS);
    expect(resolved.settings.webhookUrl).toBe(WEBHOOK);
    expect(resolved.settings.secret).toBe('sign-secret');
  });

  it('换地址时签名密钥没填就沿用原来的', async () => {
    await writeNotifySettings(
      schema.pool,
      KEY,
      {
        enabled: true,
        webhookUrl: WEBHOOK,
        secret: 'sign-secret',
        kinds: ALL_KINDS,
        repeatCooldownMs: 1_800_000,
        now: T0,
      },
      null,
    );

    const other = 'https://open.feishu.cn/open-apis/bot/v2/hook/zzzzzz999999';
    await writeNotifySettings(
      schema.pool,
      KEY,
      {
        enabled: true,
        webhookUrl: other,
        kinds: ALL_KINDS,
        repeatCooldownMs: 1_800_000,
        now: T0 + 1,
      },
      { webhookUrl: WEBHOOK, secret: 'sign-secret' },
    );

    const resolved = await resolveNotifySettings({
      pool: schema.pool,
      masterKey: KEY,
      config: CONFIG_OFF,
      env: {},
    });
    expect(resolved.settings.webhookUrl).toBe(other);
    expect(resolved.settings.secret).toBe('sign-secret');
  });

  it('只勾一部分内容时，读回来就是那几项', async () => {
    const picked = ['missing-stop-order', 'position-without-record'];
    await writeNotifySettings(
      schema.pool,
      KEY,
      {
        enabled: true,
        webhookUrl: WEBHOOK,
        kinds: picked,
        repeatCooldownMs: 1_800_000,
        now: T0,
      },
      null,
    );

    const status = await readNotifyStatus({
      pool: schema.pool,
      masterKey: KEY,
      config: CONFIG_OFF,
      env: {},
    });
    expect(status.kinds).toEqual(picked);
    expect(status.panel?.kinds).toEqual(picked);
  });

  it('勾了「清除签名密钥」就把签名清掉，地址照旧', async () => {
    await writeNotifySettings(
      schema.pool,
      KEY,
      {
        enabled: true,
        webhookUrl: WEBHOOK,
        secret: 'sign-secret',
        kinds: ALL_KINDS,
        repeatCooldownMs: 1_800_000,
        now: T0,
      },
      null,
    );

    await writeNotifySettings(
      schema.pool,
      KEY,
      {
        enabled: true,
        webhookUrl: '',
        clearSecret: true,
        kinds: ALL_KINDS,
        repeatCooldownMs: 1_800_000,
        now: T0 + 1,
      },
      { webhookUrl: WEBHOOK, secret: 'sign-secret' },
    );

    const resolved = await resolveNotifySettings({
      pool: schema.pool,
      masterKey: KEY,
      config: CONFIG_OFF,
      env: {},
    });
    expect(resolved.settings.webhookUrl).toBe(WEBHOOK);
    expect(resolved.settings.secret).toBe('');
  });

  it('第一次保存必须给地址（留空表示「保持原样」，而还没有原样可保持）', async () => {
    await expect(
      writeNotifySettings(
        schema.pool,
        KEY,
        {
          enabled: true,
          webhookUrl: '',
          kinds: ALL_KINDS,
          repeatCooldownMs: 1_800_000,
          now: T0,
        },
        null,
      ),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('不是飞书形状的地址被当场拒绝（不等到推送时才暴露）', async () => {
    await expect(
      writeNotifySettings(
        schema.pool,
        KEY,
        {
          enabled: true,
          webhookUrl: 'https://open.feishu.cn/document/home/index',
          kinds: ALL_KINDS,
          repeatCooldownMs: 1_800_000,
          now: T0,
        },
        null,
      ),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('主密钥换过时报错，不把解不开的密文当成「没配」', async () => {
    await writeNotifySettings(
      schema.pool,
      KEY,
      {
        enabled: true,
        webhookUrl: WEBHOOK,
        kinds: ALL_KINDS,
        repeatCooldownMs: 1_800_000,
        now: T0,
      },
      null,
    );

    await expect(
      resolveNotifySettings({
        pool: schema.pool,
        masterKey: OTHER_KEY,
        config: CONFIG_OFF,
        env: {},
      }),
    ).rejects.toBeInstanceOf(SyncError);
  });
});

describe('通知设置：schema 闸门', () => {
  it('未知的通知内容写不进库（schema 的 CHECK 挡住了）', async () => {
    await expect(
      schema.pool.query(
        `INSERT INTO notify_settings (id, enabled, iv, auth_tag, ciphertext, key_hint,
                                    kinds, repeat_cooldown_ms, updated_at)
         VALUES (1, false, ''::bytea, ''::bytea, ''::bytea, '', ARRAY['fatal']::text[], 1000, 1)`,
      ),
    ).rejects.toThrow();
  });

  it('「Agent 提示词」这一种**写得进库**（迁移 020 扩了枚举）', async () => {
    // 它与「未知的通知内容」只差一个迁移：写不进去就说明 schema 忘了扩。
    await expect(
      schema.pool.query(
        `INSERT INTO notify_settings (id, enabled, iv, auth_tag, ciphertext, key_hint,
                                    kinds, repeat_cooldown_ms, updated_at)
         VALUES (1, false, ''::bytea, ''::bytea, ''::bytea, '', ARRAY['agent-prompt']::text[], 1000, 1)`,
      ),
    ).resolves.toBeDefined();
  });

  it('新插入的行**默认不勾**提示词镜像（提示词带着账户权益，不能默认就发）', async () => {
    // 不给 kinds，用列的默认值
    await schema.pool.query(
      `INSERT INTO notify_settings (id, enabled, iv, auth_tag, ciphertext, key_hint,
                                    repeat_cooldown_ms, updated_at)
       VALUES (1, false, ''::bytea, ''::bytea, ''::bytea, '', 1000, 1)`,
    );
    const row = await schema.pool.query<{ kinds: string[] }>('SELECT kinds FROM notify_settings');
    expect(row.rows[0]?.kinds ?? []).not.toContain(AGENT_PROMPT_KIND);
  });

  it('负的冷却时间写不进库', async () => {
    await expect(
      schema.pool.query(
        `INSERT INTO notify_settings (id, enabled, iv, auth_tag, ciphertext, key_hint,
                                    kinds, repeat_cooldown_ms, updated_at)
         VALUES (1, false, ''::bytea, ''::bytea, ''::bytea, '', ARRAY[]::text[], -1, 1)`,
      ),
    ).rejects.toThrow();
  });

  it('单行表：第二行写不进去', async () => {
    await expect(
      schema.pool.query(
        `INSERT INTO notify_settings (id, enabled, iv, auth_tag, ciphertext, key_hint,
                                    kinds, repeat_cooldown_ms, updated_at)
         VALUES (2, false, ''::bytea, ''::bytea, ''::bytea, '', ARRAY[]::text[], 1000, 1)`,
      ),
    ).rejects.toThrow();
  });
});

describe('通知设置：测试发送用的地址', () => {
  it('取得到当前生效的地址（测试发送不关心开关）', async () => {
    await writeNotifySettings(
      schema.pool,
      KEY,
      {
        enabled: false,
        webhookUrl: WEBHOOK,
        kinds: ALL_KINDS,
        repeatCooldownMs: 1_800_000,
        now: T0,
      },
      null,
    );

    const { target, source } = await readNotifyTarget({
      pool: schema.pool,
      masterKey: KEY,
      config: CONFIG_OFF,
      env: {},
    });
    expect(source).toBe('panel');
    expect(target?.webhookUrl).toBe(WEBHOOK);
  });
});
