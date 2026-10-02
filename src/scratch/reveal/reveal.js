// reveal 过渡（风险 5）：CSS opacity 渐隐（不占 JS 帧），
// transitionend 与 durationMs×1.2 兜底定时器双完成路径；
// 隐藏 tab 时立即跳终态。完成回调恰好一次。
// 不 import konva；env 能力全部注入，测试可手动驱动。

export function runReveal({
  setOpacity, // (value:number, withTransition:boolean) => void
  clear, // 清空位图
  durationMs = 260,
  instant = false,
  onDone,
  env,
}) {
  const e = env || {};
  const setT = e.setTimeout || globalThis.setTimeout.bind(globalThis);
  const clearT = e.clearTimeout || globalThis.clearTimeout.bind(globalThis);
  const isHidden = e.isHidden || (() => false);
  const onVisibility = e.onVisibilityChange || (() => () => {});
  const onTransitionEnd = e.onTransitionEnd || (() => () => {});

  let done = false;
  let timer = null;
  let unbindVisibility = () => {};
  let unbindTransition = () => {};

  const finish = () => {
    if (done) return;
    done = true;
    if (timer !== null) clearT(timer);
    unbindVisibility();
    unbindTransition();
    setOpacity(0, false);
    clear();
    if (onDone) onDone();
  };

  if (instant || durationMs <= 0 || isHidden()) {
    finish();
    return { cancel: () => {}, isDone: () => done };
  }

  unbindVisibility = onVisibility(() => {
    if (isHidden()) finish(); // 隐藏 tab：rAF 停摆，直接跳终态
  });
  unbindTransition = onTransitionEnd(finish);
  timer = setT(finish, Math.ceil(durationMs * 1.2)); // 兜底
  setOpacity(0, true); // 触发 CSS transition

  return {
    cancel: () => {
      if (done) return;
      done = true;
      if (timer !== null) clearT(timer);
      unbindVisibility();
      unbindTransition();
      setOpacity(1, false); // 复位供 reset 后复用
    },
    isDone: () => done,
  };
}
