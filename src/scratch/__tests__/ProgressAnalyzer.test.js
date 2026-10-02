import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProgressAnalyzer, createStrokeEstimate } from '../analysis/ProgressAnalyzer.js';
import { createFakeClock } from './helpers.js';

function makeAnalyzer(overrides = {}) {
  const clock = createFakeClock(1000);
  const calls = { progress: [], reach: 0, error: 0 };
  const analyzer = new ProgressAnalyzer({
    sampler: () => 0,
    targetRatio: 0.5,
    intervalMs: 120,
    now: () => clock.now(),
    onProgress: (p) => calls.progress.push(p),
    onReach: () => { calls.reach += 1; },
    onError: () => { calls.error += 1; },
    ...overrides,
  });
  return { analyzer, clock, calls };
}

test('time throttle: multiple moves inside 120ms sample once', () => {
  let samples = 0;
  const { analyzer, clock } = makeAnalyzer({ sampler: () => { samples += 1; return 0.1; } });
  analyzer.notifyActivity(); // t=1000 -> sample
  clock.advance(50);
  analyzer.notifyActivity();
  clock.advance(50);
  analyzer.notifyActivity();
  assert.equal(samples, 1);
  clock.advance(30); // t=1130
  analyzer.notifyActivity();
  assert.equal(samples, 2);
});

test('threshold requires two consecutive confirmations and fires onReach once', () => {
  let ratio = 0;
  const { analyzer, clock, calls } = makeAnalyzer({ sampler: () => ratio });
  ratio = 0.6;
  analyzer.notifyActivity(); // confirm 1
  assert.equal(calls.reach, 0);
  clock.advance(200);
  analyzer.notifyActivity(); // confirm 2 -> reach
  assert.equal(calls.reach, 1);
  clock.advance(200);
  analyzer.notifyActivity(); // done: no more sampling
  assert.equal(calls.reach, 1);
  assert.equal(analyzer.done, true);
});

test('threshold jitter: alternating ratios never confirm', () => {
  const seq = [0.49, 0.51, 0.49, 0.51, 0.49];
  let i = 0;
  const { analyzer, clock, calls } = makeAnalyzer({ sampler: () => seq[i++ % seq.length] });
  for (let k = 0; k < 5; k += 1) {
    analyzer.notifyActivity();
    clock.advance(200);
  }
  assert.equal(calls.reach, 0);
  // two consecutive above-threshold samples confirm
  const steady = makeAnalyzer({ sampler: () => 0.51 });
  steady.analyzer.notifyActivity();
  steady.clock.advance(200);
  steady.analyzer.notifyActivity();
  assert.equal(steady.calls.reach, 1);
});

test('pointerup forces an immediate sample', () => {
  let samples = 0;
  const { analyzer, calls } = makeAnalyzer({ sampler: () => { samples += 1; return 0.2; } });
  analyzer.notifyPointerUp();
  assert.equal(samples, 1);
  assert.equal(calls.progress.length, 1);
  assert.equal(calls.progress[0].ratio, 0.2);
});

test('near-target interval halves (120ms -> 60ms)', () => {
  let samples = 0;
  const { analyzer, clock } = makeAnalyzer({ sampler: () => { samples += 1; return 0.48; } });
  analyzer.notifyActivity(); // t=1000 sample, ratio 0.48 within 5% of 0.5
  assert.equal(samples, 1);
  clock.advance(70); // t=1070: beyond halved interval 60
  analyzer.notifyActivity();
  assert.equal(samples, 2);
});

test('taint: SecurityError degrades to stroke estimate, progress-error emitted once', () => {
  const estimate = createStrokeEstimate({ brushRadius: 10, area: 1000 });
  const { analyzer, clock, calls } = makeAnalyzer({
    sampler: () => { const e = new Error('tainted'); e.name = 'SecurityError'; throw e; },
    estimate,
  });
  analyzer.notifyPointerUp(); // first sample throws -> tainted, error emitted
  assert.equal(calls.error, 1);
  analyzer.notifyStroke(10); // covered = 10*20 + pi*100 ≈ 514 -> ratio 0.514
  assert.ok(analyzer.ratio > 0.5 && analyzer.ratio < 0.6);
  analyzer.notifyStroke(10);
  assert.equal(calls.error, 1); // only once
  clock.advance(500);
  analyzer.notifyActivity(); // tainted path: no sampler call, no throw
  assert.ok(analyzer.ratio > 0.5);
});

test('reset clears confirmations and ratio', () => {
  let ratio = 0.6;
  const { analyzer, clock, calls } = makeAnalyzer({ sampler: () => ratio });
  analyzer.notifyActivity();
  clock.advance(200);
  analyzer.notifyActivity();
  assert.equal(calls.reach, 1);
  analyzer.reset();
  assert.equal(analyzer.ratio, 0);
  assert.equal(analyzer.done, false);
  ratio = 0.1;
  clock.advance(200);
  analyzer.notifyActivity();
  assert.equal(analyzer.ratio, 0.1);
});
