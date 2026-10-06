// 撤销/重做历史栈（纯逻辑，不 import konva、不触碰 DOM）。
// 混合路线：undo 条目持有「笔划前快照 + 笔划段列 + 笔刷参数」；
// undo 恢复快照后把段列移交 redo 栈（redo 重放段列，不再持快照，内存减半）。
// limit 超限淘汰最旧 undo 条目；onRelease 负责释放快照位图。

export class HistoryStack {
  constructor({ limit = 10, onRelease } = {}) {
    this.limit = Math.max(0, limit);
    this._onRelease = onRelease || (() => {});
    this._undo = [];
    this._redo = [];
  }

  get canUndo() {
    return this._undo.length > 0;
  }

  get canRedo() {
    return this._redo.length > 0;
  }

  pushUndo(entry) {
    if (this.limit === 0) {
      this._onRelease(entry);
      return;
    }
    this._undo.push(entry);
    while (this._undo.length > this.limit) {
      this._onRelease(this._undo.shift()); // 淘汰最旧
    }
  }

  popUndo() {
    return this._undo.pop() || null;
  }

  pushRedo(entry) {
    this._redo.push(entry);
  }

  popRedo() {
    return this._redo.pop() || null;
  }

  // 录入新笔划时清空 redo 栈
  clearRedo() {
    for (const entry of this._redo) this._onRelease(entry);
    this._redo = [];
  }

  forEachUndo(cb) {
    for (const entry of this._undo) cb(entry);
  }

  clear() {
    for (const entry of this._undo) this._onRelease(entry);
    this._undo = [];
    this.clearRedo();
  }
}
