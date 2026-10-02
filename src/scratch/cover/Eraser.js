// 禁用项（风险清单 15 / Q3）：本模块产出的节点严禁 cache()，严禁放入 isolated Group。
// 橡皮为无填充描边型 Line（或软刷径向渐变 Circle），直绘 layer canvas。
export class Eraser {
  constructor({ brush, createLine, createDab }) {
    this._brush = brush;
    this._createLine = createLine;
    this._createDab = createDab;
    this._linePool = [];
    this._dabPool = [];
  }

  get soft() {
    return this._brush.hardness < 1;
  }

  acquireSegment(points) {
    if (!this.soft) {
      const flat = [];
      for (const p of points) flat.push(p.x, p.y);
      const line = this._linePool.pop() || this._createLine();
      line.points(flat);
      return [line];
    }
    const dabs = [];
    for (const p of points) {
      const dab = this._dabPool.pop() || this._createDab();
      dab.x(p.x);
      dab.y(p.y);
      dabs.push(dab);
    }
    return dabs;
  }

  releaseSegment(nodes) {
    for (const node of nodes) {
      if (this.soft) this._dabPool.push(node);
      else this._linePool.push(node);
    }
  }

  destroy() {
    this._linePool = [];
    this._dabPool = [];
  }
}
