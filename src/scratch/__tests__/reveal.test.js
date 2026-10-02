import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReveal } from '../reveal/reveal.js';

function createElementStub() {
  const listeners = new Map();
  return {
    style: {},
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    fire(name, event) { if (listeners.has(name)) listeners.get(name)(event); },
    listenerCount() { return listeners.size; },
  };
}

function createDocStub() {
  const listeners = new Map();
  return {
    visibilityState: 'visible',
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    fire(name) { if (listeners.has(name)) listeners.get(name)(); },
    listenerCount() { return listeners.size; },
  };
}

function createTimerStub() {
  const pending = new Map();
  let seq = 0;
  return {
    setTimeoutFn: (fn, ms) => { seq += 1; pending.set(seq, { fn, ms }); return seq; },
    clearTimeoutFn: (id) => { pending.delete(id); },
    run(id) { const t = pending.get(id); if (t) { pending.delete(id); t.fn(); } },
    runAll() { for (const [id] of [...pending]) this.run(id); },
    pendingCount() { return pending.size; },
    lastDelay() { return [...pending.values()].at(-1)?.ms; },
  };
}

function makeReveal({ durationMs = 260 } = {}) {
  const element = createElementStub();
  const doc = createDocStub();
  const timers = createTimerStub();
  let done = 0;
  const cancel = runReveal({
    element,
    durationMs,
    doc,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onDone: () => { done += 1; },
  });
  return { element, doc, timers, cancel, doneCount: () => done };
}

test('normal path: transition starts, transitionend finishes once', () => {
  const r = makeReveal();
  assert.equal(r.element.style.opacity, '0');
  assert.match(r.element.style.transition, /260ms/);
  assert.equal(r.timers.lastDelay(), 260 * 1.2);
  r.element.fire('transitionend', { target: r.element, propertyName: 'opacity' });
  assert.equal(r.doneCount(), 1);
  assert.equal(r.timers.pendingCount(), 0);
  assert.equal(r.element.listenerCount(), 0);
  assert.equal(r.doc.listenerCount(), 0);
  r.timers.runAll(); // late timer must not re-fire
  assert.equal(r.doneCount(), 1);
});

test('fallback timer finishes when transitionend never comes', () => {
  const r = makeReveal();
  r.timers.runAll();
  assert.equal(r.doneCount(), 1);
});

test('hidden tab jumps to the end state immediately', () => {
  const r = makeReveal();
  r.doc.visibilityState = 'hidden';
  r.doc.fire('visibilitychange');
  assert.equal(r.doneCount(), 1);
  assert.equal(r.element.style.opacity, '0');
});

test('onDone fires exactly once across all completion paths', () => {
  const r = makeReveal();
  r.doc.visibilityState = 'hidden';
  r.doc.fire('visibilitychange');
  r.element.fire('transitionend', { target: r.element, propertyName: 'opacity' });
  r.timers.runAll();
  assert.equal(r.doneCount(), 1);
});

test('instant reveal (durationMs=0) completes synchronously', () => {
  const r = makeReveal({ durationMs: 0 });
  assert.equal(r.doneCount(), 1);
  assert.equal(r.element.style.opacity, '0');
});

test('cancel restores opacity and prevents completion', () => {
  const r = makeReveal();
  r.cancel();
  r.element.fire('transitionend', { target: r.element, propertyName: 'opacity' });
  r.timers.runAll();
  assert.equal(r.doneCount(), 0);
  assert.equal(r.element.style.opacity, '1');
});
