/**
 * 凭据静态加密的纯函数测试（不连 PG、不出网）。
 *
 * 锁的是四件「错了就出事」的事：
 *   * 往返一致；
 *   * **IV 每次都不同**（GCM 下复用 IV 直接摧毁安全性）；
 *   * 主密钥不对 / 密文被改 → **必须抛错**，绝不返回一段垃圾明文去签名下单请求；
 *   * 主密钥长度不对 → 启动即拒，绝不「凑合着加密」。
 */

import {
  SyncError,
  keyHint,
  open_,
  openCredentials,
  parseSecretKey,
  seal,
  sealCredentials,
} from '@trade-tool/core';
import { describe, expect, it } from 'vitest';

const KEY_A = Buffer.from('a'.repeat(64), 'hex');
const KEY_B = Buffer.from('b'.repeat(64), 'hex');

describe('parseSecretKey', () => {
  it('接受 64 位 hex 与 44 位 base64', () => {
    expect(parseSecretKey('a'.repeat(64)).length).toBe(32);
    expect(parseSecretKey(Buffer.alloc(32, 7).toString('base64')).length).toBe(32);
  });

  it('缺失时抛错，并把环境变量名说清楚', () => {
    expect(() => parseSecretKey(undefined)).toThrow(SyncError);
    expect(() => parseSecretKey(undefined)).toThrow(/TRADE_TOOL_SECRET_KEY/);
    expect(() => parseSecretKey('  ')).toThrow(SyncError);
  });

  it('长度不对一律拒绝，绝不截断后继续用', () => {
    // 截断的密钥「看起来在工作」但强度只剩残余那几字节——那是最坏的结果。
    expect(() => parseSecretKey('a'.repeat(32))).toThrow(/32 字节/);
    expect(() => parseSecretKey('a'.repeat(128))).toThrow(SyncError);
  });
});

describe('seal / open_', () => {
  it('往返一致', () => {
    const plain = Buffer.from('交易所私钥', 'utf8');
    expect(open_(seal(plain, KEY_A), KEY_A)).toEqual(plain);
  });

  it('同一明文两次加密的 IV 与密文都不同', () => {
    const plain = Buffer.from('same', 'utf8');
    const a = seal(plain, KEY_A);
    const b = seal(plain, KEY_A);
    expect(a.iv.toString('hex')).not.toBe(b.iv.toString('hex'));
    expect(a.ciphertext.toString('hex')).not.toBe(b.ciphertext.toString('hex'));
  });

  it('主密钥不对时抛错，而不是解出垃圾', () => {
    const sealed = seal(Buffer.from('secret', 'utf8'), KEY_A);
    expect(() => open_(sealed, KEY_B)).toThrow(SyncError);
  });

  it('密文被篡改时认证标签校验失败', () => {
    const sealed = seal(Buffer.from('secret', 'utf8'), KEY_A);
    const tampered = {
      ...sealed,
      ciphertext: Buffer.concat([sealed.ciphertext.subarray(0, -1), Buffer.from([0])]),
    };
    expect(() => open_(tampered, KEY_A)).toThrow(/解密失败/);
  });

  it('元数据长度不对时抛错', () => {
    expect(() =>
      open_({ iv: Buffer.alloc(8), authTag: Buffer.alloc(16), ciphertext: Buffer.alloc(4) }, KEY_A),
    ).toThrow(/长度不对/);
  });
});

describe('凭证打包', () => {
  it('往返得到 {apiKey, apiSecret}', () => {
    const creds = { apiKey: 'key-123', apiSecret: 'secret-456' };
    expect(openCredentials(sealCredentials(creds, KEY_A), KEY_A)).toEqual(creds);
  });

  it('解开后结构不对时报错，不当成空值放行', () => {
    const sealed = seal(Buffer.from('{"apiKey":"k"}', 'utf8'), KEY_A);
    expect(() => openCredentials(sealed, KEY_A)).toThrow(/不是 \{apiKey, apiSecret\}/);
  });
});

describe('keyHint', () => {
  it('取末 4 位', () => {
    expect(keyHint('abcdef123456')).toBe('3456');
  });

  it('短于 4 位时返回全部，不越界', () => {
    expect(keyHint('ab')).toBe('ab');
  });
});
