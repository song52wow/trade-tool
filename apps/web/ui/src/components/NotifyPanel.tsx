import { useLayoutEffect, useState } from 'react';

import { ApiError, api } from '../api.js';
import { fmtTime } from '../format.js';
import type { NotifyStatusDto } from '../../../src/types';
import { ConfirmDialog } from './ConfirmDialog.js';

function reason(error: unknown): string {
  if (error instanceof ApiError) return `[${error.code}] ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

interface Form {
  enabled: boolean;
  /** 留空 = 沿用当前生效的地址。 */
  webhookUrl: string;
  /** 留空 = 沿用当前生效的签名密钥。 */
  secret: string;
  clearSecret: boolean;
  /** 要通知哪些内容（差异类型 id）。 */
  kinds: string[];
  /** 冷却时间以**分钟**呈现，提交时换算成毫秒（换算只在这一处）。 */
  cooldownMinutes: string;
}

const EMPTY_FORM: Form = {
  enabled: false,
  webhookUrl: '',
  secret: '',
  clearSecret: false,
  kinds: [],
  cooldownMinutes: '30',
};

/**
 * 飞书通知设置（v0.8.0）。
 *
 * 这个区块的**核心是「要通知什么」**：用户逐项勾选关心的事（哪种差异要告诉我），
 * 而不是挑一个笼统的严重度门槛——同一类差异的严重度是固定的，门槛只能「全要」或
 * 「只要三种紧急的」，表达不了「止盈单没了这种别烦我，但仓位没止损保护一定要说」。
 *
 * 勾选项的清单**由服务端下发**（`status.topics`），页面不自己抄一份：抄了就会漂。
 *
 * 另外三条硬约束，都写在代码里：
 *
 * 1. **不回填。** `GET /api/settings/notify` 的回包里没有地址、没有密文，
 *    只有「配没配 / 末 4 位 / 生效来源 / 勾了哪些」。所以地址输入框在读到状态后
 *    一律保持空：把一个空框显示成「已填」比显示「已配置（末 4 位 xxxx）」危险得多。
 * 2. **主密钥没就绪就禁用表单。** 没有它就没有加密密钥，填了也存不下来。
 * 3. **不留副本。** 输入只流向 `PUT` 那一次提交，提交完立刻清空。
 */
export function NotifyPanel(props: { notify: (text: string, kind?: 'ok' | 'err') => void }) {
  const [status, setStatus] = useState<NotifyStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  // 取数用 layout effect：设置页可能**就是**首屏，effect 被中止会让它永远停在「读取中…」。
  useLayoutEffect(() => {
    let cancelled = false;
    void api
      .notifyStatus()
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        // 表单按**当前生效的那一份**预置：用户看到的就是现在真正在用的设置。
        setForm({
          enabled: s.enabled,
          webhookUrl: '',
          secret: '',
          clearSecret: false,
          kinds: [...s.kinds],
          cooldownMinutes: String(Math.round(s.repeatCooldownMs / 60_000)),
        });
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

  const toggleKind = (kind: string, on: boolean) => {
    setForm((f) => ({
      ...f,
      kinds: on ? [...f.kinds, kind] : f.kinds.filter((k) => k !== kind),
    }));
  };

  const submit = () => {
    const minutes = Number(form.cooldownMinutes);
    if (!Number.isFinite(minutes) || minutes < 0) {
      props.notify('重复提醒间隔必须是不小于 0 的分钟数', 'err');
      return;
    }
    setBusy(true);
    setError(null);
    void api
      .writeNotifySettings({
        enabled: form.enabled,
        webhookUrl: form.webhookUrl.trim(),
        secret: form.secret.trim(),
        clearSecret: form.clearSecret,
        kinds: form.kinds,
        repeatCooldownMs: Math.round(minutes * 60_000),
      })
      .then((next) => {
        setStatus(next);
        // 提交完立刻清空输入：地址与签名密钥不该在页面上多留一秒。
        setForm((f) => ({ ...f, webhookUrl: '', secret: '', clearSecret: false }));
        props.notify('通知设置已保存');
      })
      .catch((e: unknown) => setError(reason(e)))
      .finally(() => setBusy(false));
  };

  const test = () => {
    setBusy(true);
    setError(null);
    void api
      .testNotify()
      .then(() => props.notify('测试消息已发出，去飞书群里看看'))
      .catch((e: unknown) => setError(reason(e)))
      .finally(() => setBusy(false));
  };

  const clear = () => {
    setBusy(true);
    setError(null);
    void api
      .clearNotifySettings()
      .then((next) => {
        setStatus(next);
        setConfirmClear(false);
        props.notify('通知配置已清空');
      })
      .catch((e: unknown) => setError(reason(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="panel">
      <h2>
        飞书通知
        {status === null ? null : status.enabled ? (
          <span className="tag ok">已启用</span>
        ) : (
          <span className="tag muted">未启用</span>
        )}
      </h2>

      {error !== null ? (
        <div className="banner">
          通知操作失败：{error}
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
              <span className="muted">（本页面保存的那一份，地址以密文落库）</span>
            </>
          ) : (
            <>
              <span className="tag muted">配置文件 + 环境变量</span>{' '}
              <span className="muted">
                （地址取自 <code>{status.webhookEnv}</code>）
              </span>
            </>
          )}
        </dd>
        <dt>地址</dt>
        <dd>
          {status === null ? (
            <span className="muted">读取中…</span>
          ) : status.configured ? (
            <>
              <span className="tag ok">已配置</span>{' '}
              <span className="mono">末 4 位 {status.hint ?? '—'}</span>
              {status.secretConfigured ? (
                <span className="muted"> · 已配签名</span>
              ) : (
                <span className="muted"> · 未配签名</span>
              )}
            </>
          ) : (
            <span className="muted">未配置——对账发现的差异只会记日志，不会推送到飞书</span>
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
        {status?.panel !== null && status?.panel !== undefined ? (
          <>
            <dt>页面这一份</dt>
            <dd>
              {status.panel.configured ? (
                <>
                  <span className="tag ok">已录入</span>{' '}
                  <span className="mono">末 4 位 {status.panel.hint ?? '—'}</span>
                  {status.panel.updatedAt !== null ? (
                    <span className="muted"> · 更新于 {fmtTime(status.panel.updatedAt)}</span>
                  ) : null}
                </>
              ) : (
                <span className="muted">尚未录入地址</span>
              )}
              {fromPanel ? null : (
                <span className="muted"> · 当前生效的不是它（缺地址或主密钥没注入）</span>
              )}
            </dd>
          </>
        ) : null}
      </dl>

      {status !== null && !status.masterKeyReady ? (
        <div className="banner warn">
          <b>当前不能保存通知配置</b>：环境变量 <code>TRADE_TOOL_SECRET_KEY</code>{' '}
          没有注入或长度不合法，服务端没有用于加密的密钥。表单因此被禁用——填了也存不下来。
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            在仓库根的 <code>.env</code> 里配好该变量，重启控制面后再回来。
          </div>
        </div>
      ) : null}

      <div className="form-grid">
        <label className="check">
          <input
            type="checkbox"
            aria-label="启用飞书通知"
            checked={form.enabled}
            disabled={disabled}
            onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
          />
          <span className="label">启用推送</span>
        </label>

        <label>
          <span className="label">webhook 地址</span>
          {/* 密码框：地址本身就是凭据，拿到就能往群里发消息 */}
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="留空 = 沿用当前生效的地址"
            aria-label="webhook 地址"
            value={form.webhookUrl}
            disabled={disabled}
            onChange={(e) => setForm((f) => ({ ...f, webhookUrl: e.target.value }))}
          />
        </label>

        <label>
          <span className="label">签名密钥（选填）</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="留空 = 沿用当前（选填）"
            aria-label="签名密钥"
            value={form.secret}
            disabled={disabled}
            onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))}
          />
        </label>

        <label>
          <span className="label">重复提醒间隔（分钟）</span>
          <input
            type="number"
            min={0}
            step={1}
            aria-label="重复提醒间隔（分钟）"
            value={form.cooldownMinutes}
            disabled={disabled}
            onChange={(e) => setForm((f) => ({ ...f, cooldownMinutes: e.target.value }))}
          />
        </label>
      </div>

      {/* 要通知哪些内容：逐项勾。清单由服务端下发，页面不自己抄。 */}
      <div className="topics">
        <div className="row" style={{ marginBottom: 6 }}>
          <span className="label">要通知哪些内容</span>
          <span className="muted" style={{ fontSize: 12 }}>
            勾上的才推；没勾的差异照样记在日志里，只是不来烦你。
          </span>
          <button
            type="button"
            disabled={disabled || status === null}
            onClick={() =>
              setForm((f) => ({ ...f, kinds: (status?.topics ?? []).map((t) => t.kind) }))
            }
          >
            全选
          </button>
          <button
            type="button"
            disabled={disabled || status === null}
            onClick={() => setForm((f) => ({ ...f, kinds: [] }))}
          >
            全不选
          </button>
        </div>
        {status === null ? (
          <div className="muted" style={{ fontSize: 12 }}>
            读取中…
          </div>
        ) : (
          status.topics.map((topic) => (
            <label className="topic" key={topic.kind}>
              <input
                type="checkbox"
                aria-label={`通知：${topic.label}`}
                checked={form.kinds.includes(topic.kind)}
                disabled={disabled}
                onChange={(e) => toggleKind(topic.kind, e.target.checked)}
              />
              <span>
                <b>{topic.label}</b>
                <span className="muted"> —— {topic.hint}</span>
              </span>
            </label>
          ))
        )}
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" disabled={disabled} onClick={submit}>
          {busy ? '提交中…' : '保存设置'}
        </button>
        <button
          disabled={busy || status === null || !status.configured}
          onClick={test}
          title="会真的往飞书群里发一条消息"
        >
          发送测试消息
        </button>
        <button
          className="danger"
          disabled={busy || status === null || status.panel === null}
          onClick={() => setConfirmClear(true)}
        >
          清空配置
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          地址与密钥<b>无法回显</b>：这里只显示末 4 位。要换地址就重新填一份覆盖。
        </span>
      </div>

      <p className="muted" style={{ fontSize: 12, margin: '10px 0 0' }}>
        保存后<b>不必重启 executor</b>：它每轮对账时都会重新读一次设置，下一轮（默认 5
        分钟内）就用新值。 「留空 =
        沿用当前生效的地址」——但保存之后这一份会被固化到库里（地址仍然加密），
        此后它就是生效来源。改勾选只影响<b>之后</b>的推送，不会撤回已经发出去的消息。
      </p>

      {confirmClear ? (
        <ConfirmDialog
          title="清空飞书通知配置"
          confirmLabel="确认清空"
          danger
          busy={busy}
          onCancel={() => setConfirmClear(false)}
          onConfirm={clear}
        >
          <p>
            清空之后地址与签名密钥都会被抹掉，通知会回到「配置文件 + 环境变量」那一档
            （若那一档也没配，就彻底不推了）。
          </p>
          <p className="muted" style={{ fontSize: 12 }}>
            这条操作不可撤销——地址本来就没存明文，抹掉之后只能重新填一份。
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
