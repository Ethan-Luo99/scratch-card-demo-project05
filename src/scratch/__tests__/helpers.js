// 手写最小 canvas/context stub（DESIGN.md §三.2）：记录调用序列，
// 用可程序化挖洞的 alpha 网格模拟 drawImage 降采样与 getImageData。
export function createCanvasStub(width, height) {
  const alpha = new Uint8Array(width * height).fill(255);
  const canvas = {
    width,
    height,
    _alpha: alpha,
    getContext: () => ctx,
  };
  const ctx = {
    canvas,
    calls: [],
    save() { this.calls.push('save'); },
    restore() { this.calls.push('restore'); },
    scale() {}, translate() {}, transform() {}, setTransform() {},
    clear() {}, clearRect() {},
    beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {},
    strokeShape() {},
    // 最近邻降采样：把源 alpha 网格写入自身缓冲，计数结果可精确预期
    drawImage(src, dx, dy, dw, dh) {
      this.calls.push('drawImage');
      for (let y = 0; y < dh; y++) {
        for (let x = 0; x < dw; x++) {
          const sx = Math.min(src.width - 1, Math.floor((x * src.width) / dw));
          const sy = Math.min(src.height - 1, Math.floor((y * src.height) / dh));
          alpha[y * width + x] = src._alpha[sy * src.width + sx];
        }
      }
    },
    getImageData(x, y, w, h) {
      this.calls.push('getImageData');
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        const px = x + (i % w);
        const py = y + Math.floor(i / w);
        data[i * 4 + 3] = alpha[py * width + px];
      }
      return { data, width: w, height: h };
    },
  };
  return { canvas, ctx, alpha };
}

// 挖一个矩形洞（alpha=0）
export function punchHole(alpha, gridW, x, y, w, h) {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      alpha[py * gridW + px] = 0;
    }
  }
}
