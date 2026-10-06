import { useEffect, useId, useMemo, useRef, useState } from 'react';

/** 一屏最多渲染多少个选项；命中更多时提示继续输入过滤。 */
const MAX_VISIBLE = 60;

export interface SymbolPickerProps {
  /** 运行时发现的标的集合（exchangeInfo），不是硬编码白名单 */
  options: readonly string[];
  value: string;
  onChange: (value: string) => void;
  onSubmit: (symbol: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

/**
 * 可搜索的标的下拉选择。
 *
 * 为什么不用原生 `<datalist>`：它在桌面端勉强能用，移动端基本不可用——iOS Safari
 * 不给它可控的展开面板，Android Chrome 的表现也不一致。标的集合有几百个，没有搜索
 * 基本没法用，所以这里自己实现：输入过滤 + 键盘上下选择 + 点外部收起。
 *
 * 过滤不到时不阻止提交：标的合法性本来就由运行时元数据判定（R-7.2），前端不该替它
 * 做白名单判断，只负责给出候选。
 */
export function SymbolPicker(props: SymbolPickerProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  const matches = useMemo(() => {
    const q = props.value.trim().toUpperCase();
    if (q === '') return props.options;
    // 分档排序。exchangeInfo 的返回顺序对「用户最可能想要的那个」没有保证：
    // 输入某个基础资产前缀时，它的永续往往排在几个无关的同前缀合约之后。
    // 分档：完全相等 > 前缀命中的 USDT 永续 > 其它前缀 > 含子串；同档按长度再按字典序，
    // 保证结果稳定（不依赖交易所返回顺序，也不会每次输入都跳）。
    const rank = (s: string): number => {
      if (s === q) return 0;
      if (s.startsWith(q)) return s.endsWith('USDT') ? 1 : 2;
      return 3;
    };
    return props.options
      .filter((s) => s.includes(q))
      .sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b));
  }, [props.options, props.value]);

  const visible = matches.slice(0, MAX_VISIBLE);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current?.contains(e.target as Node) === true) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  // 候选变化时把高亮收回第一项，避免指向一个已经不存在的选项
  useEffect(() => {
    setHighlight(0);
  }, [props.value]);

  const pick = (symbol: string) => {
    props.onChange(symbol);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setHighlight((h) => {
        if (visible.length === 0) return 0;
        return (h + delta + visible.length) % visible.length;
      });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = visible[highlight];
      // 有高亮项就选它；没有（过滤不到）就按原样提交，交给运行时校验
      props.onSubmit(chosen ?? props.value.trim());
      setOpen(false);
      return;
    }
    if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="picker" ref={rootRef}>
      <input
        list={undefined}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        placeholder={props.placeholder ?? '选择或输入标的，如 BTCUSDT'}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => {
          props.onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open ? (
        <div className="picker-list" id={listId} role="listbox">
          {visible.length === 0 ? (
            <div className="picker-empty">
              运行时标的集合里没有匹配项；仍可直接提交，由交易所元数据判定合法性。
            </div>
          ) : (
            <>
              {visible.map((s, i) => (
                <button
                  key={s}
                  type="button"
                  role="option"
                  aria-selected={i === highlight}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => pick(s)}
                >
                  {s}
                </button>
              ))}
              {matches.length > MAX_VISIBLE ? (
                <div className="picker-empty">共 {matches.length} 项，继续输入以缩小范围</div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
