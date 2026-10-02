import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProgressAnalyzer } from '../analysis/ProgressAnalyzer.js';

function makeAnalyzer(overrides = {}) {
  const env = { now: 0, ratio: 0, sampleCalls: 0 };
  const calls = { progress: [], reach: 0, error: 0 };
  const analyzer = new ProgressAnalyzer({
    sample: () => {
      env.sampleCalls++;
      return env.ratio;
    },
    intervalMs: 120,
    targetRatio: 0.5,
    confirmations: 2,
    now: () => env.now,
    onProgress: (p) => calls.progress.push(p),
    onReach: () => calls.reach++,
    onError: () => calls.error++,
    ...overrides,
  });
  return { env, calls, analyzer };
}

test('120ms 时间节流：窗口内多次 move 只采一次', () => {
  const { env, calls, analyzer } = makeAnalyzer();
  env.ratio = 0.1;
  for (const t of [0, 50, 100, 119]) {
    env.now = t;
    analyzer.notifyActivity();
  }
  assert.equal(env.sampleCalls, 1); // 首次（-Infinity 起算）必采
  env.now = 120;
  analyzer.notifyActivity();
  assert.equal(env.sampleCalls, 2);
  assert.equal(calls.progress.length, 2);
  assert.equal(calls.progress[1].ratio, 0.1);
  assert.equal(calls.progress[1].sampledAt, 120);
});

test('阈值需连续两次确认；抖动不触发', () => {
  const { env, calls, analyzer } = makeAnalyzer();
  // 49% / 51% 往返（UC6）：每次间隔 120ms，末尾落在 49% 保证从未连续达标
  const seq = [0.49, 0.51, 0.49, 0.51, 0.49, 0.51, 0.49];
  seq.forEach((r, i) => {
    env.now = i * 120;
    env.ratio = r;
    analyzer.notifyActivity();
  });
  assert.equal(calls.reach, 0); // 从未连续两次 >= 0.5
  // 连续两次达标 → 触发且仅一次
  env.now = 840; env.ratio = 0.51; analyzer.notifyActivity();
  env.now = 960; env.ratio = 0.52; analyzer.notifyActivity();
  assert.equal(calls.reach, 1);
  // 达标后停止计数，回调恒为 1
  env.now = 1080; env.ratio = 0.6; analyzer.notifyActivity();
  analyzer.forceSample();
  assert.equal(calls.reach, 1);
  assert.equal(env.sampleCalls, 9); // 达标后不再采样
});

test('pointerup 强制终采：一次即可确认达标（收口）', () => {
  const { env, calls, analyzer } = makeAnalyzer();
  env.now = 0;
  env.ratio = 0.3;
  analyzer.notifyActivity();
  env.ratio = 0.55;
  analyzer.forceSample(); // 强制采样一次定音
  assert.equal(calls.reach, 1);
});

test('采样抛错 → onError 且进入失败态，不再采样', () => {
  const { calls, analyzer } = makeAnalyzer({
    sample: () => { throw new Error('SecurityError'); },
  });
  analyzer.notifyActivity();
  analyzer.notifyActivity();
  assert.equal(calls.error, 1);
});

test('reset 后重新计数；destroy 后全部静默', () => {
  const { env, calls, analyzer } = makeAnalyzer();
  env.ratio = 0.6;
  env.now = 0; analyzer.notifyActivity();
  env.now = 120; analyzer.notifyActivity();
  assert.equal(calls.reach, 1);
  analyzer.reset();
  assert.equal(analyzer.reached, false);
  assert.equal(analyzer.ratio, 0);
  env.now = 240; env.ratio = 0.1; analyzer.notifyActivity();
  assert.equal(calls.progress.at(-1).ratio, 0.1);
  analyzer.destroy();
  const before = env.sampleCalls;
  analyzer.notifyActivity();
  analyzer.forceSample();
  assert.equal(env.sampleCalls, before);
});
