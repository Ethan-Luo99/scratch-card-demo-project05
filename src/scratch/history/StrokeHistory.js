// 撤销/重做历史（G1/G2）：路线选型为"笔划脏矩形位图快照栈"。
//
// 选型理由：
//  - 纯逆操作重放在 destination-out 持久位图上不可逆（无法补回已擦像素），
//    且软刷半透明边缘按同参数重放存在抗锯齿不确定性；
//  - 全尺寸快照栈像素精确但单帧内存 = 封面物理像素×4（800×500@2 即 3.2MB/帧）；
//  - 本方案在每次合帧"打洞之前"仅裁剪笔刷包围盒（含半径外扩、按物理像素对齐）
//    的小块位图，撤销时按捕获逆序 source-over 回贴，像素精确且内存有界；
//    redo 不另存快照，而是把同一笔划的全部段经同一条 scratchSegments 路径重放
//    （deterministic），重放后再捕获一份新快照压入 undo 栈。
//
// 离屏 canvas 归属：这里的快照 canvas 是"渲染资产"（用于回贴封面位图），
// 与 analysis/SampleGrid 的采样面职责互斥，二者永不互相复用。
//
// 快照 canvas 生命周期：captureFrame 时新建并随 frame/entry 持有；
// entry 被淘汰（超 undoLimit）、被弹出（redo 重录后）、reset/rebuild/destroy
// 清栈时经 releaseCrop 立即置 0×0 释放。

export class StrokeHistory {
  constructor({
    limit = 20,
    enabled = true,
    captureCrop, // (bboxLogical) => crop（由 CoverLayer 提供）
    scratchSegments, // (segments, brush) => void（与真实刮涂同一渲染路径）
    pasteCrops, // (crops[]) => void（逆序快照回贴，单次 layer.draw）
    releaseCrop, // (crop) => void（释放快照 canvas）
  }) {
    this.limit = Math.max(0, limit | 0);
    this.enabled = enabled;
    this._captureCrop = captureCrop;
    this._scratchSegments = scratchSegments;
    this._pasteCrops = pasteCrops;
    this._releaseCrop = releaseCrop;
    this._undo = [];
    this._redo = [];
    this._active = null; // 进行中的笔划会话（多指共享：首按下到末抬起）
  }

  get canUndo() {
    return this._undo.length > 0;
  }

  get canRedo() {
    return this._redo.length > 0;
  }

  get depth() {
    return this._undo.length;
  }

  get active() {
    return this._active !== null;
  }

  // 一次刮涂会话开始（pointerdown 且此前无活动指针）
  beginSession() {
    if (!this.enabled) return;
    this._active = { frames: [] };
  }

  // 每次 rAF 合帧打洞前调用：segments 为本帧全部扁平点列，radius 为笔刷逻辑半径
  captureFrame(segments, radius) {
    if (!this.enabled || !this._active || !segments || segments.length === 0) return;
    const bbox = inflateBBox(segments, radius);
    const crop = this._captureCrop(bbox);
    if (!crop) return;
    this._active.frames.push({
      crop,
      bbox,
      segments: segments.map((s) => s.slice()),
    });
  }

  // 笔划会话正常结束（末指针抬起）：入 undo 栈并清空 redo 栈
  commitSession() {
    if (!this.enabled || !this._active) return;
    const session = this._active;
    this._active = null;
    if (session.frames.length === 0) return;
    this.clearRedo(); // 有 redo 历史时录入新笔划：redo 栈在此清空
    this._undo.push(session);
    this._enforceLimit(this._undo);
  }

  // 会话废弃（reset/rebuild/destroy 进行中的刮涂）
  abortSession() {
    if (!this._active) return;
    const session = this._active;
    this._active = null;
    this._releaseEntry(session);
  }

  // 撤销：逐帧逆序 source-over 回贴快照，位图恢复到该笔划之前
  undo() {
    if (!this.canUndo || this._active) return false;
    const entry = this._undo.pop();
    const crops = [];
    for (let i = entry.frames.length - 1; i >= 0; i--) crops.push(entry.frames[i].crop);
    this._pasteCrops(crops); // 单次 layer.draw
    this._redo.push(entry);
    return true;
  }

  // 重做：同一 scratchSegments 渲染路径逐帧重放，重录一份新快照后压回 undo 栈
  redo(brush) {
    if (!this.canRedo || this._active) return false;
    const entry = this._redo.pop();
    const frames = [];
    for (const frame of entry.frames) {
      const crop = this._captureCrop(frame.bbox); // 与正常刮涂相同的捕获时机
      this._scratchSegments(frame.segments, brush);
      if (crop) frames.push({ crop, bbox: frame.bbox, segments: frame.segments });
    }
    this._undo.push({ frames });
    this._enforceLimit(this._undo);
    return true;
  }

  clearRedo() {
    while (this._redo.length) this._releaseEntry(this._redo.pop());
  }

  // reset() / DPR rebuild：历史栈整体失效
  clear() {
    this.abortSession();
    while (this._undo.length) this._releaseEntry(this._undo.pop());
    this.clearRedo();
  }

  destroy() {
    this.clear();
    this._undo = [];
    this._redo = [];
  }

  _releaseEntry(entry) {
    for (const frame of entry.frames) this._releaseCrop(frame.crop);
    entry.frames.length = 0;
  }

  _enforceLimit(stack) {
    // 内存上限策略：超过 undoLimit 淘汰最旧历史（FIFO）
    while (stack.length > this.limit) this._releaseEntry(stack.shift());
  }
}

// 合并本帧全部段的点列包围盒，按笔刷半径外扩，软刷圆章也被完整覆盖
export function inflateBBox(segments, radius) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const points of segments) {
    for (let i = 0; i + 1 < points.length; i += 2) {
      const x = points[i];
      const y = points[i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const pad = Math.max(1, radius + 1);
  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + pad * 2,
    height: maxY - minY + pad * 2,
  };
}
