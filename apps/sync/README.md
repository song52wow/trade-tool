# @trade-tool/sync

常驻行情同步守护进程（R-17 … R-22）。

- `src/primitives.ts` — 控制原语：`addSymbol` / `removeSymbol` / `listSymbols` /
  `start` / `pause` / `resume` / `getStatus` / `getSummary`。**全部幂等、全部类型完整、
  不依赖任何 HTTP 框架**，供控制面直接 import。
  新增标的默认 `paused`，并且在**开启之前**就把首次全量的规模预估写进 `sync_state`
  （`plan_*` 列，迁移 `002`），由 `sync status` 暴露——控制面据此决定要不要开始。
- `src/daemon.ts` — 调度循环：标的集合、生命周期、全局限速、单写者、错误隔离、退避。
  启动时先过 schema 版本闸门；每轮按 `last_run_at` **公平轮转**，并发上限之外的标的不回饿死；
  单标的失败只在它自己的状态里落地，绝不终止进程。
- `src/service.ts` — `createSyncService()`：把「原语 + 守护进程 + 连接池」组装起来。
  **控制面与守护进程共享同一个 `SyncControl` 实例**，否则 `resume()` 清不掉守护进程的退避。
- `src/main.ts` — 进程入口（`bin: trade-tool-sync`）。配置里的 `sync.symbols` 支持两种写法：
  `"SOLUSDC"`（默认 paused）或 `{ "symbol": "SOLUSDC", "desiredState": "running" }`。

所有写入都经 `@trade-tool/data`，本包**不得**直接连 PG（R-2.4）。
