# quant-data

行情生成/获取，**TS ↔ Python 的桥接目标**（`python -m quant_data`）。

```bash
cd python
uv run python -m quant_data generate --symbol BTCUSDT --interval 1h --bars 500
# -> stdout: {"symbol":..., "interval":..., "intervalMs":..., "bars":[...]}
```

- `series.py` — 目前是**确定性合成源**（同参数同结果），接真实交易所时新增 `fetch_*` 即可，上层无感
- `store.py` — CSV 缓存，换格式只改这里

约定：stdout 只输出单个 JSON 文档；日志走 stderr；失败返回非零退出码并在 stderr 写明原因。
