/**
 * 写操作的来源校验（v0.5.0）。
 *
 * 这道闸门存在的原因是控制面**无鉴权且绑 0.0.0.0**，而它能写交易所密钥：
 * 浏览器里任何一个网页都能对 `http://<内网IP>:8787` 发跨站 POST，
 * 用户只要开着同一个浏览器，攻击者就能把密钥换成他的。
 *
 * 所以锁两条：跨源写必须被拒；非浏览器调用方（curl / CLI / executor）必须能过。
 */

import { describe, expect, it } from 'vitest';

import { checkOrigin } from '../src/csrf.js';

describe('checkOrigin', () => {
  const SELF = 'http://127.0.0.1:8787/api/settings/credentials';

  it('读操作一律放行', () => {
    expect(checkOrigin('GET', 'http://evil.example', SELF).ok).toBe(true);
    expect(checkOrigin('OPTIONS', 'http://evil.example', SELF).ok).toBe(true);
  });

  it('没有 Origin 头时放行（curl / CLI / executor）', () => {
    expect(checkOrigin('POST', undefined, SELF).ok).toBe(true);
    expect(checkOrigin('POST', '', SELF).ok).toBe(true);
  });

  it('同源写放行', () => {
    expect(checkOrigin('POST', 'http://127.0.0.1:8787', SELF).ok).toBe(true);
    expect(checkOrigin('PUT', 'http://mybox.lan:8787', 'http://mybox.lan:8787/api/x').ok).toBe(
      true,
    );
  });

  it('跨源写被拒——这正是要挡的那条路', () => {
    const result = checkOrigin('POST', 'http://evil.example', SELF);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/不同源/);
  });

  it('同 host 不同协议也算跨源（本服务只提供 http）', () => {
    expect(checkOrigin('POST', 'https://127.0.0.1:8787', SELF).ok).toBe(false);
  });

  it('Origin 不是合法 URL 时拒绝，而不是放行', () => {
    expect(checkOrigin('POST', 'not a url', SELF).ok).toBe(false);
  });

  it('端口不同不算同源', () => {
    expect(checkOrigin('POST', 'http://127.0.0.1:9999', SELF).ok).toBe(false);
  });
});
