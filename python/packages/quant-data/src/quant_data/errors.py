"""结构化错误：与 TS 侧 ``packages/core/src/market-sync.ts`` 的 ``SyncErrorCode`` 一一对应。

跨语言契约（AGENTS.md 硬性约定 2）：
- 成功时 stdout 只有单个 JSON 文档；
- 失败时退出码非 0，**stderr 最后一行**为 ``QUANT_DATA_ERROR {紧凑 JSON}``。

因此错误必须带 code，不允许降级成裸字符串（R-22.4）。
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Literal, get_args

#: 与 TS 侧 ``SyncErrorCode`` 逐项对应；改一端必须改另一端（AC-25）。
ErrorCode = Literal[
    # 元数据与标的校验（R-7.2）
    "SYMBOL_NOT_FOUND",
    "NOT_PERPETUAL",
    "NOT_TRADING",
    "METADATA_FETCH_FAILED",
    # 写入边界与数据完整性（R-9.4 / R-10.3）
    "BACKFILL_BOUNDARY_VIOLATION",
    "UNCLOSED_BAR_IN_STORE",
    "NULL_NOT_ALLOWED",
    "WATERMARK_MISMATCH",
    # 缺口（R-11.9）
    "GAP_ATTEMPTS_EXHAUSTED",
    # 数据库（R-21.6 / R-1.3）
    "DB_CONNECTION_FAILED",
    "DB_UNIQUE_VIOLATION",
    "DB_TRANSACTION_ROLLBACK",
    "DB_DEADLOCK",
    "SCHEMA_VERSION_MISMATCH",
    # 配额与网络（R-20 / R-21.4）
    "RATE_LIMITED",
    "EXCHANGE_RATE_LIMITED",
    "EXCHANGE_ERROR",
    "NETWORK_ERROR",
    # 单写者（R-3.3）
    "SYNC_ALREADY_RUNNING",
    # 配置与兜底
    "CONFIG_INVALID",
    "INTERNAL_ERROR",
]

#: 供测试与 CLI 校验使用的码表。
ERROR_CODES: tuple[str, ...] = get_args(ErrorCode)

#: stderr 错误行的前缀；TS 侧按此解析 stderr 的最后一行。
ERROR_LINE_PREFIX = "QUANT_DATA_ERROR "


class SyncError(Exception):
    """带错误码的异常。不静默兜底：一律抛错，由 CLI 转成结构化 stderr 行。"""

    def __init__(
        self,
        code: ErrorCode,
        message: str,
        details: Mapping[str, object] | None = None,
    ) -> None:
        super().__init__(f"[{code}] {message}")
        self.code: ErrorCode = code
        self.message: str = message
        self.details: dict[str, object] = dict(details) if details else {}

    def to_dict(self) -> dict[str, object]:
        return {"code": self.code, "message": self.message, "details": self.details}

    def to_line(self) -> str:
        """渲染成 stderr 的最后一行：紧凑 JSON，前缀固定，行内无多余内容。"""
        payload = json.dumps(
            self.to_dict(),
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        )
        return f"{ERROR_LINE_PREFIX}{payload}"
