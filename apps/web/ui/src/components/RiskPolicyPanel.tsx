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
  /** 第一段减仓的**百分数**（0–100），不是 0–1。 */
  takeProfit1Percent: string;
  takeProfit1AtrMult: string;
  trailAtrMult: string;
  /** 复选框用字符串存，因为表单整体是「非空字符串 = 可提交」。 */
  breakevenAfterTp1: string;
};

const EMPTY_FORM: PolicyForm = {
  atrPeriod: '',
  atrInterval: '15m',
  stopAtrMult: '',
  takeProfitAtrMult: '',
  takeProfit1Percent: '0',
  takeProfit1AtrMult: '3',
  trailAtrMult: '2',
  breakevenAfterTp1: 'true',
};

function toForm(p: RiskPolicyDto): PolicyForm {
  return {
    atrPeriod: String(p.atrPeriod),
    atrInterval: p.atrInterval,
    stopAtrMult: String(p.stopAtrMult),
    takeProfitAtrMult: String(p.takeProfitAtrMult),
    // 百分数由服务端换算好（core 那边只有一份实现），前端不自己 `× 100`。
    takeProfit1Percent: String(p.takeProfit1Percent),
    takeProfit1AtrMult: String(p.takeProfit1AtrMult),
    trailAtrMult: String(p.trailAtrMult),
    breakevenAfterTp1: String(p.breakevenAfterTp1),
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
  /** 运行时发现的标的集合（不含硬编码合约名）。设置页用它填下拉框。 */
  symbols: string[];
  notify: (text: string, kind?: 'ok' | 'err') => void;
  /**
   * 锁定到某一个标的（**标的详情页用**）。给了它就没有下拉框，
   * 并且**只显示这个标的的覆盖表单**。
   *
   * 为什么不显示「全局默认」那一栏：在单标的的页面上摆一个「保存全局默认」的按钮，
   * 是最容易被误按的地方——按下去影响的是**所有**标的，而用户以为自己只改了当前这个。
   * 全局那层仍然以「当前生效」的只读形式显示在上面。
   */
  fixedSymbol?: string;
}) {
  const [pickedSymbol, setPickedSymbol] = useState('');
  const symbol = props.fixedSymbol ?? pickedSymbol;
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
      takeProfit1Percent: Number(form.takeProfit1Percent),
      takeProfit1AtrMult: Number(form.takeProfit1AtrMult),
      trailAtrMult: Number(form.trailAtrMult),
      breakevenAfterTp1: form.breakevenAfterTp1 === 'true',
    };
    // 本地只拦「空 / 非数字」这种必然失败的提交；**范围校验交给服务端**并在页面上显示它回的错误，
    // 不在前端复制一份规则（复制一份就会与服务端漂移，届时两边给出不同的答案）。
    if (
      !Number.isFinite(body.atrPeriod) ||
      !Number.isFinite(body.stopAtrMult) ||
      !Number.isFinite(body.takeProfitAtrMult) ||
      !Number.isFinite(body.takeProfit1Percent) ||
      !Number.isFinite(body.takeProfit1AtrMult) ||
      !Number.isFinite(body.trailAtrMult)
    ) {
      setError('[CONFIG_INVALID] 数值字段都必须是数字');
      return;
    }
    if (body.takeProfit1Percent < 0 || body.takeProfit1Percent > 100) {
      setError('[CONFIG_INVALID] 第一段减仓的百分比必须在 0 与 100 之间');
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

      {props.fixedSymbol !== undefined ? (
        <div className="row" style={{ marginBottom: 12 }}>
          <span className="muted" style={{ fontSize: 12 }}>
            当前标的
          </span>
          <span className="mono">{props.fixedSymbol}</span>
          <span className="muted" style={{ fontSize: 12 }}>
            （这一栏改的是该标的的覆盖；全局默认在「设置」页改）
          </span>
        </div>
      ) : (
        <div className="row" style={{ marginBottom: 12 }}>
          <label className="row" style={{ gap: 6 }}>
            <span className="muted" style={{ fontSize: 12 }}>
              查看标的
            </span>
            <select
              aria-label="选择标的"
              value={symbol}
              onChange={(e) => setPickedSymbol(e.target.value)}
            >
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
      )}

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
            <dt>第一段减仓</dt>
            <dd className="mono">
              {/* 服务端已经把比例换算成百分数（浏览器端不引 core，见 apps/web/src/service.ts） */}
              {view.resolved.takeProfit1Percent}%
              {view.resolved.takeProfit1Percent === 0
                ? '（不分批）'
                : view.resolved.takeProfit1Percent >= 100
                  ? '（到价全平）'
                  : `（余下 ${Number((100 - view.resolved.takeProfit1Percent).toFixed(4))}% 交给移动止损）`}
            </dd>
            <dt>移动止损倍数</dt>
            <dd className="mono">
              {view.resolved.trailAtrMult} × ATR
              {view.resolved.breakevenAfterTp1 ? ' · 兑现后上移到保本' : ''}
            </dd>
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
        {/* 单标的页不渲染全局那栏（见 fixedSymbol 的注释） */}
        {props.fixedSymbol === undefined ? (
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
        ) : null}
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

      {/* v0.7.0 两段止盈。三个取值走三种形态，提示必须写清，否则用户会把
          「0」误读成「不分批也不止盈」。 */}
      <div className="row" style={{ marginTop: 10 }}>
        <label>
          <span className="label">第一段止盈减仓（%）</span>
          <input
            type="number"
            inputMode="decimal"
            step="1"
            min={0}
            max={100}
            aria-label={`${props.title} 第一段止盈减仓百分比`}
            value={form.takeProfit1Percent}
            disabled={disabled}
            onChange={(e) => set({ takeProfit1Percent: e.target.value })}
          />
        </label>
        <label>
          <span className="label">第一段止盈倍数（× ATR）</span>
          <input
            type="number"
            inputMode="decimal"
            step="0.1"
            aria-label={`${props.title} 第一段止盈倍数`}
            value={form.takeProfit1AtrMult}
            disabled={disabled}
            onChange={(e) => set({ takeProfit1AtrMult: e.target.value })}
          />
        </label>
        <label>
          <span className="label">移动止损倍数（× ATR）</span>
          <input
            type="number"
            inputMode="decimal"
            step="0.1"
            aria-label={`${props.title} 移动止损倍数`}
            value={form.trailAtrMult}
            disabled={disabled}
            onChange={(e) => set({ trailAtrMult: e.target.value })}
          />
        </label>
      </div>
      <div className="row" style={{ marginTop: 6, alignItems: 'center' }}>
        <label className="row" style={{ gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            aria-label={`${props.title} 第一段兑现后止损上移到保本位`}
            checked={form.breakevenAfterTp1 === 'true'}
            disabled={disabled}
            onChange={(e) => set({ breakevenAfterTp1: String(e.target.checked) })}
          />
          <span className="label">第一段兑现后，剩余仓位止损上移到保本位</span>
        </label>
      </div>
      <p className="hint">
        0% = 不分批（到价一次全平，与旧行为一致）；1–99% = 先按「第一段止盈倍数」
        卖掉这个比例，剩余仓位交给移动止损（止损 = 持仓期最高价 − 移动止损倍数 × 当前
        ATR，只上移不放宽）；100% = 到价一次全平，用「第一段止盈倍数」算。
      </p>

      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" disabled={disabled} onClick={props.onSubmit}>
          {props.submitLabel}
        </button>
        {props.extra}
      </div>
    </div>
  );
}
