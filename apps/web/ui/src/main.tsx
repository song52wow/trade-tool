import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { initTheme } from './theme.js';
import './styles.css';

// 主题必须在 createRoot **之前**定下来：首帧就画对，否则会先闪一下默认主题
// （浅色环境下先白一下，深色环境下先黑一下）再被 React 换掉。
initTheme();

const root = document.getElementById('root');
if (root === null) throw new Error('index.html 缺少 #root 挂载点');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
