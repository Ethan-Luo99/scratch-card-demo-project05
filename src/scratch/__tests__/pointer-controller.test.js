import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PointerController } from '../input/PointerController.js';

function createContentStub() {
  const listeners = new Map();
  const captured = new Set();
  return {
    style: {},
    captured,
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    },
    removeEventListener(name, fn) {
      if (listeners.has(name)) listeners.get(name).delete(fn);
    },
    setPointerCapture(id) { captured.add(id); },
    releasePointerCapture(id) { captured.delete(id); },
    dispatch(name, event) {
      for (const fn of [...(listeners.get(name) || [])]) fn(event);
    },
    listenerCount(name) {
      return listeners.has(name) ? listeners.get(name).size : 0;
    },
  };
}

function makeController(content, calls = { down: [], move: [], up: [] }) {
  const controller = new PointerController({
    target: content,
    touchAction: 'none',
    onDown: (p) => calls.down.push(p),
    onMove: (p) => calls.move.push(p),
    onUp: (p) => calls.up.push(p),
  });
  return { controller, calls };
}

test('绑定事件名集合 + touch-action 内联样式', () => {
  const content = createContentStub();
  const { controller } = makeController(content);
  for (const name of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
    assert.equal(content.listenerCount(name), 1, name);
  }
  assert.equal(content.style.touchAction, 'none');
  controller.destroy();
});

test('pointerdown 触发 setPointerCapture 与 onDown', () => {
  const content = createContentStub();
  const { controller, calls } = makeController(content);
  content.dispatch('pointerdown', { pointerId: 3, clientX: 10, clientY: 20, preventDefault() {} });
  assert.deepEqual(calls.down, [{ pointerId: 3, clientX: 10, clientY: 20, pointerType: undefined }]);
  assert.ok(content.captured.has(3));
  controller.destroy();
});

test('coalesced 展开逐条回调；多指 Map 生命周期与三路清理', () => {
  const content = createContentStub();
  const { controller, calls } = makeController(content);
  content.dispatch('pointerdown', { pointerId: 1, clientX: 0, clientY: 0, preventDefault() {} });
  content.dispatch('pointerdown', { pointerId: 2, clientX: 50, clientY: 50, preventDefault() {} });
  // 指 1 的 move 携带 3 个 coalesced
  content.dispatch('pointermove', {
    pointerId: 1,
    clientX: 12,
    clientY: 0,
    getCoalescedEvents: () => [
      { pointerId: 1, clientX: 10, clientY: 0 },
      { pointerId: 1, clientX: 11, clientY: 0 },
      { pointerId: 1, clientX: 12, clientY: 0 },
    ],
  });
  assert.equal(calls.move.length, 3);
  assert.deepEqual(calls.move.map((p) => p.clientX), [10, 11, 12]);
  // 三路清理：up / cancel / lostpointercapture
  content.dispatch('pointerup', { pointerId: 1 });
  content.dispatch('pointercancel', { pointerId: 2 });
  content.dispatch('lostpointercapture', { pointerId: 2 }); // 幂等
  assert.deepEqual(calls.up.map((p) => p.pointerId), [1, 2, 2]);
  assert.equal(content.captured.size, 0);
  controller.destroy();
});

test('setEnabled(false) 后输入静默；destroy 解绑全部监听并释放 capture', () => {
  const content = createContentStub();
  const { controller, calls } = makeController(content);
  content.dispatch('pointerdown', { pointerId: 9, clientX: 1, clientY: 1, preventDefault() {} });
  controller.setEnabled(false);
  content.dispatch('pointermove', { pointerId: 9, clientX: 2, clientY: 2 });
  assert.equal(calls.move.length, 0);
  controller.setEnabled(true);
  content.dispatch('pointermove', { pointerId: 9, clientX: 3, clientY: 3 });
  assert.equal(calls.move.length, 1);
  controller.destroy();
  for (const name of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
    assert.equal(content.listenerCount(name), 0, name);
  }
  assert.equal(content.captured.size, 0); // destroy 释放残留 capture
  // 销毁后重复 destroy 幂等，事件静默
  controller.destroy();
  content.dispatch('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 });
  assert.equal(calls.down.length, 1);
});
