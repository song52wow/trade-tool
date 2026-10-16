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
    # 派生周期（v0.2.0 R-9.3）
    "AGGREGATION_FAILED",
    "AGGREGATION_MISMATCH",
    # 技术指标（v0.3.0 R-12.3）：三个都属于「需人工介入」，不自动重试。
    # INDICATOR_FAILED     物化失败 → 整批回滚（连 1m 与派生桶一起）
    # INDICATOR_MISMATCH   --check 发现不一致
    # INDICATOR_IMPL_STALE impl_version 不一致 → 拒绝混版写入
    "INDICATOR_FAILED",
    "INDICATOR_MISMATCH",
    "INDICATOR_IMPL_STALE",
    # 风控（v0.4.0）：ATR 取不到——库里没有足够的已收盘连续 K 线。
    # 单列而不复用 CONFIG_INVALID：这是「数据还没同步上来」，处置是 start 标的，
    # 而 CONFIG_INVALID 的处置是改配置，两者混在一起会让人查错方向。
    "RISK_ATR_UNAVAILABLE",
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

#: **需人工介入**的错误码：同步守护进程不得无限重试，直接把标的钉成 ``error``。
#:
#: 指标层的三个码都在这里——物化失败会让整批（含 1m 与派生桶）回滚，自动重试只会
#: 在同一个确定性的失败上反复烧配额；要恢复 K 线同步有两条显式出路：修好问题，或用
#: ``data.indicatorSpecs = {}`` 关掉指标层（那之后关闭状态在状态里**可见**，R-12.2）。
MANUAL_INTERVENTION_CODES: frozenset[str] = frozenset(
    {
        "AGGREGATION_FAILED",
        "AGGREGATION_MISMATCH",
        "INDICATOR_FAILED",
        "INDICATOR_MISMATCH",
        "INDICATOR_IMPL_STALE",
        "BACKFILL_BOUNDARY_VIOLATION",
        "UNCLOSED_BAR_IN_STORE",
        "NULL_NOT_ALLOWED",
        "WATERMARK_MISMATCH",
    }
)

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
