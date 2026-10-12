#!/usr/bin/env bash
# 容器入口：等库 → 跑迁移 → 交还控制权。
#
# 为什么必须在这里跑 `db migrate`（而不是让用户手动敲一次）：
# apps/web 启动第一件事就是 `runtime.assertSchema()`，schema 版本对不上直接拒绝启动；
# sync / executor 也一样。把迁移放在入口里，四个入口共用一条路径，
# 就不存在「web 起来了但库还是旧的」这种半个可用状态。
set -euo pipefail

APP_ROOT="${APP_ROOT:-/app}"
CLI="${APP_ROOT}/apps/cli/dist/index.js"

log() { printf '[entrypoint] %s\n' "$*" >&2; }

# ---- 1. 等 PostgreSQL ----------------------------------------------------
# 依赖的 host/port 取应用自己的配置（TRADE_TOOL_PG_HOST / _PORT，与 databaseSchema 同名），
# 不另写一份常量：常量与配置漂移时，这里会等错端口，然后迁移连一个不存在的库。
PGHOST="${TRADE_TOOL_PG_HOST:-postgres}"
PGPORT="${TRADE_TOOL_PG_PORT:-5432}"
WAIT_SECONDS="${TRADE_TOOL_PG_WAIT_SECONDS:-120}"

if [[ "${TRADE_TOOL_SKIP_MIGRATE:-0}" != "1" ]]; then
  log "等待 PostgreSQL ${PGHOST}:${PGPORT}（最多 ${WAIT_SECONDS}s）…"
  deadline=$(( $(date +%s) + WAIT_SECONDS ))
  until node -e "
    const net = require('node:net');
    const s = net.connect({ host: process.argv[1], port: Number(process.argv[2]) });
    s.on('connect', () => { s.end(); process.exit(0); });
    s.on('error', () => process.exit(1));
    setTimeout(() => process.exit(1), 2000);
  " "${PGHOST}" "${PGPORT}" >/dev/null 2>&1; do
    if (( $(date +%s) >= deadline )); then
      log "等不到 PostgreSQL：${PGHOST}:${PGPORT}。用 docker compose logs postgres 看它为什么没起来。"
      exit 1
    fi
    sleep 2
  done
  log "PostgreSQL 已就绪"

  # 迁移是幂等的（sql/00N_*.sql 逐个记录已应用版本），重复执行安全，
  # 因此 web / sync / executor 三个容器同时启动时互相跑一遍也无妨。
  log "应用数据库迁移…"
  node "${CLI}" db migrate
  log "迁移完成"
fi

# ---- 2. 交还控制权 --------------------------------------------------------
# exec：让目标进程成为 PID 1 的直接子进程，收到 compose 发来的 SIGTERM
# （sync 靠它优雅退出并清理心跳行）。
log "启动：$*"
exec "$@"