import { createStage, applyPixelRatio, clampPixelRatio } from './core/createStage.js';
import { resolvePixelRatio, watchPixelRatioChange } from './core/pixelRatio.js';
import { Events, State } from './core/events.js';
import { toLogicalPoint } from './input/geometry.js';
import { buildSegments } from './input/coalesce.js';
import { PointerController } from './input/PointerController.js';
import { Eraser } from './cover/Eraser.js';
import { CoverLayer } from './cover/CoverLayer.js';
import { createEraserLineFactory, createEraserDabFactory } from './cover/konvaShapes.js';
import { createCoverNodeBuilder } from './cover/createCoverNodes.js';
import { SampleGrid } from './analysis/sampleCanvas.js';
import { ProgressAnalyzer, createStrokeEstimate } from './analysis/ProgressAnalyzer.js';
import { runReveal } from './reveal/reveal.js';

const DEFAULTS = {
  width: 300,
  height: 150,
  cover: { type: 'color', value: '#b8b8b8' },
  prize: null,
  brush: { radius: 22, shape: 'round', hardness: 1 },
  targetRatio: 0.5,
  pixelRatioCap: 2,
  sampling: { width: 200, height: 125, intervalMs: 120, alphaCutoff: 16 },
  reveal: { durationMs: 260 },
  touchAction: 'none',
  autoReveal: true,
  enabled: true,
};

function normalizeConfig(config) {
  const merged = { ...DEFAULTS, ...config };
  merged.brush = { ...DEFAULTS.brush, ...(config.brush || {}) };
  merged.sampling = { ...DEFAULTS.sampling, ...(config.sampling || {}) };
  merged.reveal = { ...DEFAULTS.reveal, ...(config.reveal || {}) };
  return merged;
}

export class ScratchCard {
  constructor(container, config = {}) {
    if (!container) throw new Error('ScratchCard requires a container element');
    this._container = container;
    this._config = normalizeConfig(config);
    this._state = State.IDLE;
    this._events = new Map();
    this._tracks = new Map();
    this._strokeQueue = [];
    this._rafId = 0;
    this._revealEmitted = false;
    this._cancelReveal = null;
    this._initialized = false;
    this._enabled = this._config.enabled !== false;

    if (container.clientWidth > 0 && container.clientHeight > 0) {
      this._init();
    } else {
      // 零尺寸容器（风险清单 10）：延迟到首次获得非零尺寸再建 Stage
      this._initObserver = new ResizeObserver(() => {
        if (container.clientWidth > 0 && container.clientHeight > 0) {
          this._initObserver.disconnect();
          this._initObserver = null;
          this._init();
        }
      });
      this._initObserver.observe(container);
    }
  }

  get state() {
    return this._state;
  }

  on(event, cb) {
    if (!this._events.has(event)) this._events.set(event, new Set());
    this._events.get(event).add(cb);
    return this;
  }

  off(event, cb) {
    const set = this._events.get(event);
    if (set) set.delete(cb);
    return this;
  }

  _emit(event, payload) {
    const set = this._events.get(event);
    if (!set) return;
    for (const cb of [...set]) cb(payload);
  }

  _init() {
    if (this._initialized || this._state === State.DESTROYED) return;
    const cfg = this._config;
    const { stage, prizeLayer, coverLayer } = createStage(this._container, cfg);
    this._stage = stage;
    this._prizeLayer = prizeLayer;
    this._coverLayerNative = coverLayer;

    if (cfg.prize && typeof cfg.prize.factory === 'function') {
      const nodes = cfg.prize.factory(prizeLayer) || [];
      for (const node of nodes) prizeLayer.add(node);
      prizeLayer.draw();
    }

    const brush = cfg.brush;
    this._eraser = new Eraser({
      brush,
      createLine: createEraserLineFactory(brush),
      createDab: createEraserDabFactory(brush),
    });
    this._cover = new CoverLayer({
      layer: coverLayer,
      eraser: this._eraser,
      buildCoverNodes: createCoverNodeBuilder(cfg.cover, cfg),
    });

    this._sampleGrid = new SampleGrid({
      ...cfg.sampling,
      createCanvas: (w, h) => {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        return canvas;
      },
    });
    this._analyzer = new ProgressAnalyzer({
      sampler: () => this._sampleGrid.sampleRatio(coverLayer.getCanvas()._canvas),
      targetRatio: cfg.targetRatio,
      intervalMs: cfg.sampling.intervalMs,
      estimate: createStrokeEstimate({ brushRadius: brush.radius, area: cfg.width * cfg.height }),
      onProgress: (payload) => this._emit(Events.PROGRESS, payload),
      onReach: () => {
        if (cfg.autoReveal) this.reveal();
      },
      onError: (error) => this._emit(Events.PROGRESS_ERROR, { error }),
    });

    this._pointer = new PointerController({
      target: stage.content,
      touchAction: cfg.touchAction,
      onStart: (pointerId, evt) => this._onPointerStart(pointerId, evt),
      onMove: (pointerId, points) => this._onPointerMove(pointerId, points),
      onEnd: (pointerId) => this._onPointerEnd(pointerId),
    });

    // DPR 运行时变化 + 容器 resize（风险清单 4）：去抖 200ms 统一 rebuild
    this._rebuildTimer = 0;
    const scheduleRebuild = () => {
      if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
      this._rebuildTimer = setTimeout(() => this._rebuild(), 200);
    };
    this._unwatchDpr = watchPixelRatioChange(scheduleRebuild);
    this._resizeObserver = new ResizeObserver(() => this._onContainerResize());
    this._resizeObserver.observe(this._container);

    this._initialized = true;
    this._pointer.setEnabled(this._enabled);
    this._lastContainerSize = { w: this._container.clientWidth, h: this._container.clientHeight };
    if (this._enabled) {
      this._cover.init();
    }
  }

  _onContainerResize() {
    const w = this._container.clientWidth;
    const h = this._container.clientHeight;
    if (this._lastContainerSize && w === this._lastContainerSize.w && h === this._lastContainerSize.h) {
      return;
    }
    this._lastContainerSize = { w, h };
    if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
    this._rebuildTimer = setTimeout(() => this._rebuild(), 200);
  }

  _contentMetrics() {
    const content = this._stage.content;
    return {
      rect: content.getBoundingClientRect(),
      size: { width: content.clientWidth, height: content.clientHeight },
    };
  }

  _onPointerStart(pointerId, evt) {
    if (this._state !== State.IDLE && this._state !== State.SCRATCHING) return;
    const { rect, size } = this._contentMetrics();
    const point = toLogicalPoint(evt.clientX, evt.clientY, rect, size);
    this._state = State.SCRATCHING;
    const { segments, last } = buildSegments(null, [point], this._config.brush.radius);
    this._tracks.set(pointerId, last);
    this._strokeQueue.push(...segments);
    this._emit(Events.SCRATCH_START, { pointerId, x: point.x, y: point.y });
    this._scheduleFlush();
  }

  _onPointerMove(pointerId, rawPoints) {
    if (this._state !== State.SCRATCHING) return;
    if (!this._tracks.has(pointerId)) return;
    const { rect, size } = this._contentMetrics();
    const points = rawPoints.map((p) => toLogicalPoint(p.clientX, p.clientY, rect, size));
    const { segments, last } = buildSegments(this._tracks.get(pointerId), points, this._config.brush.radius);
    this._tracks.set(pointerId, last);
    if (!segments.length) return;
    this._strokeQueue.push(...segments);
    let length = 0;
    for (const segment of segments) {
      for (let i = 1; i < segment.length; i += 1) {
        length += Math.hypot(segment[i].x - segment[i - 1].x, segment[i].y - segment[i - 1].y);
      }
    }
    this._analyzer.notifyStroke(length);
    this._analyzer.notifyActivity();
    this._emit(Events.SCRATCH_MOVE, { pointerId, x: last.x, y: last.y, progress: this._analyzer.ratio });
    this._scheduleFlush();
  }

  _onPointerEnd(pointerId) {
    if (!this._tracks.has(pointerId)) return;
    this._tracks.delete(pointerId);
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = 0;
    }
    this._flush();
    this._analyzer.notifyPointerUp();
    this._emit(Events.SCRATCH_END, { pointerId, progress: this._analyzer.ratio });
    if (this._tracks.size === 0 && this._state === State.SCRATCHING) {
      this._state = State.IDLE;
    }
  }

  _scheduleFlush() {
    if (this._rafId) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = 0;
      this._flush();
    });
  }

  _flush() {
    const segments = this._strokeQueue;
    if (!segments.length) return;
    this._strokeQueue = [];
    if (this._state === State.SCRATCHING || this._state === State.IDLE) {
      this._cover.scratch(segments);
    }
  }

  _rebuild() {
    if (!this._initialized || this._state === State.DESTROYED) return;
    const cfg = this._config;
    const pixelRatio = clampPixelRatio(resolvePixelRatio(cfg.pixelRatioCap), cfg);
    applyPixelRatio({ prizeLayer: this._prizeLayer, coverLayer: this._coverLayerNative }, pixelRatio);
    this._prizeLayer.draw();
    this._resetCover(true);
  }

  async _resetCover(emitEvent) {
    if (this._cancelReveal) {
      this._cancelReveal();
      this._cancelReveal = null;
    }
    // reveal 渐隐把封面 canvas opacity 置 0，重绘封面前必须恢复
    const coverCanvas = this._coverLayerNative.getCanvas()._canvas;
    coverCanvas.style.transition = '';
    coverCanvas.style.opacity = '1';
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = 0;
    }
    this._strokeQueue = [];
    this._tracks.clear();
    this._state = State.IDLE;
    this._analyzer.reset();
    await this._cover.reset();
    if (this._state === State.DESTROYED) return;
    this._pointer.setEnabled(this._enabled);
    if (emitEvent) this._emit(Events.RESET, {});
  }

  getProgress() {
    return this._analyzer ? this._analyzer.ratio : 0;
  }

  reveal(instant = false) {
    if (!this._initialized) return;
    if (this._state !== State.IDLE && this._state !== State.SCRATCHING) return;
    this._state = State.REVEALING;
    this._pointer.setEnabled(false);
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = 0;
    }
    this._strokeQueue = [];
    const element = this._coverLayerNative.getCanvas()._canvas;
    const durationMs = instant ? 0 : this._config.reveal.durationMs;
    this._cancelReveal = runReveal({
      element,
      durationMs,
      onDone: () => {
        this._cancelReveal = null;
        if (this._state === State.DESTROYED) return;
        this._cover.clear();
        this._state = State.REVEALED;
        if (!this._revealEmitted) {
          this._revealEmitted = true;
          this._emit(Events.REVEAL, { ratio: this._analyzer.ratio });
        }
      },
    });
  }

  reset() {
    if (!this._initialized || this._state === State.DESTROYED) return;
    this._resetCover(true);
  }

  setEnabled(enabled) {
    this._enabled = Boolean(enabled);
    if (!this._initialized) return;
    if (!this._enabled) {
      this._pointer.setEnabled(false);
      if (this._state === State.IDLE || this._state === State.SCRATCHING) {
        this._cover.clear();
        this._state = State.IDLE;
      }
    } else if (this._state !== State.REVEALING && this._state !== State.REVEALED) {
      this._resetCover(false);
    }
  }

  getStage() {
    return this._stage || null;
  }

  destroy() {
    if (this._state === State.DESTROYED) return;
    this._state = State.DESTROYED;
    if (this._initObserver) {
      this._initObserver.disconnect();
      this._initObserver = null;
    }
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = 0;
    }
    if (this._rebuildTimer) {
      clearTimeout(this._rebuildTimer);
      this._rebuildTimer = 0;
    }
    if (this._cancelReveal) {
      this._cancelReveal();
      this._cancelReveal = null;
    }
    if (this._unwatchDpr) {
      this._unwatchDpr();
      this._unwatchDpr = null;
    }
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this._pointer) this._pointer.destroy();
    if (this._analyzer) this._analyzer.destroy();
    if (this._cover) this._cover.destroy();
    if (this._stage) this._stage.destroy();
    this._emit(Events.DESTROYED);
    this._events.clear();
  }
}
