// 封面层位图状态机（ADR-001 / 风险 6）：NEEDS_PAINT → PERSISTENT → DESTROYED。
// 不 import konva：layer 与封面节点工厂均由外部注入，测试用双桩记录调用序。
//
// init  : clearBeforeDraw(true) → 加封面节点 → draw()（清屏并绘膜）
//         → 移除封面节点 → clearBeforeDraw(false)（切持久态）
// scratch: 每帧 add 全部笔迹节点 → 单次 layer.draw()（不清屏打洞）→ remove 回池
// reset : 回到 NEEDS_PAINT 后重新 init（先清屏绘首帧再切持久态，单一入口）

export const CoverState = Object.freeze({
  NEEDS_PAINT: 'NEEDS_PAINT',
  PERSISTENT: 'PERSISTENT',
  DESTROYED: 'DESTROYED',
});

export class CoverLayer {
  constructor({ layer, eraser, createCoverNodes }) {
    this.layer = layer;
    this.eraser = eraser;
    this.createCoverNodes = createCoverNodes;
    this.state = CoverState.NEEDS_PAINT;
    this._coverNodes = [];
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
  }

  _assertAlive() {
    if (this.state === CoverState.DESTROYED) {
      throw new Error('CoverLayer is destroyed');
    }
  }
}
