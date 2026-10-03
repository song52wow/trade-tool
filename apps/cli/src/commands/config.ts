import { defaultConfig, loadConfig, resolveConfigPath, saveConfig } from '@trade-tool/core';

export async function initConfig(options: { force?: boolean }): Promise<void> {
  const path = resolveConfigPath();
  if (!options.force) {
    try {
      await loadConfig(path);
      console.log(`配置已存在，未覆盖：${path}（加 --force 强制覆盖）`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await saveConfig(defaultConfig(), path);
  console.log(`已写入默认配置：${path}`);
}

export async function showConfig(): Promise<void> {
  const path = resolveConfigPath();
  const config = await loadConfig(path);
  console.log(JSON.stringify({ configPath: path, config }, null, 2));
}
