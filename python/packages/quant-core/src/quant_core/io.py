"""跨语言契约：python 侧 stdout 只输出单个 JSON 文档，日志走 stderr。"""

from __future__ import annotations

import json
import sys


def dump_json(payload: object) -> None:
    """把结果写到 stdout；``allow_nan=False`` 保证不产生 JS 侧无法解析的 NaN/Infinity。"""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, allow_nan=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def log(message: str) -> None:
    """日志统一走 stderr，避免污染 stdout 的 JSON 契约。"""
    sys.stderr.write(f"{message}\n")
    sys.stderr.flush()
