export function resolvePixelRatio(cap = 2, win = typeof window !== 'undefined' ? window : undefined) {
  const dpr = (win && win.devicePixelRatio) || 1;
  return Math.min(dpr, cap);
}

export function watchPixelRatioChange(onChange, win = typeof window !== 'undefined' ? window : undefined) {
  if (!win || typeof win.matchMedia !== 'function') {
    return () => {};
  }
  let mql = null;
  let disposed = false;
  const handler = () => {
    if (disposed) return;
    onChange();
    arm();
  };
  const arm = () => {
    if (disposed) return;
    if (mql) mql.removeEventListener('change', handler);
    mql = win.matchMedia(`(resolution: ${win.devicePixelRatio || 1}dppx)`);
    mql.addEventListener('change', handler);
  };
  arm();
  return () => {
    disposed = true;
    if (mql) mql.removeEventListener('change', handler);
    mql = null;
  };
}
