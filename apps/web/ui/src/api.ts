import type { GapRecord, RemovePolicy } from '@trade-tool/core';

import type {
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
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' };

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, init);
  const text = await res.text();
  const payload: unknown = text ? JSON.parse(text) : null;
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
  jobs: () => request<{ items: JobDto[] }>('/api/jobs').then((r) => r.items),
};
