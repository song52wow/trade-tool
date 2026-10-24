# 部署到 192.168.1.90（目录是 `~/trade-tool`）

本机（darwin x86_64）构建镜像 → `docker save` → 目标机 `docker load` → compose 起四个服务。

| 服务       | 镜像              | 作用                                        | 默认是否启动             |
| ---------- | ----------------- | ------------------------------------------- | ------------------------ |
| `postgres` | postgres:16       | 唯一的数据通道（K 线不走 stdout）           | 是                       |
| `web`      | trade-tool:deploy | 控制面 HTTP + 看板                          | 是                       |
| `sync`     | trade-tool:deploy | 常驻同步守护进程                            | 是                       |
| `executor` | trade-tool:deploy | 买入成交 → ATR → 止盈止损（**会真实下单**） | **否**，需显式开 profile |

三个应用服务（web / sync / executor）跑**同一个镜像**、只靠 `command` 区分：它们共用同一份
workspace 产物与同一个 Python venv，拆成三个镜像只会让 save/load 的传输量翻倍。
（`postgres` 是另一个镜像——它不是本仓库的应用。）

> **分析师 / 交易员 Agent（v1.0.0）暂不在部署编排里**。`apps/agent` 已在镜像里
> （workspace 产物是一份），但 compose 没有它的服务项：它默认只出方案、不下单，
> 且要用模型密钥（`TRADE_TOOL_LLM_API_KEY`）与交易所凭据来算仓位。
> 要在服务器上跑，先按 `apps/agent/README.md` 配好，再照 `executor` 的 profile
> 做法加一个服务项。

## 0. 前置

- 本机：Docker（colima 已在用）、仓库当前工作区。
- 目标机：Linux + Docker、能访问外网（容器要访问 Binance）、x86_64 架构。
- 目标机上这个目录结构是最终形态：

```
~/trade-tool/
├── compose.yaml
├── .env                    # 由 .env.example 复制并按目标机改
├── config/
│   └── trade-tool.config.json
└── images/
    └── trade-tool-deploy.tar
```

## 1. 本机构建并导出

```bash
./deploy/build-image.sh
```

产物在仓库根的 `dist-deploy/trade-tool-deploy.tar`（`.gitignore` 已排除该目录，
它是本地产物，**不要提交**）。脚本末尾会在临时容器里跑一遍自检：Node 版本、
Python 版本、`import quant_data`、`sql/*.sql` 在位、控制面前端产物在位。

首次构建约 15 分钟（工具链层 + 全量依赖 + TS 构建 + Python venv）。
Dockerfile 刻意不用 BuildKit 的 cache mount——那会让没装 buildx 组件的机器直接构建失败；
代价是每次重建都重装依赖，换来的是「只有基础 docker 的机器也能构建」。
`.dockerignore` 排除了 `deploy/Dockerfile` 与 `.dockerignore` 自身，所以改 Dockerfile
不会再让 `COPY . /app` 的缓存失效，只重跑尾部几层。

## 2. 搬运

```bash
ssh admin@192.168.1.90 'mkdir -p ~/trade-tool/{config,images}'
scp dist-deploy/trade-tool-deploy.tar        admin@192.168.1.90:~/trade-tool/images/
scp deploy/compose.yaml deploy/.env.example  admin@192.168.1.90:~/trade-tool/
ssh admin@192.168.1.90 'cd ~/trade-tool && docker load -i images/trade-tool-deploy.tar'
```

`docker load` 应输出 `Loaded image: trade-tool:deploy`。标签与 `.env` 里的
`TRADE_TOOL_IMAGE` 必须一致——compose 里 `pull_policy: never`，标签不对就是直接起不来，
而**不会**去拉一个同名不同版本的镜像。

## 3. 目标机上配置

```bash
ssh admin@192.168.1.90
cd ~/trade-tool
cp .env.example .env
openssl rand -hex 32            # 写进 .env 的 TRADE_TOOL_SECRET_KEY
vi .env                         # 至少改 TRADE_TOOL_PG_PASSWORD
```

部署配置固定 `executor.environment = "live"`——目标机跑**主网**。用户数据流地址是代码里的
常量，**不需要**在 `.env` 里配 `TRADE_TOOL_BINANCE_DEMO_STREAM_URL`；那个变量只在把环境
切回 demo 时才要填（demo 的 WS 地址**不内置代码默认值**，缺它时 web / sync / executor
三个服务**全部**以 `CONFIG_INVALID: exchange.environment = demo 但没有给 Demo 用户数据流地址`
启动失败，2026-10-22 部署实测踩到）。它是**基址**，不带 `/private/ws?listenKey=`。

⚠️ **改完 `.env` 要重建容器，`restart` 不够**：`restart` 只重启同一个容器，
**不重读 `env_file`**——表现是「变量明明写进去了，进程却说没有」。
用 `docker compose up -d`（会重建容器）而不是 `docker compose restart`。

配置文件由本机一并带过去（`deploy/config/trade-tool.config.json`）。注意它**同时**通过
「改值」和「删键（用缺省）」两种方式偏离 `config init` 的默认产物——看 `git diff` 时
别只盯着改过的值，删掉的键同样是意图：

- `database.host: "postgres"` —— compose 里的服务名，不是 `127.0.0.1`；
- `data.python: "python3"` —— 走镜像内建好的 venv，不在运行期调 `uv`；
- `market.source: "binance"` —— 默认的 `synthetic` 是离线合成数据；
- **删掉了 `data.indicatorIntervals` / `data.indicatorSpecs` / `data.indicatorBatchBars`**
  —— 让它们走新缺省，即**关闭指标物化**。理由与实测见
  [`AGENTS.md` §6.2](../AGENTS.md)：物化挂在 1m 的每批写入出口上，一轮首次全量会把同一批
  指标重写成百上千遍（实测占单轮同步 72% 的墙钟）；而控制面已无指标读路径。

  ⚠️ **这些键以前是显式写着的（10 个参数集）**。JSON 不支持注释，所以意图只能靠「删键」
  表达——如果把这一段回滚成显式配置，优化就静默失效了。要重新打开，就在控制面或这里
  显式写出参数集；重新物化用
  `node apps/cli/dist/index.js data indicators -s <SYMBOL>`（首次要算完才看得到）。

  `data.aggregateIntervals` 是另一回事，**保留**：派生周期是 K 线本身的形态，与指标层无关。

`sync.symbols` 与 `executor.*` 建议在控制面上改，不要手改文件：控制面写库、
守护进程读库，改文件不会触发任何生效动作。

## 4. 启动

```bash
cd ~/trade-tool
docker compose up -d
docker compose ps
docker compose logs -f web sync
```

控制面在 `http://192.168.1.90:8787`，PostgreSQL 映射在 `0.0.0.0:5432`
（确认网段可信再暴露；收紧只需把 `.env` 的 `TRADE_TOOL_PG_BIND` 改成 `127.0.0.1`）。

### 止盈止损（executor）

**默认不启动**。它在 compose 的 `executor` profile 里，`docker compose up -d` 不会碰它。
要开，先把三件事做完：

1. `.env` 填 `TRADE_TOOL_BINANCE_API_KEY` / `TRADE_TOOL_BINANCE_API_SECRET`
   （只开「交易」权限，不要开「提现」）与 `TRADE_TOOL_SECRET_KEY`；
   **IP 白名单**：合约 key **不强制**要设（Binance「IP 存取限制」里可以选 Unlimited），
   但目标机出网必须走代理，代理的出口 IP 又**会轮换**（见 §6 第 5 条），而白名单只收
   **单条 IP**、填不完。**正解是把代理固定到单一出口节点**（办法见 §6 第 6 条），
   再把那一个固定 IP 填进白名单；固定不了就退一步——**去掉** IP 限制（代价见 §6 第 5 条）；
2. `config/trade-tool.config.json` 里 `executor.enabled` 改成 `true`；
3. 确认 ATR 口径与倍数（`atrInterval` / `stopAtrMult` / `takeProfitAtrMult`），
   并先用控制面的**交易对账**看一眼有没有「本地记着已挂单、交易所却没有」的差异。

```bash
docker compose --profile executor up -d executor
```

⚠️ **换密钥后要重建容器**：`executor` 在**启动时**读一次凭据，之后不再重读。
控制面「设置」页换完密钥，要 `docker compose --profile executor up -d executor` 重建；
`docker compose restart executor` 不够——它不重读 `env_file`。
凭据的优先级是「控制面录入的密文 > `.env` 里的环境变量」，两者都配了时改 `.env` 不算数。

## 5. 运维

```bash
docker compose ps                  # 状态与健康
docker compose logs -f sync        # 同步守护进程的日志
docker compose restart web         # 改完配置后重启（配置是只读挂载）
docker compose down                # 停服务，保留数据卷
docker compose exec web node /app/apps/cli/dist/index.js sync status
docker compose exec web node /app/apps/cli/dist/index.js data aggregate -s BTCUSDT --check
docker compose exec web node /app/apps/cli/dist/index.js reconcile    # 全账户对账
```

**`docker compose down -v` 会连数据一起删掉。** compose 里两个卷都写了显式 `name`
（`trade-tool-pgdata` / `trade-tool-home`），`-v` 命中的就是它们。
只重启服务用 `restart` 或 `up -d`，需要清数据再敲 `-v`。

升级：重新 `./deploy/build-image.sh`，`docker load` 覆盖同名标签，再
`docker compose up -d`（迁移幂等，入口每次启动都会先跑一遍 `db migrate`）。

## 6. 代理（目标机访问不了交易所时）

行情与私有接口都要出网访问 Binance。若目标机的 DNS 解析被污染或直接不可达，
`deploy/compose.yaml` 给三个服务预留了代理变量，**只在 `.env` 里填，不用重建镜像**：

```bash
TRADE_TOOL_HTTP_PROXY=http://用户:密码@代理地址:端口
TRADE_TOOL_HTTPS_PROXY=http://用户:密码@代理地址:端口
TRADE_TOOL_NO_PROXY=postgres,127.0.0.1,localhost
TRADE_TOOL_NODE_OPTIONS=--use-env-proxy
```

四条各自的原因，少一条就只通一半：

1. **`HTTPS_PROXY`** —— Python 侧 `urllib.request` 认它，行情与 `exchangeInfo` 靠这条。
2. **`NODE_OPTIONS=--use-env-proxy`** —— Node 的 `fetch` **默认不读**代理环境变量
   （实测 Node 22.23 支持这个 flag，不加的话私有 REST 照常直连）。
   不设它就会出现「Python 通、Node 不通」这种最难查的半通状态。
3. **`NO_PROXY` 必须含 `postgres`** —— 容器到数据库的连接不该绕代理，
   代理抖动时那是最先断的一环。
4. 代理节点若开了访问控制，填进 URL 的用户名密码会**以明文存在目标机 `.env`**（权限 600）。
   更稳的做法是在代理侧关掉认证、改用「访问控制」按 IP 只放行目标机 IP。
5. **出口 IP 会轮换**（2026-10-23 实测）：目标机的请求全部经代理出去，币安看到的
   `request ip` 在 `107.148.79.89`~`107.148.79.93` 之间来回跳——同一台机器、同一分钟
   都可能是两个地址。而 **Binance 的 API key 白名单只收单条 IP**（不收网段，最多 30 条），
   所以轮换的出口**填不满白名单**。三条选择：

   - **首选：把代理固定到单一出口节点**（办法见下一条），再把那一个 IP 填进白名单；
   - **退路：去掉 key 的 IP 限制**。合约 key **不强制**要设白名单——「IP 存取限制」里
     可以选 Unlimited，只勾「允许合约」照样能下单。代价有两条：① key 泄露后任何地址
     都能用它下单；② 有一条「**未设 IP 限制的系统生成 HMAC key，权限可能只能设为
     『允许读取』**」的规则（2023-01-30 起）——若在你账号上成立，这把 key 就**直接
     不能下单**。去掉白名单前，先在页面上确认「允许合约」还能勾上；
   - **唯一被强制的那条**：**提现权限必须先设 IP 限制**才能开。所以不设白名单的 key
     结构上就提不了钱——对自动化来说这反而是件好事。

   日志里出现 `request ip: x.x.x.x` 时，那个地址**随时会变**，别把它当常量抄进配置。

6. **怎么把出口固定成单一节点**（2026-10-23 实测这台代理是 **Clash 系**：7890 是
   mixed 口、9090 是 `external-controller`，控制口要 `secret`）：

   - **持久做法**：在代理机上找到配置文件（Clash Verge / Clash for Windows 在
     `~/.config/clash/`；mihomo 独立部署看启动参数 `-d` 指向的目录；OpenClash 在
     `/etc/openclash/config/`），把出口策略组的 `type` 从 `url-test` / `fallback` /
     `load-balance` 改成 **`select`**，再选死一个节点。`url-test` 会定时重新测速、
     自动换节点——**出口 IP 跳来跳去正是它干的**；
   - **想保留负载均衡**：改用 `type: load-balance` + `strategy: consistent-hashing`。
     一致性哈希按**目标域名**分配，同一个域名（`fapi.binance.com`）永远落到同一个
     节点，于是对币安的出口是固定的；
   - **先看现在选的是谁**：控制口要配置里的 `secret`，
     `curl -H "Authorization: Bearer <secret>" http://192.168.1.79:9090/proxies/<组名>`
     的 `now` 字段就是当前节点。⚠️ 对 `url-test` 组用 `PUT` 手动选是**留不住的**
     ——自动策略会把它顶回去，这也是为什么必须改配置而不是只点一下。

**小写代理变量会把大写的顶掉（2026-10-21 实测踩到）。**
Node 的 `fetch`（undici 的 `EnvHttpProxyAgent`）**优先读小写的 `http_proxy` / `https_proxy`**，
而镜像里曾经带着三个**空值**的小写变量（`deploy/Dockerfile` 的 `toolchain` 阶段写进了 `ENV`，
运行层继承了它）。于是容器里的大写 `HTTPS_PROXY` 形同虚设，Node 直连币安 → 超时 →
报错只有一句 `fetch failed`，**完全看不出是代理被遮蔽**。

现在的做法是两头都堵上：

- 镜像里**不再带**这三个变量（`ARG` 的值本来就自动是 `RUN` 里的环境变量，apt 用得上，
  但不该固化进镜像）；
- `deploy/compose.yaml` 里**显式同时注入大小写**两套，值都取自同一个
  `TRADE_TOOL_*`，于是谁先读都一样。

排查时先在容器里对一下：

```bash
docker compose exec -T web sh -c 'env | grep -i proxy'   # 大写小写都该是同一个地址
```

验证：

```bash
docker compose exec -T sync python3 -c "import urllib.request;print(urllib.request.urlopen('https://fapi.binance.com/fapi/v1/ping',timeout=15).status)"
docker compose exec -T web node -e "fetch('https://fapi.binance.com/fapi/v1/ping').then(r=>console.log(r.status))"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/overview   # 之前是 502
```

用户数据流（executor 用的 WebSocket）走的是 Node **内置全局 WebSocket**。
**已验证（2026-10-23）**：容器里带着 `NODE_OPTIONS=--use-env-proxy` 时它**会**跟随代理——
在目标机的 web 容器里连 `wss://fstream.binance.com/ws/btcusdt@trade` 直接 OPEN，
和 REST 走的是同一套 `EnvHttpProxyAgent`。所以「REST 通、WS 不通」这种半通状态不会发生；
真出问题时先查代理本身，别怀疑 WS。

## 7. 排查

| 现象                                                    | 多半是                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 容器反复重启，日志停在「等待 PostgreSQL」               | PG 没起来或 `TRADE_TOOL_PG_PASSWORD` 与库不一致；`docker compose logs postgres`                                                                                                                                                                                        |
| `EISDIR: illegal operation on a directory, read`        | `/data/trade-tool.config.json` 被挂成了**目录**：宿主机上那个路径当时不存在，Docker 就地建了同名目录。确认文件已 `scp` 过去再 `up -d`                                                                                                                                  |
| 控制面起不来，日志说 schema 版本对不上                  | 迁移没跑成。入口每次启动都迁移，这里多半是它自己也连不上库                                                                                                                                                                                                             |
| 同步进程起来了但一条数据没进                            | `sync.symbols` 为空、或全是 `paused`；控制面「标的」页看状态                                                                                                                                                                                                           |
| 首次同步卡很久                                          | 首次全量是几十分钟量级，属正常。控制面能看 `sync_state` 的进度                                                                                                                                                                                                         |
| `Loaded image` 后仍然 `pull_policy` 报错                | 镜像标签与 `.env` 的 `TRADE_TOOL_IMAGE` 不一致                                                                                                                                                                                                                         |
| 容器日志只有一句 `启动失败：TypeError: fetch failed`    | 代理被小写变量遮蔽了（Node 优先读小写的 `http_proxy`）。见 §6 的「小写代理变量会把大写的顶掉」                                                                                                                                                                         |
| 同一分钟里既有「迁移失败」又有「迁移成功」              | 多个容器同时跑迁移撞了 duplicate key。已由迁移锁修掉；旧镜像需重新构建                                                                                                                                                                                                 |
| 日志刷 `Invalid API-key, IP, or permissions for action` | 密钥本身与**运行的环境**对不上。三种可能报的是同一句话：`executor.environment` 与密钥所属环境不一致（目标机是 `live`，只认主网密钥）；密钥设了 IP 白名单而出口 IP 是代理的（见 §6 第 5、6 条）——**出口 IP 会轮换，填白名单前先把代理固定到单一节点**；密钥没开交易权限 |
| 控制面换了密钥，executor 还在用旧的                     | 凭据**只在启动时读一次**（`apps/executor/src/main.ts`）。改完要重建容器：`docker compose --profile executor up -d executor`——`restart` 不重读 `env_file`                                                                                                               |
| 改了 `.env` 的密钥却没生效                              | 控制面「设置」页录入的那份**优先于** `.env`（`resolveActiveCredentials` 的优先级）。要改 `.env` 就先在控制面「清空」，否则改白改；`.env` 里两个密钥变量为空时更是只有控制面那一档可用                                                                                  |

macOS 本机用 colima 跑这套 compose 时注意：colima 默认只挂 `/Users`，
**不挂 `/Volumes`**。仓库在 `/Volumes/data/...` 时，配置文件绑定会被 Docker
当成不存在的源路径而创建成目录，于是出现上表第二行。目标机是 Linux，不受影响。

## 设计上值得知道的几点

**迁移在入口里跑。** `deploy/entrypoint.sh` 做的事是「等 PostgreSQL → `db migrate` → exec 目标命令」。
apps/web 启动第一件事就是 `assertSchema()`，版本对不上直接拒绝启动；把迁移放在入口里，
就不存在「web 起来了但库还是旧的」这种半个可用状态。等库超时或失败会直接退出并说明去看
postgres 日志，不静默重试。

**迁移幂等 ≠ 迁移能并发跑。** 幂等保证的是**重复执行**安全（`sql/00N_*.sql` 逐个记录已应用版本），
不保证**同时执行**安全：`docker compose up -d` 会让 web / sync / executor 三个容器同时启动，
三个容器各自在入口里跑一遍迁移，两个进程就会一起去建同一张表，撞
`duplicate key value violates unique constraint "pg_type_typname_nsp_index"`——
一个失败回滚、一个成功，日志里「迁移失败」和「迁移成功」同框出现，还取决于谁先跑完。
现在迁移内部持一把 **session 级 advisory lock**（`packages/data/src/db/migrate.ts`），
把并发迁移串行化：第二个进程等第一个跑完，发现自己无事可做。

**Python 运行期不调 uv。** 配置里 `data.python` 写的是 `python3`，解释器来自构建期
`uv sync --frozen --no-dev --no-editable` 建好的 venv。默认的 `uv` 运行模式会在每次
拉数时解析依赖，生产机上那是一次没必要的失败点。

**信号能到 Node。** 镜像用 tini 当 PID 1，`exec` 交还控制权，`stop_grace_period` 给到 60s：
sync 靠 SIGTERM 优雅退出并清理心跳行，compose stop 若只能强杀，页面会把优雅退出后的
daemon 读成 `stopped` 而不是它应有的样子。

**`/data` 是卷，配置文件是只读挂载。** 缓存、原始数据、元数据、报告落在命名卷
`trade-tool-home`；配置文件单独只读挂进去，因此容器里改不动它——否则会出现
「页面上看到的配置」和「文件里那份」对不上。

**`pull_policy: never`。** 镜像是 save/load 搬过去的，允许 compose 在标签缺失时去拉，
就等于让生产机在你不注意的时候跑起一个来源不明的镜像。

**控制面无鉴权。** 本期没有登录态（AGENTS.md 的 N-7 / R-24.8），能打开页面的人就能读库里
全部数据、触发首次全量拉取。这里按需求绑了 `0.0.0.0`；改回 `127.0.0.1` 就只走 SSH 端口转发。

## 8. 已验证的部分

在 macOS + colima 上用同一份 compose 做过一次完整冒烟（起 PG / web / sync，真实出网）：

- 入口等库 → `db migrate`（幂等，第二次报「已是最新」）→ 启动进程，全通；
- 控制面 `/api/health` 返回 `{"ok":true}`，首页 HTML 与 `/api/symbols`、`/api/symbols/:symbol/bars`
  都能取到**真实** K 线——说明 Python 子进程、PG 写入与**派生聚合**链路在镜像里都工作；
  （指标物化在 `deploy/config` 里是**关闭**的，所以这条冒烟不覆盖它。要验证那条链路，
  得先显式写出 `data.indicatorSpecs` 并跑一次 `data indicators`。）
- `?interval=5m` 返回 400（不静默回落 1m）；
- sync 守护进程起来后立刻调度标的并写库；
- `executor` 不在默认启动集合里，`docker compose ps` 里没有它。

**没验证的**：目标机上的实际启动、`docker load` 后的架构一致性、以及 executor——
它要真实密钥与 `executor.enabled=true`，本机没有条件跑，也没有在这里下过任何真实订单。
