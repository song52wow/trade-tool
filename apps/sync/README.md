# @trade-tool/sync

常驻行情同步守护进程（R-17 … R-22）。

- `src/primitives.ts` — 控制原语：`addSymbol` / `removeSymbol` / `listSymbols` /
  `start` / `pause` / `resume` / `getStatus` / `getSummary`。**全部幂等、全部类型完整、
  不依赖任何 HTTP 框架**，供控制面直接 import。
- `src/daemon.ts` — 调度循环：标的集合、生命周期、全局限速、单写者、错误隔离、退避。
- `src/main.ts` — 进程入口。

所有写入都经 `@trade-tool/data`，本包**不得**直接连 PG（R-2.4）。
