/**
 * jsdom 缺少的浏览器 API。recharts 的 `ResponsiveContainer` 在挂载时会用
 * `ResizeObserver` 量尺寸，jsdom 里没有它就会在**passive effect** 里抛
 * `ResizeObserver is not defined`。
 *
 * 这不只是测试的烦恼：effect 里抛出的异常会中止同一批次剩余的 effect，
 * 一个图表组件就能让整页的数据加载静默失效。所以这里的 stub 既是为了让用例能跑，
 * 也是在提醒「首屏取数不能依赖 passive effect 一定被执行」。
 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// 服务端的 tsconfig 不带 DOM lib，所以不能直接写 globalThis.ResizeObserver。
const scope = globalThis as unknown as { ResizeObserver?: unknown };
if (typeof scope.ResizeObserver === 'undefined') {
  scope.ResizeObserver = ResizeObserverStub;
}

/**
 * jsdom 没有实现 `<dialog>` 的模态方法（`showModal` / `close` / `show`）。
 *
 * `ConfirmDialog` 用的是原生 `<dialog>`（AGENTS.md 允许的浏览器原生控件），所以
 * 凡是断言「点确认后发生了什么」的用例都会撞上 `showModal is not a function`。
 *
 * 关键点：**必须设 `open` 属性，不能只设 `.open` 属性**。jsdom 的 UA 样式表里有
 * `dialog:not([open]) { display: none }`，而它并不实现 `open` 的属性↔属性反射——
 * 只设属性的话弹窗仍被判为隐藏，`getByRole` 会当它不存在（这个坑真实踩过一次：
 * 用例断言「点了确认」却报「找不到按钮」，看起来像选择器写错了）。
 */
type DialogLike = {
  showModal?: unknown;
  close?: unknown;
  show?: unknown;
  open?: boolean;
  setAttribute?: (name: string, value: string) => void;
  removeAttribute?: (name: string) => void;
};
const dialogProto = (globalThis as unknown as { HTMLDialogElement?: { prototype: DialogLike } })
  .HTMLDialogElement?.prototype;

if (dialogProto !== undefined) {
  const open = function showModalStub(this: DialogLike) {
    this.open = true;
    this.setAttribute?.('open', '');
  };
  if (typeof dialogProto.showModal !== 'function') dialogProto.showModal = open;
  if (typeof dialogProto.show !== 'function') dialogProto.show = open;
  if (typeof dialogProto.close !== 'function') {
    dialogProto.close = function close(this: DialogLike) {
      this.open = false;
      this.removeAttribute?.('open');
    };
  }
}
