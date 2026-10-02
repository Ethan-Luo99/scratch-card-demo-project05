// ScratchCard 门面类（DESIGN.md §3）：装配、状态机、事件总线、销毁契约。
// 状态机：idle → scratching → revealing → revealed；destroyed 为终态；reset() 回到 idle。
import Konva from 'konva';
import { EVENTS, STATES } from './core/events.js';
import { createStage } from './core/createStage.js';
import { resolvePixelRatio, watchPixelRatio, debounce } from './core/pixelRatio.js';
import { computeCssScale, toLogicalPoint } from './input/geometry.js';
import { PointerTracker } from './input/coalesce.js';
import { PointerController } from './input/PointerController.js';
import { Eraser } from './cover/Eraser.js';
import { CoverLayer } from './cover/CoverLayer.js';
import { SampleGrid } from './analysis/sampleCanvas.js';
import { StrokeEstimator } from './analysis/strokeEstimator.js';
import { ProgressAnalyzer } from './analysis/ProgressAnalyzer.js';
import { runReveal } from './reveal/reveal.js';

const DEFAULTS = {
  brush: { radius: 22, shape: 'round', hardness: 1 },
  targetRatio: 0.5,
  pixelRatioCap: 2,
  sampling: { width: 200, height: 125, intervalMs: 120, alphaCutoff: 16 },
  reveal: { durationMs: 260 },
  touchAction: 'none',
  autoReveal: true,
  enabled: true,
};

let instanceSeq = 0;

export class ScratchCard {
  constructor(container, config = {}) {
    if (!container) throw new Error('ScratchCard: container is required');
    this.container = container;
    this.config = {
      ...DEFAULTS,
      ...config,
      brush: { ...DEFAULTS.brush, ...(config.brush || {}) },
      sampling: { ...DEFAULTS.sampling, ...(config.sampling || {}) },
      reveal: { ...DEFAULTS.reveal, ...(config.reveal || {}) },
    };
    this.state = STATES.IDLE;
    this._listeners = new Map();
    this._initialized = false;
    this._destroyed = false;
    this._revealEmitted = false;
    this._revealHandle = null;
    this._pendingSegments = [];
    this._rafId = null;
    this._useEstimator = false;
    this._pendingReveal = null;
    this._coverToken = 0;
    this._imageCache = null;
    this._seq = instanceSeq++;

    if (this._hasSize()) {
      this._init();
    } else if (typeof ResizeObserver !== 'undefined') {
      // 零尺寸容器（风险 10）：延迟到首次获得非零尺寸再建 Stage
      this._resizeObserver = new ResizeObserver(() => {
        if (this._destroyed) return;
        if (this._hasSize()) {
          this._resizeObserver.disconnect();
          this._resizeObserver = null;
          this._init();
        }
      });
      this._resizeObserver.observe(container);
    } else {
      this._init();
    }
  }

  // ---------- 事件总线 ----------
  on(event, cb) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(cb);
    return this;
  }

  off(event, cb) {
    const set = this._listeners.get(event);
    if (set) set.delete(cb);
    return this;
  }

  _emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) cb(payload);
  }

  _hasSize() {
    return this.container.clientWidth > 0 && this.container.clientHeight > 0;
  }

  // ---------- 初始化 ----------
  _init() {
    if (this._initialized || this._destroyed) return;
    this._initialized = true;
    const cfg = this.config;

    this._pixelRatio = resolvePixelRatio(cfg.pixelRatioCap);
    const { stage, prizeLayer, coverLayer } = createStage(this.container, {
      width: cfg.width,
      height: cfg.height,
      pixelRatio: this._pixelRatio,
      touchAction: cfg.touchAction,
    });
    this._stage = stage;
    this._prizeLayer = prizeLayer;
    this._coverLayerRaw = coverLayer;

    // 奖品层：业务工厂注入节点，hit graph 全程可命中（ADR-004）
    if (cfg.prize && typeof cfg.prize.factory === 'function') {
      const nodes = cfg.prize.factory(prizeLayer) || [];
      for (const node of nodes) prizeLayer.add(node);
      prizeLayer.draw();
    }

    // 橡皮对象池（硬刷 Line / 软刷渐变圆章，均禁 cache、禁 isolated）
    this._eraser = new Eraser({
      createLine: () => new Konva.Line(),
      createCircle: () => new Konva.Circle(),
    });

    this._cover = new CoverLayer({
      layer: coverLayer,
      eraser: this._eraser,
      createCoverNodes: () => this._coverNodesFactory(),
    });

    this._tracker = new PointerTracker({ brushRadius: cfg.brush.radius });

    // 面积统计：离屏降采样 + 时间节流 + 连续两次确认（ADR-002）
    this._sampleGrid = new SampleGrid({
      width: cfg.sampling.width,
      height: cfg.sampling.height,
      alphaCutoff: cfg.sampling.alphaCutoff,
      targetRatio: cfg.targetRatio,
    });
    this._estimator = new StrokeEstimator({
      width: cfg.sampling.width,
      height: cfg.sampling.height,
      logicalWidth: cfg.width,
      logicalHeight: cfg.height,
    });
    this._analyzer = new ProgressAnalyzer({
      sample: () => this._sampleRatio(),
      intervalMs: cfg.sampling.intervalMs,
      targetRatio: cfg.targetRatio,
      confirmations: 2,
      jitterMs: this._seq * 7, // 多卡错峰（R6）
      onProgress: (p) => this._emit(EVENTS.PROGRESS, p),
      onReach: ({ ratio }) => {
        if (this.config.autoReveal) this._startReveal(false);
      },
    });

    // 输入层：原生 Pointer Events 挂 stage.content（ADR-003）
    this._pointer = new PointerController({
      target: stage.content,
      touchAction: cfg.touchAction,
      onDown: (p) => this._onPointerDown(p),
      onMove: (p) => this._onPointerMove(p),
      onUp: (p) => this._onPointerUp(p),
    });

    // DPR 运行时变化（风险 4）：matchMedia + 去抖 200ms → 重建封面并广播 reset
    this._unwatchDpr = watchPixelRatio(globalThis.window, debounce(() => this._rebuild(), 200));

    if (cfg.enabled === false) {
      // enabled:false → 直接呈现奖品并禁用输入；不绘封面
      this._pointer.setEnabled(false);
      this.state = STATES.REVEALED;
      this._revealEmitted = true;
      queueMicrotask(() => this._emit(EVENTS.REVEAL, { ratio: 1 }));
    } else {
      // 封面准备（image 类型为异步加载）
      this._prepareCover();
    }

    // 初始化前调用的 reveal() 在此兑现
    if (this._pendingReveal) {
      const instant = this._pendingReveal === 'instant';
      this._pendingReveal = null;
      this._startReveal(instant);
    }
  }

  // ---------- 封面 ----------
  _prepareCover() {
    const cfg = this.config;
    const cover = cfg.cover || { type: 'color', value: '#b8860b' };
    const token = ++this._coverToken;
    if (cover.type === 'image') {
      const img = new Image();
      img.crossOrigin = 'anonymous'; // 风险 9：争取 CORS，失败则采样降级
      img.onload = () => {
        if (this._destroyed || token !== this._coverToken) return;
        this._imageCache = img;
        if (this.state === STATES.IDLE) this._cover.init();
      };
      img.onerror = () => {
        if (this._destroyed || token !== this._coverToken) return;
        // 图片加载失败：退回纯色封面，保证卡片可用
        this.config.cover = { type: 'color', value: '#b8860b' };
        if (this.state === STATES.IDLE) this._cover.init();
      };
      img.src = cover.src;
    } else {
      if (this.state === STATES.IDLE) this._cover.init();
    }
  }

  _coverNodesFactory() {
    const cfg = this.config;
    const cover = cfg.cover || { type: 'color', value: '#b8860b' };
    if (cover.type === 'image' && this._imageCache) {
      return [
        new Konva.Image({
          image: this._imageCache,
          x: 0,
          y: 0,
          width: cfg.width,
          height: cfg.height,
          listening: false,
        }),
      ];
    }
    if (cover.type === 'nodes' && typeof cover.factory === 'function') {
      return cover.factory(this._coverLayerRaw) || [];
    }
    return [
      new Konva.Rect({
        x: 0,
        y: 0,
        width: cfg.width,
        height: cfg.height,
        fill: cover.value || '#b8860b',
        listening: false,
      }),
    ];
  }

  // ---------- 采样 ----------
  _sampleRatio() {
    if (this._useEstimator) return this._estimator.ratio();
    try {
      return this._sampleGrid.sample(this._coverLayerRaw.getCanvas()._canvas);
    } catch (err) {
      // 风险 9：跨域 taint → 降级为笔画几何估算，并派发 progress-error（每生命周期一次）
      this._useEstimator = true;
      this._emit(EVENTS.PROGRESS_ERROR, { error: err });
      return this._estimator.ratio();
    }
  }

  // ---------- 指针输入 ----------
  _toLogical(clientX, clientY) {
    const content = this._stage.content;
    const rect = content.getBoundingClientRect();
    const cssScale = computeCssScale(rect, content.clientWidth, content.clientHeight);
    return toLogicalPoint(clientX, clientY, rect, cssScale);
  }

  _onPointerDown(p) {
    if (this.state !== STATES.IDLE && this.state !== STATES.SCRATCHING) return;
    const { x, y } = this._toLogical(p.clientX, p.clientY);
    this._tracker.down(p.pointerId, x, y);
    this.state = STATES.SCRATCHING;
    // 单点也打一个洞：重复端点使 round 线帽渲染出圆点（仅 moveTo 不会绘制）
    this._pendingSegments.push([x, y, x, y]);
    this._scheduleFlush();
    this._emit(EVENTS.SCRATCH_START, { pointerId: p.pointerId, x, y });
  }

  _onPointerMove(p) {
    if (this.state !== STATES.SCRATCHING) return;
    const { x, y } = this._toLogical(p.clientX, p.clientY);
    const segment = this._tracker.move(p.pointerId, x, y);
    if (!segment) return; // 未知 pointerId：防串轨
    this._pendingSegments.push(segment);
    if (this._useEstimator) {
      this._estimator.stampPoints(segment, this.config.brush.radius);
    }
    this._scheduleFlush();
    this._analyzer.notifyActivity();
    this._emit(EVENTS.SCRATCH_MOVE, {
      pointerId: p.pointerId,
      x,
      y,
      progress: this.getProgress(),
    });
  }

  _onPointerUp(p) {
    if (!this._tracker.has(p.pointerId)) return;
    this._tracker.up(p.pointerId);
    this._flushSegments(); // 尾段立即落图，不等下一帧
    this._analyzer.forceSample(); // pointerup 强制补采（收口）
    this._emit(EVENTS.SCRATCH_END, { pointerId: p.pointerId, progress: this.getProgress() });
    if (this._tracker.size() === 0 && this.state === STATES.SCRATCHING) {
      this.state = STATES.IDLE;
    }
  }

  // ---------- 帧合并渲染（R5/R14：每帧至多一次 layer.draw()） ----------
  _scheduleFlush() {
    if (this._rafId !== null) return;
    const win = globalThis.window;
    this._rafId = win.requestAnimationFrame(() => {
      this._rafId = null;
      this._flushSegments();
    });
  }

  _flushSegments() {
    if (this._pendingSegments.length === 0) return;
    const segments = this._pendingSegments;
    this._pendingSegments = [];
    if (this.state !== STATES.SCRATCHING && this.state !== STATES.IDLE) return;
    this._cover.scratchSegments(segments, this.config.brush);
  }

  // ---------- reveal ----------
  _startReveal(instant) {
    if (this._destroyed) return;
    if (this.state === STATES.REVEALING || this.state === STATES.REVEALED) return;
    if (!this._initialized) {
      this._pendingReveal = instant ? 'instant' : 'deferred';
      return;
    }
    this.state = STATES.REVEALING;
    this._pointer.setEnabled(false);
    this._pendingSegments = [];
    this._tracker.clear();
    const canvasEl = this._coverLayerRaw.getCanvas()._canvas;
    const durationMs = this.config.reveal.durationMs;
    const doc = globalThis.document;
    this._revealHandle = runReveal({
      setOpacity: (value, withTransition) => {
        canvasEl.style.transition = withTransition ? `opacity ${durationMs}ms ease` : '';
        canvasEl.style.opacity = String(value);
      },
      clear: () => this._cover.clearBitmap(),
      durationMs,
      instant,
      env: {
        isHidden: () => !!doc && doc.visibilityState === 'hidden',
        onVisibilityChange: (cb) => {
          if (!doc) return () => {};
          doc.addEventListener('visibilitychange', cb);
          return () => doc.removeEventListener('visibilitychange', cb);
        },
        onTransitionEnd: (cb) => {
          const handler = (e) => {
            if (e.propertyName === 'opacity') cb();
          };
          canvasEl.addEventListener('transitionend', handler);
          return () => canvasEl.removeEventListener('transitionend', handler);
        },
      },
      onDone: () => {
        this.state = STATES.REVEALED;
        this._emitRevealOnce();
      },
    });
  }

  _emitRevealOnce() {
    if (this._revealEmitted) return;
    this._revealEmitted = true;
    this._emit(EVENTS.REVEAL, { ratio: this.getProgress() });
  }

  // ---------- DPR 重建（风险 4） ----------
  _rebuild() {
    if (this._destroyed || !this._initialized) return;
    const next = resolvePixelRatio(this.config.pixelRatioCap);
    if (next === this._pixelRatio) return;
    this._pixelRatio = next;
    // setPixelRatio → setSize 重分配位图并重置 context（Canvas.js:113-119），封面被清空
    this._prizeLayer.getCanvas().setPixelRatio(next);
    this._coverLayerRaw.getCanvas().setPixelRatio(next);
    this._prizeLayer.draw();
    if (this.state === STATES.REVEALING || this.state === STATES.REVEALED) {
      // 已揭示的卡片不重新覆盖封面，仅保持位图清空
      this._cover.clearBitmap();
      return;
    }
    this._tracker.clear();
    this._analyzer.reset();
    this._estimator.reset();
    this.state = STATES.IDLE;
    this._cover.reset(); // NEEDS_PAINT → 重绘全新封面
    this._emit(EVENTS.RESET, { reason: 'dpr-change' });
  }

  // ---------- 公共 API ----------
  getProgress() {
    return this._analyzer ? this._analyzer.ratio : 0;
  }

  reveal(instant = false) {
    this._startReveal(instant);
  }

  // 回到全新封面；可选传入新 cover 配置
  reset(newCover) {
    if (this._destroyed) return;
    if (newCover) this.config.cover = newCover;
    if (this._revealHandle) {
      this._revealHandle.cancel();
      this._revealHandle = null;
    }
    if (!this._initialized) return;
    const canvasEl = this._coverLayerRaw.getCanvas()._canvas;
    canvasEl.style.transition = '';
    canvasEl.style.opacity = '1';
    this._tracker.clear();
    this._pendingSegments = [];
    this._analyzer.reset();
    this._estimator.reset();
    this._useEstimator = false;
    this._revealEmitted = false;
    this.state = STATES.IDLE;
    this._pointer.setEnabled(true);
    if (newCover && newCover.type === 'image') {
      this._imageCache = null;
      this._prepareCover(); // 异步加载完成后 init
    } else {
      this._cover.reset();
    }
    this._emit(EVENTS.RESET, { reason: 'manual' });
  }

  setEnabled(flag) {
    if (this._destroyed || !this._initialized) return;
    this._pointer.setEnabled(flag);
  }

  getStage() {
    return this._stage || null;
  }

  // 幂等销毁：移除全部原生监听、释放 capture、取消 rAF/定时器、解绑媒体查询
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.state = STATES.DESTROYED;
    this._coverToken++; // 使进行中的图片加载回调失效
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this._rafId !== null) {
      globalThis.window.cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this._revealHandle) {
      this._revealHandle.cancel();
      this._revealHandle = null;
    }
    if (this._unwatchDpr) this._unwatchDpr();
    if (this._pointer) this._pointer.destroy();
    if (this._analyzer) this._analyzer.destroy();
    if (this._sampleGrid) this._sampleGrid.destroy();
    if (this._cover) this._cover.destroy();
    if (this._stage) this._stage.destroy(); // 移除 content DOM、释放 canvas（Stage.js:226-238）
    this._pendingSegments = [];
    this._emit(EVENTS.DESTROYED, {});
    this._listeners.clear();
  }
}
