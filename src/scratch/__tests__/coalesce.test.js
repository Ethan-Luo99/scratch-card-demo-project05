import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenEvents, interpolateSegment, buildSegments } from '../input/coalesce.js';

test('flattenEvents falls back to the event itself', () => {
  const evt = { pointerId: 1, clientX: 10, clientY: 20, timeStamp: 5 };
  assert.deepEqual(flattenEvents(evt), [{ pointerId: 1, clientX: 10, clientY: 20, timeStamp: 5 }]);
});

test('flattenEvents expands getCoalescedEvents', () => {
  const coalesced = Array.from({ length: 5 }, (_, i) => ({ pointerId: 2, clientX: i, clientY: i * 2 }));
  const evt = { pointerId: 2, clientX: 99, clientY: 99, getCoalescedEvents: () => coalesced };
  const points = flattenEvents(evt);
  assert.equal(points.length, 5);
  assert.deepEqual(points[3], { pointerId: 2, clientX: 3, clientY: 6, timeStamp: undefined });
});

test('interpolateSegment point count = ceil(dist/step) + 1', () => {
  const pts = interpolateSegment({ x: 0, y: 0 }, { x: 100, y: 0 }, 5);
  assert.equal(pts.length, Math.ceil(100 / 5) + 1);
  assert.deepEqual(pts[0], { x: 0, y: 0 });
  assert.deepEqual(pts[pts.length - 1], { x: 100, y: 0 });
  const odd = interpolateSegment({ x: 0, y: 0 }, { x: 7, y: 0 }, 5);
  assert.equal(odd.length, Math.ceil(7 / 5) + 1);
});

test('buildSegments: first point emits a dot segment', () => {
  const { segments, last } = buildSegments(null, [{ x: 3, y: 4 }], 10);
  assert.deepEqual(segments, [[{ x: 3, y: 4 }, { x: 3, y: 4 }]]);
  assert.deepEqual(last, { x: 3, y: 4 });
});

test('buildSegments: short moves stay raw, gaps beyond 2*radius interpolate', () => {
  const radius = 10;
  let track = null;
  let r = buildSegments(track, [{ x: 0, y: 0 }], radius);
  track = r.last;
  r = buildSegments(track, [{ x: 15, y: 0 }], radius); // dist 15 <= 20
  assert.deepEqual(r.segments, [[{ x: 0, y: 0 }, { x: 15, y: 0 }]]);
  track = r.last;
  r = buildSegments(track, [{ x: 115, y: 0 }], radius); // dist 100 > 20
  assert.equal(r.segments.length, 1);
  assert.equal(r.segments[0].length, Math.ceil(100 / 5) + 1); // step = 0.5 * radius
});

test('buildSegments: independent tracks do not cross (multi-pointer)', () => {
  const radius = 10;
  let trackA = null;
  let trackB = null;
  trackA = buildSegments(trackA, [{ x: 0, y: 0 }], radius).last;
  trackB = buildSegments(trackB, [{ x: 500, y: 500 }], radius).last;
  const a = buildSegments(trackA, [{ x: 5, y: 0 }], radius);
  const b = buildSegments(trackB, [{ x: 505, y: 500 }], radius);
  assert.deepEqual(a.segments, [[{ x: 0, y: 0 }, { x: 5, y: 0 }]]);
  assert.deepEqual(b.segments, [[{ x: 500, y: 500 }, { x: 505, y: 500 }]]);
});

test('buildSegments: zero-distance move produces no segment', () => {
  let track = buildSegments(null, [{ x: 1, y: 1 }], 10).last;
  const r = buildSegments(track, [{ x: 1, y: 1 }], 10);
  assert.equal(r.segments.length, 0);
});
