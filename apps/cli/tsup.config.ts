import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['@trade-tool/core', '@trade-tool/data', '@trade-tool/backtest', 'commander'],
  // 刻意**不用** `banner`：`src/index.ts` 自身已有 shebang，tsup 会把它保留到产物首行。
  // 再叠一个 banner 就得到两个 shebang，第二个落在第 2 行——Node 只在第 1 行识别 shebang，
  // 于是 `node apps/cli/dist/index.js …`（AGENTS.md / apps/cli/README.md 记录的构建产物入口，
  // 也是 package.json 的 `bin`）无条件抛 SyntaxError 并以退出码 1 结束。
});
