// 节流采样 + 阈值判定（ADR-002 / R2 / 风险清单 8、9）。
// 全部环境能力（时钟、采样器）经构造参数注入，不 import konva。
export class ProgressAnalyzer {
  constructor({
    sampler,
    targetRatio = 0.5,
    intervalMs = 120,
    now = () => Date.now(),
    estimate = null,
    onProgress,
    onReach,
    onError,
  }) {
    this._sampler = sampler;
    this._targetRatio = targetRatio;
    this._intervalMs = intervalMs;
    this._now = now;
    this._estimate = estimate;
    this._onProgress = onProgress;
    this._onReach = onReach;
    this._onError = onError;

    this._lastSampleAt = -Infinity;
    this._confirmations = 0;
    this._tainted = false;
    this._errorEmitted = false;
    this._done = false;
    this._ratio = 0;
  }

  get ratio() {
    return this._ratio;
  }

  get done() {
    return this._done;
  }

  notifyStroke(length) {
    if (this._done) return;
    if (this._estimate) this._estimate.addStroke(length);
    if (this._tainted) this._sample(this._now());
  }

  notifyActivity() {
    if (this._done || this._tainted) return;
    const t = this._now();
    const nearTarget = this._ratio >= this._targetRatio - 0.05;
    const interval = nearTarget ? this._intervalMs / 2 : this._intervalMs;
    if (t - this._lastSampleAt >= interval) {
      this._sample(t);
    }
  }

  notifyPointerUp() {
    if (this._done) return;
    this._sample(this._now());
  }

  _sample(t) {
    this._lastSampleAt = t;
    let ratio;
    if (this._tainted) {
      ratio = this._estimate ? this._estimate.ratio() : 0;
    } else {
      try {
        ratio = this._sampler();
      } catch (error) {
        this._tainted = true;
        if (!this._errorEmitted) {
          this._errorEmitted = true;
          if (this._onError) this._onError(error);
        }
        ratio = this._estimate ? this._estimate.ratio() : 0;
      }
    }
    this._ratio = ratio;
    if (ratio >= this._targetRatio) this._confirmations += 1;
    else this._confirmations = 0;
    if (this._onProgress) this._onProgress({ ratio, sampledAt: t });
    if (this._confirmations >= 2 && !this._done) {
      this._done = true;
      if (this._onReach) this._onReach(ratio);
    }
  }

  reset() {
    this._lastSampleAt = -Infinity;
    this._confirmations = 0;
    this._done = false;
    this._ratio = 0;
    if (this._estimate) this._estimate.reset();
  }

  destroy() {
    this._done = true;
    this._sampler = null;
    this._estimate = null;
  }
}

// 跨域 taint 降级：笔画几何面积估算（风险清单 9）。
export function createStrokeEstimate({ brushRadius, area }) {
  let covered = 0;
  return {
    addStroke(length) {
      covered += length * brushRadius * 2 + Math.PI * brushRadius * brushRadius;
    },
    ratio() {
      return Math.min(1, covered / area);
    },
    reset() {
      covered = 0;
    },
  };
}
