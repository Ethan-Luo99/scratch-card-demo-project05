import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCssScale,
  toLogicalPoint,
  toBitmapPixel,
  clientToBitmap,
} from '../input/geometry.js';

// Q5 公式对账：dpr ∈ {1,2,3} × cssScale ∈ {0.5,1,1.25} 共 9 组合
const DPRS = [1, 2, 3];
const SCALES = [0.5, 1, 1.25];

test('cssScale = rect.width / content.clientWidth || 1', () => {
  const s = computeCssScale({ width: 400, height: 250 }, 800, 500);
  assert.equal(s.scaleX, 0.5);
  assert.equal(s.scaleY, 0.5);
  // clientWidth 为 0 时回退 1（Stage.js:906-912 同款回退）
  const fallback = computeCssScale({ width: 400, height: 250 }, 0, 0);
  assert.equal(fallback.scaleX, 1);
  assert.equal(fallback.scaleY, 1);
});

test('logical/bitmap 换算矩阵（9 组合）', () => {
  const rect = { left: 137, top: 42, width: 0, height: 0 };
  const clientX = 337.6;
  const clientY = 142.4;
  for (const dpr of DPRS) {
    for (const scale of SCALES) {
      const cssScale = { scaleX: scale, scaleY: scale };
      const logical = toLogicalPoint(clientX, clientY, rect, cssScale);
      assert.equal(logical.x, (clientX - rect.left) / scale);
      assert.equal(logical.y, (clientY - rect.top) / scale);

      const bitmap = toBitmapPixel(logical.x, logical.y, dpr);
      assert.equal(bitmap.x, Math.floor(logical.x * dpr));
      assert.equal(bitmap.y, Math.floor(logical.y * dpr));

      // 合并式：floor((client - rect) * dpr / cssScale)，单次 floor
      const merged = clientToBitmap(clientX, clientY, rect, cssScale, dpr);
      assert.equal(merged.x, Math.floor(((clientX - rect.left) * dpr) / scale));
      assert.equal(merged.y, Math.floor(((clientY - rect.top) * dpr) / scale));
    }
  }
});

test('DESIGN.md Q5 示例：DPR=3、cssScale=0.5 → 倍率 6', () => {
  const rect = { left: 0, top: 0 };
  const cssScale = { scaleX: 0.5, scaleY: 0.5 };
  const p = clientToBitmap(10, 20, rect, cssScale, 3);
  assert.equal(p.x, 60);
  assert.equal(p.y, 120);
});
