import { useEffect, useRef } from 'react';

export interface ConfirmDialogProps {
  title: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}

/**
 * 重量级操作的二次确认。刻意用原生 `<dialog>`：
 * Esc 关闭、焦点陷阱、遮罩都是浏览器给的，不需要自己实现一遍。
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (!el.open) el.showModal();
  }, []);

  return (
    <dialog ref={ref} onCancel={props.onCancel}>
      <h3 style={{ marginTop: 0 }}>{props.title}</h3>
      {props.children}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button onClick={props.onCancel} disabled={props.busy}>
          取消
        </button>
        <button
          className={props.danger ? 'danger' : 'primary'}
          onClick={props.onConfirm}
          disabled={props.busy}
        >
          {props.busy ? '处理中…' : props.confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
