import { useLayoutEffect, useState } from 'react';

import { ApiError, api } from '../api.js';
import { fmtTime } from '../format.js';
import type { AgentLlmStatusDto } from '../../../src/types';
import { ConfirmDialog } from './ConfirmDialog.js';

function reason(error: unknown): string {
  if (error instanceof ApiError) return `[${error.code}] ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

interface Form {
  enabled: boolean;
  /** 留空 = 沿用当前生效的地址。 */
  baseUrl: string;
  /** 留空 = 沿用当前生效的模型名。 */
  model: string;
  /** 留空 = 沿用当前生效的密钥（提交时**不传** apiKey 字段）。 */
  apiKey: string;
  /** 超时以**秒**呈现，提交时换算成毫秒（换算只在这一处）。 */
  timeoutSeconds: string;
}

const EMPTY_FORM: Form = {
  enabled: false,
  baseUrl: '',
  model: '',
  apiKey: '',
  timeoutSeconds: '8',
};

/** 超时的上限，与配置文件里 `agent.llm.timeoutMs` 的上限一致（60 秒）。 */
const MAX_TIMEOUT_SECONDS = 60;

/**
 * 读到的状态 → 表单初值。
 *
 * **地址、模型名、密钥一律不回填**（`baseUrl` / `model` / `apiKey` 全是空串）：
 * 回包里没有明文密钥，页面手上根本没有那个值。把空框显示成「已填」比显示
 * 「已配置（末 4 位 xxxx）」危险得多——用户会以为已经配过了。
 *
 * 开关与超时按**当前生效的那一份**预置：用户看到的就是现在真正在用的设置。
 */
function formFromStatus(s: AgentLlmStatusDto): Form {
  return {
    enabled: s.enabled,
    baseUrl: '',
    model: '',
    apiKey: '',
    timeoutSeconds: String(Math.round(s.timeoutMs / 1000)),
  };
}

/**
 * 密钥状态的显示文案。
 *
 * `null` = **读不到**（主密钥没注入，解不开密文）。这时候必须说「不知道」，
 * 说「没配」是猜测，而页面会照着它显示——用户会以为还得去重新填一遍。
 */
function keyText(keyConfigured: boolean | null, hint: string | null): string {
  if (keyConfigured === null) return '不知道（主密钥没注入，读不到密文）';
  if (!keyConfigured) return '未配置';
  return hint === null ? '已配置' : `已配置（末 4 位 ${hint}）`;
}

/**
 * 模型接入设置（v1.0.0）。
 *
 * 这个区块要回答三个问题，缺一不可：
 *   * **哪一份在生效**——控制面录入的，还是配置文件 + 环境变量的？
 *   * **密钥配了没有**——配了只显示末 4 位；读不到就说「不知道」。
 *   * **改完之后写到哪里**——地址、模型名、密钥都是加密 / 落库，不会进日志。
 *
 * 四条硬约束，都写在代码里：
 *
 * 1. **不回填。** 回包里没有明文密钥，所以地址、模型名、密钥三个框读到状态后一律
 *    保持空。留空提交 = 保持原样（服务端按「原样传空串」处理）。
 * 2. **主密钥没就绪就禁用整个表单。** 没有它就没有加密密钥，填了也存不下来。
 * 3. **「清空控制面这一份」≠「关掉模型」。** 前者退回配置文件 + 环境变量，
 *    后者要把「启用模型」的勾去掉再保存。两件事混为一谈，用户会以为模型还在跑。
 * 4. **不留副本。** 输入只流向 `PUT` 那一次提交，提交完立刻清空。
 */
export function AgentLlmPanel(props: { notify: (text: string, kind?: 'ok' | 'err') => void }) {
  const [status, setStatus] = useState<AgentLlmStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'clearKey' | 'clearAll' | null>(null);

  // 取数用 layout effect：设置页可能**就是**首屏，effect 被中止会让它永远停在「读取中…」。
  useLayoutEffect(() => {
    let cancelled = false;
    void api
      .agentLlmStatus()
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        setForm(formFromStatus(s));
        // 成功即清错：上一轮的失败提示必须能自己消失。
        setError(null);
      })
      .catch((e: unknown) => {
        // 读失败常驻显示：这里绝不能「读不到就当没配」，否则用户会以为该去填而不是该修。
        if (!cancelled) setError(reason(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const masterKeyReady = status?.masterKeyReady ?? false;
  const disabled = busy || !masterKeyReady;
  const fromPanel = status?.source === 'panel';
  const panel = status?.panel ?? null;

  /** 超时（秒）→ 毫秒。非法就返回 `null`，由调用方报错——不静默兜底成一个默认值。 */
  const timeoutMsOf = (): number | null => {
    const seconds = Number(form.timeoutSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    if (seconds > MAX_TIMEOUT_SECONDS) return null;
    return Math.round(seconds * 1000);
  };

  const submit = () => {
    const timeoutMs = timeoutMsOf();
    if (timeoutMs === null) {
      props.notify(`超时必须是不小于 1、不大于 ${MAX_TIMEOUT_SECONDS} 的秒数`, 'err');
      return;
    }
    setBusy(true);
    setError(null);
    const apiKey = form.apiKey.trim();
    void api
      .writeAgentLlmSettings({
        enabled: form.enabled,
        // 留空 = 保持原样：**原样传空串**，服务端据此沿用已存的值。
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        // 密钥留空时**不传** apiKey 字段：传空串在服务端是「没有新密钥」，
        // 但多传一个字段就多一处两端口径不一致的地方。
        ...(apiKey === '' ? {} : { apiKey }),
        timeoutMs,
      })
      .then((next) => {
        setStatus(next);
        // 提交完立刻清空输入：地址与密钥不该在页面上多留一秒。
        setForm((f) => ({ ...f, baseUrl: '', model: '', apiKey: '' }));
        props.notify('模型接入设置已保存');
      })
      .catch((e: unknown) => setError(reason(e)))
      .finally(() => setBusy(false));
  };

  /**
   * 清空密钥：**单独一个动作**（`clearApiKey: true`），与「保存」分开。
   *
   * 它会连同「启用模型」一起关掉——服务端不许「开着模型却没有密钥」，
   * 硬留着 enabled=true 的清密钥请求只会被打回，那还不如一开始就说清。
   */
  const clearKey = () => {
    const timeoutMs = timeoutMsOf();
    if (timeoutMs === null) {
      props.notify(`超时必须是不小于 1、不大于 ${MAX_TIMEOUT_SECONDS} 的秒数`, 'err');
      return;
    }
    setBusy(true);
    setError(null);
    void api
      .writeAgentLlmSettings({
        enabled: false,
        // 地址与模型名保持原样：留空 = 沿用已存的值。
        baseUrl: '',
        model: '',
        clearApiKey: true,
        timeoutMs,
      })
      .then((next) => {
        setStatus(next);
        setForm((f) => ({ ...f, enabled: false, apiKey: '' }));
        setConfirm(null);
        props.notify('模型 API 密钥已清空');
      })
      .catch((e: unknown) => {
        setError(reason(e));
        setConfirm(null);
      })
      .finally(() => setBusy(false));
  };

  /**
   * 清空控制面录入的那一份，**退回配置文件 + 环境变量**。
   *
   * 不是「关掉模型」：要停用请取消「启用模型」的勾再保存。
   */
  const clearAll = () => {
    setBusy(true);
    setError(null);
    void api
      .clearAgentLlmSettings()
      .then((next) => {
        setStatus(next);
        // 清完之后表单回到「当前生效的那一份」的样子：开关与超时重新按生效值预置。
        setForm(formFromStatus(next));
        setConfirm(null);
        props.notify('控制面录入的模型配置已清空，已退回配置文件 + 环境变量');
      })
      .catch((e: unknown) => {
        setError(reason(e));
        setConfirm(null);
      })
      .finally(() => setBusy(false));
  };

  /** 重新读取。主密钥配好并重启控制面之后，用户需要一条路把新状态读回来。 */
  const reload = () => {
    setError(null);
    void api
      .agentLlmStatus()
      .then((next) => {
        setStatus(next);
        setForm(formFromStatus(next));
      })
      .catch((e: unknown) => setError(reason(e)));
  };

  return (
    <div className="panel">
      <h2>
        模型接入
        {status === null ? null : status.enabled ? (
          <span className="tag ok">已启用</span>
        ) : (
          <span className="tag muted">未启用</span>
        )}
      </h2>

      {error !== null ? (
        <div className="banner">
          模型接入设置操作失败：{error}
          {/* 失败时保留上一次读到的内容，并明说是旧的：清空会让「已配置」突然消失。 */}
          {status !== null ? '（下面显示的是上一次读到的内容）' : ''}
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            错误常驻显示，修好后重新提交即可让它消失。
          </div>
        </div>
      ) : null}

      <dl className="kv" style={{ margin: '0 0 12px' }}>
        <dt>生效来源</dt>
        <dd>
          {status === null ? (
            <span className="muted">读取中…</span>
          ) : fromPanel ? (
            <>
              <span className="tag ok">控制面录入</span>{' '}
              <span className="muted">（本页面保存的那一份，密钥以密文落库）</span>
            </>
          ) : (
            <>
              <span className="tag muted">配置文件 + 环境变量</span>{' '}
              <span className="muted">
                （密钥取自 <code>{status.apiKeyEnv}</code>）
              </span>
              {/* 密钥读不到是最常见的配置错误：**要说清去补哪个变量**，
                  而不是只显示一句笼统的「设置操作失败」。 */}
              {status.configKeyAvailable ? null : (
                <>
                  {' '}
                  <span className="tag warn">密钥读不到</span>{' '}
                  <span className="muted">
                    （环境变量 <code>{status.apiKeyEnv}</code> 里没有密钥——
                    在这个变量的配置文件里填上，或在上面「控制面录入」一份）
                  </span>
                </>
              )}
            </>
          )}
        </dd>
        <dt>生效的模型</dt>
        <dd>
          {status === null ? (
            <span className="muted">读取中…</span>
          ) : (
            <span className="mono">
              {status.baseUrl === '' ? '（API 地址未配置）' : status.baseUrl} ·{' '}
              {status.model === '' ? '（模型名未配置）' : status.model}
            </span>
          )}
        </dd>
        <dt>超时</dt>
        <dd>
          {status === null ? (
            <span className="muted">读取中…</span>
          ) : (
            <span className="mono">{status.timeoutMs} ms</span>
          )}
        </dd>
        <dt>主密钥</dt>
        <dd>
          {status === null ? (
            <span className="muted">读取中…</span>
          ) : status.masterKeyReady ? (
            <span className="tag ok">就绪</span>
          ) : (
            <span className="tag error">未就绪</span>
          )}
        </dd>
        {panel !== null ? (
          <>
            <dt>页面这一份</dt>
            <dd>
              {panel.configured ? (
                <>
                  <span className="tag ok">已录入</span>{' '}
                  <span className="mono">{keyText(panel.keyConfigured, panel.hint)}</span>
                  {panel.updatedAt !== null ? (
                    <span className="muted"> · 更新于 {fmtTime(panel.updatedAt)}</span>
                  ) : null}
                </>
              ) : (
                <>
                  <span className="muted">尚未录入</span>{' '}
                  <span className="mono">{keyText(panel.keyConfigured, panel.hint)}</span>
                </>
              )}
              {fromPanel ? null : (
                <span className="muted"> · 当前生效的不是它（缺地址或模型名，或主密钥没注入）</span>
              )}
            </dd>
          </>
        ) : null}
      </dl>

      {status !== null && !status.masterKeyReady ? (
        <div className="banner warn">
          <b>当前不能保存模型接入设置</b>：环境变量 <code>TRADE_TOOL_SECRET_KEY</code>{' '}
          没有注入或长度不合法，服务端没有用于加密的密钥。表单因此被禁用——填了也存不下来。
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            在仓库根的 <code>.env</code> 里配好该变量，重启控制面后再点「重新读取」。
          </div>
        </div>
      ) : null}

      <div className="form-grid">
        <label className="check">
          <input
            type="checkbox"
            aria-label="启用模型"
            checked={form.enabled}
            disabled={disabled}
            onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
          />
          <span className="label">启用模型</span>
        </label>

        <label>
          <span className="label">API 地址</span>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="留空 = 保持原样"
            aria-label="API 地址"
            value={form.baseUrl}
            disabled={disabled}
            onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
          />
        </label>

        <label>
          <span className="label">模型名</span>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="留空 = 保持原样"
            aria-label="模型名"
            value={form.model}
            disabled={disabled}
            onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
          />
        </label>

        <label>
          <span className="label">API 密钥</span>
          {/* 密码框：密钥是凭据，拿到就能直接调模型 */}
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="留空 = 保持原样"
            aria-label="API 密钥"
            value={form.apiKey}
            disabled={disabled}
            onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
          />
        </label>

        <label>
          <span className="label">超时（秒）</span>
          <input
            type="number"
            min={1}
            max={MAX_TIMEOUT_SECONDS}
            step={1}
            aria-label="超时（秒）"
            value={form.timeoutSeconds}
            disabled={disabled}
            onChange={(e) => setForm((f) => ({ ...f, timeoutSeconds: e.target.value }))}
          />
        </label>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" disabled={disabled} onClick={submit}>
          {busy ? '提交中…' : '保存模型设置'}
        </button>
        <button
          disabled={busy || panel === null || panel.keyConfigured !== true}
          onClick={() => setConfirm('clearKey')}
          title="只清掉密钥，地址与模型名保持原样"
        >
          清空密钥
        </button>
        <button
          className="danger"
          disabled={busy || panel === null}
          onClick={() => setConfirm('clearAll')}
          title="退回配置文件 + 环境变量，不是关掉模型"
        >
          清空控制面这一份
        </button>
        <button disabled={busy} onClick={reload}>
          重新读取
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          地址、模型名与密钥<b>无法回显</b>：这里只显示末 4 位。要换就重新填一份覆盖。
        </span>
      </div>

      <p className="muted" style={{ fontSize: 12, margin: '10px 0 0' }}>
        「留空 = 保持原样」：地址、模型名、密钥三个框留空提交时，服务端沿用已存的值。
        <b>「清空控制面这一份」是退回配置文件 + 环境变量</b>，不是「关掉模型」——
        真要停用请取消「启用模型」的勾再保存。
      </p>

      {confirm === 'clearKey' ? (
        <ConfirmDialog
          title="清空模型 API 密钥"
          confirmLabel="确认清空密钥"
          danger
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={clearKey}
        >
          <p>
            清掉之后，控制面录入的这一份就没有密钥了，<b>会连同「启用模型」一起关掉</b>
            ——服务端不允许「开着模型却没有密钥」。
          </p>
          <p className="muted" style={{ fontSize: 12 }}>
            地址与模型名保持原样。当前生效的那一份若来自配置文件 + 环境变量，则不受影响。
          </p>
        </ConfirmDialog>
      ) : null}

      {confirm === 'clearAll' ? (
        <ConfirmDialog
          title="清空控制面录入的模型配置"
          confirmLabel="确认清空"
          danger
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={clearAll}
        >
          <p>
            清空之后地址、模型名与密钥都会被抹掉，模型接入会回到「配置文件 + 环境变量」那一档
            （若那一档也没配，就彻底调不动模型）。
          </p>
          <p className="muted" style={{ fontSize: 12 }}>
            这条操作不可撤销——密钥本来就没存明文，抹掉之后只能重新填一份。它<b>不是「关掉模型」</b>
            ： 要停用请取消「启用模型」的勾再保存。
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
