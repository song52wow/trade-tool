import { useLayoutEffect, useState } from 'react';

import { ApiError, api } from '../api.js';
import { fmtTime } from '../format.js';
import type { CredentialStatusDto } from '../../../src/types';
import { ConfirmDialog } from './ConfirmDialog.js';

function reason(error: unknown): string {
  if (error instanceof ApiError) return `[${error.code}] ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * 交易所 API 凭据（v0.5.0）。
 *
 * 这个区块的**核心是安全性**，因此有三条硬约束，都写在代码里而不是只写在注释里：
 *
 * 1. **不回填。** `GET /api/settings/credentials` 的回包只有 `configured` / `hint`（末 4 位）
 *    / `updatedAt` / `masterKeyReady`，**没有也不可能有明文**。所以输入框在读到状态后
 *    一律保持空：把一个空框显示成「已填」比显示「已配置（末 4 位 xxxx）」危险得多。
 * 2. **主密钥没就绪就禁用表单。** `masterKeyReady=false` 时服务端根本没有加密密钥，
 *    让用户填完再失败等于骗他「填了就能用」。
 * 3. **不留副本。** 输入只流向 `PUT` 那一次提交，提交完立刻清空。
 */
export function CredentialsPanel(props: { notify: (text: string, kind?: 'ok' | 'err') => void }) {
  const [status, setStatus] = useState<CredentialStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  // 取数用 layout effect：设置页可能**就是**首屏，effect 被中止会让它永远停在「读取中…」。
  useLayoutEffect(() => {
    let cancelled = false;
    void api
      .credentialStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
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

  const submit = () => {
    const key = apiKey.trim();
    const secret = apiSecret.trim();
    if (key === '' || secret === '') {
      props.notify('apiKey 与 apiSecret 都要填', 'err');
      return;
    }
    setBusy(true);
    setError(null);
    void api
      .writeCredentials({ apiKey: key, apiSecret: secret })
      .then((next) => {
        setStatus(next);
        setApiKey('');
        setApiSecret('');
        props.notify('凭据已保存');
      })
      .catch((e: unknown) => setError(reason(e)))
      .finally(() => setBusy(false));
  };

  const clear = () => {
    setBusy(true);
    setError(null);
    void api
      .clearCredentials()
      .then((next) => {
        setStatus(next);
        setConfirmClear(false);
        props.notify('凭据已清空');
      })
      .catch((e: unknown) => setError(reason(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="panel">
      <h2>
        交易所 API 凭据
        {status === null ? null : status.configured ? (
          <span className="tag ok">已配置</span>
        ) : (
          <span className="tag muted">未配置</span>
        )}
      </h2>

      {error !== null ? (
        <div className="banner">
          凭据操作失败：{error}
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            错误常驻显示，修好后重新提交即可让它消失。
          </div>
        </div>
      ) : null}

      <dl className="kv" style={{ margin: '0 0 12px' }}>
        <dt>交易所</dt>
        <dd className="mono">{status?.exchange ?? '—'}</dd>
        <dt>状态</dt>
        <dd>
          {status === null ? (
            <span className="muted">读取中…</span>
          ) : status.configured ? (
            <>
              <span className="tag ok">已配置</span>{' '}
              <span className="mono">末 4 位 {status.hint ?? '—'}</span>
              {status.updatedAt !== null ? (
                <span className="muted"> · 更新于 {fmtTime(status.updatedAt)}</span>
              ) : null}
            </>
          ) : (
            <span className="muted">未配置——下单类操作会因缺少凭据而失败</span>
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
      </dl>

      {status !== null && !status.masterKeyReady ? (
        <div className="banner warn">
          <b>当前不能保存凭据</b>：环境变量 <code>TRADE_TOOL_SECRET_KEY</code>{' '}
          没有注入或长度不合法， 服务端没有用于加密的密钥。表单因此被禁用——填了也存不下来。
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            在仓库根的 <code>.env</code> 里配好该变量，重启控制面后再回来。
          </div>
        </div>
      ) : null}

      <div className="form-grid">
        <label>
          <span className="label">API Key</span>
          {/* apiKey 同样用密码框：它也是凭据，默认明文摆着等于主动泄露 */}
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label="API Key"
            value={apiKey}
            disabled={disabled}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        <label>
          <span className="label">API Secret</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label="API Secret"
            value={apiSecret}
            disabled={disabled}
            onChange={(e) => setApiSecret(e.target.value)}
          />
        </label>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" disabled={disabled} onClick={submit}>
          {busy ? '提交中…' : '保存凭据'}
        </button>
        <button
          className="danger"
          disabled={busy || status === null || !status.configured}
          onClick={() => setConfirmClear(true)}
        >
          清空凭据
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          已保存的密钥<b>无法回显</b>：这里只显示末 4 位。要换密钥就重新填一份覆盖。
        </span>
      </div>

      <p className="muted" style={{ fontSize: 12, margin: '10px 0 0' }}>
        凭据在 <b>executor 进程启动时读取</b>。改完之后必须重启 executor 才会用上新值；
        正在运行的进程不会热加载。
      </p>

      {confirmClear ? (
        <ConfirmDialog
          title="清空已保存的交易所凭据"
          confirmLabel="确认清空"
          danger
          busy={busy}
          onCancel={() => setConfirmClear(false)}
          onConfirm={clear}
        >
          <p>
            清空之后，依赖私有接口的操作（下单、查询持仓、用户数据流）会因缺少凭据而失败。
            公共行情不受影响。
          </p>
          <p className="muted" style={{ fontSize: 12 }}>
            这条操作不可撤销——密钥本来就没存明文，删掉之后只能重新填一份。
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
