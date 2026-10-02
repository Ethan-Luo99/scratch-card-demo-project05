// 唯一允许的离屏 canvas 用途：像素分析（ADR-002）。
export class SampleGrid {
  constructor({ width = 200, height = 125, alphaCutoff = 16, createCanvas }) {
    this.width = width;
    this.height = height;
    this.alphaCutoff = alphaCutoff;
    this.canvas = createCanvas(width, height);
    this.ctx = this.canvas.getContext('2d');
  }

  sampleRatio(sourceCanvas, stopAtCount = Infinity) {
    const { width, height, alphaCutoff, ctx } = this;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(sourceCanvas, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    const data = image.data;
    const total = width * height;
    let cleared = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < alphaCutoff) {
        cleared += 1;
        if (cleared >= stopAtCount) break;
      }
    }
    return cleared / total;
  }
}
