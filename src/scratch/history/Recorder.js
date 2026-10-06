// 笔迹录制器（纯逻辑）：记录真实输入的 pointer 事件流（逻辑坐标 + 时间戳），
// export 产出可 JSON 序列化的录制包。回放见 playback.js。

const round2 = (v) => Math.round(v * 100) / 100;

export class Recorder {
  constructor({ now } = {}) {
    this._now =
      now ||
      (() =>
        typeof performance !== 'undefined' && performance.now
          ? performance.now()
          : Date.now());
    this._events = [];
  }

  // type: 'down' | 'move' | 'up'；x/y 为逻辑坐标
  record(type, pointerId, x, y) {
    this._events.push({ t: this._now(), type, pointerId, x, y });
  }

  clear() {
    this._events = [];
  }

  get size() {
    return this._events.length;
  }

  // 时间戳重置为相对首事件的毫秒偏移，保证 JSON 稳定可读
  export({ width, height } = {}) {
    const t0 = this._events.length ? this._events[0].t : 0;
    return {
      version: 1,
      width,
      height,
      events: this._events.map((e) => ({
        t: round2(e.t - t0),
        type: e.type,
        pointerId: e.pointerId,
        x: round2(e.x),
        y: round2(e.y),
      })),
    };
  }
}
