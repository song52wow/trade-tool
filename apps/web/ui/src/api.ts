import type { GapRecord, RemovePolicy, StoredInterval } from '@trade-tool/core';

import type {
  BarsDto,
  ExchangeListDto,
  JobDto,
  OverviewDto,
  SymbolDetailDto,
  SymbolRowDto,
} from '../../src/types';

/** 服务端错误一律带上 code，页面要显示它而不是笼统的「操作失败」。 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    /**
     * HTTP 状态码。与 `code` 分开：`code` 说的是**哪一类**错误，状态码能区分
     * 「服务端明确拒绝」（4xx 带 code）与「路由根本不存在」（404 且响应体不是本服务的
     * 错误体）——后者说明连的进程不是这份代码，提示必须不一样。
     */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' };

/**
 * 错误响应的正文**未必**是 JSON：Hono 对未注册的路由直接回一段纯文本 `404 Not Found`。
 * 让 `JSON.parse` 在那里抛错，等于把「这个进程没有这条路由」显示成一句
 * `Unexpected token 'o'`，把真正的原因彻底盖掉。
 */
function parseErrorBody(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, init);
  const text = await res.text();
  // 成功响应必须是 JSON：解析不了就是服务端违约，让它当场抛出来，而不是悄悄
  // 当成 null 传下去（AGENTS.md 第 9 条：不静默兜底）。
  const payload: unknown = res.ok ? (text === '' ? null : JSON.parse(text)) : parseErrorBody(text);
  if (!res.ok) {
    const err = (
      payload as {
        error?: { code: string; message: string; details?: Record<string, unknown> };
      }
    )?.error;
    throw new ApiError(
      err?.code ?? 'HTTP_ERROR',
      err?.message ?? `${res.status} ${res.statusText}`,
      err?.details,
      res.status,
    );
  }
  return payload as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, {
    method: 'POST',
    headers: JSON_HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

export const api = {
  overview: () => request<OverviewDto>('/api/overview'),
  symbols: () => request<{ items: SymbolRowDto[] }>('/api/symbols').then((r) => r.items),
  symbol: (s: string) => request<SymbolDetailDto>(`/api/symbols/${encodeURIComponent(s)}`),
  /**
   * 最近 limit 根 1m K 线（升序）。只读本地库，limit 超上限由服务端截断。
   *
   * 404 在这里单列，因为它的含义非常具体：路由是在**进程启动时**注册的，所以 404
   * 几乎总是「正在访问的控制面是改动前的旧进程」——前端已经是新的，后端还没重启。
   * 这与「库里没数据」（200 + 空数组）完全相反：前者要重启，后者要去同步。报一句
   * 笼统的 `404 Not Found`，用户根本判断不出该做哪件事。
   */
  bars: (s: string, limit: number, interval: StoredInterval = '1m') =>
    request<BarsDto>(
      `/api/symbols/${encodeURIComponent(s)}/bars?limit=${String(limit)}&interval=${interval}`,
    ).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404) {
        throw new ApiError(
          'CONTROL_PLANE_STALE',
          `控制面没有 /bars 路由：它还是改动前启动的旧进程。重启 trade-tool 控制面后刷新页面即可（页面本身已是新的）。`,
        );
      }
      throw error;
    }),
  exchange: (refresh = false) =>
    request<ExchangeListDto>(`/api/exchange${refresh ? '?refresh=true' : ''}`),
  addSymbol: (symbol: string) => post<SymbolRowDto>('/api/symbols', { symbol }),
  removeSymbol: (symbol: string, policy: RemovePolicy) =>
    request<{ ok: boolean }>(`/api/symbols/${encodeURIComponent(symbol)}`, {
      method: 'DELETE',
      headers: JSON_HEADERS,
      body: JSON.stringify({ policy }),
    }),
  lifecycle: (symbol: string, action: 'start' | 'pause' | 'resume') =>
    post<SymbolRowDto>(`/api/symbols/${encodeURIComponent(symbol)}/${action}`),
  gaps: (symbol: string) =>
    request<{ symbol: string; items: GapRecord[] }>(
      `/api/symbols/${encodeURIComponent(symbol)}/gaps`,
    ).then((r) => r.items),
  estimate: (symbol: string) =>
    request<{ symbol: string; estimate: NonNullable<SymbolDetailDto['estimate']> }>(
      `/api/symbols/${encodeURIComponent(symbol)}/estimate`,
    ).then((r) => r.estimate),
  startFull: (symbol: string, target: number) =>
    post<JobDto>(`/api/symbols/${encodeURIComponent(symbol)}/full`, { target }),
  startVerify: (symbol: string) =>
    post<JobDto>(`/api/symbols/${encodeURIComponent(symbol)}/verify`, { target: null }),
  /**
   * 重建派生 K 线（v0.2.0 R-7.6）。
   *
   * 走的是长任务通道：重建是几十分钟量级，HTTP 绝不能挂在原地等（202 + job id）。
   *
   * **刻意不传 target**（与 `verify` 一致）。作业进度读的是 `sync_state.rows`，
   * 而重建**不改 sync_state**（R-5.4）——把它同时当分子和分母，进度条会全程钉在
   * 100%：一边显示「已完成」一边还在跑，正是 R-7.6 禁止的假进度。读不到真实进度
   * 就如实不显示（页面显示「—」），而不是编一个百分比。
   */
  startAggregate: (symbol: string) =>
    post<JobDto>(`/api/symbols/${encodeURIComponent(symbol)}/aggregate`, { target: null }),
  jobs: () => request<{ items: JobDto[] }>('/api/jobs').then((r) => r.items),
};
