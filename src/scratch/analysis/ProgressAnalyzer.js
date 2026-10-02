// ADR-002 / R2：时间节流采样 + 阈值连续两次确认 + pointerup 强制终采。
// 纯逻辑：sample/now 由构造注入，不 import konva、不触碰 DOM。

export class ProgressAnalyzer {
  constructor({
    sample, // () => ratio，可能抛错（taint）
    intervalMs = 120,
    targetRatio = 0.5,
    confirmations = 2,
    now = () => Date.now(),
    jitterMs = 0, // 多卡错峰：等价于把上次采样时刻往前拨
    onProgress, // ({ ratio, sampledAt })
    onReach, // ({ ratio }) 恰好一次
    onError, // (err) 采样抛错时
  }) {
    this.sampleFn = sample;
    this.intervalMs = intervalMs;
    this.targetRatio = targetRatio;
    this.confirmationsNeeded = confirmations;
    this.now = now;
    this.onProgress = onProgress;
    this.onReach = onReach;
    this.onError = onError;
    this.ratio = 0;
    this._lastSampleAt = -Infinity + jitterMs;
    this._confirmCount = 0;
    this._reached = false;
    this._failed = false;
    this._destroyed = false;
  }

  // 刮涂移动中调用：距上次采样 >= intervalMs 才采
  notifyActivity() {
    if (this._destroyed || this._reached || this._failed) return;
    const t = this.now();
    if (t - this._lastSampleAt < this.intervalMs) return;
    this._sample(t, false);
  }

  // pointerup 强制终采（收口）；强制采样一次即可确认达标
  forceSample() {
    if (this._destroyed || this._reached || this._failed) return;
    this._sample(this.now(), true);
  }

  _sample(t, forced) {
    this._lastSampleAt = t;
    let ratio;
    try {
      ratio = this.sampleFn();
    } catch (err) {
      this._failed = true;
      if (this.onError) this.onError(err);
      return;
    }
    this.ratio = ratio;
    if (this.onProgress) this.onProgress({ ratio, sampledAt: t });
    if (ratio >= this.targetRatio) {
      // 节流采样需连续 confirmations 次确认；pointerup 强制采样一次定音
      this._confirmCount = forced ? this.confirmationsNeeded : this._confirmCount + 1;
      if (this._confirmCount >= this.confirmationsNeeded) this._reach(ratio);
    } else {
      this._confirmCount = 0;
    }
  }

  _reach(ratio) {
    if (this._reached) return;
    this._reached = true;
    if (this.onReach) this.onReach({ ratio });
  }

  get reached() {
    return this._reached;
  }

  get failed() {
    return this._failed;
  }

  // 换采样函数（taint 降级为笔画估算时由 ScratchCard 调用）
  setSampleFn(fn) {
    this.sampleFn = fn;
    this._failed = false;
  }

  reset() {
    this.ratio = 0;
    this._lastSampleAt = -Infinity;
    this._confirmCount = 0;
    this._reached = false;
  }

  destroy() {
    this._destroyed = true;
  }
}
