// 最小 2D context stub：记录调用序列，用可程序化挖洞的 alpha 网格
// 模拟 drawImage 降采样（最近邻）与 getImageData。
export function createCtxStub(width, height) {
  const alpha = new Uint8Array(width * height).fill(255);
  const calls = [];
  const ctx = {
    _alpha: alpha,
    _w: width,
    _h: height,
    calls,
    canvas: null,
    save() { calls.push('save'); },
    restore() { calls.push('restore'); },
    scale() {},
    translate() {},
    transform() {},
    setTransform() {},
    clear() { alpha.fill(0); },
    clearRect(x, y, w, h) {
      for (let py = y; py < y + h; py += 1) {
        for (let px = x; px < x + w; px += 1) alpha[py * width + px] = 0;
      }
    },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    strokeShape() {},
    drawImage(source, dx, dy, dw, dh) {
      calls.push('drawImage');
      const sa = source._alpha;
      const sw = source._w;
      const sh = source._h;
      for (let y = 0; y < dh; y += 1) {
        for (let x = 0; x < dw; x += 1) {
          const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
          const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
          alpha[(dy + y) * width + (dx + x)] = sa[sy * sw + sx];
        }
      }
    },
    getImageData(x, y, w, h) {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i += 1) {
        const px = x + (i % w);
        const py = y + Math.floor(i / w);
        data[i * 4 + 3] = alpha[py * width + px];
      }
      return { data, width: w, height: h };
    },
    set globalCompositeOperation(v) { calls.push(['gco', v]); },
    get globalCompositeOperation() { return 'source-over'; },
  };
  return ctx;
}

export function createCanvasStub(width, height) {
  const ctx = createCtxStub(width, height);
  const canvas = {
    width,
    height,
    _w: width,
    _h: height,
    _alpha: ctx._alpha,
    _ctx: ctx,
    getContext() { return ctx; },
  };
  ctx.canvas = canvas;
  return canvas;
}

export function createFakeClock(start = 0) {
  const clock = {
    t: start,
    now() { return this.t; },
    advance(ms) { this.t += ms; },
  };
  return clock;
}
