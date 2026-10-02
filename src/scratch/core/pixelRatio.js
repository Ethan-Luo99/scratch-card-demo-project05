// 逐卡 DPR 解析与运行时变更监听。禁止写全局 Konva.pixelRatio（Global.js:97）。

export function resolvePixelRatio(cap = 2, win = globalThis.window) {
  const dpr = (win && win.devicePixelRatio) || 1;
  return Math.min(dpr, cap);
}

// matchMedia('(resolution: Xdppx)') 一次性监听，触发后重新武装；返回解绑函数。
export function watchPixelRatio(win, callback) {
  if (!win || typeof win.matchMedia !== 'function') return () => {};
  let mql = null;
  let disposed = false;
  const onChange = () => {
    if (mql) mql.removeEventListener('change', onChange);
    if (disposed) return;
    arm();
    callback();
  };
  const arm = () => {
    mql = win.matchMedia(`(resolution: ${win.devicePixelRatio || 1}dppx)`);
    mql.addEventListener('change', onChange);
  };
  arm();
  return () => {
    disposed = true;
    if (mql) mql.removeEventListener('change', onChange);
  };
}

// 通用去抖（DPR/resize 重建用，默认 200ms，DESIGN.md 风险 4）
export function debounce(fn, waitMs, setTimeoutFn, clearTimeoutFn) {
  const setT = setTimeoutFn || globalThis.setTimeout.bind(globalThis);
  const clearT = clearTimeoutFn || globalThis.clearTimeout.bind(globalThis);
  let timer = null;
  const wrapped = (...args) => {
    if (timer !== null) clearT(timer);
    timer = setT(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  };
  wrapped.cancel = () => {
    if (timer !== null) clearT(timer);
    timer = null;
  };
  return wrapped;
}
