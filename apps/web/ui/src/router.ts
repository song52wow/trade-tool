import { useSyncExternalStore } from 'react';

/**
 * hash 路由（不引入 react-router：仓库没有这个依赖，也不该为一个三页的控制面新增它）。
 *
 * 三条路由：
 *   `#/`              首页（概览 / 标的集合 / 作业）
 *   `#/symbol/<CODE>` 单标的详情
 *   `#/settings`      运行期设置（凭据 + 止盈止损策略）
 *
 * 走 hash 而不是 history API 的理由很实际：详情页要能被**收藏与分享**（复制地址栏就能
 * 回到同一个标的），而刷新后必须停在当前路由。hash 两条都天然满足，不需要服务端配合。
 */
export type Route = { kind: 'home' } | { kind: 'symbol'; symbol: string } | { kind: 'settings' };

export const HOME_PATH = '#/';
export const SETTINGS_PATH = '#/settings';

export function symbolPath(symbol: string): string {
  return `#/symbol/${encodeURIComponent(symbol)}`;
}

/**
 * 解析 hash。**认不出的一律回首页**，但不抛错、不吞异常：用户手敲一个错地址时，
 * 页面该有个明确落点，而不是一片空白。非法转义同样当首页处理。
 */
export function parseRoute(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  const parts = path.split('/').filter((p) => p !== '');
  if (parts.length === 0) return { kind: 'home' };
  if (parts[0] === 'settings' && parts.length === 1) return { kind: 'settings' };
  if (parts[0] === 'symbol' && parts.length === 2) {
    try {
      const symbol = decodeURIComponent(parts[1] ?? '');
      return symbol === '' ? { kind: 'home' } : { kind: 'symbol', symbol };
    } catch {
      return { kind: 'home' };
    }
  }
  return { kind: 'home' };
}

function readHash(): string {
  return typeof window === 'undefined' ? '' : window.location.hash;
}

const listeners = new Set<() => void>();
let cached: Route | null = null;
let listening = false;

/**
 * `hashchange` 只在**异步**事件里派发，页内点击切标的就会白白多一帧「内容还是旧的」。
 * 所以订阅时同时保留 hashchange（前进 / 后退 / 手改地址栏）与同步派发（页内导航）两条路。
 */
function emit(): void {
  cached = null;
  for (const listener of listeners) listener();
}

function bind(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('hashchange', emit);
}

function subscribe(listener: () => void): () => void {
  bind();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Route {
  if (cached === null) cached = parseRoute(readHash());
  return cached;
}

/** 页内导航：改 hash 并**立刻**通知订阅者，不必等异步的 hashchange。 */
export function navigate(path: string): void {
  if (typeof window === 'undefined') return;
  bind();
  if (window.location.hash !== path) window.location.hash = path;
  emit();
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
