/**
 * 模型接入的运行期设置（v1.0.0）。
 *
 * 回答一个问题：**模型到底接的是哪一家，密钥在哪**。
 *
 * 有两档，来源不同、优先级明确：
 *
 *   1. **控制面录入**（库里那一份，密文落库）——有行、行里填全了、主密钥可用；
 *   2. **配置文件 + 环境变量**（`agent.llm` 段 + `apiKeyEnv` 指的那个变量）——其余情况。
 *
 * 优先级只有这一份实现（同 `resolveNotifySettings` / `resolveActiveCredentials`
 * 的做法）：两处各判一次的话，「哪一份在生效」就有两个答案，
 * 而那正是排障时第一个要回答的问题。
 * 因此**所有出口都从 `resolveAll()` 出发**，谁也不许自己再判一次。
 *
 * **面板那一档是整体的**：开关、地址、模型、密钥要么一起生效，要么一起不生效。
 * 拆开用（地址走面板、开关走文件）会让「界面显示的和实际发生的不一致」。
 *
 * 表结构在 `sql/019_agent_llm_settings.sql`，本模块不另持影子定义。
 */

import {
  SyncError,
  keyHint,
  openAgentLlmKey,
  sealAgentLlmKey,
  type LlmEndpoint,
} from '@trade-tool/core';

import { toSyncError } from './errors.js';
import type { Pool } from './pool.js';

const TABLE = 'agent_llm_settings';
const SINGLETON_ID = 1;

/**
 * 生效的那一档。**含明文密钥**——只给真的要调模型的人用（agent 进程）。
 * 其余读路径一律走 `readAgentLlmStatus`（没有明文）。
 */
export interface AgentLlmSettings {
  enabled: boolean;
  baseUrl: string;
  model: string;
  /** 明文密钥。 */
  apiKey: string;
  timeoutMs: number;
}

/** 面板录入的那一档的状态。**没有明文密钥**——控制面从设计上就没有回显它的能力。 */
export interface AgentLlmPanelState {
  /** 行里填全了没有。空 = 用户主动清空过，与「从未配置」必须分开。 */
  configured: boolean;
  /** 密钥末 4 位，纯展示用，不是机密。 */
  hint: string | null;
  enabled: boolean;
  baseUrl: string | null;
  model: string | null;
  timeoutMs: number | null;
  updatedAt: number | null;
  /**
   * 有没有配密钥。
   *
   * `null` = **读不到**（主密钥没注入，解不开密文）。这时候必须说「不知道」，
   * 而不能说「没配」——后者是猜测，而页面会照着它显示。
   */
  keyConfigured: boolean | null;
}

/** 控制面看到的完整状态。 */
export interface AgentLlmStatus {
  /** 生效的那一档：开关、地址、模型、超时。 */
  enabled: boolean;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /** 生效来源。`panel` = 控制面录入；`config` = 配置文件 + 环境变量。 */
  source: 'panel' | 'config';
  /** 生效来源是 `config` 时，密钥取自哪个环境变量（排障要看）。 */
  apiKeyEnv: string;
  /**
   * 生效来源是 `config` 时，**那个环境变量里的密钥读到了没有**。
   *
   * `false` = 环境变量里没有密钥（或读不到）——这是**最常见的配置错误**，
   * 页面要显示出来（并说清去补哪个变量），而不是笼统的「设置操作失败」。
   *
   * 生效来源是 `panel` 时恒为 `true`（面板那一档的密钥是解开了才走到这一步的）。
   */
  configKeyAvailable: boolean;
  /**
   * 面板那一档的状态。**无论它是否生效都在这里**——
   * 「面板里配过、但当前生效的是配置文件那一档」必须看得见，
   * 否则用户会以为改了面板就一定在用。
   */
  panel: AgentLlmPanelState | null;
  updatedAt: number | null;
}

interface AgentLlmRow {
  id: number;
  enabled: boolean;
  base_url: string;
  model: string;
  timeout_ms: number;
  iv: Buffer;
  auth_tag: Buffer;
  ciphertext: Buffer;
  key_hint: string;
  updated_at: string | number;
}

function asBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new SyncError('NULL_NOT_ALLOWED', '模型密钥密文的二进制列类型不对', { type: typeof value });
}

function asTimestamp(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

async function readRow(pool: Pool): Promise<AgentLlmRow | null> {
  try {
    const result = await pool.query(`SELECT * FROM ${TABLE} WHERE id = $1`, [SINGLETON_ID]);
    const row = result.rows[0] as AgentLlmRow | undefined;
    return row === undefined ? null : row;
  } catch (error) {
    throw toSyncError(error, '读取模型设置失败');
  }
}

interface Resolution {
  source: 'panel' | 'config';
  settings: AgentLlmSettings;
  panel: AgentLlmPanelState | null;
  updatedAt: number | null;
}

/**
 * 「哪一份在生效」的唯一实现。
 *
 * 判据只有一条：**面板那一行填全了、且主密钥可用** → 用面板；
 * 否则 → 用配置文件那一档。
 *
 * 注意它**不看 `enabled`**：`enabled` 是那一档**内部**的开关，
 * 不是「选哪一档」的条件。面板填全了但 `enabled=false`，
 * 生效的仍然是面板那一档——只是模型被关掉了。
 * 把两者混起来会出现「面板关了模型，配置文件那一档又冒出来了」，
 * 于是「我在控制面关了模型，Agent 还在调模型」。
 */
async function resolveAll(options: {
  pool: Pool;
  masterKey: Buffer | null;
  config: LlmEndpoint;
  env: NodeJS.ProcessEnv;
  /**
   * 「只读状态」这条路上，**读不到密钥不抛错**。
   *
   * 为什么：配置文件的档开着、而环境变量里没密钥时，这是**最常见的配置错误**。
   * 若读状态也抛错，控制面整个面板就取不到东西，页面只显示一句
   * 「模型接入设置操作失败」——用户连「生效的是哪一份」都看不到，
   * 更不知道该去补哪个环境变量。
   *
   * **真要调模型时仍然抛错**（`resolveAgentLlmSettings` 那条路不传这个标志）——
   * 拿着空串去请求只会得到一个语焉不详的 401。
   */
  tolerateMissingKey?: boolean;
}): Promise<Resolution> {
  const { pool, masterKey, config, env } = options;
  const row = await readRow(pool);

  const panelFilled =
    row !== null && row.base_url.trim() !== '' && row.model.trim() !== '' && row.key_hint !== '';

  if (row !== null && panelFilled && masterKey !== null) {
    const opened = openAgentLlmKey(
      {
        iv: asBuffer(row.iv),
        authTag: asBuffer(row.auth_tag),
        ciphertext: asBuffer(row.ciphertext),
      },
      masterKey,
    );
    return {
      source: 'panel',
      settings: {
        enabled: row.enabled,
        baseUrl: row.base_url,
        model: row.model,
        apiKey: opened.apiKey,
        timeoutMs: row.timeout_ms,
      },
      panel: {
        configured: true,
        hint: row.key_hint,
        enabled: row.enabled,
        baseUrl: row.base_url,
        model: row.model,
        timeoutMs: row.timeout_ms,
        updatedAt: asTimestamp(row.updated_at),
        keyConfigured: opened.apiKey !== '',
      },
      updatedAt: asTimestamp(row.updated_at),
    };
  }

  // 配置文件那一档。密钥**只从环境变量读**（约定 2：配置文件里不写密钥本身）。
  //
  // 「只读状态」那条路上读不到密钥**不抛错**（见 `tolerateMissingKey`）：
  // 控制面要能显示「生效的是配置文件那一档，但环境变量里没有密钥」，
  // 而不是整个面板取不到东西。
  let apiKey = '';
  if (config.enabled) {
    try {
      apiKey = readKeyFromEnv(config.apiKeyEnv, env);
    } catch (error) {
      if (options.tolerateMissingKey !== true) throw error;
      apiKey = '';
    }
  }
  const panelState: AgentLlmPanelState | null =
    row === null
      ? null
      : {
          configured: panelFilled,
          hint: row.key_hint === '' ? null : row.key_hint,
          enabled: row.enabled,
          baseUrl: row.base_url === '' ? null : row.base_url,
          model: row.model === '' ? null : row.model,
          timeoutMs: row.timeout_ms,
          updatedAt: asTimestamp(row.updated_at),
          // 主密钥没注入就**读不到**密文内容：这时说「不知道」，
          // 而不是说「没配」——后者是猜测，而页面会照着它显示。
          keyConfigured: masterKey === null ? null : row.key_hint !== '',
        };

  return {
    source: 'config',
    settings: {
      enabled: config.enabled,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey,
      timeoutMs: config.timeoutMs,
    },
    panel: panelState,
    updatedAt: row === null ? null : asTimestamp(row.updated_at),
  };
}

/**
 * 从环境变量读密钥。**读不到就报错**，不用空串继续（约定 8）。
 *
 * 错误信息里带上环境变量名，让人一眼知道该配哪个。
 */
function readKeyFromEnv(envName: string, env: NodeJS.ProcessEnv): string {
  const value = env[envName];
  if (value === undefined || value.trim() === '') {
    throw new SyncError(
      'CONFIG_INVALID',
      `模型 API 密钥缺失：请在环境变量 ${envName} 里填上密钥（配置文件里只写变量名），` +
        '或在控制面「设置」页录入。',
      { envName },
    );
  }
  return value.trim();
}

/**
 * 真正要调模型的人用它（agent 进程）。**含明文密钥**。
 *
 * @throws SyncError 'CONFIG_INVALID' 生效来源是配置文件那一档、而密钥读不到。
 */
export async function resolveAgentLlmSettings(options: {
  pool: Pool;
  /** 主密钥。没注入就读不到面板那一档（与交易所凭据同一套理由）。 */
  masterKey: Buffer | null;
  /** 配置文件里的 `agent.llm` 段（没有面板那一档时的兜底）。 */
  config: LlmEndpoint;
  env?: NodeJS.ProcessEnv;
}): Promise<{ settings: AgentLlmSettings; source: 'panel' | 'config' }> {
  const resolved = await resolveAll({ ...options, env: options.env ?? process.env });
  return { source: resolved.source, settings: resolved.settings };
}

/**
 * 控制面用的状态。**没有明文密钥**，也不带密文。
 *
 * 主密钥没注入时，面板那一档仍然读得到（`key_hint` 是明文列），
 * 但它**不是**生效来源——页面据此显示「配过，但当前没在用这一档」。
 *
 * ⚠️ **读状态这条路不因「密钥读不到」而失败**：生效来源是配置文件那一档、
 * 而那个环境变量里没有密钥时，这是最常见的配置错误。若这里抛错，
 * 控制面整个面板就取不到东西，页面只显示一句「设置操作失败」——
 * 用户连「生效的是哪一份」都看不到，更不知道该去补哪个变量。
 * 这里把「读不到」如实报进 `configKeyAvailable`（真正的调模型那条路仍然抛错）。
 */
export async function readAgentLlmStatus(options: {
  pool: Pool;
  masterKey: Buffer | null;
  config: LlmEndpoint;
  env?: NodeJS.ProcessEnv;
}): Promise<AgentLlmStatus> {
  const resolved = await resolveAll({
    ...options,
    env: options.env ?? process.env,
    tolerateMissingKey: true,
  });
  return {
    enabled: resolved.settings.enabled,
    baseUrl: resolved.settings.baseUrl,
    model: resolved.settings.model,
    timeoutMs: resolved.settings.timeoutMs,
    source: resolved.source,
    apiKeyEnv: options.config.apiKeyEnv,
    // 生效来源是配置文件那一档时，密钥读到了没有（读不到 = 最常见的配置错误）。
    configKeyAvailable: resolved.source === 'panel' ? true : resolved.settings.apiKey !== '',
    panel: resolved.panel,
    updatedAt: resolved.updatedAt,
  };
}

/**
 * 读面板那一档**当前存着的值**（含明文密钥）。
 *
 * 只给「写入」用：写入时需要知道「留空 = 保持原样」的那个原样是什么。
 * 控制面读状态一律走 {@link readAgentLlmStatus}——它**没有**明文。
 *
 * 主密钥没注入时返回 `null`（读不到密文）。此时写入必须**重填**地址、模型与密钥，
 * 否则等于把它们清空。
 */
export async function readAgentLlmPanelTarget(options: {
  pool: Pool;
  masterKey: Buffer | null;
}): Promise<{ baseUrl: string; model: string; apiKey: string } | null> {
  if (options.masterKey === null) return null;
  const row = await readRow(options.pool);
  if (row === null) return null;
  const opened = openAgentLlmKey(
    {
      iv: asBuffer(row.iv),
      authTag: asBuffer(row.auth_tag),
      ciphertext: asBuffer(row.ciphertext),
    },
    options.masterKey,
  );
  return { baseUrl: row.base_url, model: row.model, apiKey: opened.apiKey };
}

export interface AgentLlmWriteInput {
  enabled: boolean;
  /** 非空 = 替换地址；空 = 保留已存的（第一次保存时必填）。 */
  baseUrl: string;
  /** 非空 = 替换模型名；空 = 保留已存的。 */
  model: string;
  /** 非空 = 替换密钥；缺省 = 保留。 */
  apiKey?: string | undefined;
  /** 显式清除密钥。 */
  clearApiKey?: boolean;
  timeoutMs: number;
  now: number;
}

/**
 * 写入（或覆盖）模型设置。
 *
 * `ON CONFLICT DO UPDATE` 而不是 DO NOTHING：这是一次**明确的用户操作**，
 * 「保存」就必须真的写进去，静默保留旧值会让用户以为已经换过了。
 *
 * 返回值刻意是 `void`：写完之后的状态一律由 `readAgentLlmStatus` 重新读出来。
 * 在这里拼一个「刚写完的状态」回去，等于多一份可能与库里不一致的副本。
 */
export async function writeAgentLlmSettings(
  pool: Pool,
  masterKey: Buffer,
  input: AgentLlmWriteInput,
  /**
   * 面板那一档**当前**存着的值。
   *
   * 它让「留空 = 保持原样」成立：用户不必把已有的地址、模型名、密钥
   * 抄一遍才能只改开关或超时。
   */
  current: { baseUrl: string; model: string; apiKey: string } | null,
): Promise<void> {
  const givenBaseUrl = input.baseUrl.trim();
  const givenModel = input.model.trim();
  const givenKey = (input.apiKey ?? '').trim();

  const baseUrl = givenBaseUrl !== '' ? givenBaseUrl : (current?.baseUrl ?? '');
  const model = givenModel !== '' ? givenModel : (current?.model ?? '');
  const apiKey =
    input.clearApiKey === true ? '' : givenKey !== '' ? givenKey : (current?.apiKey ?? '');

  // 开着就必须三件套齐全。**在这里报**，而不是等第一轮分析时才失败——
  // 那时候用户已经等了一轮，还不一定知道是配置问题。
  if (input.enabled && (baseUrl === '' || model === '' || apiKey === '')) {
    const missing: string[] = [];
    if (baseUrl === '') missing.push('API 地址');
    if (model === '') missing.push('模型名');
    if (apiKey === '') missing.push('API 密钥');
    throw new SyncError(
      'CONFIG_INVALID',
      `启用模型时必须填全：${missing.join('、')}。` +
        '密钥可以直接填在这里（它会加密落库，不会出现在配置文件或日志里）。',
      { missing },
    );
  }

  const sealed = sealAgentLlmKey({ apiKey }, masterKey);
  try {
    await pool.query(
      `INSERT INTO ${TABLE}
         (id, enabled, base_url, model, timeout_ms, iv, auth_tag, ciphertext, key_hint, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         base_url = EXCLUDED.base_url,
         model = EXCLUDED.model,
         timeout_ms = EXCLUDED.timeout_ms,
         iv = EXCLUDED.iv,
         auth_tag = EXCLUDED.auth_tag,
         ciphertext = EXCLUDED.ciphertext,
         key_hint = EXCLUDED.key_hint,
         updated_at = EXCLUDED.updated_at`,
      [
        SINGLETON_ID,
        input.enabled,
        baseUrl,
        model,
        input.timeoutMs,
        sealed.iv,
        sealed.authTag,
        sealed.ciphertext,
        apiKey === '' ? '' : keyHint(apiKey),
        input.now,
      ],
    );
  } catch (error) {
    throw toSyncError(error, '写入模型设置失败');
  }
}

/**
 * 清空面板那一档（退回配置文件 + 环境变量）。
 *
 * 删的是**面板录入的那一份**，不是「把模型关掉」。用户想关模型应该用开关。
 */
export async function clearAgentLlmSettings(pool: Pool): Promise<void> {
  try {
    await pool.query(`DELETE FROM ${TABLE} WHERE id = $1`, [SINGLETON_ID]);
  } catch (error) {
    throw toSyncError(error, '清空模型设置失败');
  }
}
