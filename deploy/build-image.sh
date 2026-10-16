#!/usr/bin/env bash
# 在**本机**构建部署镜像，并导出成一个可直接 `docker load` 的 tar。
#
# 为什么是本机构建 + save/load，而不是在目标机上 build：
#   * 目标机不需要 git 访问、不需要 pnpm/uv，镜像即制品；
#   * 构建期要联网装依赖，把「构建能不能成功」留在本机，出问题时看得到日志。
#
# 平台固定 linux/amd64：本机是 x86_64 Mac（Docker 里跑 linux/amd64），
# 目标机 192.168.1.90 也是 x86_64。目标机若换成 arm64，要改这个变量重新构建。
set -euo pipefail

PLATFORM="${PLATFORM:-linux/amd64}"
IMAGE="${TRADE_TOOL_IMAGE:-trade-tool:deploy}"
OUT="${OUT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/dist-deploy}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "${REPO_ROOT}"

echo "==> 构建 ${IMAGE} (${PLATFORM})"
# 透传给 docker build 的额外参数。Dockerfile 声明了构建期代理
# （http_proxy / https_proxy / no_proxy），但这个脚本原先并不转发它们：
# 网络受限时装依赖会慢到几十分钟，而 Dockerfile 明明为此留了口子。
# 用法：EXTRA_BUILD_ARGS="--build-arg http_proxy=… --build-arg https_proxy=…" ./deploy/build-image.sh
read -r -a EXTRA_ARGS <<< "${EXTRA_BUILD_ARGS:-}"

# 从仓库根构建，Dockerfile 里的 `COPY . /app` 才包含 pnpm workspace 与 uv workspace。
docker build \
  --platform "${PLATFORM}" \
  -f deploy/Dockerfile \
  -t "${IMAGE}" \
  "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}" \
  .

echo "==> 导出到 ${OUT}/${IMAGE//[:\/]/-}.tar"
mkdir -p "${OUT}"
docker save -o "${OUT}/${IMAGE//[:\/]/-}.tar" "${IMAGE}"

echo "==> 校验导出产物里有没有 Python 运行时与迁移 SQL"
# 这两项缺失是最典型的「镜像能启动但一跑就炸」：Python 缺了，行情同步在
# 第一次 spawn 子进程时才报错；SQL 缺了，迁移会报出「已应用了表结构里没有的版本」。
docker run --rm --platform "${PLATFORM}" --entrypoint sh "${IMAGE}" -c '
  set -e
  command -v node >/dev/null && node -v
  command -v python3 >/dev/null && python3 -V
  python3 -c "import quant_data, quant_core, quant_backtest; print(\"python 接缝 OK\")"
  ls /app/packages/data/sql/*.sql >/dev/null && echo "迁移 SQL OK"
  test -f /app/apps/web/dist/ui/index.html && echo "控制面前端产物 OK"
  test -f /app/apps/cli/dist/index.js && echo "CLI 产物 OK"
'

echo
echo "完成。把这一行发给目标机（连同 deploy/ 目录）执行："
echo "  scp ${OUT}/${IMAGE//[:\/]/-}.tar admin@192.168.1.90:/tmp/"
echo "  ssh admin@192.168.1.90 'docker load -i /tmp/${IMAGE//[:\/]/-}.tar'"
echo
echo "详细步骤见 deploy/README.md"