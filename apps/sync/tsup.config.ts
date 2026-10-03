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
  banner: { js: '#!/usr/bin/env node' },
});
