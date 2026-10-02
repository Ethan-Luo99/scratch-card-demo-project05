// ADR-002：独立低分辨率离屏采样面（唯一允许的离屏 canvas 用途：像素分析）。
// 不 import konva；canvas 工厂由构造参数注入，便于 node:test 用 stub 验证。

export class TaintedCanvasError extends Error {
  constructor(cause) {
    super('cover canvas is tainted; getImageData is blocked');
    this.name = 'TaintedCanvasError';
    this.cause = cause;
  }
}

export class SampleGrid {
  constructor({ width = 200, height = 125, alphaCutoff = 16, targetRatio = 0.5, createCanvas } = {}) {
    this.width = width;
    this.height = height;
    this.alphaCutoff = alphaCutoff;
    this.targetRatio = targetRatio;
    const factory =
      createCanvas ||
      (() => {
        if (typeof document === 'undefined') {
          throw new Error('SampleGrid: no createCanvas factory and no document');
        }
        return document.createElement('canvas');
      });
    this.canvas = factory();
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');
  }

  // 返回已刮开比例 [0,1]。源 canvas 被跨域污染时抛 TaintedCanvasError。
  // 计数提前结束：透明计数已超 target 对应格数时停止遍历（返回值为下界，仍 >= target）。
  sample(sourceCanvas) {
    const { ctx, width, height, alphaCutoff } = this;
    ctx.clearRect(0, 0, width, height);
    try {
      ctx.drawImage(sourceCanvas, 0, 0, width, height);
    } catch (err) {
      throw new TaintedCanvasError(err);
    }
    let image;
    try {
      image = ctx.getImageData(0, 0, width, height);
    } catch (err) {
      throw new TaintedCanvasError(err);
    }
    const data = image.data;
    const total = width * height;
    const stopAt = Math.ceil(this.targetRatio * total);
    let transparent = 0;
    for (let i = 0; i < total; i++) {
      if (data[i * 4 + 3] < alphaCutoff) {
        transparent++;
        if (transparent > stopAt) break;
      }
    }
    return transparent / total;
  }

  destroy() {
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.ctx = null;
  }
}
