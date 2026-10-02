import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenEvents, interpolateSegment, PointerTracker } from '../input/coalesce.js';

test('flattenEvents：1 原生事件 + N 个 coalesced 全部展开', () => {
  const coalesced = [
    { pointerId: 1, clientX: 10, clientY: 10 },
    { pointerId: 1, clientX: 11, clientY: 10 },
    { pointerId: 1, clientX: 12, clientY: 10 },
    { pointerId: 1, clientX: 13, clientY: 10 },
    { pointerId: 1, clientX: 14, clientY: 10 },
  ];
  const evt = { pointerId: 1, clientX: 14, clientY: 10, getCoalescedEvents: () => coalesced };
  const out = flattenEvents(evt);
  assert.equal(out.length, 5);
  assert.deepEqual(out.map((p) => p.clientX), [10, 11, 12, 13, 14]);
});

test('flattenEvents：无 getCoalescedEvents 时回退为自身', () => {
  const evt = { pointerId: 7, clientX: 1, clientY: 2 };
  const out = flattenEvents(evt);
  assert.equal(out.length, 1);
  assert.equal(out[0].pointerId, 7);
});

test('interpolateSegment：点数 = ceil(dist / step) + 1，含首尾', () => {
  const pts = interpolateSegment(0, 0, 100, 0, 5);
  assert.equal(pts.length, Math.ceil(100 / 5) + 1);
  assert.deepEqual(pts[0], { x: 0, y: 0 });
  assert.deepEqual(pts[pts.length - 1], { x: 100, y: 0 });
  // 零距
  assert.equal(interpolateSegment(3, 3, 3, 3, 5).length, 1);
});

test('PointerTracker：两 pointerId 交错不串轨', () => {
  const t = new PointerTracker({ brushRadius: 10 });
  t.down(1, 0, 0);
  t.down(2, 500, 500);
  const s1 = t.move(1, 5, 0); // dist 5 <= 2r → 两点段
  const s2 = t.move(2, 505, 500);
  assert.deepEqual(s1, [0, 0, 5, 0]);
  assert.deepEqual(s2, [500, 500, 505, 500]);
  t.up(1);
  // 抬起后该 id 的 move 被丢弃（防泄漏/复用）
  assert.equal(t.move(1, 9, 9), null);
  // 余指继续正常
  assert.deepEqual(t.move(2, 510, 500), [505, 500, 510, 500]);
  assert.equal(t.size(), 1);
});

test('PointerTracker：100px 跳跃触发插值，点数符合公式', () => {
  const radius = 10;
  const t = new PointerTracker({ brushRadius: radius });
  t.down(1, 0, 0);
  const seg = t.move(1, 100, 0); // dist 100 > 2r=20 → step=0.5r=5
  const pointCount = seg.length / 2;
  assert.equal(pointCount, Math.ceil(100 / (radius * 0.5)) + 1);
  assert.deepEqual(seg.slice(0, 2), [0, 0]);
  assert.deepEqual(seg.slice(-2), [100, 0]);
});

test('PointerTracker：小位移不插值，仅两端点', () => {
  const t = new PointerTracker({ brushRadius: 10 });
  t.down(1, 0, 0);
  const seg = t.move(1, 15, 0); // dist 15 <= 20
  assert.equal(seg.length, 4);
});
