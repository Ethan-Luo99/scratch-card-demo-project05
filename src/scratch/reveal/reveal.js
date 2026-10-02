// 全清渐隐（R2 / 风险清单 5）：CSS transition 为主，transitionend 与
// durationMs×1.2 兜底定时器双完成路径；hidden tab 立即跳终态。
export function runReveal({
  element,
  durationMs = 260,
  doc = typeof document !== 'undefined' ? document : undefined,
  setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutFn = (id) => clearTimeout(id),
  onDone,
}) {
  let finished = false;
  let timer = null;

  const cleanup = () => {
    element.removeEventListener('transitionend', onTransitionEnd);
    if (doc) doc.removeEventListener('visibilitychange', onVisibility);
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    cleanup();
    element.style.transition = '';
    element.style.opacity = '0';
    if (onDone) onDone();
  };
  const onTransitionEnd = (e) => {
    if (e.target === element && e.propertyName === 'opacity') finish();
  };
  const onVisibility = () => {
    if (doc && doc.visibilityState === 'hidden') finish();
  };

  if (durationMs <= 0) {
    finish();
    return () => {};
  }

  element.addEventListener('transitionend', onTransitionEnd);
  if (doc) doc.addEventListener('visibilitychange', onVisibility);
  element.style.transition = `opacity ${durationMs}ms ease`;
  element.style.opacity = '0';
  timer = setTimeoutFn(finish, durationMs * 1.2);

  return () => {
    if (finished) return;
    finished = true;
    cleanup();
    element.style.transition = '';
    element.style.opacity = '1';
  };
}
