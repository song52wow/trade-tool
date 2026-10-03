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
  banner: { js: '#!/usr/bin/env node' },
});
