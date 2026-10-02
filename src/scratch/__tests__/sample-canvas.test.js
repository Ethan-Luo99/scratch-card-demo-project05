import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SampleGrid, TaintedCanvasError } from '../analysis/sampleCanvas.js';
import { StrokeEstimator } from '../analysis/strokeEstimator.js';
import { createCanvasStub, punchHole } from './helpers.js';

const GRID_W = 200;
const GRID_H = 125;

function makeGrid(overrides = {}) {
  const stub = createCanvasStub(GRID_W, GRID_H);
  const grid = new SampleGrid({
    width: GRID_W,
    height: GRID_H,
    alphaCutoff: 16,
    targetRatio: 0.5,
    createCanvas: () => stub.canvas,
    ...overrides,
  });
  return { grid, stub };
}

test('全不透明 = 0；全透明 ≥ target（计数提前结束，返回值为下界）', () => {
  const { grid } = makeGrid();
  const src = createCanvasStub(800, 500);
  assert.equal(grid.sample(src.canvas), 0);
  src.alpha.fill(0);
  const ratio = grid.sample(src.canvas);
  // ADR-002 计数提前结束：超过 target 对应格数即停止，返回值是 ≥ target 的下界
  assert.ok(ratio > 0.5 && ratio <= 1, `ratio=${ratio}`);
});

test('已知孔洞比例在量化误差带内（≤ 1/格数 + 0.5%）', () => {
  const { grid } = makeGrid();
  const src = createCanvasStub(800, 500);
  // 刮开左侧 1/4（200×500 源像素 → 采样面 50×125）
  punchHole(src.alpha, 800, 0, 0, 200, 500);
  const ratio = grid.sample(src.canvas);
  const tolerance = 1 / (GRID_W * GRID_H) + 0.005;
  assert.ok(Math.abs(ratio - 0.25) <= tolerance, `ratio=${ratio}`);
});

test('alphaCutoff 边界：alpha=15 计为透明，alpha=16 不计', () => {
  const { grid } = makeGrid();
  const src = createCanvasStub(800, 500);
  src.alpha.fill(15); // < 16 → 全透明
  assert.ok(grid.sample(src.canvas) > 0.5);
  src.alpha.fill(16); // 不小于 cutoff → 不透明
  assert.equal(grid.sample(src.canvas), 0);
});

test('getImageData 抛 SecurityError → TaintedCanvasError', () => {
  const stub = createCanvasStub(GRID_W, GRID_H);
  stub.ctx.getImageData = () => {
    const err = new Error('The canvas has been tainted');
    err.name = 'SecurityError';
    throw err;
  };
  const grid = new SampleGrid({ createCanvas: () => stub.canvas });
  const src = createCanvasStub(800, 500);
  assert.throws(() => grid.sample(src.canvas), TaintedCanvasError);
});

test('StrokeEstimator：笔画盖章并集估算', () => {
  const est = new StrokeEstimator({
    width: GRID_W,
    height: GRID_H,
    logicalWidth: 800,
    logicalHeight: 500,
  });
  assert.equal(est.ratio(), 0);
  // 一条横贯中线的粗笔画：半径 125 逻辑像素 → 覆盖约一半高度
  const points = [];
  for (let x = 0; x <= 800; x += 10) points.push(x, 250);
  const ratio = est.stampPoints(points, 125);
  assert.ok(ratio > 0.4 && ratio < 0.6, `ratio=${ratio}`);
  // 重复盖章不重复计数（并集）
  const again = est.stampPoints(points, 125);
  assert.equal(again, ratio);
  est.reset();
  assert.equal(est.ratio(), 0);
});
