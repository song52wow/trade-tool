/**
 * 分析师报告与交易员执行方案的读写（v1.0.0）。
 *
 * 表结构的唯一来源是 `sql/016_agent_decisions.sql`（AGENTS.md 约定 3）。
 *
 * ## 写进来的都是「事实」，不是「判据」
 *
 * `stance` / `confidence` / 价格 / 数量 **全部是纯函数算出来的结果**，
 * 这个模块只负责把它们**原样**存下来。它不重算、不修正、不兜底——
 * 一份算错了的方案存进去，也必须原样存进去（页面上要能看到它错在哪）。
 *
 * ## 读出来的不加工
 *
 * 读侧只做「数据库行 → 领域对象」的搬运。`notes` / `adjustments` 是 JSONB，
 * 形状由 core 的类型定义，**这里不再校验一遍**（那是第二份定义）。
 */

import { SyncError, type AnalystVerdict, type Stance } from '@trade-tool/core';

import { toSyncError } from './errors.js';
import type { Pool } from './pool.js';

const REPORT_TABLE = 'analyst_report';
const PLAN_TABLE = 'trading_plan';

/** 落库的分析师报告。 */
export interface AnalystReportRecord {
  exchange: string;
  symbol: string;
  interval: string;
  /** 数据的时刻（epoch ms）。 */
  asOfMs: number;
  /** 报告生成的时刻（epoch ms）。 */
  createdAtMs: number;
  /** 合成结论（由 `aggregateAnalystReport` 算出）。 */
  verdict: AnalystVerdict;
  /** 当时的行情刻度。 */
  atr: number | null;
  lastClose: number | null;
  /** 喂给模型的完整上下文（留痕用）。 */
  context: unknown;
  /** 模型原始返回的正文。 */
  raw: string | null;
  /** 情绪面有接口没取到。 */
  degraded: boolean;
}

/** 落库的执行方案。`action = 'failed'` 时 `failureReason` 必须有值。 */
export interface TradingPlanRecord {
  exchange: string;
  symbol: string;
  /** 来自哪份报告。 */
  reportId: string | null;
  asOfMs: number;
  createdAtMs: number;
  /** 'enter' = 有可执行方案；'hold' = 这一轮不做；'failed' = 出不了方案。 */
  action: 'enter' | 'hold' | 'failed';
  /** 方向。`action = 'enter'` 时必有。 */
  side: 'BUY' | 'SELL' | null;
  entryType: 'market' | 'limit' | null;
  entryPrice: number | null;
  stopPrice: number | null;
  takeProfitPrice: number | null;
  quantity: number | null;
  notional: number | null;
  riskAmount: number | null;
  equity: number | null;
  equitySource: 'exchange' | 'config' | null;
  riskFraction: number | null;
  atr: number | null;
  stopAtrMult: number | null;
  takeProfitAtrMult: number | null;
  riskReward: number | null;
  stance: Stance;
  confidence: number;
  rationale: string;
  /** 为合规而做的调整。 */
  adjustments: string[];
  /** 出不了方案的原因。 */
  failureReason: string | null;
  raw: string | null;
}

/** 读出来的一份报告。 */
export interface AnalystReportRow {
  id: string;
  exchange: string;
  symbol: string;
  interval: string;
  asOfMs: number;
  createdAtMs: number;
  stance: Stance;
  confidence: number;
  bias: number;
  agreement: number;
  technical: { score: number; notes: string[] };
  sentiment: { score: number; notes: string[] };
  fundamental: { score: number; notes: string[] };
  atr: number | null;
  lastClose: number | null;
  stopAtrMult: number | null;
  takeProfitAtrMult: number | null;
  rationale: string;
  context: unknown;
  raw: string | null;
  degraded: boolean;
}

/** 读出来的一份方案。 */
export interface TradingPlanRow {
  id: string;
  exchange: string;
  symbol: string;
  reportId: string | null;
  asOfMs: number;
  createdAtMs: number;
  action: 'enter' | 'hold' | 'failed';
  status: 'advisory' | 'approved' | 'executed' | 'rejected' | 'expired';
  side: 'BUY' | 'SELL' | null;
  entryType: 'market' | 'limit' | null;
  entryPrice: number | null;
  stopPrice: number | null;
  takeProfitPrice: number | null;
  quantity: number | null;
  notional: number | null;
  riskAmount: number | null;
  equity: number | null;
  equitySource: 'exchange' | 'config' | null;
  riskFraction: number | null;
  atr: number | null;
  stopAtrMult: number | null;
  takeProfitAtrMult: number | null;
  riskReward: number | null;
  stance: Stance;
  confidence: number;
  rationale: string;
  adjustments: string[];
  failureReason: string | null;
  raw: string | null;
}

/**
 * 写入一份分析师报告。
 *
 * **同一份数据时刻的同一标的只留一份**（表上的唯一索引）：重跑一轮不该产生第二条，
 * 否则「这一轮怎么看的」在页面上会出现两个答案。
 *
 * 因此这里用 `ON CONFLICT ... DO UPDATE`：重复写同一份时刻时**覆盖**而不是报错——
 * 报错会让「重跑一轮」变成一次故障，而实际上第二次跑出来的报告通常更新（模型重新判了一次）。
 */
export async function recordAnalystReport(
  pool: Pool,
  record: AnalystReportRecord,
): Promise<string> {
  const v = record.verdict;
  try {
    const result = await pool.query(
      `INSERT INTO ${REPORT_TABLE}
         (exchange, symbol, interval, as_of_ms, created_at_ms,
          stance, confidence, bias, agreement,
          technical_score, sentiment_score, fundamental_score,
          technical_notes, sentiment_notes, fundamental_notes,
          atr, last_close, stop_atr_mult, take_profit_atr_mult,
          rationale, context, raw, degraded)
       VALUES ($1, $2, $3, $4, $5,
               $6, $7, $8, $9,
               $10, $11, $12,
               $13::jsonb, $14::jsonb, $15::jsonb,
               $16, $17, $18, $19,
               $20, $21::jsonb, $22, $23)
       ON CONFLICT (exchange, symbol, as_of_ms) DO UPDATE SET
         created_at_ms = EXCLUDED.created_at_ms,
         stance = EXCLUDED.stance,
         confidence = EXCLUDED.confidence,
         bias = EXCLUDED.bias,
         agreement = EXCLUDED.agreement,
         technical_score = EXCLUDED.technical_score,
         sentiment_score = EXCLUDED.sentiment_score,
         fundamental_score = EXCLUDED.fundamental_score,
         technical_notes = EXCLUDED.technical_notes,
         sentiment_notes = EXCLUDED.sentiment_notes,
         fundamental_notes = EXCLUDED.fundamental_notes,
         atr = EXCLUDED.atr,
         last_close = EXCLUDED.last_close,
         stop_atr_mult = EXCLUDED.stop_atr_mult,
         take_profit_atr_mult = EXCLUDED.take_profit_atr_mult,
         rationale = EXCLUDED.rationale,
         context = EXCLUDED.context,
         raw = EXCLUDED.raw,
         degraded = EXCLUDED.degraded
       RETURNING id`,
      [
        record.exchange,
        record.symbol,
        record.interval,
        record.asOfMs,
        record.createdAtMs,
        v.stance,
        v.confidence,
        v.bias,
        v.agreement,
        v.facets.technical.score,
        v.facets.sentiment.score,
        v.facets.fundamental.score,
        JSON.stringify(v.facets.technical.notes),
        JSON.stringify(v.facets.sentiment.notes),
        JSON.stringify(v.facets.fundamental.notes),
        record.atr,
        record.lastClose,
        v.stopAtrMult,
        v.takeProfitAtrMult,
        v.rationale,
        JSON.stringify(record.context ?? {}),
        record.raw,
        record.degraded,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new SyncError('INTERNAL_ERROR', '写分析师报告后没有拿到 id', {
        symbol: record.symbol,
      });
    }
    return String(row['id']);
  } catch (error) {
    throw toSyncError(error, `写入分析师报告失败：${record.symbol}`);
  }
}

/**
 * 写入一份执行方案。
 *
 * 每一轮都写一条，**不覆盖**：方案是历史，事后要能回答「当时为什么这么做」。
 * 「同一时刻重跑会不会写两条」由调用方用 `as_of_ms` 判——同一份数据时刻的方案
 * 是同一个，重复写两条只会让人在页面上看到两个答案。
 */
export async function recordTradingPlan(pool: Pool, record: TradingPlanRecord): Promise<string> {
  try {
    const result = await pool.query(
      `INSERT INTO ${PLAN_TABLE}
         (exchange, symbol, report_id, as_of_ms, created_at_ms,
          action, status, side, entry_type, entry_price, stop_price, take_profit_price,
          quantity, notional, risk_amount, equity, equity_source, risk_fraction,
          atr, stop_atr_mult, take_profit_atr_mult, risk_reward,
          stance, confidence, rationale, adjustments, failure_reason, raw)
       VALUES ($1, $2, $3, $4, $5,
               $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16, $17, $18,
               $19, $20, $21, $22,
               $23, $24, $25, $26::jsonb, $27, $28)
       RETURNING id`,
      [
        record.exchange,
        record.symbol,
        record.reportId,
        record.asOfMs,
        record.createdAtMs,
        record.action,
        'advisory',
        record.side,
        record.entryType,
        record.entryPrice,
        record.stopPrice,
        record.takeProfitPrice,
        record.quantity,
        record.notional,
        record.riskAmount,
        record.equity,
        record.equitySource,
        record.riskFraction,
        record.atr,
        record.stopAtrMult,
        record.takeProfitAtrMult,
        record.riskReward,
        record.stance,
        record.confidence,
        record.rationale,
        JSON.stringify(record.adjustments),
        record.failureReason,
        record.raw,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new SyncError('INTERNAL_ERROR', '写执行方案后没有拿到 id', { symbol: record.symbol });
    }
    return String(row['id']);
  } catch (error) {
    throw toSyncError(error, `写入执行方案失败：${record.symbol}`);
  }
}

/** 列表查询的过滤条件。`symbol` 缺省 = 全部标的。 */
export interface AgentListOptions {
  symbol?: string;
  limit?: number;
}

/** 最近一份分析师报告。从来没有过返回 `null`（不返回空报告）。 */
export async function readLatestAnalystReport(
  pool: Pool,
  exchange: string,
  symbol: string,
): Promise<AnalystReportRow | null> {
  const result = await pool.query(
    `SELECT * FROM ${REPORT_TABLE}
      WHERE exchange = $1 AND symbol = $2
      ORDER BY created_at_ms DESC, id DESC
      LIMIT 1`,
    [exchange, symbol],
  );
  const row = result.rows[0];
  return row === undefined ? null : toReportRow(row);
}

/**
 * 按 id 读一份分析师报告。
 *
 * 为什么要有「按 id 读」：调用方常常**刚刚跑完一轮**，手里握着这一轮落库的 id。
 * 这时候再去读「最近一条」会读到**上一轮**的——
 * 于是「这一轮模型失败了」就被显示成「这一轮有报告」，只是报告来自上一轮。
 * 那种错位不报错、也不显眼，是这个仓库最忌讳的一种失败。
 */
export async function readAnalystReportById(
  pool: Pool,
  exchange: string,
  symbol: string,
  id: string,
): Promise<AnalystReportRow | null> {
  const result = await pool.query(
    `SELECT * FROM ${REPORT_TABLE} WHERE exchange = $1 AND symbol = $2 AND id = $3`,
    [exchange, symbol, id],
  );
  const row = result.rows[0];
  return row === undefined ? null : toReportRow(row);
}

/** 最近若干份分析师报告。 */
export async function listAnalystReports(
  pool: Pool,
  exchange: string,
  options: AgentListOptions = {},
): Promise<AnalystReportRow[]> {
  const limit = options.limit ?? 20;
  const result = await pool.query(
    `SELECT * FROM ${REPORT_TABLE}
      WHERE exchange = $1 AND ($2::text IS NULL OR symbol = $2)
      ORDER BY created_at_ms DESC, id DESC
      LIMIT $3`,
    [exchange, options.symbol ?? null, limit],
  );
  return result.rows.map((row) => toReportRow(row));
}

/** 最近一份执行方案。从来没有过返回 `null`。 */
export async function readLatestTradingPlan(
  pool: Pool,
  exchange: string,
  symbol: string,
): Promise<TradingPlanRow | null> {
  const result = await pool.query(
    `SELECT * FROM ${PLAN_TABLE}
      WHERE exchange = $1 AND symbol = $2
      ORDER BY created_at_ms DESC, id DESC
      LIMIT 1`,
    [exchange, symbol],
  );
  const row = result.rows[0];
  return row === undefined ? null : toPlanRow(row);
}

/**
 * 按 id 读一份执行方案。理由同 {@link readAnalystReportById}：
 * 刚跑完一轮时读「最近一条」会读到上一轮的。
 */
export async function readTradingPlanById(
  pool: Pool,
  exchange: string,
  symbol: string,
  id: string,
): Promise<TradingPlanRow | null> {
  const result = await pool.query(
    `SELECT * FROM ${PLAN_TABLE} WHERE exchange = $1 AND symbol = $2 AND id = $3`,
    [exchange, symbol, id],
  );
  const row = result.rows[0];
  return row === undefined ? null : toPlanRow(row);
}

/** 最近若干份执行方案。 */
export async function listTradingPlans(
  pool: Pool,
  exchange: string,
  options: AgentListOptions = {},
): Promise<TradingPlanRow[]> {
  const limit = options.limit ?? 20;
  const result = await pool.query(
    `SELECT * FROM ${PLAN_TABLE}
      WHERE exchange = $1 AND ($2::text IS NULL OR symbol = $2)
      ORDER BY created_at_ms DESC, id DESC
      LIMIT $3`,
    [exchange, options.symbol ?? null, limit],
  );
  return result.rows.map((row) => toPlanRow(row));
}

/**
 * 把一份方案的状态改成「已执行」或「已否决」。
 *
 * 只允许从 `advisory` / `approved` 改过来：一份已经 `executed` 的方案不该被改回
 * `advisory`（那会让「这单到底发出去没有」变得不确定）。
 *
 * @throws SyncError 'CONFIG_INVALID' 状态转换不合法；'DB_UNIQUE_VIOLATION' 找不到该方案。
 */
export async function updateTradingPlanStatus(
  pool: Pool,
  planId: string,
  status: TradingPlanRow['status'],
): Promise<void> {
  if (
    status !== 'approved' &&
    status !== 'executed' &&
    status !== 'rejected' &&
    status !== 'expired'
  ) {
    throw new SyncError('CONFIG_INVALID', `不允许把方案状态改成 ${status}`, { status });
  }
  try {
    const result = await pool.query(
      `UPDATE ${PLAN_TABLE} SET status = $2
        WHERE id = $1 AND status IN ('advisory', 'approved')`,
      [planId, status],
    );
    if (result.rowCount === 0) {
      throw new SyncError('DB_UNIQUE_VIOLATION', `方案 ${planId} 不存在，或已经不在可改的状态`, {
        planId,
        status,
      });
    }
  } catch (error) {
    throw toSyncError(error, `更新方案状态失败：${planId}`);
  }
}

function toNotes(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) {
    throw new SyncError('NULL_NOT_ALLOWED', `${where} 不是数组`, {
      value: JSON.stringify(value).slice(0, 200),
    });
  }
  return value.map((item) => String(item));
}

function toReportRow(row: Record<string, unknown>): AnalystReportRow {
  const where = `analyst_report#${String(row['id'])}`;
  return {
    id: String(row['id']),
    exchange: String(row['exchange']),
    symbol: String(row['symbol']),
    interval: String(row['interval']),
    asOfMs: Number(row['as_of_ms']),
    createdAtMs: Number(row['created_at_ms']),
    stance: row['stance'] as Stance,
    confidence: Number(row['confidence']),
    bias: Number(row['bias']),
    agreement: Number(row['agreement']),
    technical: {
      score: Number(row['technical_score']),
      notes: toNotes(row['technical_notes'], `${where}.technical_notes`),
    },
    sentiment: {
      score: Number(row['sentiment_score']),
      notes: toNotes(row['sentiment_notes'], `${where}.sentiment_notes`),
    },
    fundamental: {
      score: Number(row['fundamental_score']),
      notes: toNotes(row['fundamental_notes'], `${where}.fundamental_notes`),
    },
    atr: row['atr'] === null ? null : Number(row['atr']),
    lastClose: row['last_close'] === null ? null : Number(row['last_close']),
    stopAtrMult: row['stop_atr_mult'] === null ? null : Number(row['stop_atr_mult']),
    takeProfitAtrMult:
      row['take_profit_atr_mult'] === null ? null : Number(row['take_profit_atr_mult']),
    rationale: String(row['rationale']),
    context: row['context'],
    raw: row['raw'] === null ? null : String(row['raw']),
    degraded: row['degraded'] === true,
  };
}

function toPlanRow(row: Record<string, unknown>): TradingPlanRow {
  const where = `trading_plan#${String(row['id'])}`;
  const num = (key: string): number | null => (row[key] === null ? null : Number(row[key]));
  return {
    id: String(row['id']),
    exchange: String(row['exchange']),
    symbol: String(row['symbol']),
    reportId: row['report_id'] === null ? null : String(row['report_id']),
    asOfMs: Number(row['as_of_ms']),
    createdAtMs: Number(row['created_at_ms']),
    action: row['action'] as TradingPlanRow['action'],
    status: row['status'] as TradingPlanRow['status'],
    side: row['side'] === null ? null : (row['side'] as 'BUY' | 'SELL'),
    entryType: row['entry_type'] === null ? null : (row['entry_type'] as 'market' | 'limit'),
    entryPrice: num('entry_price'),
    stopPrice: num('stop_price'),
    takeProfitPrice: num('take_profit_price'),
    quantity: num('quantity'),
    notional: num('notional'),
    riskAmount: num('risk_amount'),
    equity: num('equity'),
    equitySource:
      row['equity_source'] === null ? null : (row['equity_source'] as 'exchange' | 'config'),
    riskFraction: num('risk_fraction'),
    atr: num('atr'),
    stopAtrMult: num('stop_atr_mult'),
    takeProfitAtrMult: num('take_profit_atr_mult'),
    riskReward: num('risk_reward'),
    stance: row['stance'] as Stance,
    confidence: Number(row['confidence']),
    rationale: String(row['rationale']),
    adjustments: toNotes(row['adjustments'], `${where}.adjustments`),
    failureReason: row['failure_reason'] === null ? null : String(row['failure_reason']),
    raw: row['raw'] === null ? null : String(row['raw']),
  };
}
