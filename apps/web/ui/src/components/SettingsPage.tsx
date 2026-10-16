import { HOME_PATH, navigate } from '../router.js';
import type { SymbolRowDto } from '../../../src/types';
import { CredentialsPanel } from './CredentialsPanel.js';
import { RiskPolicyPanel } from './RiskPolicyPanel.js';

/**
 * 运行期设置页（`#/settings`）。
 *
 * 只做组合：两个区块各自管自己的取数与错误，彼此不共享状态——凭据能不能存与
 * ATR 倍数是多少是两件互不影响的事，耦在一起会让其中一个失败带倒另一个。
 */
export function SettingsPage(props: {
  symbols: SymbolRowDto[];
  notify: (text: string, kind?: 'ok' | 'err') => void;
}) {
  return (
    <div className="page">
      <div className="detail-head">
        <button className="link" onClick={() => navigate(HOME_PATH)} title="回到首页">
          ← 首页
        </button>
        <h2 className="detail-title">运行期设置</h2>
      </div>

      <div className="settings-grid">
        <CredentialsPanel notify={props.notify} />
        <RiskPolicyPanel symbols={props.symbols.map((s) => s.symbol)} notify={props.notify} />
      </div>
    </div>
  );
}
