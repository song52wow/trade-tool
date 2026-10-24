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
 * ⚠️ **「未来」是致命的那一侧，「过去」是安全的**：时间戳落在服务器时间**前面**
 * 超过约 1 秒就 -1021；落在**后面**则按 `recvWindow` 容忍（实测 5 秒内没问题）。
 * 所以补偿的目标不是「尽量准」，而是**宁可早到**。
 *
 * ## 这里的取舍
 *
 * 补偿是「拿测量值去纠正一个已知误差」，**不是**猜。它有三条硬约束：
 *
 * 1. **必须可见**：测量结果由调用方打到日志 / `doctor`，不静默生效——
 *    否则就是 AGENTS.md 约定 9 说的「看起来成功了，其实什么都没做」。
 * 2. **有上限**：偏差大到一定程度说明测量本身不可信（网络异常、代理、
 *    多层 NAT），此时补偿只会把一个响亮的失败变成一个安静的错误，必须直接拒绝。
 * 3. **宁可早到**：补偿后的时间戳只允许落在服务器时间**之前**。做法有两个：
 *    - 用**中点估计**去掉网络延迟的干扰（只记「发出去的时刻」会把延迟算成偏差，
 *      补偿量因此偏小、时间戳反而跑到服务器时间前面——2026-10-25 在服务器 +
 *      代理上实测踩到，私有请求全挂）；
 *    - 再加一条**可证明的下限**（`min(收到时刻 − 服务器时刻) ≥ 真实偏差`），
 *      兜住「路径不对称」时中点估计可能偏小的那一侧。
 *
 * 不读时钟、不发请求、不做 IO——纯函数，输入是测量样本，输出是偏移与诊断。
 */

/** 单次测量的原始样本：发送时刻、收到时刻与响应里带回的服务器时刻（都是 epoch ms）。 */
export interface ClockSample {
  /** 本机发起请求的 `Date.now()`。 */
  sentAt: number;
  /**
   * 本机**收到响应**的 `Date.now()`。
   *
   * **没有它就量不出网络延迟**，而延迟正是补偿偏小的根源（见下面的推导）。
   */
  receivedAt: number;
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
  /** 中点估计的最小 / 最大观测值，用于判断测量是否稳定。 */
  minObservedMs: number;
  maxObservedMs: number;
  /**
   * 补偿下限：`min(收到时刻 − 服务器时刻)`。
   *
   * 这是一个**可证明的下界**——见 `computeClockSkew` 的推导。它保证
   * 「补偿量 ≥ 真实偏差」，于是签出去的时间戳**绝不会**跑到服务器时间前面。
   */
  floorMs: number;
  /** 样本极差。偏大说明测量路径有抖动（例如响应打到了时钟偏慢的边缘节点）。 */
  spreadMs: number;
  /** 极差过大时的可见提示。不阻断——补偿量取的是两个估计里更保守的那个。 */
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
 * 设本机相对交易所的真实偏差为 `D`（正 = 本机快），请求在真实时刻 `t0` 发出，
 * 去程延迟 `L1`、回程延迟 `L2`，交易所生成响应的真实时刻是 `t0 + L1 + ε`
 * （`ε` 是它自己的处理时间，毫秒级，可忽略）：
 *
 * ```
 * sentAt     = t0 + D                     （本机时钟快 D）
 * serverTime = t0 + L1 + ε                （交易所自己的时钟）
 * receivedAt = t0 + L1 + ε + L2 + D
 * ```
 *
 * ### 只看 `sentAt` 会把延迟算进偏差里
 *
 * `sentAt − serverTime = D − L1` —— **少了整整一个单程延迟**。
 *
 * 2026-10-25 实测（服务器 + 代理，RTT 1.0~3.4 秒）：本机时钟与交易所其实
 * 只差几百毫秒，这种算法却量出「慢 678ms」——补偿量因此偏小 678ms，
 * 签出去的时间戳落在服务器时间**前面**——而那正是币安拒得最狠的一侧
 * （-1021，容差是硬的 ~1000ms，调大 `recvWindow` 无效）。**私有请求于是全挂**：
 * 连不上仓位、对账失败、挂单与撤单也一起废掉。
 *
 * ### 用中点（NTP 的做法）
 *
 * ```
 * (sentAt + receivedAt) / 2 = t0 + (L1 + L2 + ε) / 2 + D
 * 中点 − serverTime        = D + (L2 − L1) / 2
 * ```
 *
 * 误差只剩**往返的不对称**，不再是延迟本身。路径越对称，估得越准。
 *
 * ### 两个估计，取更保守的那个
 *
 * 补偿量有两个来源：
 *
 * 1. **中点估计的最大值** `max(D + (L2 − L1) / 2)`——去掉延迟干扰，再往
 *    「更早」的方向偏（观测区间里的最大值就是最有利于「落在过去」的那个）。
 * 2. **补偿下限** `min(收到时刻 − 服务器时刻)`。由上面的式子：
 *
 *    ```
 *    receivedAt − serverTime = L2 + D
 *    ```
 *
 *    回程延迟 `L2` **不可能为负**（响应不可能在交易所生成之前就回到本机），
 *    所以这个差值**必然 ≥ 真实偏差 D**。拿它当补偿量，就等于保证了
 *    「补偿量 ≥ D」，于是签出去的时间戳相对服务器处理时刻的落点
 *    `= 去程延迟 + (补偿量 − D) ≥ 0`——**绝不会跑到服务器时间前面**。
 *
 * 取两者的**较大值**：下限保证「不跑到前面」，中点估计保证「不把延迟当成偏差」。
 * 代价是补偿会偏大一点（多补一个回程延迟），落点因此更靠前——
 * 而落点靠前是**安全**的那一侧（按 `recvWindow` 容忍，实测 5 秒内没问题）。
 *
 * ⚠️ 这条「下限」是 2026-10-25 那次事故的直接教训：老公式只给出一个
 * 「大概率安全」的估计，而**未来侧是致命的那一侧**——宁可多补。
 *
 * @throws {ClockSkewError} 没有有效样本，或偏移大到补偿没有意义。
 */
export function computeClockSkew(
  samples: readonly ClockSample[],
  options: ClockSkewOptions = {},
): ClockSkew {
  const maxSpreadMs = options.maxSpreadMs ?? 3_000;
  const usable = samples.filter(
    (s) =>
      Number.isFinite(s.sentAt) &&
      Number.isFinite(s.receivedAt) &&
      Number.isFinite(s.serverTime) &&
      // 收到时刻早于发出时刻 = 这条样本本身是坏的，丢掉而不是拿它算偏移。
      s.receivedAt >= s.sentAt,
  );
  if (usable.length === 0) {
    throw new ClockSkewError('CLOCK_SKEW_UNSTABLE', '没有任何有效的时钟测量样本', {
      samples: samples.length,
    });
  }

  // **中点估计**：偏差 + 往返不对称的一半。少了 receivedAt 的老公式在这里。
  const observed = usable.map((s) => (s.sentAt + s.receivedAt) / 2 - s.serverTime);
  const sorted = [...observed].sort((a, b) => a - b);
  const minObservedMs = sorted[0]!;
  const maxObservedMs = sorted[sorted.length - 1]!;
  const spreadMs = maxObservedMs - minObservedMs;

  // **补偿下限** = min(收到时刻 − 服务器时刻) = D + min(回程延迟) ≥ D。
  // 它保证补偿量不小于真实偏差 → 时间戳绝不会跑到服务器时间前面。
  const floorMs = Math.min(...usable.map((s) => s.receivedAt - s.serverTime));

  // 取两者中更保守（更早）的那个：下限兜底「不跑到前面」，中点估计去掉延迟干扰。
  const offsetMs = Math.max(maxObservedMs, floorMs);

  if (Math.abs(offsetMs) > 60_000) {
    throw new ClockSkewError(
      'CLOCK_SKEW_TOO_LARGE',
      `本机时钟与交易所相差 ${offsetMs}ms（超过 60s）：这不是可补偿的量级，` +
        `请先修系统时钟（macOS：系统设置 → 通用 → 日期与时间 → 自动设置时间）`,
      { offsetMs, minObservedMs, maxObservedMs, floorMs, samples: usable.length },
    );
  }

  // 极差大不直接拒绝：离群样本只会拉低最小值，取最大值不受影响。
  // 但它说明**测量路径有抖动**（往返不对称），必须在摘要里报出来，不能悄悄带过。
  if (spreadMs > maxSpreadMs) {
    return {
      offsetMs,
      samples: usable.length,
      minObservedMs,
      maxObservedMs,
      floorMs,
      spreadMs,
      warning:
        `样本极差 ${spreadMs}ms 偏大（往返路径不对称，可能有响应打到了慢节点），` +
        `已按最保守的观测补偿（时间戳只会早到）；建议加大样本数或检查网络`,
    };
  }

  return {
    offsetMs,
    samples: usable.length,
    minObservedMs,
    maxObservedMs,
    floorMs,
    spreadMs,
  };
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
