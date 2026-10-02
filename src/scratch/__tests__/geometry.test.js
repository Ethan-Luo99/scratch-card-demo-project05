import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cssScale, toLogicalPoint, toBitmapPixel, clientToBitmap } from '../input/geometry.js';

const DPRS = [1, 2, 3];
const SCALES = [0.5, 1, 1.25];
const LOGICAL = { width: 800, height: 500 };

function makeEnv(cssScale) {
  return {
    rect: {
      left: 13,
      top: 7,
      width: LOGICAL.width * cssScale,
      height: LOGICAL.height * cssScale,
    },
    size: { width: LOGICAL.width, height: LOGICAL.height },
  };
}

test('cssScale derives from rect / clientWidth with fallback 1', () => {
  const { rect, size } = makeEnv(0.5);
  assert.deepEqual(cssScale(rect, size), { scaleX: 0.5, scaleY: 0.5 });
  assert.deepEqual(cssScale({ left: 0, top: 0, width: 0, height: 0 }, size), { scaleX: 1, scaleY: 1 });
});

test('Q5 matrix: dpr x cssScale 9 combinations', () => {
  for (const dpr of DPRS) {
    for (const scale of SCALES) {
      const { rect, size } = makeEnv(scale);
      // pick a logical point, project to client coords, then convert back
      const logical = { x: 123.4, y: 456.7 };
      const clientX = rect.left + logical.x * scale;
      const clientY = rect.top + logical.y * scale;

      const p = toLogicalPoint(clientX, clientY, rect, size);
      assert.ok(Math.abs(p.x - logical.x) < 1e-9, `dpr=${dpr} scale=${scale} logical x`);
      assert.ok(Math.abs(p.y - logical.y) < 1e-9, `dpr=${dpr} scale=${scale} logical y`);

      const expectedBitmap = {
        x: Math.floor(logical.x * dpr),
        y: Math.floor(logical.y * dpr),
      };
      assert.deepEqual(toBitmapPixel(p.x, p.y, dpr), expectedBitmap, `dpr=${dpr} scale=${scale}`);

      const direct = clientToBitmap(clientX, clientY, rect, size, dpr);
      const expectedDirect = {
        x: Math.floor(((clientX - rect.left) * dpr) / scale),
        y: Math.floor(((clientY - rect.top) * dpr) / scale),
      };
      assert.deepEqual(direct, expectedDirect, `dpr=${dpr} scale=${scale} combined formula`);
    }
  }
});

test('Q5 worked example: dpr=3, cssScale=0.5 => factor 6', () => {
  const { rect, size } = makeEnv(0.5);
  const p = clientToBitmap(rect.left + 10, rect.top + 10, rect, size, 3);
  assert.deepEqual(p, { x: 60, y: 60 });
});
