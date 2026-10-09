import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/main.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: { entry: 'src/index.ts' },
  sourcemap: true,
  clean: true,
  external: ['@trade-tool/core', '@trade-tool/data'],
  // 同 apps/cli：`src/main.ts` 自带 shebang，无需 banner。
  // 叠加 banner 会让 `dist/main.js`（package.json 的 `bin: trade-tool-sync`）出现两个 shebang，
  // 第二个在第 2 行 → Node 抛 SyntaxError。
});
