#!/usr/bin/env node
import { loadProjectEnv, resolveConfigPath } from '@trade-tool/core';
import { findRepoRoot } from '@trade-tool/data';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from './server.js';
import { createWebRuntime, loadConfigOrDefault } from './service.js';

// 必须在任何读 process.env 的代码之前：密码与 TRADE_TOOL_HOME 都来自 .env。
loadProjectEnv();

const HOST_ENV = 'TRADE_TOOL_WEB_HOST';
const PORT_ENV = 'TRADE_TOOL_WEB_PORT';
/**
 * 默认**只监听回环**（R-24.8 / N-7）：本期不做鉴权 / 多用户，而控制面能触发首次全量、
 * 也能读库里的全部数据——默认绑到 `0.0.0.0` 等于把一个无认证的控制面交给整个局域网。
 * 确实需要局域网访问时，由使用者在 `.env` 里显式写 `TRADE_TOOL_WEB_HOST=0.0.0.0`
 * （`.env.example` 有说明），那是知情选择，而不是默认值。
 */
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`${PORT_ENV} 必须是 1-65535 的整数，收到：${raw}`);
  }
  return port;
}

/**
 * 定位前端产物。两个候选覆盖两种运行方式：
 * - 生产：`dist/main.js` 与 `dist/ui/` 同级，`import.meta.url` 一跳就到；
 * - dev（tsx 直跑 `src/main.ts`）：产物在仓库里 `apps/web/dist/ui`。
 * 都不存在时返回 null，交给路由如实报「先构建」，不静默返回空白页。
 */
function resolveUiDir(): string | null {
  const candidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), 'ui'),
    resolve(findRepoRoot(), 'apps/web/dist/ui'),
  ];
  return candidates.find((dir) => existsSync(resolve(dir, 'index.html'))) ?? null;
}

async function main(): Promise<void> {
  const config = await loadConfigOrDefault(resolveConfigPath());
  const runtime = createWebRuntime(config);
  await runtime.assertSchema();

  const uiDir = resolveUiDir();
  const app = buildApp(runtime);
  // 访问日志：控制面会自己发轮询请求，出问题时第一手证据就是「请求到底有没有到」。
  app.use('*', logger());

  if (uiDir === null) {
    app.get('/', (c) =>
      c.json(
        {
          error: {
            code: 'UI_NOT_BUILT',
            message: '前端产物不存在：先跑 `pnpm build`（或开发时用 `pnpm dev:ui` 起 Vite）',
          },
        },
        503,
      ),
    );
  } else {
    app.use('/*', serveStatic({ root: uiDir, rewriteRequestPath: (p) => p }));
    // 前端没有客户端路由（单页、无 URL 状态），因此**不存在**需要回退到 index.html 的路径。
    // 这条兜底只服务一个目的：未命中的非 /api 路径如实回 404，而不是把 index.html
    // 当成「什么都能匹配」的答案回给一个要 CSS / 图片 / 数据的请求。
    app.get('*', (c) => c.text('', 404));
  }

  const host = process.env[HOST_ENV] ?? DEFAULT_HOST;
  const port = readPort(process.env[PORT_ENV]);

  const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
    const lines = [
      `trade-tool 控制面已启动：http://${host}:${info.port}`,
      `  配置    ${resolveConfigPath()}`,
      `  前端    ${uiDir ?? '<未构建>'}`,
      `  监听    ${host}:${info.port}（无鉴权；非回环地址时局域网内可访问）`,
    ];
    console.log(lines.join('\n'));
  });

  const shutdown = async (signal: string) => {
    console.error(`\n收到 ${signal}，关闭控制面…`);
    server.close();
    await runtime.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

await main();
