import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReveal } from '../reveal/reveal.js';

// 可手动排空的假定时器队列 + 可见性开关 + transitionend 触发器
function makeEnv() {
  const timers = new Set();
  const visibilityCbs = new Set();
  const transitionCbs = new Set();
  const env = {
    hidden: false,
    setTimeout: (fn, ms) => {
      const t = { fn, ms };
      timers.add(t);
      return t;
    },
    clearTimeout: (t) => timers.delete(t),
    isHidden: () => env.hidden,
    onVisibilityChange: (cb) => {
      visibilityCbs.add(cb);
      return () => visibilityCbs.delete(cb);
    },
    onTransitionEnd: (cb) => {
      transitionCbs.add(cb);
      return () => transitionCbs.delete(cb);
    },
    runTimers() {
      for (const t of [...timers]) {
        timers.delete(t);
        t.fn();
      }
    },
    fireVisibility() {
      for (const cb of [...visibilityCbs]) cb();
    },
    fireTransitionEnd() {
      for (const cb of [...transitionCbs]) cb();
    },
    timerCount: () => timers.size,
  };
  return env;
}

function makeReveal(env, overrides = {}) {
  const calls = { opacity: [], clear: 0, done: 0 };
  const handle = runReveal({
    setOpacity: (v, withTransition) => calls.opacity.push([v, withTransition]),
    clear: () => calls.clear++,
    durationMs: 260,
    onDone: () => calls.done++,
    env,
    ...overrides,
  });
  return { handle, calls };
}

test('正常渐隐：opacity 置 0（带过渡），兜底定时器到点完成一次', () => {
  const env = makeEnv();
  const { calls } = makeReveal(env);
  assert.deepEqual(calls.opacity, [[0, true]]); // 触发 CSS transition
  assert.equal(env.timerCount(), 1);
  env.runTimers(); // durationMs×1.2 兜底
  assert.equal(calls.done, 1);
  assert.equal(calls.clear, 1);
  assert.deepEqual(calls.opacity.at(-1), [0, false]); // 终态复位
  env.runTimers();
  assert.equal(calls.done, 1); // 恰好一次
});

test('transitionend 先到时完成，兜底定时器被取消', () => {
  const env = makeEnv();
  const { calls } = makeReveal(env);
  env.fireTransitionEnd();
  assert.equal(calls.done, 1);
  assert.equal(env.timerCount(), 0);
  env.runTimers();
  assert.equal(calls.done, 1);
});

test('渐隐中途切到隐藏 tab：立即跳终态', () => {
  const env = makeEnv();
  const { calls } = makeReveal(env);
  env.hidden = true;
  env.fireVisibility();
  assert.equal(calls.done, 1);
  assert.equal(calls.clear, 1);
  assert.equal(env.timerCount(), 0);
});

test('启动时已隐藏：同步完成，不安排渐隐', () => {
  const env = makeEnv();
  env.hidden = true;
  const { calls } = makeReveal(env);
  assert.equal(calls.done, 1);
  assert.equal(calls.clear, 1);
  assert.equal(env.timerCount(), 0);
});

test('instant=true 同步完成；cancel 复位 opacity 且不回调', () => {
  const env = makeEnv();
  const a = makeReveal(env, { instant: true });
  assert.equal(a.calls.done, 1);
  const b = makeReveal(env);
  b.handle.cancel();
  assert.equal(b.calls.done, 0);
  assert.deepEqual(b.calls.opacity.at(-1), [1, false]); // 复位供 reset 复用
  assert.equal(env.timerCount(), 0);
});
