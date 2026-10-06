// 录制回放节拍器（纯逻辑）：按事件时间戳 / speed 的节拍依次 emit。
// 渲染与统计路径由调用方（ScratchCard._stroke*）复用真实输入路径，本模块只负责节拍。
// 返回 { cancel, isDone }；destroy()/reset() 通过 cancel 中断，不泄漏定时器。

export function playEvents(events, { speed = 1, emit, onDone, setTimeoutFn, clearTimeoutFn } = {}) {
  const setT = setTimeoutFn || globalThis.setTimeout.bind(globalThis);
  const clearT = clearTimeoutFn || globalThis.clearTimeout.bind(globalThis);
  const pace = Math.max(0.01, speed || 1);
  let index = 0;
  let timer = null;
  let done = false;

  const finish = () => {
    if (done) return;
    done = true;
    if (onDone) onDone();
  };

  const step = () => {
    if (done) return;
    emit(events[index]);
    index++;
    if (index >= events.length) {
      finish();
      return;
    }
    const dt = Math.max(0, (events[index].t - events[index - 1].t) / pace);
    timer = setT(step, dt);
  };

  step(); // 首事件立即派发

  return {
    cancel: () => {
      if (done) return;
      done = true;
      if (timer !== null) clearT(timer);
    },
    isDone: () => done,
  };
}
