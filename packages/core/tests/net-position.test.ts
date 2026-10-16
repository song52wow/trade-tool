/**
 * 流内增量净额 + 三段判定（纯逻辑，不连 PG、不出网）。
 *
 * 这块判据决定「挂不挂保护」，错了就是仓位裸奔，所以锁的是最容易错的三类：
 * 减仓被当成开仓、平仓被当成减仓、以及「没跟踪过」被当成「空仓」。
 */

import { NetPositionTracker, classifyFill, signedFillDelta } from '@trade-tool/core';
import { describe, expect, it } from 'vitest';

describe('signedFillDelta', () => {
  it('BUY 加、SELL 减', () => {
    expect(signedFillDelta('BUY', 0.1)).toBe(0.1);
    expect(signedFillDelta('SELL', 0.1)).toBe(-0.1);
  });

  it('数量非法直接抛错，不当成 0 继续算', () => {
    expect(() => signedFillDelta('BUY', Number.NaN)).toThrow(TypeError);
  });
});

describe('classifyFill', () => {
  it('归零 → 平仓（工具外平仓的唯一入口）', () => {
    expect(classifyFill({ side: 'SELL', delta: -0.1, positionAfter: 0 })).toBe('closed');
    expect(classifyFill({ side: 'BUY', delta: 0.1, positionAfter: 0 })).toBe('closed');
  });

  it('方向一致 → 新开仓（含开空）', () => {
    expect(classifyFill({ side: 'BUY', delta: 0.1, positionAfter: 0.1 })).toBe('opened');
    expect(classifyFill({ side: 'SELL', delta: -0.1, positionAfter: -0.1 })).toBe('opened');
  });

  it('方向相反 → 减仓。这条是「只做多」时代的老写法会错的地方', () => {
    // 有多仓时卖出：净额仍为正 → 减仓，不是开空
    expect(classifyFill({ side: 'SELL', delta: -0.1, positionAfter: 0.1 })).toBe('reduced');
    // 有空仓时买入：净额仍为负 → 减仓，不是开多
    expect(classifyFill({ side: 'BUY', delta: 0.1, positionAfter: -0.1 })).toBe('reduced');
  });
});

describe('NetPositionTracker', () => {
  it('未跟踪过的标的返回 undefined，而不是 0', () => {
    const t = new NetPositionTracker();
    expect(t.get('BTCUSDT')).toBeUndefined();
  });

  it('播种后按成交逐笔累加，与交易所净额一致', () => {
    const t = new NetPositionTracker();
    t.seed('BTCUSDT', 0);
    expect(t.apply('BTCUSDT', signedFillDelta('SELL', 0.1))).toBe(-0.1); // 开空
    expect(t.apply('BTCUSDT', signedFillDelta('SELL', 0.05))).toBeCloseTo(-0.15, 10); // 加空
    expect(t.apply('BTCUSDT', signedFillDelta('BUY', 0.15))).toBe(0); // 平空
  });

  it('重启后从既有仓位播种，再累加仍然正确', () => {
    const t = new NetPositionTracker();
    t.seed('BTCUSDT', -0.0024); // 上次退出时带着的空仓
    expect(t.apply('BTCUSDT', signedFillDelta('BUY', 0.0024))).toBe(0);
  });

  it('ACCOUNT_UPDATE 校正会覆盖本地值', () => {
    const t = new NetPositionTracker();
    t.seed('BTCUSDT', 0.1);
    t.apply('BTCUSDT', signedFillDelta('SELL', 0.05));
    t.correct('BTCUSDT', 0, 1_000);
    expect(t.get('BTCUSDT')).toBe(0);
  });

  it('未播种就 apply 视为从 0 起算（唯一可辩护的初值）', () => {
    const t = new NetPositionTracker();
    expect(t.apply('NEWUSDT', signedFillDelta('BUY', 0.2))).toBe(0.2);
  });

  it('reset 清空全部跟踪，重连后从零开始播种', () => {
    const t = new NetPositionTracker();
    t.seed('BTCUSDT', 0.1);
    t.seed('ETHUSDT', -0.2);
    expect(t.size).toBe(2);
    t.reset();
    expect(t.size).toBe(0);
    expect(t.get('BTCUSDT')).toBeUndefined();
  });

  it('非法增量直接抛错，不让失准悄悄发生', () => {
    const t = new NetPositionTracker();
    expect(() => t.apply('BTCUSDT', Number.NaN)).toThrow(TypeError);
    expect(() => t.seed('BTCUSDT', Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

describe('浮点残差', () => {
  it('平掉一手 0.1 后净额精确归零，不留 -2.8e-17', () => {
    const t = new NetPositionTracker();
    t.seed('BTCUSDT', 0);
    t.apply('BTCUSDT', signedFillDelta('SELL', 0.1));
    t.apply('BTCUSDT', signedFillDelta('SELL', 0.05));
    expect(t.apply('BTCUSDT', signedFillDelta('BUY', 0.15))).toBe(0);
  });

  it('分类判定用容差，平仓不会被判成减仓', () => {
    // 直接喂浮点残差：这是逐笔累加后的真实形态
    expect(classifyFill({ side: 'BUY', delta: 0.15, positionAfter: -2.7755575615628914e-17 })).toBe(
      'closed',
    );
  });
});

describe('ACCOUNT_UPDATE 与成交事件乱序（双计防护）', () => {
  it('校正先到、成交后到：该成交不再累加，否则会凭空造出反向仓位', () => {
    const t = new NetPositionTracker();
    t.seed('BTCUSDT', -0.0024);

    // 交易所先推「仓位 = 0」（撮合时间 T），它描述的正是下一笔成交的效果。
    t.correct('BTCUSDT', 0, 1_000);
    expect(t.get('BTCUSDT')).toBe(0);

    // 那笔平仓成交随后才到，撮合时间与校正相同 → 效果已计入，跳过累加。
    const result = t.applyFill('BTCUSDT', signedFillDelta('BUY', 0.0024), 1_000);
    expect(result.applied).toBe(false);
    expect(result.positionAfter).toBe(0);
    expect(t.get('BTCUSDT')).toBe(0); // 关键：不能再变成 +0.0024

    // 判定仍然要用「成交后的净额」——它正是把仓位变平的那一笔。
    expect(classifyFill({ side: 'BUY', delta: 0.0024, positionAfter: result.positionAfter })).toBe(
      'closed',
    );
  });

  it('撮合时间晚于校正的成交照常累加', () => {
    const t = new NetPositionTracker();
    t.seed('BTCUSDT', 0);
    t.correct('BTCUSDT', 0, 1_000);
    const result = t.applyFill('BTCUSDT', signedFillDelta('SELL', 0.1), 2_000);
    expect(result.applied).toBe(true);
    expect(result.positionAfter).toBe(-0.1);
  });

  it('reset 清掉校正水位，重连后旧成交不会继续被跳过', () => {
    const t = new NetPositionTracker();
    t.correct('BTCUSDT', 0, 1_000);
    t.reset();
    expect(t.applyFill('BTCUSDT', signedFillDelta('BUY', 0.1), 1_000).applied).toBe(true);
  });
});
