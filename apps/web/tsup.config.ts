import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/server.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    '@trade-tool/core',
    '@trade-tool/data',
    '@trade-tool/sync',
    'hono',
    '@hono/node-server',
  ],
  // 刻意**不用** `banner`：`src/main.ts` 自身已有 shebang，tsup 会把它保留到产物首行。
  // 再叠一个 banner 就得到两个 shebang，第二个落在第 2 行——Node 只在第 1 行识别 shebang，
  // 于是 `node apps/web/dist/main.js`（也是 package.json 的 `bin`）无条件抛 SyntaxError。
});
