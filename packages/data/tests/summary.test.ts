/**
 * 全局汇总的「指标层是否启用」判据（纯函数，不连库）。
 *
 * 锁的是一条**每 5 秒都在付**的开销：控制面的 `/api/overview` 会读全局汇总，
 * 而指标表统计（7 张表 × 行数 + 体积）只有「指标层真的启用」时才该跑。
 * 漏传 `null` 时它照样去数 7 张空表，并且把「关闭」显示成「0 行」——
 * 既慢又谎报（2026-11-12 审计发现）。
 */

import { defaultConfig } from '@trade-tool/core';
import { describe, expect, it } from 'vitest';

import { summaryIndicatorIntervals } from '../src/index.js';

describe('summaryIndicatorIntervals', () => {
  it('缺省配置（七个键都是空数组）→ null：关闭就是关闭，不是 0 行', () => {
    const data = defaultConfig().data;
    // zod 会把七个键都补成 `[]`（不是字面量 `{}`），所以「关闭」的判据是**全空**，
    // 不是「键不存在」——这两种写法都必须落到 null。
    expect(Object.values(data.indicatorSpecs).every((specs) => specs.length === 0)).toBe(true);
    expect(summaryIndicatorIntervals(data)).toBeNull();
  });

  it('七个键都显式写成空数组也算关闭（「没启用」不等于「配置里出现了这个键」）', () => {
    const data = defaultConfig().data;
    data.indicatorSpecs = {
      ma: [],
      macd: [],
      rsi: [],
      boll: [],
      kdj: [],
      atr: [],
      obv: [],
    };
    expect(summaryIndicatorIntervals(data)).toBeNull();
  });

  it('只要有一个参数集 → 返回**实际启用的周期**（交给 readGlobalSummary 去数）', () => {
    const data = defaultConfig().data;
    data.indicatorSpecs = {
      ma: [{ kind: 'sma', window: 20 }],
      macd: [],
      rsi: [],
      boll: [],
      kdj: [],
      atr: [],
      obv: [],
    };
    expect(summaryIndicatorIntervals(data)).toEqual(data.indicatorIntervals);
  });
});
