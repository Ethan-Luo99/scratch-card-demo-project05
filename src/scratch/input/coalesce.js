export function flattenEvents(evt) {
  const coalesced = typeof evt.getCoalescedEvents === 'function' ? evt.getCoalescedEvents() : null;
  const source = coalesced && coalesced.length ? coalesced : [evt];
  return source.map((e) => ({
    pointerId: e.pointerId !== undefined ? e.pointerId : evt.pointerId,
    clientX: e.clientX,
    clientY: e.clientY,
    timeStamp: e.timeStamp !== undefined ? e.timeStamp : evt.timeStamp,
  }));
}

export function interpolateSegment(from, to, step) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return [{ x: from.x, y: from.y }];
  const count = Math.ceil(dist / step);
  const points = [];
  for (let i = 0; i <= count; i += 1) {
    points.push({ x: from.x + (dx * i) / count, y: from.y + (dy * i) / count });
  }
  return points;
}

export function buildSegments(track, points, brushRadius) {
  const segments = [];
  let prev = track;
  const gapThreshold = 2 * brushRadius;
  const step = 0.5 * brushRadius;
  for (const point of points) {
    if (!prev) {
      segments.push([{ x: point.x, y: point.y }, { x: point.x, y: point.y }]);
      prev = point;
      continue;
    }
    const dist = Math.hypot(point.x - prev.x, point.y - prev.y);
    if (dist === 0) continue;
    if (dist > gapThreshold) {
      segments.push(interpolateSegment(prev, point, step));
    } else {
      segments.push([{ x: prev.x, y: prev.y }, { x: point.x, y: point.y }]);
    }
    prev = point;
  }
  return { segments, last: prev };
}
