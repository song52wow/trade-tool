"""进程全局的请求权重预算（R-20）。

关键事实（附录 A.3）：``REQUEST_WEIGHT`` 2400/分钟是**账号级**配额。
进程内的信号量满足不了「跨进程共享」——多个 Python 子进程（``apps/sync`` 的并发标的）
会各自把自己的桶用满，合计直接超配额。

因此预算落在 PG 的 ``weight_budget`` 单行表里：每次出网请求**先在事务里预留令牌**，
预留成功才发请求。429/418 时把 ``pause_until`` 写回同一行，实现**全局暂停**（R-21.4）。

本模块只依赖 psycopg，不依赖 ``pg``，避免 ``pg -> ratelimit -> pg`` 循环导入；
连接由调用方传入（通常是短事务专用的独立连接，保证预算预留不随写入回滚而撤销）。
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

import psycopg

from .errors import SyncError

#: 权重窗口长度（毫秒），与交易所的 1 分钟窗口对齐。
WINDOW_MS = 60_000

#: 默认预算：交易所 2400/分钟的 80%，留余量给人工排查（R-20.3）。
DEFAULT_BUDGET_PER_MINUTE = 1920

#: 429 时无法解析 ``Retry-After`` 时的保守默认暂停秒数。
DEFAULT_RETRY_AFTER_SECONDS = 60

#: 等待预算超过该时长仍拿不到令牌即放弃，避免无期限挂起。
MAX_RESERVE_WAIT_MS = 10 * WINDOW_MS


class WeightBudget:
    """PG 协调的全局令牌桶（单行 ``weight_budget``）。"""

    def __init__(
        self,
        conn: psycopg.Connection[dict[str, Any]],
        budget_per_minute: int = DEFAULT_BUDGET_PER_MINUTE,
        *,
        sleeper: Callable[[float], None] = time.sleep,
        clock_ms: Callable[[], int] | None = None,
    ) -> None:
        if budget_per_minute <= 0:
            raise SyncError("CONFIG_INVALID", "权重预算必须为正整数", {"budget": budget_per_minute})
        self._conn = conn
        self._budget = budget_per_minute
        self._sleep = sleeper
        self._clock_ms = clock_ms if clock_ms is not None else lambda: int(time.time() * 1000)
        self.reserved: int = 0

    @property
    def budget_per_minute(self) -> int:
        return self._budget

    def reserve(self, weight: int) -> None:
        """预留 ``weight`` 个令牌；不够则等到下一个窗口。

        预留与实际请求必须成对出现——预留失败绝不发请求（R-20.2）。
        """
        if weight <= 0:
            raise SyncError("CONFIG_INVALID", "请求权重必须为正整数", {"weight": weight})
        waited = 0
        while True:
            granted, wait_ms = self._try_reserve(weight)
            if granted:
                self.reserved += weight
                return
            waited += wait_ms
            if waited > MAX_RESERVE_WAIT_MS:
                raise SyncError(
                    "RATE_LIMITED",
                    "全局权重预算等待超时，本轮放弃（不静默超配额发出请求）",
                    {"weight": weight, "waitedMs": waited, "budgetPerMinute": self._budget},
                )
            self._sleep(wait_ms / 1000)

    def register_pause(self, retry_after_seconds: int) -> int:
        """429/418 时设置全局暂停截止时间，返回截止的 epoch ms（R-21.4）。"""
        seconds = retry_after_seconds if retry_after_seconds > 0 else DEFAULT_RETRY_AFTER_SECONDS
        now = self._clock_ms()
        until = now + seconds * 1000
        with self._conn.transaction():
            self._conn.execute(
                """
                UPDATE weight_budget
                   SET pause_until = GREATEST(COALESCE(pause_until, 0), %s)
                 WHERE id = 1
                """,
                (until,),
            )
        return until

    def status(self) -> dict[str, object]:
        """当前窗口的配额使用率（R-20.4）。"""
        row = self._conn.execute(
            "SELECT window_from, used, pause_until FROM weight_budget WHERE id = 1"
        ).fetchone()
        if row is None:
            return {
                "budgetPerMinute": self._budget,
                "windowFrom": 0,
                "used": 0,
                "pauseUntil": None,
                "utilization": 0.0,
            }
        window_from = int(row["window_from"])
        used = int(row["used"])
        # 窗口已经滚动过一次，但还没有任何请求触发重置：此时行里的 used 是**上一个窗口**
        # 的残留，直接报出去会让 `sync status` 显示一个早就过期的 100%。
        # 「当前窗口的使用量」在窗口滚动后就是 0，直到下一次 reserve 写下新的窗口起点。
        if self._clock_ms() - window_from >= WINDOW_MS:
            used = 0
        return {
            "budgetPerMinute": self._budget,
            "windowFrom": window_from,
            "used": used,
            "pauseUntil": int(row["pause_until"]) if row["pause_until"] is not None else None,
            "utilization": round(used / self._budget, 6),
        }

    def observe_used_weight(self, used_weight: int) -> None:
        """并入交易所回传的 ``X-MBX-USED-WEIGHT-1M``（只增不减）。

        本地令牌桶记的是「**我们以为**自己用了多少」；交易所的响应头是**账号级**的权威值
        （可能包含别的客户端或人工排查的消耗）。不读它，本地模型就会在漂移后继续以为
        还有额度，AC-17 的「始终低于上限」也就只剩本地账本自说自话。

        只增不减是刻意的保守方向：一次偏小的观测不会把计数拉回去。
        """
        if used_weight < 0:
            return
        with self._conn.transaction():
            row = self._conn.execute(
                "SELECT used FROM weight_budget WHERE id = 1 FOR UPDATE"
            ).fetchone()
            if row is None:
                return
            current = int(row["used"])
            if used_weight > current:
                self._conn.execute(
                    "UPDATE weight_budget SET used = %s WHERE id = 1", (used_weight,)
                )

    def _try_reserve(self, weight: int) -> tuple[bool, int]:
        """一次预留尝试，返回 ``(是否成功, 需等待毫秒)``。"""
        now = self._clock_ms()
        with self._conn.transaction():
            # 账号级配额的互斥点：FOR UPDATE 保证并发进程不会同时拿到同一份额度。
            row = self._conn.execute(
                "SELECT window_from, used, pause_until FROM weight_budget WHERE id = 1 FOR UPDATE"
            ).fetchone()
            if row is None:
                self._conn.execute(
                    "INSERT INTO weight_budget (id, window_from, used) VALUES (1, %s, 0)"
                    " ON CONFLICT (id) DO NOTHING",
                    (now,),
                )
                window_from, used, pause_until = now, 0, None
            else:
                window_from, used, pause_until = (
                    int(row["window_from"]),
                    int(row["used"]),
                    int(row["pause_until"]) if row["pause_until"] is not None else None,
                )

            if pause_until is not None and now < pause_until:
                return False, pause_until - now
            if now - window_from >= WINDOW_MS:
                window_from, used = now, 0
            if used + weight > self._budget:
                return False, (window_from + WINDOW_MS) - now + 1

            self._conn.execute(
                "UPDATE weight_budget SET window_from = %s, used = %s WHERE id = 1",
                (window_from, used + weight),
            )
        return True, 0
