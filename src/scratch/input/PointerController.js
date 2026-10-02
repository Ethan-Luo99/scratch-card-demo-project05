// 原生 Pointer Events 输入层（ADR-003 / 风险 1、2、12）。
// 挂在 stage.content 上；touch-action 内联设置；pointer capture；
// pointerup / pointercancel / lostpointercapture 三路统一清理。
// 不 import konva；target（content div）由外部注入。

import { flattenEvents } from './coalesce.js';

const OPTS = { passive: false };

export class PointerController {
  constructor({ target, touchAction = 'none', onDown, onMove, onUp }) {
    this.target = target;
    this.onDown = onDown;
    this.onMove = onMove;
    this.onUp = onUp;
    this.enabled = true;
    this._destroyed = false;
    this._captured = new Set();

    if (target.style) target.style.touchAction = touchAction;

    this._handlers = {
      pointerdown: (e) => this._down(e),
      pointermove: (e) => this._move(e),
      pointerup: (e) => this._up(e),
      pointercancel: (e) => this._up(e),
      lostpointercapture: (e) => this._up(e),
    };
    for (const [name, fn] of Object.entries(this._handlers)) {
      target.addEventListener(name, fn, OPTS);
    }
  }

  setEnabled(flag) {
    this.enabled = !!flag;
  }

  _down(e) {
    if (!this.enabled || this._destroyed) return;
    if (e.preventDefault) e.preventDefault(); // 阻断拖拽/滚动接管（passive:false）
    try {
      this.target.setPointerCapture(e.pointerId);
      this._captured.add(e.pointerId);
    } catch {
      // 某些环境（如事件已 uncapture）忽略
    }
    this.onDown({ pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY, pointerType: e.pointerType });
  }

  _move(e) {
    if (!this.enabled || this._destroyed) return;
    for (const c of flattenEvents(e)) {
      this.onMove(c);
    }
  }

  _up(e) {
    if (this._destroyed) return;
    const pointerId = e.pointerId;
    if (this._captured.has(pointerId)) {
      this._captured.delete(pointerId);
      try {
        this.target.releasePointerCapture(pointerId);
      } catch {
        // 已释放
      }
    }
    if (this.enabled) this.onUp({ pointerId });
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const [name, fn] of Object.entries(this._handlers)) {
      this.target.removeEventListener(name, fn, OPTS);
    }
    for (const pointerId of this._captured) {
      try {
        this.target.releasePointerCapture(pointerId);
      } catch {
        // 已释放
      }
    }
    this._captured.clear();
  }
}
