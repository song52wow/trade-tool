import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { CoverageDto } from '../../../src/types';
import { fmtDate } from '../format.js';

/**
 * 覆盖时间线：从 onboartDate 到「现在」画一条横轴，用竖线标出三个事实——
 * 最早入库、已验证水位、增量水位。缺口和「没拉到的那段」会直接显形，
 * 这比看一堆数字更容易判断该跑 verify 还是 backfill。
 */
export function CoverageChart(props: { coverage: CoverageDto }) {
  const { onboardDate, earliest, watermark, verifiedUpTo, now } = props.coverage;
  if (onboardDate === null) {
    return <p className="muted">元数据里没有该标的，无法画出覆盖时间线。</p>;
  }
  const start = earliest ?? onboardDate;
  const end = Math.max(now, start + 60_000);
  // 透明底条把「起点之前」那段留白，蓝色那段才是真正的时间跨度
  const data = [{ name: 'coverage', base: start, span: end - start }];
  const markers: { key: string; at: number; label: string; color: string }[] = [];
  if (earliest !== null)
    markers.push({ key: 'earliest', at: earliest, label: '最早入库', color: '#3fb950' });
  if (verifiedUpTo !== null)
    markers.push({ key: 'verified', at: verifiedUpTo, label: '已验证', color: '#a371f7' });
  if (watermark !== null)
    markers.push({ key: 'watermark', at: watermark, label: '水位', color: '#d29922' });

  return (
    <div className="chart-box">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 8, right: 24, bottom: 8, left: 0 }}>
          <CartesianGrid horizontal={false} stroke="#2a2f3a" />
          <XAxis
            type="number"
            domain={[start, end]}
            tickFormatter={(v: number) => fmtDate(v)}
            stroke="#9aa3b2"
            fontSize={11}
          />
          <YAxis type="category" dataKey="name" hide />
          <Tooltip
            formatter={(v: number) => fmtDate(v)}
            labelFormatter={() => ''}
            contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', fontSize: 12 }}
          />
          <Bar dataKey="base" stackId="a" fill="transparent" isAnimationActive={false} />
          <Bar dataKey="span" stackId="a" fill="#4c8dff" barSize={20} isAnimationActive={false} />
          {markers.map((m) => (
            <ReferenceLine
              key={m.key}
              x={m.at}
              stroke={m.color}
              strokeDasharray="3 3"
              label={{ value: m.label, fill: m.color, fontSize: 10, position: 'top' }}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
