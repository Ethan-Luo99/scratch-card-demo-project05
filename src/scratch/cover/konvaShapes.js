import Konva from 'konva';

// Konva 适配层：只负责对象组装。禁用 cache() / isolated Group（Q3 / ADR-001）。
export function createEraserLineFactory({ radius }) {
  return () => new Konva.Line({
    points: [],
    stroke: '#000000',
    strokeWidth: radius * 2,
    lineCap: 'round',
    lineJoin: 'round',
    globalCompositeOperation: 'destination-out',
    listening: false,
  });
}

export function createEraserDabFactory({ radius, hardness }) {
  const inner = Math.max(0, radius * hardness);
  return () => new Konva.Circle({
    radius,
    fillRadialGradientStartPoint: { x: 0, y: 0 },
    fillRadialGradientEndPoint: { x: 0, y: 0 },
    fillRadialGradientStartRadius: inner,
    fillRadialGradientEndRadius: radius,
    fillRadialGradientColorStops: [0, 'rgba(0,0,0,1)', 1, 'rgba(0,0,0,0)'],
    globalCompositeOperation: 'destination-out',
    listening: false,
  });
}
