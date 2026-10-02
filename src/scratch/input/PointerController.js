import { flattenEvents } from './coalesce.js';

const HANDLED_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture'];

export class PointerController {
  constructor({ target, touchAction = 'none', onStart, onMove, onEnd }) {
    this._target = target;
    this._onStart = onStart;
    this._onMove = onMove;
    this._onEnd = onEnd;
    this._enabled = true;
    this._tracks = new Map();
    this._handlers = [];

    if (target.style) target.style.touchAction = touchAction;

    const bind = (name, fn, options) => {
      target.addEventListener(name, fn, options);
      this._handlers.push([name, fn, options]);
    };
    bind('pointerdown', (e) => this._handleDown(e), { passive: false });
    bind('pointermove', (e) => this._handleMove(e), { passive: false });
    bind('pointerup', (e) => this._handleUp(e));
    bind('pointercancel', (e) => this._handleUp(e));
    bind('lostpointercapture', (e) => this._handleUp(e));
  }

  setEnabled(enabled) {
    this._enabled = Boolean(enabled);
    if (!this._enabled) this._clearTracks();
  }

  activePointerCount() {
    return this._tracks.size;
  }

  _clearTracks() {
    for (const pointerId of this._tracks.keys()) {
      this._tracks.delete(pointerId);
      if (this._onEnd) this._onEnd(pointerId);
    }
  }

  _handleDown(evt) {
    if (!this._enabled) return;
    if (this._target.setPointerCapture) {
      try {
        this._target.setPointerCapture(evt.pointerId);
      } catch (_) {
        // pointer may already be released; capture is best-effort
      }
    }
    this._tracks.set(evt.pointerId, true);
    if (this._onStart) this._onStart(evt.pointerId, evt);
  }

  _handleMove(evt) {
    if (!this._enabled) return;
    const points = flattenEvents(evt);
    const byPointer = new Map();
    for (const point of points) {
      if (!this._tracks.has(point.pointerId)) continue;
      if (!byPointer.has(point.pointerId)) byPointer.set(point.pointerId, []);
      byPointer.get(point.pointerId).push(point);
    }
    for (const [pointerId, list] of byPointer) {
      if (this._onMove) this._onMove(pointerId, list);
    }
  }

  _handleUp(evt) {
    if (!this._tracks.has(evt.pointerId)) return;
    this._tracks.delete(evt.pointerId);
    if (this._onEnd) this._onEnd(evt.pointerId);
  }

  destroy() {
    for (const [name, fn, options] of this._handlers) {
      this._target.removeEventListener(name, fn, options);
    }
    this._handlers = [];
    this._tracks.clear();
  }
}

export { HANDLED_EVENTS };
