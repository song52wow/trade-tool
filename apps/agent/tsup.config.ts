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
  // 同 apps/sync：src/main.ts 自带 shebang，不再叠 banner（会出两个 shebang）。
});
