import { useTheme } from '../theme.js';

/**
 * 明 / 暗主题切换。
 *
 * 切换后除了 CSS 变量，还会同步 `color-scheme`（见 theme.ts）——否则页面变了、
 * 滚动条和原生输入框还是上一套深色，看起来像只换了一半。
 */
export function ThemeToggle() {
  const [theme, toggle] = useTheme();
  const next = theme === 'dark' ? '亮色' : '深色';
  return (
    <button
      onClick={toggle}
      title={`切换到${next}主题（选择会记住）`}
      aria-label={`切换到${next}主题`}
      data-theme-toggle={theme}
    >
      <span aria-hidden="true">{theme === 'dark' ? '☾' : '☀'}</span> {next}
    </button>
  );
}
