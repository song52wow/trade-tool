"""quant-data 的命令行入口，也是 TS 侧 ``@trade-tool/data`` 的桥接目标。

契约：
- 成功：退出码 0，stdout 只有**一个** JSON 文档，日志走 stderr；
- 失败：退出码非 0，stderr **最后一行**为 ``QUANT_DATA_ERROR {"code":…,"message":…,"details":…}``；
- K 线数据不经 stdout 传输，只回小摘要（R-2.1 / AC-8）。

子命令：
- ``generate``：确定性合成源（既有行为保持不变，``packages/data/src/provider.ts`` 依赖它）
- ``symbols`` / ``resolve`` / ``estimate``：元数据与规模预估
- ``sync`` / ``backfill`` / ``verify``：落库的一轮同步、区间回补、全表缺口校验
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

from quant_core import INTERVALS, interval_to_ms, series_to_dicts
from quant_core.io import dump_json, log

from . import sync
from .errors import SyncError
from .metadata import DEFAULT_TTL_MS
from .ratelimit import DEFAULT_BUDGET_PER_MINUTE
from .series import generate_series
from .store import cache_path, write_series


def _add_exchange(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--exchange", default=sync.EXCHANGE_BINANCE, help="交易所（本期只有 binance）"
    )


def _add_metadata_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--meta-dir", default=None, help="exchangeInfo 缓存目录，缺省则不落盘")
    parser.add_argument("--ttl-ms", type=int, default=DEFAULT_TTL_MS, help="元数据缓存 TTL（毫秒）")
    parser.add_argument(
        "--allow-stale",
        action="store_true",
        help="TTL 过期且拉取失败时允许使用过期缓存（会标记 stale）",
    )
    parser.add_argument(
        "--refresh", action="store_true", help="忽略本地缓存与进程内单例，强制重新拉取"
    )


def _add_clock_option(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--now-ms", type=int, default=None, help="注入固定时钟（epoch ms），便于测试断言"
    )


def _add_weight_option(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--weight-budget",
        type=int,
        default=DEFAULT_BUDGET_PER_MINUTE,
        help=f"全局每分钟权重预算（默认 {DEFAULT_BUDGET_PER_MINUTE}）",
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="quant_data", description="行情生成/获取与同步")
    sub = parser.add_subparsers(dest="command", required=True)

    gen = sub.add_parser("generate", help="生成/获取 K 线序列")
    gen.add_argument("--symbol", required=True)
    gen.add_argument("--interval", default="1h", choices=INTERVALS)
    gen.add_argument("--bars", type=int, default=500)
    gen.add_argument("--end-time-ms", type=int, default=None, help="序列结束时间（epoch ms）")
    gen.add_argument("--cache-root", default=None, help="CSV 缓存目录，缺省则不落盘")

    symbols = sub.add_parser("symbols", help="列出运行时发现的可交易永续标的")
    _add_exchange(symbols)
    _add_metadata_options(symbols)
    _add_weight_option(symbols)
    _add_clock_option(symbols)

    resolve = sub.add_parser("resolve", help="校验并解析单个标的的合约元数据")
    _add_exchange(resolve)
    resolve.add_argument("--symbol", required=True)
    _add_metadata_options(resolve)
    _add_weight_option(resolve)
    _add_clock_option(resolve)

    estimate = sub.add_parser("estimate", help="预估首次全量的规模（不需要数据库）")
    _add_exchange(estimate)
    estimate.add_argument("--symbol", required=True)
    _add_metadata_options(estimate)
    _add_weight_option(estimate)
    estimate.add_argument(
        "--to", dest="to_ms", type=int, default=None, help="区间结束时间（epoch ms）"
    )
    estimate.add_argument("--now-ms", type=int, default=None, help="注入固定时钟（epoch ms）")

    one_shot = sub.add_parser("sync", help="跑一轮同步（首次全量 / 增量续传 / 缺口回补）")
    _add_exchange(one_shot)
    one_shot.add_argument("--symbol", required=True)
    one_shot.add_argument("--from", dest="from_ms", type=int, default=None, help="起点（epoch ms）")
    one_shot.add_argument(
        "--to", dest="to_ms", type=int, default=None, help="终点（epoch ms），缺省拉到最新"
    )
    one_shot.add_argument(
        "--batch-size",
        type=int,
        default=sync.DEFAULT_BATCH_SIZE,
        help="每批写入行数（每批一个事务）",
    )
    one_shot.add_argument(
        "--gap-lookback-ms",
        type=int,
        default=sync.DEFAULT_GAP_LOOKBACK_MS,
        help="缺口检测的回看窗口（毫秒）：每轮在 verified_upto 之外多扫这么久，"
        "使「已验证区间之后被外部删改」也能被下一轮自动发现（AC-7）",
    )
    one_shot.add_argument(
        "--max-gap-attempts",
        type=int,
        default=sync.DEFAULT_MAX_GAP_ATTEMPTS,
        help="缺口自动回补的尝试上限",
    )
    one_shot.add_argument(
        "--allow-backfill",
        action="store_true",
        default=True,
        help="先回补已登记的缺口（默认开启）",
    )
    one_shot.add_argument(
        "--no-backfill", dest="allow_backfill", action="store_false", help="跳过缺口回补"
    )
    _add_clock_option(one_shot)
    _add_metadata_options(one_shot)
    _add_weight_option(one_shot)

    backfill = sub.add_parser("backfill", help="显式区间回补（恒为 ON CONFLICT DO NOTHING）")
    _add_exchange(backfill)
    backfill.add_argument("--symbol", required=True)
    backfill.add_argument(
        "--from", dest="from_ms", type=int, required=True, help="起点（epoch ms）"
    )
    backfill.add_argument("--to", dest="to_ms", type=int, required=True, help="终点（epoch ms）")
    backfill.add_argument(
        "--batch-size",
        type=int,
        default=sync.DEFAULT_BATCH_SIZE,
        help="每批写入行数（每批一个事务）",
    )
    backfill.add_argument(
        "--gap-lookback-ms",
        type=int,
        default=sync.DEFAULT_GAP_LOOKBACK_MS,
        help="缺口检测的回看窗口（毫秒），语义同 sync",
    )
    backfill.add_argument(
        "--max-gap-attempts",
        type=int,
        default=sync.DEFAULT_MAX_GAP_ATTEMPTS,
        help="缺口自动回补的尝试上限",
    )
    _add_clock_option(backfill)
    _add_metadata_options(backfill)
    _add_weight_option(backfill)

    verify = sub.add_parser("verify", help="全表缺口扫描并重建 verified_upto 基线")
    _add_exchange(verify)
    verify.add_argument("--symbol", required=True)
    _add_clock_option(verify)

    return parser


def _cmd_generate(args: argparse.Namespace) -> int:
    bars = generate_series(args.symbol, args.interval, args.bars, args.end_time_ms)

    if args.cache_root:
        path = cache_path(Path(args.cache_root), args.symbol, args.interval, args.bars)
        write_series(path, bars)
        log(f"cached -> {path}")

    dump_json(
        {
            "symbol": args.symbol,
            "interval": args.interval,
            "intervalMs": interval_to_ms(args.interval),
            "bars": series_to_dicts(bars),
        }
    )
    return 0


def _meta_dir(args: argparse.Namespace) -> Path | None:
    return Path(args.meta_dir) if getattr(args, "meta_dir", None) else None


def _options(args: argparse.Namespace) -> sync.SyncOptions:
    """把 argparse 结果转成 :class:`SyncOptions`。

    各子命令的开关集合不同（例如 ``verify`` 不出网，没有 ``--meta-dir``/``--weight-budget``），
    因此除 ``--exchange`` 外全部走 ``getattr`` + 缺省值：少一个开关不会在运行期炸成
    ``AttributeError``。
    """
    return sync.SyncOptions(
        exchange=args.exchange,
        symbol=getattr(args, "symbol", ""),
        from_ms=getattr(args, "from_ms", None),
        to_ms=getattr(args, "to_ms", None),
        batch_size=getattr(args, "batch_size", sync.DEFAULT_BATCH_SIZE),
        max_gap_attempts=getattr(args, "max_gap_attempts", sync.DEFAULT_MAX_GAP_ATTEMPTS),
        gap_lookback_ms=getattr(args, "gap_lookback_ms", sync.DEFAULT_GAP_LOOKBACK_MS),
        weight_budget=getattr(args, "weight_budget", DEFAULT_BUDGET_PER_MINUTE),
        allow_backfill=getattr(args, "allow_backfill", True),
        now_ms=getattr(args, "now_ms", None),
        meta_dir=_meta_dir(args),
        ttl_ms=getattr(args, "ttl_ms", DEFAULT_TTL_MS),
        allow_stale=getattr(args, "allow_stale", False),
        refresh=getattr(args, "refresh", False),
    )


def _cmd_symbols(args: argparse.Namespace) -> int:
    dump_json(sync.list_symbols(_options(args)))
    return 0


def _cmd_resolve(args: argparse.Namespace) -> int:
    dump_json(sync.resolve_symbol(_options(args)))
    return 0


def _cmd_estimate(args: argparse.Namespace) -> int:
    dump_json(sync.estimate_scale(_options(args)))
    return 0


def _cmd_sync(args: argparse.Namespace) -> int:
    dump_json(sync.run_sync(_options(args)))
    return 0


def _cmd_backfill(args: argparse.Namespace) -> int:
    dump_json(sync.run_backfill(_options(args)))
    return 0


def _cmd_verify(args: argparse.Namespace) -> int:
    dump_json(sync.run_verify(_options(args)))
    return 0


_COMMANDS = {
    "symbols": _cmd_symbols,
    "resolve": _cmd_resolve,
    "estimate": _cmd_estimate,
    "sync": _cmd_sync,
    "backfill": _cmd_backfill,
    "verify": _cmd_verify,
}


def _emit_error(error: SyncError) -> None:
    """把结构化错误写到 stderr 的**最后一行**（TS 侧按此解析）。"""
    sys.stderr.write(f"{error.to_line()}\n")
    sys.stderr.flush()


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "generate":
            return _cmd_generate(args)
        handler = _COMMANDS.get(args.command)
        if handler is not None:
            return handler(args)
    except SyncError as exc:
        log(f"error: {exc}")
        _emit_error(exc)
        return 1
    except Exception as exc:
        log(f"error: {exc}")
        if args.command != "generate":
            _emit_error(SyncError("INTERNAL_ERROR", str(exc)))
        return 1
    log(f"unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
