# Python 层（uv workspace）

Node 生态之外的计算层，用 [uv](https://docs.astral.sh/uv/) 做 workspace 与依赖管理。

```
python/
├── pyproject.toml          # workspace 根（虚拟项目，不打包）
├── packages/
│   ├── quant-core/         # 数据结构 + 指标
│   ├── quant-data/         # 行情生成/获取（TS 桥接目标）
│   └── quant-backtest/     # 回测与绩效
```

## 常用命令

```bash
pnpm py:sync        # uv sync --all-packages --all-groups
pnpm py:test        # pytest（根目录聚合跑全部包）
pnpm py:lint        # ruff check
pnpm py:format      # ruff format
pnpm py:typecheck   # mypy --strict
```

或直接进 `python/` 目录用 `uv run <cmd>`。

## 约定

- 每个包 `src/` 布局 + hatchling 构建，根 `pyproject.toml` 用 `[tool.uv.sources]` 指向 workspace 成员。
- 需被 TS 调用的模块必须有 `__main__.py`，且 stdout 保持纯 JSON。
- 依赖新增用 `uv add --package <name> <dep>`，别手改锁文件。
- 代码风格 ruff（行宽 100），类型必须过 `mypy --strict`。
