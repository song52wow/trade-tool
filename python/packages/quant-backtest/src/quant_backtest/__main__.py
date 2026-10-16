"""quant-backtest 的命令行入口，也是 TS 侧 ``@trade-tool/data`` 的桥接目标。

契约与 ``quant_data`` 完全一致：
- 成功：退出码 0，stdout 只有**一个** JSON 文档，日志走 stderr；
- 失败：退出码非 0，stderr **最后一行**为 ``QUANT_DATA_ERROR {"code":…,"message":…,"details":…}``。

**K 线不经 stdout 传输**（R-7.2）：合成数据路径在 Python 进程内直接生成并消费，
真实数据路径从 PG 读；两条路径都只把**摘要**（绩效指标、成交列表）写 stdout。
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from typing import Literal

from quant_core import Bar, generate_series, interval_to_ms
from quant_core.io import dump_json, log

from .engine import BacktestConfig, BacktestResult, bars_per_year_for, run_backtest


def _source_symbol(source: str, interval: str, bars: int) -> list[Bar]:
    """离线合成源：进程内生成并直接消费，**不经 stdout**（R-7.2）。

    `quant_data generate` 走 stdout 回传 bars，那是 v0.1.0 为离线链路留的例外；
    这里在同进程内生成，顺带把那条例外从**回测路径**上消掉。
    """
    if source != "synthetic":
        raise ValueError("synthetic 生成器只支持 synthetic 源")
    return generate_series("SYNTHETIC", interval, bars, None)


def _cmd_backtest(args: argparse.Namespace) -> int:
    bars = _source_symbol(args.source, args.interval, args.bars)
    interval_ms = interval_to_ms(args.interval)
    config = BacktestConfig(
        fast=args.fast,
        slow=args.slow,
        initial_capital=args.initial_capital,
        fee_rate=args.fee_rate,
        slippage_rate=args.slippage_rate,
        bars_per_year=bars_per_year_for(interval_ms),
    )
    result: BacktestResult = run_backtest(bars, config)
    dump_json(
        {
            "symbol": args.symbol,
            "interval": args.interval,
            "intervalMs": interval_ms,
            "bars": len(bars),
            "strategy": "ma-cross",
            "params": {"fast": args.fast, "slow": args.slow},
            "fills": {
                # 成交模型是「信号在 t 收盘确认、成交在 t+1 开盘」（R-2.3），
                # 与改动前的「以 t 收盘价成交」**有意不同**；回传出来是为了让
                # 报告里的数字能被解释，而不是让人以为回测出了 bug。
                "model": "signal-at-close-t-fill-at-open-t+1",
            },
            **result.to_dict(),
        }
    )
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="quant_backtest", description="回测")
    sub = parser.add_subparsers(dest="command", required=True)

    backtest = sub.add_parser("backtest", help="跑一次回测")
    backtest.add_argument("--symbol", default="")
    backtest.add_argument("--interval", default="1h")
    backtest.add_argument("--bars", type=int, default=500)
    backtest.add_argument("--source", default="synthetic", choices=["synthetic"])
    backtest.add_argument("--fast", type=int, default=20)
    backtest.add_argument("--slow", type=int, default=60)
    backtest.add_argument("--initial-capital", type=float, default=10_000.0)
    backtest.add_argument("--fee-rate", type=float, default=0.0005)
    backtest.add_argument("--slippage-rate", type=float, default=0.0)
    return parser


SourceName = Literal["synthetic"]


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "backtest":
            return _cmd_backtest(args)
    except ValueError as exc:
        log(f"error: {exc}")
        sys.stderr.write(
            'QUANT_DATA_ERROR {"code":"CONFIG_INVALID","message":'
            + _json_str(str(exc))
            + ',"details":{}}\n'
        )
        sys.stderr.flush()
        return 1
    log(f"unknown command: {args.command}")
    return 2


def _json_str(value: str) -> str:
    import json

    return json.dumps(value, ensure_ascii=False)


if __name__ == "__main__":
    sys.exit(main())
