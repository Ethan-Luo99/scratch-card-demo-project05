// 纯函数/纯类：coalesced 事件展开、按 pointerId 分轨、弧长插值补点。
// 依据 DESIGN.md ADR-003 与风险 7：点距 > 2×brushRadius 时按 0.5×半径步长插值。

// 一个原生 pointermove → N 个逻辑事件（不支持 coalesced 的旧内核回退为自身）
export function flattenEvents(evt) {
  const list =
    typeof evt.getCoalescedEvents === 'function'
      ? evt.getCoalescedEvents()
      : null;
  const source = list && list.length ? list : [evt];
  return source.map((e) => ({
    pointerId: e.pointerId,
    clientX: e.clientX,
    clientY: e.clientY,
    pointerType: e.pointerType,
  }));
}

// 线段密采：返回含首尾端点的插值点列，点数 = ceil(dist / step) + 1
export function interpolateSegment(x0, y0, x1, y1, step) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return [{ x: x0, y: y0 }];
  const n = Math.max(1, Math.ceil(dist / step));
  const points = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    points.push({ x: x0 + dx * t, y: y0 + dy * t });
  }
  return points;
}

// 多指分轨器：每个 pointerId 独立轨迹；move 返回本段应绘制的密集点列（扁平数组）
export class PointerTracker {
  constructor({ brushRadius }) {
    this.brushRadius = brushRadius;
    this.tracks = new Map(); // pointerId -> { x, y }
  }

  size() {
    return this.tracks.size;
  }

  has(pointerId) {
    return this.tracks.has(pointerId);
  }

  down(pointerId, x, y) {
    this.tracks.set(pointerId, { x, y });
    return [x, y];
  }

  // 返回扁平点列 [x0, y0, x1, y1, ...]；未知 pointerId 返回 null（防串轨/泄漏）
  move(pointerId, x, y) {
    const last = this.tracks.get(pointerId);
    if (!last) return null;
    const dist = Math.hypot(x - last.x, y - last.y);
    let segment;
    if (dist > 2 * this.brushRadius) {
      const dense = interpolateSegment(last.x, last.y, x, y, this.brushRadius * 0.5);
      segment = dense.flatMap((p) => [p.x, p.y]);
    } else {
      segment = [last.x, last.y, x, y];
    }
    this.tracks.set(pointerId, { x, y });
    return segment;
  }

  up(pointerId) {
    this.tracks.delete(pointerId);
  }

  clear() {
    this.tracks.clear();
  }
}
