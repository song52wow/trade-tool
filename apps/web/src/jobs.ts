import { SyncError } from '@trade-tool/core';

import type { JobDto, JobError, JobKind, JobStatus } from './types.js';

/** 作业执行体需要的外部能力。抽出来是为了让作业逻辑能脱离 PG 与交易所单测。 */
export interface JobRunnerOptions {
  /** 真正跑首次全量 / 增量；resolve 出来的值原样进 `result`。 */
  runFull(symbol: string): Promise<Record<string, unknown>>;
  runVerify(symbol: string): Promise<Record<string, unknown>>;
  /** 读进度：`rows` 来自 `sync_state`，是权威水位之外的观测值。 */
  readProgress(symbol: string): Promise<{ rows: number | null; pendingGaps: number | null }>;
  /** 该标的是否被守护进程接管（desired_state = running）。为真时拒绝启动本进程作业。 */
  isDaemonOwned(symbol: string): Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  historyLimit?: number;
  idFactory?: () => string;
}

export interface StartJobInput {
  kind: JobKind;
  symbol: string;
  /** 规模预估的目标行数；没有时进度只显示已入库行数。 */
  target?: number | undefined;
}

interface ProgressSample {
  rows: number | null;
  pendingGaps: number | null;
}

function toJobError(error: unknown): JobError {
  if (error instanceof SyncError) return { code: error.code, message: error.message };
  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * 长任务登记表。
 *
 * 为什么需要它：首次全量是**几分钟到几十分钟**量级，HTTP 请求不可能同步等它跑完
 * （R-17.6 也明确要求生命周期操作立即返回）。所以接口只负责「登记 + 立刻返回 id」，
 * 进度由页面轮询本表——而进度不是内存里的计数，而是每次从 `sync_state` 重读，
 * 这样即使作业跨越进程重启，页面看到的水位依然与库里的事实一致。
 */
export class JobRegistry {
  private readonly jobs = new Map<string, JobDto>();
  private readonly order: string[] = [];
  private readonly runningBySymbol = new Map<string, string>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly historyLimit: number;
  private readonly idFactory: () => string;
  private counter = 0;

  constructor(private readonly options: JobRunnerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.historyLimit = options.historyLimit ?? 50;
    this.idFactory = options.idFactory ?? (() => `job-${(this.counter += 1)}`);
  }

  /** 新的在前。 */
  list(): JobDto[] {
    return this.order
      .slice()
      .reverse()
      .map((id) => this.jobs.get(id))
      .filter((job): job is JobDto => job !== undefined);
  }

  get(id: string): JobDto | null {
    return this.jobs.get(id) ?? null;
  }

  activeCount(): number {
    return this.runningBySymbol.size;
  }

  /**
   * 登记一个作业并立即返回，不等待完成。
   *
   * 拒绝两种情形（都抛 `SYNC_ALREADY_RUNNING` → 409，不静默降级）：
   * 1. 同一标的已有作业在跑 —— 本进程内避免重复拉取；
   * 2. 该标的 `desired_state = running` —— 那是守护进程的地盘，两个进程写同一张表
   *    会撞单写者锁（R-3.3）。要手动拉就先 pause，错误消息里直接告诉用户这句。
   */
  async start(input: StartJobInput): Promise<JobDto> {
    const { symbol, kind } = input;
    if (this.runningBySymbol.has(symbol)) {
      throw new SyncError('SYNC_ALREADY_RUNNING', `${symbol} 已有作业在进行中`, {
        symbol,
        jobId: this.runningBySymbol.get(symbol) ?? null,
      });
    }
    if (await this.options.isDaemonOwned(symbol)) {
      throw new SyncError(
        'SYNC_ALREADY_RUNNING',
        `${symbol} 的期望状态是 running，归守护进程所有；请先 pause 再手动拉取`,
        { symbol, desiredState: 'running' },
      );
    }

    const id = this.idFactory();
    const job: JobDto = {
      id,
      kind,
      symbol,
      status: 'running',
      startedAt: this.now(),
      finishedAt: null,
      progress: { rows: null, target: input.target ?? null, pendingGaps: null },
      result: null,
      error: null,
    };
    this.jobs.set(id, job);
    this.order.push(id);
    this.runningBySymbol.set(symbol, id);
    this.evict();

    // 故意不 await：调用方拿到 id 就走，作业在后台推进。
    void this.execute(job);
    return job;
  }

  private async execute(job: JobDto): Promise<void> {
    // 停止信号用 Promise 表达，这样才能用 Promise.race **立刻**打断休眠：
    // 否则作业结束后还要干等一整个轮询周期才对外可见「已结束」。
    let stopped = false;
    let markStopped: () => void = () => undefined;
    const stopSignal = new Promise<void>((r) => {
      markStopped = r;
    });
    const progressTask = this.trackProgress(job, stopSignal, () => stopped);

    // 先攒结果，**最后一步**才把 status 翻成非 running：
    // 页面一看到「结束」就可能立刻发下一次请求，若此时 runningBySymbol 还没释放，
    // 用户会撞上一个自己完全无法理解的 SYNC_ALREADY_RUNNING。
    let outcome: JobStatus = 'succeeded';
    try {
      const run = job.kind === 'full' ? this.options.runFull : this.options.runVerify;
      job.result = await run(job.symbol);
    } catch (error) {
      outcome = 'failed';
      job.error = toJobError(error);
    } finally {
      stopped = true;
      markStopped();
      await progressTask;
      // 收尾再采一次：让结束时的行数是最新的，而不是上一轮轮询的旧值。
      await this.sample(job);
      job.finishedAt = this.now();
      this.runningBySymbol.delete(job.symbol);
      job.status = outcome;
    }
  }

  private async trackProgress(
    job: JobDto,
    stopSignal: Promise<void>,
    shouldStop: () => boolean,
  ): Promise<void> {
    for (;;) {
      if (shouldStop()) return;
      await this.sample(job);
      if (shouldStop()) return;
      // race 掉休眠：作业结束时立刻返回，而不是等满一个轮询周期。
      await Promise.race([this.sleep(this.pollIntervalMs), stopSignal]);
    }
  }

  private async sample(job: JobDto): Promise<void> {
    const progress: ProgressSample | null = await this.options
      .readProgress(job.symbol)
      .catch(() => null);
    if (progress === null) return;
    job.progress = {
      rows: progress.rows,
      target: job.progress.target,
      pendingGaps: progress.pendingGaps,
    };
  }

  /** 只保留最近 historyLimit 条已结束的作业；运行中的绝不驱逐。 */
  private evict(): void {
    while (this.order.length > this.historyLimit) {
      const oldest = this.order[0];
      if (oldest === undefined) return;
      const job = this.jobs.get(oldest);
      if (job && job.status === 'running') return;
      this.order.shift();
      this.jobs.delete(oldest);
    }
  }
}
