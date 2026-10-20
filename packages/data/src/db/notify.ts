/**
 * 飞书通知通道的运行期设置（v0.8.0）。
 *
 * 回答一个问题：**通知到底该按哪一份设置推？**
 *
 * 有两档，来源不同、优先级明确：
 *
 *   1. **控制面录入**（库里那一份，密文落库）——有行、且行里有地址、且主密钥可用；
 *   2. **配置文件 + 环境变量**（`notify` 段 + `TRADE_TOOL_FEISHU_WEBHOOK_URL`）——其余情况。
 *
 * 优先级只有这一份实现（同 `resolveActiveCredentials` 的做法）：两处各判一次的话，
 * 「哪一份在生效」就有两个答案，而那正是排障时第一个要回答的问题。
 * 因此**所有出口都从 `resolveAll()` 出发**，谁也不许自己再判一次。
 *
 * **面板那一档是整体的**：地址、开关、参数要么一起生效，要么一起不生效。
 * 拆开用（地址走面板、开关走文件）会让「界面显示的和实际发生的不一致」——
 * 正是这个仓库反复在治的病。
 *
 * 表结构在 `sql/011_notify_settings.sql`，本模块不另持影子定义。
 */

import {
  RECONCILE_KINDS,
  SyncError,
  keyHint,
  openNotifyTarget,
  sealNotifyTarget,
  type NotifyConfig,
  type NotifySettings,
  type ReconcileKind,
  type SecretNotifyTarget,
} from '@trade-tool/core';

import { toSyncError } from './errors.js';
import type { Pool } from './pool.js';

const TABLE = 'notify_settings';
const SINGLETON_ID = 1;

/** 面板录入的那一档的状态。**没有明文**——控制面从设计上就没有回显它的能力。 */
export interface NotifyPanelState {
  /** 行里有没有地址。空串 = 用户主动清空过，与「从未配置」必须分开。 */
  configured: boolean;
  /** 地址末 4 位，纯展示用，不是机密。 */
  hint: string | null;
  enabled: boolean;
  /** 要通知哪些内容（交易对账的差异类型）。空数组 = 一样都不推。 */
  kinds: readonly string[];
  repeatCooldownMs: number;
  updatedAt: number | null;
  /**
   * 有没有配签名密钥。
   *
   * `null` = **读不到**（主密钥没注入，解不开密文）。这时候必须说「不知道」，
   * 而不能说「没配」——后者是猜测，而页面会照着它显示。
   */
  secretConfigured: boolean | null;
}

/** 控制面看到的完整状态。 */
export interface NotifyStatus {
  /** 生效的那一档：开关、参数、地址在不在。 */
  enabled: boolean;
  /** 生效的那一档**要通知哪些内容**（交易对账的差异类型）。 */
  kinds: readonly string[];
  repeatCooldownMs: number;
  /** 生效的那一档有没有地址。 */
  configured: boolean;
  hint: string | null;
  secretConfigured: boolean;
  /** 生效来源。`panel` = 控制面录入；`config` = 配置文件 + 环境变量。 */
  source: 'panel' | 'config';
  /** 生效来源是 `config` 时，地址取自哪个环境变量（排障要看）。 */
  webhookEnv: string;
  secretEnv: string;
  /**
   * 面板那一档的状态。**无论它是否生效都在这里**——
   * 「面板里配过、但当前生效的是配置文件那一档」必须看得见，
   * 否则用户会以为改了面板就一定在推。
   */
  panel: NotifyPanelState | null;
  updatedAt: number | null;
}

interface NotifyRow {
  id: number;
  enabled: boolean;
  iv: Buffer;
  auth_tag: Buffer;
  ciphertext: Buffer;
  key_hint: string;
  kinds: string[];
  repeat_cooldown_ms: number;
  updated_at: string | number;
}

function asBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new SyncError('NULL_NOT_ALLOWED', '通知密文的二进制列类型不对', { type: typeof value });
}

function asTimestamp(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

/**
 * 库里那一列的取值。
 *
 * 取值范围由 schema 的 CHECK 钉住（`kinds <@ 允许集合`），但**这里仍要再查一遍**：
 * 库里出现了未知的内容种类，说明表被改过或迁移漏了一步——暴露出来，
 * 而不是悄悄把它当成「不通知」。
 */
function asKinds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new SyncError('CONFIG_INVALID', '通知设置里的 kinds 不是数组', { value });
  }
  for (const item of value) {
    if (typeof item !== 'string' || !RECONCILE_KINDS.includes(item as ReconcileKind)) {
      throw new SyncError('CONFIG_INVALID', `库里出现了未知的内容种类：${String(item)}`, { value });
    }
  }
  return value as string[];
}

async function readRow(pool: Pool): Promise<NotifyRow | null> {
  try {
    const result = await pool.query<NotifyRow>(
      `SELECT id, enabled, iv, auth_tag, ciphertext, key_hint, kinds,
              repeat_cooldown_ms, updated_at
         FROM ${TABLE} WHERE id = $1`,
      [SINGLETON_ID],
    );
    return result.rows[0] ?? null;
  } catch (error) {
    throw toSyncError(error, '读取通知设置失败');
  }
}

/** 解密出地址。**解密失败必须抛错**，不能当成「没配」——那会让一个配好的通道凭空消失。 */
function decryptTarget(row: NotifyRow, masterKey: Buffer): SecretNotifyTarget {
  return openNotifyTarget(
    {
      iv: asBuffer(row.iv),
      authTag: asBuffer(row.auth_tag),
      ciphertext: asBuffer(row.ciphertext),
    },
    masterKey,
  );
}

/** 解析的全部结果。**所有出口都从这里派生**，谁也不许自己再判一次「哪一份在生效」。 */
interface Resolution {
  source: 'panel' | 'config';
  /** 生效那一档的地址；没有地址时是 null（不是空串，也不是一个假地址）。 */
  target: SecretNotifyTarget | null;
  enabled: boolean;
  kinds: readonly string[];
  repeatCooldownMs: number;
  panel: NotifyPanelState | null;
  updatedAt: number | null;
}

async function resolveAll(options: {
  pool: Pool;
  masterKey: Buffer | null;
  config: NotifyConfig;
  env: NodeJS.ProcessEnv;
}): Promise<Resolution> {
  const { pool, masterKey, config, env } = options;
  const row = await readRow(pool);

  const hasAddress = row !== null && row.key_hint !== '';
  if (row !== null && hasAddress && masterKey !== null) {
    const target = decryptTarget(row, masterKey);
    return {
      source: 'panel',
      target,
      enabled: row.enabled,
      kinds: asKinds(row.kinds),
      repeatCooldownMs: row.repeat_cooldown_ms,
      panel: {
        configured: true,
        hint: row.key_hint,
        enabled: row.enabled,
        kinds: asKinds(row.kinds),
        repeatCooldownMs: row.repeat_cooldown_ms,
        updatedAt: asTimestamp(row.updated_at),
        secretConfigured: target.secret !== '',
      },
      updatedAt: asTimestamp(row.updated_at),
    };
  }

  // 配置文件 + 环境变量那一档。
  const webhookUrl = (env[config.webhookEnv] ?? '').trim();
  const secret = (env[config.secretEnv] ?? '').trim();
  return {
    source: 'config',
    target: webhookUrl === '' ? null : { webhookUrl, secret },
    enabled: config.enabled,
    kinds: config.kinds,
    repeatCooldownMs: config.repeatCooldownMs,
    panel:
      row === null
        ? null
        : {
            configured: hasAddress,
            hint: hasAddress ? row.key_hint : null,
            enabled: row.enabled,
            kinds: asKinds(row.kinds),
            repeatCooldownMs: row.repeat_cooldown_ms,
            updatedAt: asTimestamp(row.updated_at),
            // 主密钥没注入就读不出签名密钥有没有配——如实说「不知道」，
            // 而不是说「没配」（后者是猜测，而页面会照着它显示）。
            secretConfigured: hasAddress ? null : false,
          },
    updatedAt: null,
  };
}

/**
 * 解析**当前生效**的设置（含明文地址）。
 *
 * 只给需要真的发消息的人用：executor。其余读路径一律走 `readNotifyStatus`（没有明文）。
 */
export async function resolveNotifySettings(options: {
  pool: Pool;
  /** 主密钥。没注入就读不到面板那一档（与交易所凭据同一套理由）。 */
  masterKey: Buffer | null;
  /** 配置文件里的 `notify` 段（没有面板那一档时的兜底）。 */
  config: NotifyConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{ settings: NotifySettings; source: 'panel' | 'config' }> {
  const env = options.env ?? process.env;
  const resolved = await resolveAll({ ...options, env });

  if (resolved.source === 'config' && resolved.enabled && resolved.target === null) {
    throw new SyncError(
      'CONFIG_INVALID',
      `notify.enabled = true，但环境变量 ${options.config.webhookEnv} 未设置或为空——` +
        '飞书 webhook 地址只能从环境变量或控制面录入来（它是凭据，不能写进配置文件）。' +
        '请在 .env 里填上该地址，在控制面「设置」页录入，或把 notify.enabled 改回 false。',
      { webhookEnv: options.config.webhookEnv },
    );
  }

  return {
    source: resolved.source,
    settings: {
      enabled: resolved.enabled,
      webhookUrl: resolved.target?.webhookUrl ?? '',
      secret: resolved.target?.secret ?? '',
      kinds: resolved.kinds,
      repeatCooldownMs: resolved.repeatCooldownMs,
    },
  };
}

/**
 * 控制面用的状态。**没有明文**，也不带密文。
 *
 * 主密钥没注入时，面板那一档仍然读得到（`key_hint` 是明文列），
 * 但它**不是**生效来源——页面据此显示「配过，但当前没在用这一档」。
 */
export async function readNotifyStatus(options: {
  pool: Pool;
  masterKey: Buffer | null;
  config: NotifyConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<NotifyStatus> {
  const env = options.env ?? process.env;
  const resolved = await resolveAll({ ...options, env });
  const target = resolved.target;

  return {
    enabled: resolved.enabled,
    kinds: resolved.kinds,
    repeatCooldownMs: resolved.repeatCooldownMs,
    configured: target !== null,
    hint: target === null ? null : keyHint(target.webhookUrl),
    secretConfigured: (target?.secret ?? '') !== '',
    source: resolved.source,
    webhookEnv: options.config.webhookEnv,
    secretEnv: options.config.secretEnv,
    panel: resolved.panel,
    updatedAt: resolved.updatedAt,
  };
}

/**
 * 取「当前可用的地址」，**不关心开关**。只给「发送测试消息」用。
 *
 * 测试的意义恰恰是「开关还没打开时先确认通道通不通」，
 * 所以它不能因为 `enabled = false` 就拒绝发送。
 */
export async function readNotifyTarget(options: {
  pool: Pool;
  masterKey: Buffer | null;
  config: NotifyConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{ target: SecretNotifyTarget | null; source: 'panel' | 'config' }> {
  const env = options.env ?? process.env;
  const resolved = await resolveAll({ ...options, env });
  return { target: resolved.target, source: resolved.source };
}

export interface NotifyWriteInput {
  enabled: boolean;
  /** 非空 = 替换地址；空 = 保留已存的（第一次保存时必填）。 */
  webhookUrl: string;
  /** 非空 = 替换签名密钥；缺省 = 保留。 */
  secret?: string | undefined;
  /** 显式清除签名密钥。 */
  clearSecret?: boolean;
  /** 要通知哪些内容（交易对账的差异类型）。空数组 = 一样都不推。 */
  kinds: readonly string[];
  repeatCooldownMs: number;
  now: number;
}

/**
 * 校验 webhook 地址。
 *
 * 只认官方那一种形状：太宽松会让「把群链接贴进来了」这种错误存进去，
 * 而它要到真正推送时才暴露（那时错误已经隔了很远）；太严会挡掉自建代理。
 */
export function assertWebhookUrl(url: string): void {
  const text = url.trim();
  if (text === '') {
    throw new SyncError('CONFIG_INVALID', 'webhook 地址不能为空');
  }
  if (!text.startsWith('https://')) {
    throw new SyncError(
      'CONFIG_INVALID',
      'webhook 地址必须以 https:// 开头（它是一个凭据，只走加密的 https 通道）',
    );
  }
  if (!text.includes('/open-apis/bot/v2/hook/')) {
    throw new SyncError(
      'CONFIG_INVALID',
      '这不像是飞书自定义机器人的 webhook 地址。' +
        '正确形状是 https://open.feishu.cn/open-apis/bot/v2/hook/<token>，' +
        '在群「设置 → 群机器人 → 添加机器人 → 自定义机器人」里复制。',
    );
  }
}

/**
 * 写入（或覆盖）通知设置。
 *
 * `ON CONFLICT DO UPDATE` 而不是 DO NOTHING：这是一次**明确的用户操作**，
 * 「保存」就必须真的写进去，静默保留旧值会让用户以为已经换过了。
 *
 * `current` 是**当前生效的地址**（面板那一档或环境变量那一档，由调用方解析）。
 * 它让「留空 = 保持原样」在两种来源下都成立：用户不必把环境变量里的地址
 * 抄一遍才能保存开关与参数。
 *
 * 返回值刻意是 `void`：写完之后的状态一律由 `readNotifyStatus` 重新读出来。
 * 在这里拼一个「刚写完的状态」回去，等于多一份可能与库里不一致的副本。
 */
export async function writeNotifySettings(
  pool: Pool,
  masterKey: Buffer,
  input: NotifyWriteInput,
  current: SecretNotifyTarget | null,
): Promise<void> {
  const given = input.webhookUrl.trim();
  if (given !== '') assertWebhookUrl(given);

  // 「留空 = 保持原样」的三条规则，页面上的提示与这段代码必须一致：
  //   * 填了新地址 → 换地址；签名密钥填了就换，没填就保留原来的；
  //   * 没填地址 → 地址与签名密钥都保留，只改开关与参数；
  //   * 勾了「清除签名密钥」→ 签名密钥清掉，地址照旧。
  let target: SecretNotifyTarget | null = current;
  if (given !== '') {
    const typed = (input.secret ?? '').trim();
    const secret = input.clearSecret ? '' : typed !== '' ? typed : (current?.secret ?? '');
    target = { webhookUrl: given, secret };
  } else if (input.clearSecret) {
    if (current === null) {
      throw new SyncError('CONFIG_INVALID', '还没有配置过签名密钥，没什么可清除的');
    }
    target = { webhookUrl: current.webhookUrl, secret: '' };
  }

  if (target === null) {
    throw new SyncError(
      'CONFIG_INVALID',
      '第一次保存必须填 webhook 地址——' + '留空表示「保持原样」，而现在还没有原样可保持。',
    );
  }

  const sealed = sealNotifyTarget(target, masterKey);
  try {
    const result = await pool.query<{ key_hint: string; updated_at: string | number }>(
      `INSERT INTO ${TABLE}
         (id, enabled, iv, auth_tag, ciphertext, key_hint, kinds, repeat_cooldown_ms, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE
         SET enabled = EXCLUDED.enabled,
             iv = EXCLUDED.iv,
             auth_tag = EXCLUDED.auth_tag,
             ciphertext = EXCLUDED.ciphertext,
             key_hint = EXCLUDED.key_hint,
             kinds = EXCLUDED.kinds,
             repeat_cooldown_ms = EXCLUDED.repeat_cooldown_ms,
             updated_at = EXCLUDED.updated_at
       RETURNING key_hint, updated_at`,
      [
        SINGLETON_ID,
        input.enabled,
        sealed.iv,
        sealed.authTag,
        sealed.ciphertext,
        keyHint(target.webhookUrl),
        input.kinds,
        input.repeatCooldownMs,
        input.now,
      ],
    );
    if (result.rows[0] === undefined) {
      throw new SyncError('CONFIG_INVALID', '写入通知设置后没有拿到回写行');
    }
  } catch (error) {
    if (error instanceof SyncError) throw error;
    throw toSyncError(error, '写入通知设置失败');
  }
}

/**
 * 清空通知配置。
 *
 * 留下 tombstone 行（地址清空、开关关掉）而不是 DELETE：
 * `updatedAt` 变新、页面能显示「已清空」，不会退回「从未配置」那种含糊状态。
 * 清完之后**生效来源回到「配置文件 + 环境变量」那一档**。
 */
export async function clearNotifySettings(pool: Pool, now: number): Promise<void> {
  try {
    await pool.query(
      `UPDATE ${TABLE} SET enabled = false, iv = ''::bytea, auth_tag = ''::bytea,
              ciphertext = ''::bytea, key_hint = '', updated_at = $2
        WHERE id = $1`,
      [SINGLETON_ID, now],
    );
  } catch (error) {
    throw toSyncError(error, '清空通知设置失败');
  }
}
