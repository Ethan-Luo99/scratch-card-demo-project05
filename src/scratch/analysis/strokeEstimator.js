// 降级估算器（DESIGN.md 风险 9）：跨域 taint 导致 getImageData 不可用时，
// 用与采样面同分辨率的布尔网格按笔画几何盖章，估算刮开面积并集占比。

export class StrokeEstimator {
  constructor({ width = 200, height = 125, logicalWidth, logicalHeight }) {
    this.width = width;
    this.height = height;
    this.logicalWidth = logicalWidth;
    this.logicalHeight = logicalHeight;
    this.cells = new Uint8Array(width * height);
    this.marked = 0;
  }

  // points: 扁平逻辑坐标 [x0,y0,x1,y1,...]；radiusLogical: 笔刷逻辑半径
  stampPoints(points, radiusLogical) {
    const scaleX = this.width / this.logicalWidth;
    const scaleY = this.height / this.logicalHeight;
    const rx = Math.max(1, Math.ceil(radiusLogical * scaleX));
    const ry = Math.max(1, Math.ceil(radiusLogical * scaleY));
    for (let i = 0; i + 1 < points.length; i += 2) {
      const cx = points[i] * scaleX;
      const cy = points[i + 1] * scaleY;
      const x0 = Math.max(0, Math.floor(cx - rx));
      const x1 = Math.min(this.width - 1, Math.ceil(cx + rx));
      const y0 = Math.max(0, Math.floor(cy - ry));
      const y1 = Math.min(this.height - 1, Math.ceil(cy + ry));
      for (let gy = y0; gy <= y1; gy++) {
        for (let gx = x0; gx <= x1; gx++) {
          const nx = (gx - cx) / rx;
          const ny = (gy - cy) / ry;
          if (nx * nx + ny * ny > 1) continue;
          const idx = gy * this.width + gx;
          if (!this.cells[idx]) {
            this.cells[idx] = 1;
            this.marked++;
          }
        }
      }
    }
    return this.ratio();
  }

  ratio() {
    return this.marked / (this.width * this.height);
  }

  reset() {
    this.cells.fill(0);
    this.marked = 0;
  }
}
