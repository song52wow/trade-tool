// @vitest-environment jsdom
// UI 用例需要 DOM；服务端用例跑在默认的 node 环境。
import './setup.js';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SymbolPicker } from '../../ui/src/components/SymbolPicker';

const OPTIONS = ['BTCUSDC', 'BTCUSDT', 'ETHUSDT', 'SOLUSDC', 'SOLUSDT', 'DOGEUSDT'];

// vitest 没开 globals，testing-library 的自动清理不会生效；不清理的话
// 上一个用例的 DOM 会让 getByRole 命中多个元素。
afterEach(cleanup);

/**
 * 用有状态的宿主包一层：SymbolPicker 是受控组件，若直接把 `value=""` 喂进去
 * 而 onChange 只是 spy，输入永远不会变，过滤逻辑也就测不到。
 */
function setup(
  options: { initial?: string; onSubmit?: (s: string) => void; list?: readonly string[] } = {},
) {
  const submit = options.onSubmit ?? vi.fn();
  function Harness() {
    const [value, setValue] = useState(options.initial ?? '');
    return (
      <SymbolPicker
        options={options.list ?? OPTIONS}
        value={value}
        onChange={setValue}
        onSubmit={submit}
      />
    );
  }
  render(<Harness />);
  return { onSubmit: submit, input: screen.getByRole('combobox') as HTMLInputElement };
}

describe('SymbolPicker', () => {
  it('聚焦后展开全部候选（运行时发现的集合，不是硬编码）', () => {
    setup();
    fireEvent.focus(screen.getByRole('combobox'));

    for (const s of OPTIONS) {
      expect(screen.getByText(s)).toBeTruthy();
    }
  });

  it('输入后按前缀过滤', () => {
    const { input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'sol' } });

    expect(screen.getByText('SOLUSDC')).toBeTruthy();
    expect(screen.getByText('SOLUSDT')).toBeTruthy();
    expect(screen.queryByText('BTCUSDT')).toBeNull();
  });

  it('前缀命中排在包含命中之前', () => {
    const { input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'usdt' } });

    const items = screen.getAllByRole('option').map((el) => el.textContent);
    // BTCUSDT 是前缀命中，应排在只用包含命中的 SOLUSDT 之前
    expect(items.indexOf('BTCUSDT')).toBeLessThan(items.indexOf('ETHUSDT'));
  });

  it('点选候选会回填输入框', () => {
    const { input } = setup();
    fireEvent.focus(input);
    fireEvent.click(screen.getByText('ETHUSDT'));

    expect(input.value).toBe('ETHUSDT');
  });

  it('上下键移动高亮，回车提交高亮项', () => {
    const { input, onSubmit } = setup();
    // focus 就会展开列表并高亮第一项，所以只需一次 ArrowDown 才移到第二项
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledWith(OPTIONS[1]);
  });

  it('ArrowUp 从第一项绕回最后一项', () => {
    const { input, onSubmit } = setup();
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledWith(OPTIONS[OPTIONS.length - 1]);
  });

  it('过滤不到时仍可原样提交，交由运行时元数据判定', () => {
    const { input, onSubmit } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'NOSUCH' } });

    expect(screen.getByText(/没有匹配项/)).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('NOSUCH');
  });

  it('Esc 收起候选', () => {
    const { input } = setup();
    fireEvent.focus(input);
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('输入 BTC 时 BTCUSDT 排第一，不受交易所返回顺序影响', () => {
    // 这串顺序是实测 exchangeInfo 的真实返回顺序：BTCUSDT 原本落在第 5 位
    const { input } = setup({
      list: ['BTCDOMUSDT', 'BTCU', 'BTCUSD1', 'BTCUSDC', 'BTCUSDT', 'ETHBTC', 'PUMPBTCUSDT'],
    });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'BTC' } });

    const items = screen.getAllByRole('option').map((el) => el.textContent);
    expect(items[0]).toBe('BTCUSDT');
    // 前缀命中全部排在只含子串的命中之前
    expect(items.indexOf('ETHBTC')).toBeGreaterThan(items.indexOf('BTCUSDT'));
  });

  it('完全相等的候选排最前', () => {
    const { input } = setup({ list: ['ETHUSDC', 'ETHUSDT', 'ETHBTC'] });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'ETHUSDT' } });

    const items = screen.getAllByRole('option').map((el) => el.textContent);
    expect(items[0]).toBe('ETHUSDT');
  });
});
