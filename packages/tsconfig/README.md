# @trade-tool/tsconfig

本仓库统一的 TypeScript 预设，包内 `tsconfig.json` 一律 `extends` 这里，不要各自复制一份 compilerOptions。

| 预设                | 用途                                              | 额外开关                                       |
| ------------------- | ------------------------------------------------- | ---------------------------------------------- |
| `base.json`         | 语言级基线（ES2023 / Bundler 解析 / strict 全开） | —                                              |
| `node-library.json` | `packages/*` 下的库                               | `types: ["node"]`                              |
| `app.json`          | `apps/*` 下的可执行入口                           | `types: ["node"]`、`noUnusedLocals/Parameters` |

```jsonc
// packages/core/tsconfig.json
{
  "extends": "@trade-tool/tsconfig/node-library.json",
  "include": ["src", "tests"],
}
```
