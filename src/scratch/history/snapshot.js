// 撤销快照离屏 canvas（本轮新增的第二类离屏 canvas，仅用于封面位图快照，
// 与 analysis/sampleCanvas.js 的采样面职责隔离，互不复用）。
// 不 import konva；canvas 工厂可注入，纯 DOM 辅助函数。

export function createSnapshotCanvas(sourceCanvas, createCanvas) {
  const factory =
    createCanvas ||
    (() => {
      if (typeof document === 'undefined') {
        throw new Error('snapshot: no createCanvas factory and no document');
      }
      return document.createElement('canvas');
    });
  const snap = factory();
  snap.width = sourceCanvas.width;
  snap.height = sourceCanvas.height;
  snap.getContext('2d').drawImage(sourceCanvas, 0, 0);
  return snap;
}

// 把快照写回封面位图。targetCtx 为 Konva scene canvas 的 2d context
// （已带 pixelRatio 变换），故按逻辑坐标清除并绘制。
export function applySnapshot(targetCanvas, snapshot, logicalWidth, logicalHeight) {
  const ctx = targetCanvas.getContext('2d');
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, logicalWidth, logicalHeight);
  ctx.drawImage(snapshot, 0, 0, logicalWidth, logicalHeight);
  ctx.restore();
}

// 释放快照位图（宽高归零，供 GC 回收）
export function releaseSnapshot(snapshot) {
  if (!snapshot) return;
  snapshot.width = 0;
  snapshot.height = 0;
}
