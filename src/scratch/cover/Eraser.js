// 笔迹节点对象池（ADR-001）。
// 禁用项（DESIGN.md 风险 15，勿回归）：
//   - 严禁对橡皮节点调用 cache()（Q3：快照会冻结笔迹且缓存期不施加 GCO）
//   - 严禁 isolated Group 包裹（Group.js:59-69：每帧整组重栅格化且边缘像素不一致）
//   - 橡皮必须是无填充描边型 Line（或径向渐变圆章）直绘 layer canvas
// createLine/createCircle 由外部注入（生产环境为 Konva.Line/Konva.Circle），本模块不 import konva。

const HARD_POOL_LIMIT = 64;
const SOFT_POOL_LIMIT = 512;

export class Eraser {
  constructor({ createLine, createCircle }) {
    this.createLine = createLine;
    this.createCircle = createCircle;
    this._linePool = [];
    this._circlePool = [];
  }

  // 一段密集点列 → 本段所需节点（硬刷 1 个 Line；软刷每点 1 个渐变圆章）
  acquireSegmentNodes(points, brush) {
    const radius = brush.radius;
    if (brush.hardness >= 1) {
      const line = this._linePool.pop() || this.createLine();
      line.setAttrs({
        points,
        stroke: '#000',
        strokeWidth: radius * 2,
        lineCap: 'round',
        lineJoin: 'round',
        tension: 0,
        fillEnabled: false,
        shadowEnabled: false,
        perfectDrawEnabled: true,
        listening: false,
        opacity: 1,
        globalCompositeOperation: 'destination-out',
      });
      return [line];
    }
    // 软边刷：径向渐变圆章，仅 alpha 参与 destination-out
    const nodes = [];
    for (let i = 0; i + 1 < points.length; i += 2) {
      const circle = this._circlePool.pop() || this.createCircle();
      circle.setAttrs({
        x: points[i],
        y: points[i + 1],
        radius,
        fillRadialGradientStartPoint: { x: 0, y: 0 },
        fillRadialGradientEndPoint: { x: 0, y: 0 },
        fillRadialGradientStartRadius: 0,
        fillRadialGradientEndRadius: radius,
        fillRadialGradientColorStops: [
          0, 'rgba(0,0,0,1)',
          brush.hardness, 'rgba(0,0,0,1)',
          1, 'rgba(0,0,0,0)',
        ],
        strokeEnabled: false,
        shadowEnabled: false,
        perfectDrawEnabled: true,
        listening: false,
        opacity: 1,
        globalCompositeOperation: 'destination-out',
      });
      nodes.push(circle);
    }
    return nodes;
  }

  release(nodes) {
    for (const node of nodes) {
      if (node.getClassName && node.getClassName() === 'Circle') {
        if (this._circlePool.length < SOFT_POOL_LIMIT) this._circlePool.push(node);
      } else if (this._linePool.length < HARD_POOL_LIMIT) {
        this._linePool.push(node);
      }
    }
  }

  poolSize() {
    return this._linePool.length + this._circlePool.length;
  }
}
