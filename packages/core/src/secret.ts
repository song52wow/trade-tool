/**
 * 凭据的**静态加密**（v0.5.0）。
 *
 * 仓库原本的规矩是「凭据只从环境变量读，配置文件里只写变量名」
 * （`executorSchema.apiKeyEnv`）。控制面改成可以录入密钥之后，这条规矩没有消失，
 * 而是换了落点：密钥进数据库，但**进的是密文**，主密钥仍然只从环境变量来。
 *
 * 两者的分工必须说清楚，否则「加密了」会被当成「安全了」：
 *   * 密文躺在 PG 里 —— 数据库被整个拖走时，攻击者拿不到可用的密钥；
 *   * 主密钥在进程环境里 —— 拿到**运行中进程**的攻击者仍然能解。
 * 后者不是缺陷，是任何静态加密都绕不开的边界。所以这个模块只承诺前者。
 *
 * 纯函数：不读时钟、不做 IO、不用随机数以外的隐藏状态（随机数只用于 IV）。
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { SyncError } from './market-sync.js';

/** 主密钥的环境变量名。与 `executorSchema.apiKeyEnv` 同一套约定：**配置里只写变量名**。 */
export const SECRET_KEY_ENV = 'TRADE_TOOL_SECRET_KEY';

/** AES-256-GCM 的固定参数。IV 长度由规范定死 12 字节，短了会退化。 */
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface SealedPayload {
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

/**
 * 解析主密钥。
 *
 * 接受 64 位 hex 或 44 位 base64（32 字节）。**长度不对一律抛错**：
 * 用一个被截断的密钥「凑合着加密」是最坏的结果——它看起来在工作，
 * 但强度只剩截断后那几字节，而没有任何地方会提示你。
 */
export function parseSecretKey(raw: string | undefined, envName = SECRET_KEY_ENV): Buffer {
  if (raw === undefined || raw.trim() === '') {
    throw new SyncError(
      'CONFIG_INVALID',
      `缺少凭据主密钥环境变量 ${envName}。` +
        `请生成一个（openssl rand -hex 32）并写进仓库根 .env。`,
      { env: envName },
    );
  }
  const text = raw.trim();
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(text)) {
    key = Buffer.from(text, 'hex');
  } else {
    key = Buffer.from(text, 'base64');
  }
  if (key.length !== KEY_BYTES) {
    throw new SyncError(
      'CONFIG_INVALID',
      `${envName} 必须是 ${KEY_BYTES} 字节（64 位 hex 或 44 位 base64），收到 ${key.length} 字节。` +
        `不要截断它——那会让加密看起来在工作而强度只剩残余的那几字节。`,
      { env: envName, gotBytes: key.length },
    );
  }
  return key;
}

/**
 * 加密。
 *
 * **每次调用都重新随机 IV**：GCM 下 IV 复用会直接摧毁机密性与完整性，
 * 这不是「稍微弱一点」而是「等同没有加密」。IV 不需要保密，只要求不重复。
 */
export function seal(plaintext: Buffer, key: Buffer): SealedPayload {
  if (key.length !== KEY_BYTES) {
    throw new SyncError('CONFIG_INVALID', `主密钥必须是 ${KEY_BYTES} 字节`, { got: key.length });
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, authTag: cipher.getAuthTag(), ciphertext };
}

/**
 * 解密。
 *
 * 认证标签对不上时**必须抛错**，不能返回明文或空值：密文被改过、或主密钥换了，
 * 这两种情况下的正确动作都是「停下来让人处理」，而不是继续拿着一段垃圾去签名
 * 下单请求（那会变成一批必然失败的真实订单）。
 */
export function open_(payload: SealedPayload, key: Buffer): Buffer {
  if (key.length !== KEY_BYTES) {
    throw new SyncError('CONFIG_INVALID', `主密钥必须是 ${KEY_BYTES} 字节`, { got: key.length });
  }
  if (payload.iv.length !== IV_BYTES || payload.authTag.length !== TAG_BYTES) {
    throw new SyncError(
      'CONFIG_INVALID',
      `密文元数据长度不对：iv=${payload.iv.length}（应为 ${IV_BYTES}），` +
        `tag=${payload.authTag.length}（应为 ${TAG_BYTES}）`,
    );
  }
  const decipher = createDecipheriv(ALGORITHM, key, payload.iv);
  decipher.setAuthTag(payload.authTag);
  try {
    return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
  } catch (error) {
    throw new SyncError(
      'CONFIG_INVALID',
      '凭据解密失败：认证标签不匹配。可能是主密钥换过，或密文被修改过。' +
        '请重新在控制面录入凭据——不要绕过这个错误。',
      { cause: (error as Error).message },
    );
  }
}

/**
 * 可展示的 key 末 4 位。
 *
 * 纯展示用，**不是机密**：它存在的唯一目的是让人确认「配的是哪一把」，
 * 省得换了一把之后完全看不出来。api_key 前缀本来就是公开信息。
 */
export function keyHint(apiKey: string): string {
  return apiKey.slice(-4);
}

/** 明文凭证的形状。与 `core/types.ts` 的 `Credentials` 一致，但这里多一层 JSON 序列化。 */
export interface SecretCredentials {
  apiKey: string;
  apiSecret: string;
}

/** 打包成一段 JSON 再加密：GCM 的认证标签覆盖整段，两项一起校验，省一份元数据。 */
export function sealCredentials(creds: SecretCredentials, key: Buffer): SealedPayload {
  return seal(Buffer.from(JSON.stringify(creds), 'utf8'), key);
}

export function openCredentials(payload: SealedPayload, key: Buffer): SecretCredentials {
  const parsed = JSON.parse(open_(payload, key).toString('utf8')) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as SecretCredentials).apiKey !== 'string' ||
    typeof (parsed as SecretCredentials).apiSecret !== 'string'
  ) {
    // 解开了但内容不是凭证：说明这段密文不是这个模块写的，必须暴露而不是当空值用。
    throw new SyncError('CONFIG_INVALID', '凭据密文解开后不是 {apiKey, apiSecret} 结构');
  }
  return parsed as SecretCredentials;
}
