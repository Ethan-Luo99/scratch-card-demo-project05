// 位图状态机（ADR-001 / 风险清单 6）：
//   NEEDS_PAINT → clearBeforeDraw(true) 绘膜 → 移除封面节点 → clearBeforeDraw(false) → PERSISTENT
//   PERSISTENT  → 每帧一批橡皮节点 add → 一次 layer.draw() → remove 回池
//   DESTROYED   → 终态
// 禁用项：封面/橡皮节点严禁 cache()（Q3），严禁 isolated Group（ADR-001 备选 B）。
export const CoverState = Object.freeze({
  NEEDS_PAINT: 'NEEDS_PAINT',
  PERSISTENT: 'PERSISTENT',
  DESTROYED: 'DESTROYED',
});

export class CoverLayer {
  constructor({ layer, eraser, buildCoverNodes }) {
    this._layer = layer;
    this._eraser = eraser;
    this._buildCoverNodes = buildCoverNodes;
    this.state = CoverState.NEEDS_PAINT;
  }

  _resetComposite() {
    // Konva 的 _applyGlobalCompositeOperation 只在非默认值时写入、从不复位
    // （Context.js:647-653），橡皮绘制后必须显式把 layer context 复位，
    // 否则 reset 重绘封面时会以 destination-out 落笔。
    const context = this._layer.getContext && this._layer.getContext();
    if (context && typeof context.setAttr === 'function') {
      context.setAttr('globalCompositeOperation', 'source-over');
    }
  }

  async init() {
    this._assertAlive();
    this.state = CoverState.NEEDS_PAINT;
    this._layer.clearBeforeDraw(true);
    this._resetComposite();
    const nodes = (await this._buildCoverNodes(this._layer)) || [];
    if (this.state === CoverState.DESTROYED) return;
    for (const node of nodes) this._layer.add(node);
    this._layer.draw();
    for (const node of nodes) {
      node.remove();
      if (typeof node.destroy === 'function') node.destroy();
    }
    this._layer.clearBeforeDraw(false);
    this.state = CoverState.PERSISTENT;
  }

  scratch(segments) {
    if (this.state !== CoverState.PERSISTENT || !segments.length) return;
    const nodes = [];
    for (const segment of segments) {
      for (const node of this._eraser.acquireSegment(segment)) {
        this._layer.add(node);
        nodes.push(node);
      }
    }
    this._layer.draw();
    for (const node of nodes) node.remove();
    this._eraser.releaseSegment(nodes);
    this._resetComposite();
  }

  clear() {
    this._assertAlive();
    this._layer.clearBeforeDraw(true);
    this._resetComposite();
    this._layer.draw();
    this._layer.clearBeforeDraw(false);
  }

  async reset() {
    await this.init();
  }

  destroy() {
    if (this.state === CoverState.DESTROYED) return;
    this.state = CoverState.DESTROYED;
    this._eraser.destroy();
  }

  _assertAlive() {
    if (this.state === CoverState.DESTROYED) {
      throw new Error('CoverLayer is destroyed');
    }
  }
}
