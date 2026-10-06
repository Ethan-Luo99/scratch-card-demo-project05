// 封面层位图状态机（ADR-001 / 风险 6）：NEEDS_PAINT → PERSISTENT → DESTROYED。
// 不 import konva：layer 与封面节点工厂均由外部注入，测试用双桩记录调用序。
//
// init  : clearBeforeDraw(true) → 加封面节点 → draw()（清屏并绘膜）
//         → 移除封面节点 → clearBeforeDraw(false)（切持久态）
// scratch: 每帧 add 全部笔迹节点 → 单次 layer.draw()（不清屏打洞）→ remove 回池
// reset : 回到 NEEDS_PAINT 后重新 init（先清屏绘首帧再切持久态，单一入口）
//
// 撤销快照（G1/G2 增量）：captureCrop 从 scene canvas 按物理像素对齐裁剪小块位图
// 到独立离屏 canvas（渲染资产，与采样面 SampleGrid 永不复用）；pasteCrops 用
// Konva.Image（默认 source-over）add→draw→remove 回贴，仍走 Konva 体系。
// 严禁对任何节点调用 cache()，严禁在此改 Konva.pixelRatio。

export const CoverState = Object.freeze({
  NEEDS_PAINT: 'NEEDS_PAINT',
  PERSISTENT: 'PERSISTENT',
  DESTROYED: 'DESTROYED',
});

const IMAGE_POOL_LIMIT = 64;

export class CoverLayer {
  constructor({
    layer,
    eraser,
    createCoverNodes,
    createCanvas,
    createImage,
    getPixelRatio,
  }) {
    this.layer = layer;
    this.eraser = eraser;
    this.createCoverNodes = createCoverNodes;
    this._createCanvas =
      createCanvas ||
      (() => {
        if (typeof document === 'undefined') {
          throw new Error('CoverLayer: no createCanvas factory and no document');
        }
        return document.createElement('canvas');
      });
    // Konva.Image 工厂（生产注入）；裁剪回贴未启用时可缺省
    this._createImage = createImage || null;
    this._getPixelRatio =
      getPixelRatio ||
      ((() => {
        const canvas = layer && layer.getCanvas ? layer.getCanvas() : null;
        return () => (canvas && canvas.pixelRatio ? canvas.pixelRatio() : 1);
      })());
    this.state = CoverState.NEEDS_PAINT;
    this._coverNodes = [];
    this._imagePool = [];
  }

  init() {
    this._assertAlive();
    const layer = this.layer;
    layer.clearBeforeDraw(true);
    this._coverNodes = this.createCoverNodes() || [];
    for (const node of this._coverNodes) layer.add(node);
    layer.draw(); // 首帧：清屏 + 绘膜
    for (const node of this._coverNodes) node.remove();
    this._coverNodes = [];
    layer.clearBeforeDraw(false); // 之后不清屏，位图持久化
    this.state = CoverState.PERSISTENT;
  }

  // segments: 扁平点列数组；brush 透传给 Eraser。每帧至多一次 layer.draw()。
  scratchSegments(segments, brush) {
    if (this.state !== CoverState.PERSISTENT || segments.length === 0) return;
    const layer = this.layer;
    const nodes = [];
    for (const points of segments) {
      if (points && points.length >= 2) {
        nodes.push(...this.eraser.acquireSegmentNodes(points, brush));
      }
    }
    if (nodes.length === 0) return;
    for (const node of nodes) layer.add(node);
    layer.draw(); // 不清屏，destination-out 在持久位图上打洞
    for (const node of nodes) node.remove();
    this.eraser.release(nodes);
  }

  // ---- 撤销快照（G2 脏矩形位图路线）----

  // 按逻辑坐标 bbox 从持久位图裁剪一块快照（物理像素对齐，避免亚像素取整误差）。
  // 返回 { canvas, x, y, width, height }（逻辑坐标 + 裁剪源 canvas）；越界自动夹取。
  captureCrop(bbox) {
    if (this.state !== CoverState.PERSISTENT) return null;
    const ratio = this._getPixelRatio() || 1;
    const sceneCanvas = this.layer.getCanvas();
    const src = sceneCanvas._canvas;
    // Konva.Canvas 的物理像素尺寸（Canvas.js:96 _bitmapSize）
    const srcW = sceneCanvas.width;
    const srcH = sceneCanvas.height;

    const sx = Math.max(0, Math.floor(bbox.x * ratio));
    const sy = Math.max(0, Math.floor(bbox.y * ratio));
    const right = Math.min(srcW, Math.ceil((bbox.x + bbox.width) * ratio));
    const bottom = Math.min(srcH, Math.ceil((bbox.y + bbox.height) * ratio));
    const w = right - sx;
    const h = bottom - sy;
    if (w <= 0 || h <= 0) return null;

    const canvas = this._createCanvas();
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(src, sx, sy, w, h, 0, 0, w, h);
    return {
      canvas,
      x: sx / ratio,
      y: sy / ratio,
      width: w / ratio,
      height: h / ratio,
    };
  }

  // 逆序回贴一批快照：add 全部 Konva.Image → 单次 draw → remove 回池。
  // 默认 source-over：后加入的节点后绘制，crops 已按"最新帧在前"传入。
  pasteCrops(crops) {
    if (this.state !== CoverState.PERSISTENT || !this._createImage || crops.length === 0) {
      return;
    }
    const layer = this.layer;
    const nodes = [];
    for (const crop of crops) {
      if (!crop) continue;
      const image = this._imagePool.pop() || this._createImage();
      image.setAttrs({
        image: crop.canvas,
        x: crop.x,
        y: crop.y,
        width: crop.width,
        height: crop.height,
        listening: false,
        opacity: 1,
        globalCompositeOperation: 'source-over',
      });
      nodes.push(image);
    }
    if (nodes.length === 0) return;
    for (const node of nodes) layer.add(node);
    layer.draw(); // 不清屏：在持久位图上回贴快照
    for (const node of nodes) node.remove();
    this._releaseImages(nodes);
  }

  // 快照 canvas 释放（历史淘汰/清栈时调用）
  releaseCropCanvas(crop) {
    if (!crop || !crop.canvas) return;
    crop.canvas.width = 0;
    crop.canvas.height = 0;
    crop.canvas = null;
  }

  // reveal 完成后清空位图（清屏一次再切回持久态，保持状态机一致）
  clearBitmap() {
    if (this.state !== CoverState.PERSISTENT) return;
    const layer = this.layer;
    layer.clearBeforeDraw(true);
    layer.draw();
    layer.clearBeforeDraw(false);
  }

  reset() {
    this._assertAlive();
    this.state = CoverState.NEEDS_PAINT;
    this.init();
  }

  destroy() {
    this.state = CoverState.DESTROYED;
    this._coverNodes = [];
    this._imagePool.length = 0;
  }

  _releaseImages(nodes) {
    for (const node of nodes) {
      if (this._imagePool.length < IMAGE_POOL_LIMIT) this._imagePool.push(node);
    }
  }

  _assertAlive() {
    if (this.state === CoverState.DESTROYED) {
      throw new Error('CoverLayer is destroyed');
    }
  }
}
