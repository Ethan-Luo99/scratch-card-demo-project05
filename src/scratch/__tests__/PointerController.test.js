import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PointerController, HANDLED_EVENTS } from '../input/PointerController.js';

function createTargetStub() {
  const listeners = new Map();
  return {
    style: {},
    captured: [],
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    setPointerCapture(id) { this.captured.push(id); },
    dispatch(name, evt) { if (listeners.has(name)) listeners.get(name)(evt); },
    listenerCount() { return listeners.size; },
  };
}

function makeController() {
  const target = createTargetStub();
  const calls = { start: [], move: [], end: [] };
  const controller = new PointerController({
    target,
    touchAction: 'none',
    onStart: (id, e) => calls.start.push([id, e.clientX, e.clientY]),
    onMove: (id, pts) => calls.move.push([id, pts]),
    onEnd: (id) => calls.end.push(id),
  });
  return { target, controller, calls };
}

test('binds the full pointer event set and sets touch-action inline', () => {
  const { target, controller } = makeController();
  assert.equal(target.style.touchAction, 'none');
  assert.equal(target.listenerCount(), HANDLED_EVENTS.length);
  controller.destroy();
  assert.equal(target.listenerCount(), 0);
});

test('pointerdown captures the pointer and emits onStart', () => {
  const { target, calls } = makeController();
  target.dispatch('pointerdown', { pointerId: 7, clientX: 1, clientY: 2 });
  assert.deepEqual(target.captured, [7]);
  assert.deepEqual(calls.start, [[7, 1, 2]]);
});

test('coalesced move expands and routes per pointerId', () => {
  const { target, calls } = makeController();
  target.dispatch('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 });
  const coalesced = [1, 2, 3, 4, 5].map((x) => ({ pointerId: 1, clientX: x, clientY: x }));
  target.dispatch('pointermove', { pointerId: 1, clientX: 5, clientY: 5, getCoalescedEvents: () => coalesced });
  assert.equal(calls.move.length, 1);
  assert.equal(calls.move[0][0], 1);
  assert.equal(calls.move[0][1].length, 5);
  assert.equal(calls.move[0][1][4].clientX, 5);
});

test('multi-pointer tracks stay separate; three-way cleanup works', () => {
  const { target, controller, calls } = makeController();
  target.dispatch('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 });
  target.dispatch('pointerdown', { pointerId: 2, clientX: 100, clientY: 100 });
  assert.equal(controller.activePointerCount(), 2);

  target.dispatch('pointermove', { pointerId: 1, clientX: 10, clientY: 0 });
  target.dispatch('pointermove', { pointerId: 2, clientX: 90, clientY: 100 });
  assert.deepEqual(calls.move.map(([id]) => id), [1, 2]);

  target.dispatch('pointerup', { pointerId: 1 });
  assert.deepEqual(calls.end, [1]);
  assert.equal(controller.activePointerCount(), 1);

  target.dispatch('pointercancel', { pointerId: 2 });
  assert.deepEqual(calls.end, [1, 2]);
  assert.equal(controller.activePointerCount(), 0);

  // lostpointercapture path
  target.dispatch('pointerdown', { pointerId: 3, clientX: 0, clientY: 0 });
  target.dispatch('lostpointercapture', { pointerId: 3 });
  assert.deepEqual(calls.end, [1, 2, 3]);
});

test('moves from unknown pointers are ignored; disabled controller is inert', () => {
  const { target, controller, calls } = makeController();
  target.dispatch('pointermove', { pointerId: 99, clientX: 1, clientY: 1 });
  assert.equal(calls.move.length, 0);

  target.dispatch('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 });
  controller.setEnabled(false); // clears active tracks, emits onEnd
  assert.deepEqual(calls.end, [1]);
  target.dispatch('pointerdown', { pointerId: 2, clientX: 0, clientY: 0 });
  assert.equal(calls.start.length, 1);
  assert.equal(controller.activePointerCount(), 0);
});

test('destroy unbinds every listener and clears tracks', () => {
  const { target, controller } = makeController();
  target.dispatch('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 });
  controller.destroy();
  assert.equal(target.listenerCount(), 0);
  assert.equal(controller.activePointerCount(), 0);
  target.dispatch('pointerdown', { pointerId: 2, clientX: 0, clientY: 0 });
  assert.equal(controller.activePointerCount(), 0);
});
