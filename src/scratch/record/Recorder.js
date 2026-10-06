// 笔迹录制（G3）：记录可 JSON 序列化的原始逻辑坐标事件序列与相对时间戳。
// 只录制真实输入（回放合成输入由 ScratchCard 侧门控，不二次入录）。
// reset 标记同样入列，使回放能复现"录到一半重置卡片"的真实链路。
//
// 事件格式（均为平面对象，可直接 JSON.stringify）：
//   { t, type: 'down'|'move'|'up', pointerId, x, y }
//   { t, type: 'reset' }
// 导出：{ version: 1, events: [...] }，t 为相对录制起点的毫秒数。

export const RECORDING_VERSION = 1;

export class Recorder {
  constructor({ now } = {}) {
    this._now = now || defaultNow;
    this._events = [];
    this._recording = false;
    this._startAt = 0;
  }

  get recording() {
    return this._recording;
  }

  get eventCount() {
    return this._events.length;
  }

  start() {
    if (this._recording) return;
    this._events = [];
    this._recording = true;
    this._startAt = this._now();
  }

  stop() {
    if (!this._recording) return;
    this._recording = false;
  }

  pointerEvent(type, { pointerId, x, y }) {
    if (!this._recording) return;
    this._events.push({
      t: Math.round(this._now() - this._startAt),
      type,
      pointerId,
      x,
      y,
    });
  }

  markReset() {
    if (!this._recording) return;
    this._events.push({ t: Math.round(this._now() - this._startAt), type: 'reset' });
  }

  // 返回可 JSON 序列化的纯对象快照（不停止录制）
  exportRecording() {
    return { version: RECORDING_VERSION, events: this._events.slice() };
  }
}

export function defaultNow() {
  const g = globalThis;
  if (g.performance && typeof g.performance.now === 'function') return g.performance.now();
  return Date.now();
}
