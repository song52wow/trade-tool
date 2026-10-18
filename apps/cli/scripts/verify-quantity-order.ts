/**
 * v0.7.0 分批止盈的**交易所契约验证**（一次性脚本，跑完即可删）。
 *
 * 它要回答的唯一问题：**带数量的条件单在真实端点上真的能挂出去、能看到、能撤掉吗？**
 * 官方参数表（2026-10-17 核对）确认 `quantity` / `reduceOnly` 是合法参数，但文档和
 * 实际行为之间还差这一步——而这一步无法只读完成，必须真下一张单。
 *
 * ## 安全边界（**不满足就拒绝运行**）
 *
 * 1. **绝不在主网运行。** 脚本从与 executor 同一套配置解析端点，若解析到主网直接退出。
 * 2. 只挂**远离市价**的条件单，理论上不可能立刻成交；挂完立刻撤。
 * 3. 打印里不出现任何密钥：只打印 algoId、数量、触发价这类业务字段。
 *
 * ## 用法
 *
 * ```bash
 * # 前提：executor.environment = demo，且凭据已在控制面录入（库内密文）或环境变量里
 * pnpm --filter @trade-tool/cli exec tsx ../../scripts/verify-quantity-order.ts
 * ```
 *
 * 它**复用 executor 的凭据解析、端点解析与时钟补偿**——刻意不自己写一份，
 * 否则验的就是「脚本里的假设」而不是「系统真正会发出去的请求」。
 */

import {
  createPool,
  exchangeEndpointsFromEnv,
  resolveActiveCredentials,
  readContractSpecRaw,
  parseStepSize,
  parseTickSize,
  BinancePrivateClient,
  type Pool,
} from '@trade-tool/data';
import {
  LIVE_REST_BASE_URL,
  SyncError,
  describeClockSkew,
  loadConfigOrDefault,
  loadProjectEnv,
  parseSecretKey,
  SECRET_KEY_ENV,
} from '@trade-tool/core';

/** 探针标的：用流动性最好、步长最细的那个，减少「数量取整后不合法」的概率。 */
const SYMBOL = 'BTCUSDT';

function ok(line: string): void {
  console.error(`  ✓ ${line}`);
}
function step(n: string): void {
  console.error(`\n[${n}]`);
}

/** 挂过单的 client；`finally` 里也要用它，所以提到 main 外面。 */
let cancelSafely = async (algoId: number): Promise<void> => {
  throw new Error(`撤单尚未就绪：${algoId}`);
};

async function main(): Promise<number> {
  loadProjectEnv();
  const config = await loadConfigOrDefault();
  const endpoints = exchangeEndpointsFromEnv(config.executor);

  console.error(`交易所端点：${endpoints.baseUrl}`);
  console.error(`配置里的 environment：${config.executor.environment}`);

  // ---- 安全闸门 1：主网一律拒绝 -------------------------------------------
  if (endpoints.baseUrl === LIVE_REST_BASE_URL) {
    console.error(
      '\n拒绝运行：端点解析到了**主网**。本脚本会真的下一张单并在验证后撤掉，' +
        '请先把配置里的 executor.environment 改成 demo（§6.3 第 6 条）。',
    );
    return 2;
  }
  ok('不在主网，可以继续');

  const pool: Pool = createPool(config.database);
  const placed: number[] = [];
  try {
    const credentials = await resolveActiveCredentials({
      pool,
      masterKey: parseSecretKey(process.env[SECRET_KEY_ENV]),
      exchange: config.market.exchange,
      apiKeyEnv: config.executor.apiKeyEnv,
      apiSecretEnv: config.executor.apiSecretEnv,
      note: (message) => console.error(`  [凭据] ${message}`),
    });

    const client = new BinancePrivateClient({
      credentials,
      ...endpoints,
      recvWindowMs: config.executor.recvWindowMs,
    });

    // ---- 安全闸门 2：先看账上有没有仓位 ----------------------------------
    // 有仓位时挂 closePosition 单会**真的平掉它**。本脚本绝不碰真实仓位。
    step('0. 检查账户当前有没有 BTCUSDT 仓位');
    const positions = await client.positionRisk({ symbol: SYMBOL });
    const pos = positions.find((p) => p.symbol === SYMBOL);
    const amt = pos?.positionAmt ?? 0;
    if (amt !== 0) {
      console.error(
        `\n拒绝运行：${SYMBOL} 当前有仓位 ${amt}。本脚本会挂 closePosition 止损单做对照，` +
          `那会平掉真实仓位。请换一个没有持仓的标的再跑。`,
      );
      return 2;
    }
    ok(`${SYMBOL} 无仓位（挂单不会动到任何东西）`);

    // ---- 校时钟（§6.3 第 8 条）------------------------------------------
    step('1. 校时钟');
    // 走客户端自带的方法：它同时负责测量与写入补偿量，脚本不另抄一份。
    cancelSafely = (algoId: number) => client.cancelAlgoOrder(algoId);

    const skew = await client.measureClockSkew();
    ok(describeClockSkew(skew) + `（已补偿 ${skew.offsetMs}ms）`);

    // ---- 读规格 -----------------------------------------------------------
    step('2. 读标的规格（步长 / 最小变动）');
    const raw = await readContractSpecRaw(pool, config.market.exchange, SYMBOL);
    const stepSize = parseStepSize(raw, SYMBOL);
    const tickSize = parseTickSize(raw, SYMBOL);
    ok(`stepSize=${stepSize} tickSize=${tickSize}`);

    // ---- 只读存活性探测（§10.1 第 2 条）---------------------------------
    step('3. 只读存活性探测：故意少参数打 algoOrder');
    try {
      await client.placeClosePositionOrder({
        symbol: SYMBOL,
        side: 'BUY',
        type: 'STOP_MARKET',
        // 0 会被当作缺参数，期望返回的是**参数错误**而不是「订单类型不支持」
        stopPrice: 0,
        clientAlgoId: 'probe-missing-params',
      });
      console.error('  ! 返回了成功——说明端点对缺参数的校验比预期宽松，继续观察');
    } catch (error) {
      const code =
        error instanceof SyncError ? error.code : error instanceof Error ? error.name : '未知';
      console.error(`  端点回了 ${code}（这是我们要的：端点活着且在报参数）`);
      if (/Order type not supported/i.test(String(error))) {
        console.error('  ! 这句话说明条件单又迁走了 —— 必须重新核对官方文档');
        return 1;
      }
    }

    // ---- 价格：挑一个远离市价的触发价 ------------------------------------
    step('4. 取市价并挑一个远离市价的触发价');
    const ticker = await fetch(`${endpoints.baseUrl}/fapi/v1/ticker/price?symbol=${SYMBOL}`);
    const price = Number(((await ticker.json()) as { price: string }).price);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`取不到 ${SYMBOL} 的市价：${price}`);
    }
    // 多头仓位不存在时挂 SELL 单：触发价抬到市价上方 5% → 不可能成交。
    const farAbove = Number(
      (price * 1.05).toFixed(Math.max(0, String(tickSize).split('.')[1]?.length ?? 0)),
    );
    const farBelow = Number(
      (price * 0.95).toFixed(Math.max(0, String(tickSize).split('.')[1]?.length ?? 0)),
    );
    ok(`市价 ${price}；触发价取 ${farAbove}（止盈，另一侧为 ${farBelow}）`);

    // ---- 第 5 步：★被验证的那一步 ★ -------------------------------------
    step('5. 挂带数量的条件单（v0.7.0 第一段止盈的形态）');
    const tp = await client.placeQuantityOrder({
      symbol: SYMBOL,
      side: 'SELL',
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: farAbove,
      quantity: stepSize, // 最小那一档，够验证「能不能挂」
      reduceOnly: true,
      clientAlgoId: `verify-tp-${Date.now()}`,
      workingType: config.executor.workingType,
      priceProtect: config.executor.priceProtect,
    });
    placed.push(tp.algoId);
    ok(`挂上了：algoId=${tp.algoId} clientAlgoId=${tp.clientAlgoId} 类型=${tp.type}`);

    step('6. 回查交易所上的挂单（确认 quantity 真被接受、且没被当成全平单）');
    const open = await client.openAlgoOrders({ symbol: SYMBOL });
    const row = open.find((o) => o.algoId === tp.algoId);
    if (row === undefined) {
      console.error('  ! 交易所上查不到刚挂的那张单 —— 单可能被立刻拒了或已成交');
      return 1;
    }
    console.error(
      `  closePosition=${row.closePosition} quantity=${String(row.quantity)} ` +
        `orderType=${row.orderType} triggerPrice=${row.triggerPrice}`,
    );
    if (row.closePosition) {
      console.error('  ! 交易所把它当成「全平」单了 —— 说明 quantity 没被接受');
      return 1;
    }
    if (row.quantity === null) {
      console.error('  ! 回查拿不到数量：分批语义无法确认');
      return 1;
    }
    if (Math.abs(row.quantity - stepSize) > 1e-9) {
      console.error(`  ! 数量与挂出去的不一致：挂了 ${stepSize}，回来的是 ${row.quantity}`);
      return 1;
    }
    ok(`带数量的条件单成立：数量 ${row.quantity}、非全平单`);

    // 说明为什么**没有**再挂一张 closePosition 止损单做对照（2026-10-17 实测）：
    // 无仓位时交易所直接拒 `closePosition=true`，报
    //   「Time in Force (TIF) GTE can only be used with open positions」
    // 而真实链路里止损单总是**成交之后**才挂，仓位必然存在，所以那一步不是风险点。
    // 被验证的是「带数量」这一形态——它才是 v0.7.0 新增的、官方文档以外没验过的部分。
    step('6b. 跳过「closePosition 对照单」（无仓位时交易所会拒，理由见代码注释）');

    // ---- 撤单：两张都撤掉 -------------------------------------------------
    step('7. 撤掉挂的单（不留任何挂单）');
    for (const algoId of [...placed]) {
      await cancelSafely(algoId);
      // 从待撤列表里移除：`finally` 只兜底还没撤成功的，重复撤会得到
      // 「Unknown order sent.」这种会让人误以为出了新问题的噪音。
      placed.splice(placed.indexOf(algoId), 1);
      ok(`已撤 ${algoId}`);
    }

    step('8. 复查：确认一张都没留下');
    const after = await client.openAlgoOrders({ symbol: SYMBOL });
    const left = after.filter((o) => placed.includes(o.algoId));
    if (left.length > 0) {
      console.error(`  ! 还剩 ${left.length} 张没撤掉，需要手动去交易所清理`);
      return 1;
    }
    ok('一张都没留下，账户回到验证前的样子');

    console.error('\n结论：带数量的条件单可以挂出、能查到、能撤掉。v0.7.0 的 API 前提成立。');
    return 0;
  } finally {
    // 无论走哪条路，**先把挂单清干净**再退出。
    //
    // 这里必须**真的去撤**：早期版本只打印了一句话就退出，结果验证脚本在第 6 步失败后
    // 把一张条件单留在了交易所上——而「验证脚本留下探针单」正是它自己要去发现的那类漂移。
    if (placed.length > 0) {
      console.error('\n[收尾] 撤掉本脚本挂过的单');
      for (const algoId of placed) {
        try {
          await cancelSafely(algoId);
          console.error(`  ✓ 已撤 ${algoId}`);
        } catch (error) {
          console.error(`  ! 撤 ${algoId} 失败：${String(error)}`);
          console.error(`    请手动清理，或跑 scripts/cleanup-probe-orders.ts`);
        }
      }
    }
    await pool.end().catch(() => undefined);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const message = error instanceof SyncError ? `${error.code}: ${error.message}` : String(error);
    console.error(`\n验证失败：${message}`);
    process.exit(1);
  });
