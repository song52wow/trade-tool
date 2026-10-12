#
# 单一镜像承载四个入口（web / sync / executor / cli），用 `command` 区分。
# 不按服务拆镜像的理由：它们共用同一份 workspace 产物与同一份 Python venv，
# 拆开只会让 save/load 的传输量翻倍，而四个入口的依赖集完全相同。
#
# 目标机是 x86_64，用 `docker build --platform linux/amd64` 构建后 save/load 过去。
# 构建期需要联网（pnpm install + uv sync）；运行期除行情/私有接口外不出网。

# 基础镜像选 python:3.12-slim-bookworm 而不是 node:22-slim：Debian bookworm 自带的
# Python 是 3.11，而 python/pyproject.toml 要求 >= 3.12；Node 反过来用 NodeSource 装。
# toolchain 层被 builder 与 runtime 共用，免得两处各写一遍系统包安装。
FROM python:3.12-slim-bookworm AS toolchain

ARG NODE_MAJOR=22
# uv 只在构建期用来按 uv.lock 装依赖；运行期解释器来自镜像内建好的 venv。
# 版本在此钉死：换 uv 大版本可能改变解析结果，与本地 uv.lock 产生漂移。
ARG UV_VERSION=0.9.12

ENV DEBIAN_FRONTEND=noninteractive \
    CI=true \
    PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    UV_PROJECT_ENVIRONMENT=/app/python/.venv \
    PATH=/pnpm:/app/python/.venv/bin:$PATH

# ca-certificates：出网访问交易所。tini：让 SIGTERM 真的到达 Node 进程，
# 否则 compose stop 只能等超时强杀，sync 的优雅退出（删心跳行）就跑了。
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg tini \
    && curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# 只开 shim，不在这里钉 pnpm 版本：`corepack prepare` 需要一个带 packageManager
# 字段的 package.json，而这一层还没有拷贝源码。版本由下面 `pnpm install` 在 /app 下
# 触发 corepack 按 package.json 的 packageManager（当前 11.23.0）自动取。
#
# 之所以走 corepack 而不是 `npm i -g pnpm`：版本与 packageManager 不一致时，
# 仓库里任何 pnpm 命令都会以 `Cannot verify the identity of the @pnpm/exe…` 失败（AGENTS.md）。
RUN corepack enable && pip install --no-cache-dir "uv==${UV_VERSION}"

# ---- 构建层：装全部依赖并产出 dist ----------------------------------------
FROM toolchain AS builder
WORKDIR /app
COPY . /app
# 刻意**不用** BuildKit 的 cache mount：那会让没装 buildx 组件的机器直接构建失败。
# 代价是每次重建都重跑一次依赖安装（几分钟），换来的是「只有基础 docker 的机器也能构建」。
RUN pnpm install --frozen-lockfile --store-dir /pnpm/store
RUN pnpm build
# --frozen：严格按 uv.lock 解析，不重新解依赖。
# --no-dev：不装 pytest/ruff/mypy，它们只在仓库里跑测试时需要。
# --no-editable：装进 site-packages，运行期不依赖 /app/python 源码路径。
RUN uv sync --project python --frozen --no-dev --no-editable \
    && /app/python/.venv/bin/python -c "import quant_data, quant_core, quant_backtest"

# ---- 运行层 -------------------------------------------------------------
FROM toolchain AS runtime
WORKDIR /app

# 运行期只装 prod 依赖。workspace 包是指向 /app/packages/* 的软链，
# 因此源码目录与 dist 必须一起搬过来，否则解析不到 @trade-tool/core。
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps ./apps
RUN pnpm install --prod --frozen-lockfile --store-dir /pnpm/store

# .dockerignore 排掉了构建产物，这里只把结果搬过来（dist 与源码目录同名，覆盖写入）。
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/data/dist ./packages/data/dist
COPY --from=builder /app/apps/cli/dist ./apps/cli/dist
COPY --from=builder /app/apps/sync/dist ./apps/sync/dist
COPY --from=builder /app/apps/executor/dist ./apps/executor/dist
COPY --from=builder /app/apps/web/dist ./apps/web/dist

# Python：只搬 venv。解释器就是基础镜像自带的 /usr/local/bin/python3.12
# （3.12 满足 python/pyproject.toml 的 requires-python，uv 因此不必另装托管解释器），
# builder 与 runtime 的基础镜像是同一个，venv 里的 shebang 因此在运行层同样成立。
# 连带的效果：运行层没有任何 uv，也不必在生产机上解析依赖。
COPY --from=builder /app/python/.venv /app/python/.venv
COPY python /app/python

COPY deploy/entrypoint.sh /usr/local/bin/trade-tool-entrypoint
RUN chmod +x /usr/local/bin/trade-tool-entrypoint

ENV TRADE_TOOL_HOME=/data \
    TRADE_TOOL_PYTHON_DIR=/app/python
WORKDIR /data
# 刻意**不**写 `VOLUME ["/data"]`：工作根目录由 compose 的命名卷 trade-tool-home 提供，
# 镜像里再声明 VOLUME 只会让 `docker run` 时多出一个没人认领的匿名卷。

# 默认跑控制面；sync / executor / cli 由 compose 覆盖 command。
ENTRYPOINT ["/usr/bin/tini", "--", "trade-tool-entrypoint"]
CMD ["node", "/app/apps/web/dist/main.js"]