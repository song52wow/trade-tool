/**
 * 交易所时钟偏差的**测量与补偿**（私有接口签名用）。
 *
 * ## 为什么需要它
 *
 * Binance 的每个私有请求都要签名，签名里带 `timestamp` 与 `recvWindow`：

 * ```
 * -recvWindow ≤ (timestamp − 服务器当前时间) ≤ +recvWindow  → 放行
 * 否则 -1021 Timestamp for this request was ... ahead/behind the server's time
 * ```
 *
 * 这个窗口的本意是容忍**网络延迟**——请求从发出到到达要跑几百毫秒，
 * 但它假定**你的时钟和交易所的时钟大致同源**。一旦本机时钟快了一截，
 * 服务器看到的就是「一个来自未来的请求」，与**签名重放**在它看来属于同一类风险，
 * 于是忠实拒掉。它不会去猜你是不是时钟偏了。
 *
 * 实测（本机自动校时已开，偏差却是稳定的 ~0.9 秒）：
 * `recvWindow` 取 5000 / 15000 / 60000 三档，报的都是同一句 `1000ms ahead`——
 * **容差是硬的，调大窗口救不了**。偏在阈值附近时表现为时好时坏，
 * 而失败的又不只是对账：挂单、撤单、续期 listenKey 全都签在同一套机制上。
 *
 * ## 这里的取舍
 *
 * 补偿是「拿测量值去纠正一个已知误差」，**不是**猜。它有三条硬约束：
 *
 * 1. **必须可见**：测量结果由调用方打到日志 / `doctor`，不静默生效——
 *    否则就是 AGENTS.md 约定 9 说的「看起来成功了，其实什么都没做」。
 * 2. **有上限**：偏差大到一定程度说明测量本身不可信（网络异常、代理、
 *    多层 NAT），此时补偿只会把一个响亮的失败变成一个安静的错误，必须直接拒绝。
 * 3. **宁可欠补**：补偿值取**下限**而不是中位数。少补一点只是让请求早一点点到达，
 *    仍在窗口内；多补则可能把请求送到窗口的另一侧之外。
 *
 * 不读时钟、不发请求、不做 IO——纯函数，输入是测量样本，输出是偏移与诊断。
 */

/** 单次测量的原始样本：发送时刻与响应里带回的服务器时刻（都是 epoch ms）。 */
export interface ClockSample {
  /** 本机发起请求的 `Date.now()`。 */
  sentAt: number;
  /** 交易所 `/fapi/v1/time` 返回的 `serverTime`。 */
  serverTime: number;
}

export interface ClockSkew {
  /**
   * 要从本机时间里**减掉**的毫秒数。
   *
   * 正值 = 本机快于交易所，签名时用 `Date.now() - offset`。
   */
  offsetMs: number;
  /** 参与测量的样本数。 */
  samples: number;
  /** 样本里的最小 / 最大观测值，用于判断测量是否稳定。 */
  minObservedMs: number;
  maxObservedMs: number;
  /** 样本极差。偏大说明测量路径有抖动（例如响应打到了时钟偏慢的边缘节点）。 */
  spreadMs: number;
  /** 极差过大时的可见提示。不阻断——取最大值的推导已保证补偿不会补过头。 */
  warning?: string;
}

export interface ClockSkewOptions {
  /**
   * 允许的样本极差（毫秒）。超出则认为测量不可信。
   *
   * 取 3000：远大于正常抖动（本机实测 RTT 100–1200ms），又远小于
   * 「本机与交易所差了几分钟」这种真正需要人工介入的量级。
   */
  maxSpreadMs?: number;
}

export class ClockSkewError extends Error {
  readonly code: 'CLOCK_SKEW_UNSTABLE' | 'CLOCK_SKEW_TOO_LARGE';
  constructor(
    code: 'CLOCK_SKEW_UNSTABLE' | 'CLOCK_SKEW_TOO_LARGE',
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ClockSkewError';
    this.code = code;
  }
}

/**
 * 由样本算出补偿量。
 *
 * ## 采样公式（这一条推导错了整条路就反了）
 *
 * 设本机相对交易所的真实偏差为 `D`（正 = 本机快），我们发出请求的真实时刻是 `T`，
 * 服务器**收到并生成响应**的真实时刻是 `T + g`，其中 `g >= 0` 是服务器的处理耗时：
 *
 * ```
 * sentAt    = T + D          （本机时钟快 D）
 * serverTime = T + g         （服务器时钟准）
 * 观测值     = sentAt − serverTime = D − g
 * ```
 *
 * **`g >= 0`，所以观测值只会低估 `D`，永远不会高估。** 于是
 * **最大观测值就是 `D` 的最紧下界**——拿它去补偿只会「少补」，
 * 绝不会把请求补到窗口的另一侧之外。
 *
 * 实测（2026-10-16，本机真实 D ≈ 1.2s）：多数样本 `obs ≈ 1215`，
 * 偶尔出现 `obs ≈ -900` 的样本——那是响应打到了一台时钟偏慢的边缘节点，
 * `g` 大到 2 秒以上。这种离群值**只会拉低最小值**，所以取最大值天然免疫它。
 * （早期实现取了「下四分位」，结果补偿方向反了，-1021 照旧。）
 *
 * @throws {ClockSkewError} 没有有效样本，或偏移大到补偿没有意义。
 */
export function computeClockSkew(
  samples: readonly ClockSample[],
  options: ClockSkewOptions = {},
): ClockSkew {
  const maxSpreadMs = options.maxSpreadMs ?? 3_000;
  const usable = samples.filter((s) => Number.isFinite(s.sentAt) && Number.isFinite(s.serverTime));
  if (usable.length === 0) {
    throw new ClockSkewError('CLOCK_SKEW_UNSTABLE', '没有任何有效的时钟测量样本', {
      samples: samples.length,
    });
  }

  const observed = usable.map((s) => s.sentAt - s.serverTime);
  const sorted = [...observed].sort((a, b) => a - b);
  const minObservedMs = sorted[0]!;
  const maxObservedMs = sorted[sorted.length - 1]!;
  const spreadMs = maxObservedMs - minObservedMs;

  // 取最大值：`D >= max(obs)`，这是唯一能保证「只少补、不少补」的取值。
  const offsetMs = maxObservedMs;

  if (Math.abs(offsetMs) > 60_000) {
    throw new ClockSkewError(
      'CLOCK_SKEW_TOO_LARGE',
      `本机时钟与交易所相差 ${offsetMs}ms（超过 60s）：这不是可补偿的量级，` +
        `请先修系统时钟（macOS：系统设置 → 通用 → 日期与时间 → 自动设置时间）`,
      { offsetMs, minObservedMs, maxObservedMs, samples: usable.length },
    );
  }

  // 极差大不直接拒绝：上面的推导说明离群样本只会拉低最小值，取最大值不受影响。
  // 但它说明**测量路径有抖动**，必须在摘要里报出来，不能悄悄带过。
  if (spreadMs > maxSpreadMs) {
    return {
      offsetMs,
      samples: usable.length,
      minObservedMs,
      maxObservedMs,
      spreadMs,
      warning:
        `样本极差 ${spreadMs}ms 偏大（响应可能打到了时钟偏慢的边缘节点），` +
        `已按最大观测值补偿；建议加大样本数或检查网络`,
    };
  }

  return { offsetMs, samples: usable.length, minObservedMs, maxObservedMs, spreadMs };
}

/** 给人看的一行摘要。调用方应当把它打到启动日志与 `doctor` 里——补偿必须可见。 */
export function describeClockSkew(skew: ClockSkew): string {
  const direction = skew.offsetMs > 0 ? '快于' : skew.offsetMs < 0 ? '慢于' : '与';
  const magnitude = Math.abs(skew.offsetMs);
  const base =
    `本机时钟${direction}交易所约 ${magnitude}ms` +
    `（${skew.samples} 个样本，观测区间 ${skew.minObservedMs}~${skew.maxObservedMs}ms，极差 ${skew.spreadMs}ms）` +
    `；签名时间戳已按此补偿`;
  return skew.warning === undefined ? base : `${base}；注意 ${skew.warning}`;
}
