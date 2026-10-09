// @vitest-environment jsdom
// UI 用例需要 DOM；服务端用例跑在默认的 node 环境。
import './setup.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../ui/src/App';
import { initTheme, preferredTheme } from '../../ui/src/theme';
import { baseHandlers, stubFetch } from './fixtures';

const STORAGE_KEY = 'trade-tool.theme';

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = '';
  // 每个用例都从「没有主题」开始：主题是写在根元素上的全局状态，
  // 漏清一次会让后面的断言读到上一个用例的选择。
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.colorScheme = '';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('主题切换', () => {
  it('切到亮色后根元素真的换成了亮色变量，并同步 color-scheme', async () => {
    // 起始是深色：固定住系统偏好，否则这一条断言的「切到亮色」无从谈起
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    );
    stubFetch(baseHandlers());
    initTheme();
    render(<App />);
    await waitFor(() => screen.getByText('标的集合'));

    // 当前是深色，按钮写的是「切到亮色」
    expect(document.documentElement.dataset['theme']).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: /切换到亮色主题/ }));

    expect(document.documentElement.dataset['theme']).toBe('light');
    // 只改变量不改 color-scheme 的话，滚动条 / 原生输入框还是深色——看起来像只换了一半
    expect(document.documentElement.style.colorScheme).toBe('light');

    // 选择必须记住：关掉页面再打开还应该是亮色
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('light');
  });

  it('切换会反向：亮色下点一下回到深色', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'light');
    stubFetch(baseHandlers());
    initTheme();
    render(<App />);
    await waitFor(() => screen.getByText('标的集合'));

    expect(document.documentElement.dataset['theme']).toBe('light');
    fireEvent.click(screen.getByRole('button', { name: /切换到深色主题/ }));

    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('dark');
  });

  /**
   * 首屏就应用：`initTheme()` 在 createRoot 之前跑（main.tsx 的模块体里）。
   * 这里断言的就是**渲染之前**那一刻根元素已经是用户选的那一套——
   * 否则第一帧会先按 `:root` 的亮色画一遍再被换掉，闪一下白。
   */
  it('首屏之前就应用已记住的选择（不闪）', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'dark');

    // 还没有任何 React 渲染发生
    const applied = initTheme();
    expect(applied).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');

    stubFetch(baseHandlers());
    render(<App />);
    await waitFor(() => screen.getByText('标的集合'));
    // 渲染期间没有再改过一次主题
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('没记住选择时跟随系统 prefers-color-scheme', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    );
    expect(preferredTheme()).toBe('dark');
    initTheme();
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('localStorage 读不到时不报错，退回系统偏好而不是没有主题', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false })),
    );
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(preferredTheme()).toBe('light');
  });
});

describe('调色板', () => {
  // 用 cwd 拼：jsdom 环境下 `import.meta.url` 未必是 file: 协议，new URL 会直接抛错
  const css = readFileSync(resolve(process.cwd(), 'ui/src/styles.css'), 'utf8');

  /** 取 `:root[data-theme='dark']` 块里声明的某个变量值。 */
  function darkVar(name: string): string | undefined {
    const block = css.match(/:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/);
    return block?.[1].match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim();
  }

  /** 取亮色（`:root`）块里声明的某个变量值。 */
  function lightVar(name: string): string | undefined {
    const block = css.match(/^\:root\s*\{([\s\S]*?)\n\}/m);
    return block?.[1].match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim();
  }

  it('两个主题都声明了变量，且底色不是互相反相', () => {
    expect(lightVar('--bg')).toBeTruthy();
    expect(darkVar('--bg')).toBeTruthy();
    // 反相只是把颜色取反，并不等于「这个色在另一个主题下读得清」。
    // 两套底色必须是各自挑的，不是同一个 hex 的明暗版。
    expect(lightVar('--bg')).not.toBe(darkVar('--bg'));
    expect(lightVar('--text')).not.toBe(darkVar('--text'));
    expect(lightVar('--muted')).not.toBe(darkVar('--muted'));
  });

  it('两个主题各自声明 color-scheme（原生控件跟着变）', () => {
    expect(css).toMatch(/:root\s*\{[^}]*color-scheme:\s*light/);
    expect(darkVar('color-scheme')).toBe('dark');
  });
});
