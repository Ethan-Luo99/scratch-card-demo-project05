import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SampleGrid } from '../analysis/sampleCanvas.js';
import { createCanvasStub } from './helpers.js';

function makeGrid(w = 4, h = 4, alphaCutoff = 16) {
  return new SampleGrid({ width: w, height: h, alphaCutoff, createCanvas: createCanvasStub });
}

test('fully opaque cover => ratio 0; fully cleared => ratio 1', () => {
  const grid = makeGrid();
  const source = createCanvasStub(4, 4);
  assert.equal(grid.sampleRatio(source), 0);
  source._alpha.fill(0);
  assert.equal(grid.sampleRatio(source), 1);
});

test('known hole ratio matches within quantization', () => {
  const grid = makeGrid(4, 4);
  const source = createCanvasStub(4, 4);
  source._alpha[0] = 0; // 1/16 cleared
  source._alpha[5] = 0; // 2/16
  const ratio = grid.sampleRatio(source);
  assert.ok(Math.abs(ratio - 2 / 16) < 1e-9);
});

test('downsample from larger source uses nearest grid mapping', () => {
  const grid = makeGrid(2, 2);
  const source = createCanvasStub(8, 8);
  // clear the top-left quadrant (4x4 of 8x8) => 25%
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) source._alpha[y * 8 + x] = 0;
  }
  const ratio = grid.sampleRatio(source);
  assert.ok(Math.abs(ratio - 0.25) < 1e-9);
});

test('alphaCutoff: pixels below cutoff count as cleared', () => {
  const grid = makeGrid(2, 2, 16);
  const source = createCanvasStub(2, 2);
  source._alpha[0] = 10; // below cutoff -> cleared
  source._alpha[1] = 20; // above cutoff -> covered
  assert.equal(grid.sampleRatio(source), 0.25);
});

test('SecurityError from getImageData propagates to caller', () => {
  const grid = makeGrid(2, 2);
  grid.ctx.getImageData = () => {
    const e = new Error('tainted');
    e.name = 'SecurityError';
    throw e;
  };
  const source = createCanvasStub(2, 2);
  assert.throws(() => grid.sampleRatio(source), /tainted/);
});
