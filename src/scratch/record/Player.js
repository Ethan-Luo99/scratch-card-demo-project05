// 笔迹回放（G3）：按录制时间戳节拍，经 rAF 合帧驱动原始输入路径。
// 重放不另开渲染通道——onDown/onMove/onUp 直接进入 ScratchCard 的逻辑输入
// 方法（与真实 pointer 事件共用 tracker / _pendingSegments / 同一 rAF flush /
// 同一 ProgressAnalyzer 节流采样），因此 progress 派发与达标自动 reveal 完全一致。
//
// 节拍：rAF 轮询 elapsed = (now - anchor) * speed，下发所有到期事件；
// down/move/up 的事件坐标即录制时的逻辑坐标，跳过 client→logical 换算。
// 真实输入在播放期由 PointerController.setEnabled(false) 门控忽略。
// destroy() 取消 rAF 句柄即中断回放，不泄漏。

import { defaultNow } from './Recorder.js';

export class Player {
  constructor({ now, requestFrame, cancelFrame, onDown, onMove, onUp, onReset, onEnd } = {}) {
    this._now = now || defaultNow;
    this._requestFrame =
      requestFrame || ((cb) => globalThis.window.requestAnimationFrame(cb));
    this._cancelFrame =
      cancelFrame || ((id) => globalThis.window.cancelAnimationFrame(id));
    this._onDown = onDown;
    this._onMove = onMove;
    this._onUp = onUp;
    this._onReset = onReset;
    this._onEnd = onEnd;
    this._events = null;
    this._index = 0;
    this._anchor = 0;
    this._speed = 1;
    this._rafId = null;
    this._playing = false;
  }

  get playing() {
    return this._playing;
  }

  play(recording, { speed = 1 } = {}) {
    if (this._playing) return false;
    const events = recording && Array.isArray(recording.events) ? recording.events : null;
    if (!events || events.length === 0) return false;
    this._events = events;
    this._index = 0;
    this._speed = speed > 0 ? speed : 1;
    this._playing = true;
    this._anchor = this._now();
    this._loop = this._loop.bind(this);
    this._rafId = this._requestFrame(this._loop);
    return true;
  }

  // destroy 中断；不触发 onEnd（卡片已销毁）
  stop() {
    if (!this._playing) return;
    this._playing = false;
    if (this._rafId !== null) this._cancelFrame(this._rafId);
    this._rafId = null;
    this._events = null;
  }

  _loop() {
    if (!this._playing) return;
    this._rafId = null;
    const elapsed = (this._now() - this._anchor) * this._speed;
    while (this._index < this._events.length && this._events[this._index].t <= elapsed) {
      const ev = this._events[this._index++];
      this._dispatch(ev);
    }
    if (this._index >= this._events.length) {
      this._playing = false;
      this._events = null;
      if (this._onEnd) this._onEnd();
      return;
    }
    this._rafId = this._requestFrame(this._loop);
  }

  _dispatch(ev) {
    switch (ev.type) {
      case 'down':
        this._onDown({ pointerId: ev.pointerId, x: ev.x, y: ev.y });
        break;
      case 'move':
        this._onMove({ pointerId: ev.pointerId, x: ev.x, y: ev.y });
        break;
      case 'up':
        this._onUp({ pointerId: ev.pointerId });
        break;
      case 'reset':
        if (this._onReset) this._onReset();
        break;
      default:
        break; // 前向兼容：忽略未知事件类型
    }
  }
}
