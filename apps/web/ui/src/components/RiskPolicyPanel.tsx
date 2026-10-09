import { useLayoutEffect, useState } from 'react';

import { ApiError, api } from '../api.js';
import { fmtTime } from '../format.js';
import type { RiskPolicyDto, RiskPolicyViewDto } from '../../../src/types';

/** 服务端只接受这几个周期；下拉里不给出 `5m` / `2h` 之类未实现的档位，免得提交后被拒。 */
const INTERVALS = ['1m', '15m', '1h', '4h', '1d'] as const;

type PolicyForm = {
  atrPeriod: string;
  atrInterval: string;
  stopAtrMult: string;
  takeProfitAtrMult: string;
};

const EMPTY_FORM: PolicyForm = {
  atrPeriod: '',
  atrInterval: '15m',
  stopAtrMult: '',
  takeProfitAtrMult: '',
};

function toForm(p: RiskPolicyDto): PolicyForm {
  return {
    atrPeriod: String(p.atrPeriod),
    atrInterval: p.atrInterval,
    stopAtrMult: String(p.stopAtrMult),
    takeProfitAtrMult: String(p.takeProfitAtrMult),
  };
}

/**
 * 生效来源的三档标签与视觉等级。
 *
 * 三档必须一眼可分：用户在看某个标的时，最该知道的是「现在生效的这一套到底是哪一层来的」。
 * 合成一句话（比如「默认策略」）会让「我改过但没生效」这类问题永远查不出来。
 */
const SOURCE_META: Record<
  RiskPolicyViewDto['resolved']['source'],
  { label: string; cls: string; hint: string }
> = {
  symbol: {
    label: '本标的覆盖',
    cls: 'source source-symbol',
    hint: '来自该标的自己的覆盖，优先于全局',
  },
  global: { label: '全局默认', cls: 'source source-global', hint: '来自全局默认，该标的没有覆盖' },
  config: {
    label: '配置文件',
    cls: 'source source-config',
    hint: '库里还没有任何设置，用的是配置文件里的值',
  },
};

function reason(error: unknown): string {
  if (error instanceof ApiError) return `[${error.code}] ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export function RiskPolicyPanel(props: {
  /** 运行时发现的标的集合（不含硬编码合约名）。 */
  symbols: string[];
  notify: (text: string, kind?: 'ok' | 'err') => void;
}) {
  const [symbol, setSymbol] = useState('');
  const [view, setView] = useState<RiskPolicyViewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [globalForm, setGlobalForm] = useState<PolicyForm>(EMPTY_FORM);
  const [symbolForm, setSymbolForm] = useState<PolicyForm>(EMPTY_FORM);

  useLayoutEffect(() => {
    let cancelled = false;
    void api
      .riskPolicy(symbol === '' ? undefined : symbol)
      .then((v) => {
        if (cancelled) return;
        setView(v);
        setGlobalForm(v.global === null ? EMPTY_FORM : toForm(v.global));
        const own = v.overrides.find((o) => o.symbol === symbol);
        setSymbolForm(own === undefined ? EMPTY_FORM : toForm(own));
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(reason(e));
      });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  const submit = (scope: 'global' | 'symbol') => {
    const form = scope === 'global' ? globalForm : symbolForm;
    const body = {
      scope,
      ...(scope === 'symbol' ? { symbol } : {}),
      atrPeriod: Number(form.atrPeriod),
      atrInterval: form.atrInterval,
      stopAtrMult: Number(form.stopAtrMult),
      takeProfitAtrMult: Number(form.takeProfitAtrMult),
    };
    // 本地只拦「空 / 非数字」这种必然失败的提交；**范围校验交给服务端**并在页面上显示它回的错误，
    // 不在前端复制一份规则（复制一份就会与服务端漂移，届时两边给出不同的答案）。
    if (
      !Number.isFinite(body.atrPeriod) ||
      !Number.isFinite(body.stopAtrMult) ||
      !Number.isFinite(body.takeProfitAtrMult)
    ) {
      setError('[CONFIG_INVALID] 三个数值字段都必须是数字');
      return;
    }
    if (scope === 'symbol' && symbol === '') {
      setError('[CONFIG_INVALID] 先在上方选择一个标的才能保存覆盖');
      return;
    }
    setBusy(true);
    setError(null);
    void api
      .putRiskPolicy(body)
      .then(() => {
        props.notify(scope === 'global' ? '全局默认已保存' : `${symbol} 的覆盖已保存`);
        // 保存后按服务端给的值重新读一遍：页面显示的必须来自库，而不是本地这一份输入。
        void api
          .riskPolicy(scope === 'symbol' ? symbol : undefined)
          .then((v) => {
            setView(v);
            setGlobalForm(v.global === null ? EMPTY_FORM : toForm(v.global));
            const own = v.overrides.find((o) => o.symbol === symbol);
            setSymbolForm(own === undefined ? EMPTY_FORM : toForm(own));
          })
          .catch((e: unknown) => setError(reason(e)));
      })
      .catch((e: unknown) => setError(reason(e)))
      .finally(() => setBusy(false));
  };

  const dropOverride = () => {
    if (symbol === '') return;
    setBusy(true);
    setError(null);
    void api
      .deleteRiskPolicy('symbol', symbol)
      .then(() => {
        props.notify(`${symbol} 已回到全局默认`);
        return api.riskPolicy(symbol);
      })
      .then((v) => {
        setView(v);
        setSymbolForm(EMPTY_FORM);
        setGlobalForm(v.global === null ? EMPTY_FORM : toForm(v.global));
      })
      .catch((e: unknown) => setError(reason(e)))
      .finally(() => setBusy(false));
  };

  const source = view === null ? null : SOURCE_META[view.resolved.source];
  const hasOverride = view !== null && view.overrides.some((o) => o.symbol === symbol);

  return (
    <div className="panel">
      <h2>止盈止损策略</h2>

      {error !== null ? (
        <div className="banner">
          策略操作失败：{error}
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            校验规则由服务端执行；这条错误会留在页面上，改对再提交才会消失。
          </div>
        </div>
      ) : null}

      <div className="row" style={{ marginBottom: 12 }}>
        <label className="row" style={{ gap: 6 }}>
          <span className="muted" style={{ fontSize: 12 }}>
            查看标的
          </span>
          <select aria-label="选择标的" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            <option value="">（不指定，看全局默认）</option>
            {props.symbols.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        {props.symbols.length === 0 ? (
          <span className="muted" style={{ fontSize: 12 }}>
            标的集合为空——先用首页的输入框添加标的。
          </span>
        ) : null}
      </div>

      {view !== null && source !== null ? (
        <div className="resolved">
          <div className="row" style={{ gap: 8 }}>
            <span className="muted" style={{ fontSize: 12 }}>
              当前生效
            </span>
            <span className={source.cls} title={source.hint}>
              {source.label}
            </span>
          </div>
          <dl className="kv" style={{ marginTop: 8 }}>
            <dt>ATR 周期</dt>
            <dd className="mono">
              {view.resolved.atrPeriod} × {view.resolved.atrInterval}
            </dd>
            <dt>止损倍数</dt>
            <dd className="mono">{view.resolved.stopAtrMult} × ATR</dd>
            <dt>止盈倍数</dt>
            <dd className="mono">{view.resolved.takeProfitAtrMult} × ATR</dd>
          </dl>
          <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
            {source.hint}
            {symbol === '' ? '（当前没有指定标的，显示的就是全局这一层。）' : ''}
          </p>
        </div>
      ) : (
        <p className="muted">读取中…</p>
      )}

      <div className="grid2" style={{ marginTop: 16 }}>
        <PolicyFormBlock
          title="全局默认"
          subtitle={
            view?.global === null || view === null
              ? '尚未设置：新建的标的会落到配置文件那一档'
              : `更新于 ${fmtTime(view.global.updatedAt)}`
          }
          form={globalForm}
          disabled={busy}
          onChange={setGlobalForm}
          onSubmit={() => submit('global')}
          submitLabel="保存全局默认"
        />
        <PolicyFormBlock
          title={symbol === '' ? '标的覆盖' : `${symbol} 的覆盖`}
          subtitle={
            symbol === ''
              ? '先在上方选择标的'
              : hasOverride
                ? '该标的有覆盖，优先于全局'
                : '该标的没有覆盖，正在生效的是上面那一档'
          }
          form={symbolForm}
          disabled={busy || symbol === ''}
          onChange={setSymbolForm}
          onSubmit={() => submit('symbol')}
          submitLabel="保存覆盖"
          extra={
            <button className="danger" disabled={busy || !hasOverride} onClick={dropOverride}>
              删除覆盖（回到全局默认）
            </button>
          }
        />
      </div>

      {view !== null && view.overrides.length > 0 ? (
        <div style={{ marginTop: 16 }}>
          <h3 className="sub">当前所有标的覆盖（{view.overrides.length}）</h3>
          <div className="row">
            {view.overrides.map((o) => (
              <span
                key={o.symbol}
                className="tag source source-symbol"
                title={`ATR ${o.atrPeriod} × ${o.atrInterval}`}
              >
                {o.symbol}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <p className="muted" style={{ fontSize: 12, margin: '14px 0 0' }}>
        改动<b>只影响之后的新买入成交</b>：已经挂出去的止盈 / 止损单不会被撤单重挂，
        按买入那一刻算出来的 ATR 与倍数继续有效。
      </p>
    </div>
  );
}

function PolicyFormBlock(props: {
  title: string;
  subtitle: string;
  form: PolicyForm;
  disabled: boolean;
  onChange: (form: PolicyForm) => void;
  onSubmit: () => void;
  submitLabel: string;
  extra?: React.ReactNode;
}) {
  const { form, disabled, onChange } = props;
  const set = (patch: Partial<PolicyForm>) => onChange({ ...form, ...patch });
  return (
    <div className="form-block">
      <h3 className="sub">{props.title}</h3>
      <p className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>
        {props.subtitle}
      </p>
      <div className="form-grid">
        <label>
          <span className="label">ATR 周期（根）</span>
          <input
            type="number"
            inputMode="numeric"
            aria-label={`${props.title} ATR 周期`}
            value={form.atrPeriod}
            disabled={disabled}
            onChange={(e) => set({ atrPeriod: e.target.value })}
          />
        </label>
        <label>
          <span className="label">ATR 周期口径</span>
          <select
            aria-label={`${props.title} ATR 周期口径`}
            value={form.atrInterval}
            disabled={disabled}
            onChange={(e) => set({ atrInterval: e.target.value })}
          >
            {INTERVALS.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">止损倍数（× ATR）</span>
          <input
            type="number"
            inputMode="decimal"
            step="0.1"
            aria-label={`${props.title} 止损倍数`}
            value={form.stopAtrMult}
            disabled={disabled}
            onChange={(e) => set({ stopAtrMult: e.target.value })}
          />
        </label>
        <label>
          <span className="label">止盈倍数（× ATR）</span>
          <input
            type="number"
            inputMode="decimal"
            step="0.1"
            aria-label={`${props.title} 止盈倍数`}
            value={form.takeProfitAtrMult}
            disabled={disabled}
            onChange={(e) => set({ takeProfitAtrMult: e.target.value })}
          />
        </label>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" disabled={disabled} onClick={props.onSubmit}>
          {props.submitLabel}
        </button>
        {props.extra}
      </div>
    </div>
  );
}
