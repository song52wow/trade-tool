import { useCallback, useState } from 'react';

export type ThemeName = 'light' | 'dark';

/**
 * 主题选择的落盘位置。用独立 key 而不是别的东西，是为了让「读不出来」与「没设过」
 * 仍然是同一件事：读不到就退回系统偏好，绝不因为 localStorage 坏了就白屏或没主题。
 */
const STORAGE_KEY = 'trade-tool.theme';

function stored(): ThemeName | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    // 隐私模式 / 禁用存储时 getItem 会抛。没有它还能用系统偏好，因此不算失败。
    return null;
  }
}

/** 用户显式选过的优先，否则跟随系统 `prefers-color-scheme`。 */
export function preferredTheme(): ThemeName {
  const saved = stored();
  if (saved !== null) return saved;
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/**
 * 同时设 `data-theme`（CSS 变量靠它切换）与 `color-scheme`（原生控件：滚动条、
 * 输入框、日期选择器靠它取色）。只设其中一个，就会出现「页面已经变亮、滚动条还是黑的」
 * 这种半切换状态。
 */
export function applyTheme(name: ThemeName): void {
  const root = document.documentElement;
  root.dataset['theme'] = name;
  root.style.colorScheme = name;
}

function persist(name: ThemeName): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // 存不下只影响下次打开的默认值，本次切换已经生效，不该因此报错。
  }
}

/**
 * 首屏初始化。**必须在 React 渲染前调用一次**（main.tsx 的模块体里），
 * 否则第一帧会先按 `:root` 的亮色画一遍再切到深色，闪一下白。
 */
export function initTheme(): ThemeName {
  const name = preferredTheme();
  applyTheme(name);
  return name;
}

export function currentTheme(): ThemeName {
  const attr = document.documentElement.dataset['theme'];
  return attr === 'dark' ? 'dark' : 'light';
}

export function setTheme(name: ThemeName): void {
  applyTheme(name);
  persist(name);
}

/** 头部切换按钮用的 hook：返回当前主题与一个「明 ↔ 暗」翻转。 */
export function useTheme(): [ThemeName, () => void] {
  const [theme, setThemeState] = useState<ThemeName>(currentTheme);
  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      setTheme(next);
      return next;
    });
  }, []);
  return [theme, toggle];
}
