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
import { StrokeHistory } from './history/StrokeHistory.js';
import { Recorder, defaultNow, RECORDING_VERSION } from './record/Recorder.js';
import { Player } from './record/Player.js';
import { ClipLibrary } from './record/ClipLibrary.js';
import { STATE_VERSION, parseState, concatClipEvents } from './state/serialize.js';

const DEFAULTS = {
  brush: { radius: 22, shape: 'round', hardness: 1 },
  targetRatio: 0.5,
  pixelRatioCap: 2,
  sampling: { width: 200, height: 125, intervalMs: 120, alphaCutoff: 16 },
  reveal: { durationMs: 260 },
  touchAction: 'none',
  autoReveal: true,
  enabled: true,
  undoLimit: 20, // G2：撤销历史笔划数上限，超限淘汰最旧；0 关闭撤销能力
  storageKeyPrefix: 'scratch-card', // H3：片段库 localStorage key 前缀（`${prefix}:clips`）
  storageQuota: 256 * 1024, // H3：片段库总字节上限，超限 LRU 淘汰；<=0 关闭持久化
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
    this._history = null; // G1/G2：_init 时按 undoLimit 装配
    this._recorder = new Recorder({ now: defaultNow }); // G3
    this._lastRecording = null; // 最近一次 stop 的录制结果（playRecording 默认重放它）
    this._player = null; // _init 时装配（依赖逻辑输入路径）
    // H1/H3：片段库（localStorage 持久化，不可用时降级内存态并派发一次 storage-error）
    this._clips = new ClipLibrary({
      storageKey: `${this.config.storageKeyPrefix}:clips`,
      quota: this.config.storageQuota,
      onStorageError: () => this._emit(EVENTS.STORAGE_ERROR, {}),
    });
    this._activeClip = null; // 进行中的片段录制 { label, startedAt }

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
      createImage: () => new Konva.Image(),
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

    // G1/G2：笔划脏矩形位图快照栈（快照 canvas 为渲染资产，独立于采样面）
    const undoLimit = cfg.undoLimit === undefined ? DEFAULTS.undoLimit : cfg.undoLimit;
    this._history = new StrokeHistory({
      limit: undoLimit,
      enabled: undoLimit > 0,
      captureCrop: (bbox) => this._cover.captureCrop(bbox),
      scratchSegments: (segments, brush) => this._cover.scratchSegments(segments, brush),
      pasteCrops: (crops) => this._cover.pasteCrops(crops),
      releaseCrop: (crop) => this._cover.releaseCropCanvas(crop),
    });

    // G3：回放器复用逻辑输入路径（同一 tracker / rAF 合帧 / 采样节流）
    const win = globalThis.window;
    this._player = new Player({
      now: defaultNow,
      requestFrame: (cb) => win.requestAnimationFrame(cb),
      cancelFrame: (id) => win.cancelAnimationFrame(id),
      onDown: (p) => this._logicalDown(p),
      onMove: (p) => this._logicalMove(p),
      onUp: (p) => this._logicalUp(p),
      onReset: () => this._playbackReset(),
      onEnd: () => this._onPlayEnd(),
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

  // 真实输入：client 坐标 → 逻辑坐标 → 录制 → 逻辑核心
  _onPointerDown(p) {
    if (this.state !== STATES.IDLE && this.state !== STATES.SCRATCHING) return;
    if (this._player && this._player.playing) return; // 回放期忽略真实输入（G3）
    const { x, y } = this._toLogical(p.clientX, p.clientY);
    this._recorder.pointerEvent('down', { pointerId: p.pointerId, x, y });
    this._logicalDown({ pointerId: p.pointerId, x, y });
  }

  _onPointerMove(p) {
    if (this.state !== STATES.SCRATCHING) return;
    const { x, y } = this._toLogical(p.clientX, p.clientY);
    this._recorder.pointerEvent('move', { pointerId: p.pointerId, x, y });
    this._logicalMove({ pointerId: p.pointerId, x, y });
  }

  _onPointerUp(p) {
    if (!this._tracker.has(p.pointerId)) return;
    this._recorder.pointerEvent('up', { pointerId: p.pointerId, x: 0, y: 0 });
    this._logicalUp({ pointerId: p.pointerId });
  }

  // 逻辑输入核心：真实输入与回放合成输入共用（G3：同一渲染与统计路径）
  _logicalDown({ pointerId, x, y }) {
    if (this.state !== STATES.IDLE && this.state !== STATES.SCRATCHING) return;
    if (this._tracker.size() === 0) this._history.beginSession(); // 多指共享一个笔划会话
    this._tracker.down(pointerId, x, y);
    this.state = STATES.SCRATCHING;
    // 单点也打一个洞：重复端点使 round 线帽渲染出圆点（仅 moveTo 不会绘制）
    this._pendingSegments.push([x, y, x, y]);
    this._scheduleFlush();
    this._emit(EVENTS.SCRATCH_START, { pointerId, x, y });
  }

  _logicalMove({ pointerId, x, y }) {
    if (this.state !== STATES.SCRATCHING) return;
    const segment = this._tracker.move(pointerId, x, y);
    if (!segment) return; // 未知 pointerId：防串轨
    this._pendingSegments.push(segment);
    if (this._useEstimator) {
      this._estimator.stampPoints(segment, this.config.brush.radius);
    }
    this._scheduleFlush();
    this._analyzer.notifyActivity();
    this._emit(EVENTS.SCRATCH_MOVE, {
      pointerId,
      x,
      y,
      progress: this.getProgress(),
    });
  }

  _logicalUp({ pointerId }) {
    if (!this._tracker.has(pointerId)) return;
    this._tracker.up(pointerId);
    this._flushSegments(); // 尾段立即落图，不等下一帧
    this._analyzer.forceSample(); // pointerup 强制补采（收口）
    this._emit(EVENTS.SCRATCH_END, { pointerId, progress: this.getProgress() });
    if (this._tracker.size() === 0 && this.state === STATES.SCRATCHING) {
      this.state = STATES.IDLE;
      this._history.commitSession(); // 笔划收口：快照入 undo 栈、清空 redo 栈
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
    // 打洞之前裁剪脏矩形快照（撤销路线 G2）；与渲染同一帧、单次 layer.draw
    this._history.captureFrame(segments, this.config.brush.radius);
    this._cover.scratchSegments(segments, this.config.brush);
  }

  // ---------- reveal ----------
  _startReveal(instant) {
    if (this._destroyed) return;
    if (this.state === STATES.REVEALING || this.state === STATES.REVEALED) return;
    if (this._activeClip) this.stopClip(); // H1：reveal 自动落库进行中的片段（输入即将锁定）
    if (!this._initialized) {
      this._pendingReveal = instant ? 'instant' : 'deferred';
      return;
    }
    this.state = STATES.REVEALING;
    this._pointer.setEnabled(false);
    this._pendingSegments = [];
    this._tracker.clear();
    // reveal 是单向上锁：历史快照即刻释放；同一生命周期内不可撤销回可再 reveal 态
    if (this._history) this._history.clear();
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
    if (this._player && this._player.playing) this._player.stop(); // 重建中断回放
    if (this._history) this._history.clear(); // 位图被 setSize 重分配：快照坐标失效
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

  // 录制内 reset 标记：回放不中断，在全新封面上继续后续笔迹
  _playbackReset() {
    this.reset(undefined, true);
  }

  // undo/redo 后以当前位图重新采样，progress 回退/前进并派发一次 progress
  _resyncProgress() {
    if (this._useEstimator) {
      // 几何降级：用撤销后剩余笔划重建并集网格（taint 面无法回读像素）
      this._estimator.reset();
      for (const entry of this._history._undo) {
        for (const frame of entry.frames) {
          this._estimator.stampPoints(frame.segments.flat(), this.config.brush.radius);
        }
      }
      this._analyzer.resync(defaultNow());
      return;
    }
    if (!this._analyzer.resync(defaultNow())) {
      // 此前未降级、此刻采样面 taint：转降级并用全部剩余笔划补建估算网格
      this._useEstimator = true;
      this._estimator.reset();
      for (const entry of this._history._undo) {
        for (const frame of entry.frames) {
          this._estimator.stampPoints(frame.segments.flat(), this.config.brush.radius);
        }
      }
      this._analyzer.resync(defaultNow());
      this._emit(EVENTS.PROGRESS_ERROR, {});
    }
  }

  // ---------- 公共 API ----------
  getProgress() {
    return this._analyzer ? this._analyzer.ratio : 0;
  }

  reveal(instant = false) {
    this._startReveal(instant);
  }

  // 回到全新封面；可选传入新 cover 配置
  // fromPlayback：录制内 reset 标记触发，不停止回放、不重复入列 reset 标记
  reset(newCover, fromPlayback = false) {
    if (this._destroyed) return;
    if (newCover) this.config.cover = newCover;
    if (!fromPlayback) this._recorder.markReset(); // 录制中：reset 标记事件入列
    if (!fromPlayback && this._player && this._player.playing) this._player.stop();
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
    if (this._history) this._history.clear(); // reset 契约：撤销/重做栈清空
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

  // ---------- G1：撤销 / 重做 ----------
  // 语义：笔划进行中（仍有活动指针）一律拒绝（不排队）；revealing/revealed
  // 拒绝（reveal 单向上锁，历史已释放）；回放中拒绝。返回是否实际执行。
  get canUndo() {
    return !!this._history && this._history.canUndo && !this._history.active;
  }

  get canRedo() {
    return !!this._history && this._history.canRedo && !this._history.active;
  }

  undo() {
    if (this._destroyed || !this._history || !this._initialized) return false;
    if (this.state !== STATES.IDLE) return false;
    if (this._history.active || (this._player && this._player.playing)) return false;
    if (this._rafId !== null || this._pendingSegments.length > 0) return false; // 禁用窗口：待合帧
    if (!this._history.undo()) return false;
    this._resyncProgress(); // 位图恢复后 progress 回退
    return true;
  }

  redo() {
    if (this._destroyed || !this._history || !this._initialized) return false;
    if (this.state !== STATES.IDLE) return false;
    if (this._history.active || (this._player && this._player.playing)) return false;
    if (this._rafId !== null || this._pendingSegments.length > 0) return false;
    if (!this._history.redo(this.config.brush)) return false;
    this._resyncProgress();
    return true;
  }

  // ---------- G3：录制 / 回放 ----------
  get recording() {
    return this._recorder.recording;
  }

  get playing() {
    return !!this._player && this._player.playing;
  }

  startRecording() {
    if (this._destroyed || this._recorder.recording) return false;
    this._recorder.start();
    return true;
  }

  stopRecording() {
    if (!this._recorder.recording) return false;
    if (this._activeClip) {
      this.stopClip(); // H1：片段录制中调用 stopRecording 等价于 stopClip
      return true;
    }
    this._recorder.stop();
    this._lastRecording = this._recorder.exportRecording();
    return true;
  }

  // 返回可 JSON 序列化的笔迹序列；未录制过返回 null
  exportRecording() {
    if (this._recorder.recording) return this._recorder.exportRecording();
    return this._lastRecording || null;
  }

  // 按录制时间戳节拍重放；recording 缺省时重放最近一次 stopRecording 的结果。
  // H1 增量：recording 还可为单个 clip（对象或 id）、clip id/对象数组（顺序拼接、节拍连续）。
  playRecording({ speed = 1, recording = this._lastRecording } = {}) {
    if (this._destroyed || !this._initialized || !this._player) return false;
    if (this._player.playing) return false;
    const resolved = this._resolvePlayable(recording);
    if (!resolved || resolved.events.length === 0) return false;
    // 仅可从干净的 idle 封面起放（避免与既有刮痕/揭示态叠加）
    if (this.state !== STATES.IDLE || this._tracker.size() > 0) return false;
    if (!this._player.play(resolved, { speed })) return false;
    this._pointer.setEnabled(false); // 重放期间真实输入被忽略
    this._emit(EVENTS.PLAY_START, { speed, events: resolved.events.length });
    return true;
  }

  // 归一化 playRecording 的 recording 形参 → { version, events }
  _resolvePlayable(recording) {
    if (!recording) return null;
    if (Array.isArray(recording)) {
      if (recording.length === 0) return null;
      const clips = [];
      for (const item of recording) {
        const clip = this._resolveClip(item);
        if (!clip) return null; // 任一 id 未找到：整体拒绝
        clips.push(clip);
      }
      return { version: RECORDING_VERSION, events: concatClipEvents(clips) };
    }
    const clip = this._resolveClip(recording);
    if (clip) return { version: RECORDING_VERSION, events: clip.events.slice() };
    if (Array.isArray(recording.events)) return recording; // 既有录制对象原样透传
    return null;
  }

  _resolveClip(item) {
    if (typeof item === 'string') {
      const clip = this._clips.get(item);
      if (clip) this._clips.touch(item); // LRU：播放即最近使用
      return clip;
    }
    if (
      item &&
      typeof item === 'object' &&
      Array.isArray(item.events) &&
      ('id' in item || 'label' in item || 'duration' in item)
    ) {
      if (typeof item.id === 'string') this._clips.touch(item.id);
      return item;
    }
    return null;
  }

  _onPlayEnd() {
    // 若末段笔划达标自动进入 revealing/revealed，输入保持禁用（语义与真实一致）
    if (this.state === STATES.IDLE) this._pointer.setEnabled(true);
    this._emit(EVENTS.PLAY_END, {});
  }

  // ---------- H1：片段库 ----------
  get clipActive() {
    return this._activeClip !== null;
  }

  // 开始一段命名片段录制（底层复用 G3 Recorder；与普通录制互斥）
  startClip(label = '') {
    if (this._destroyed || this._recorder.recording) return false;
    this._recorder.start();
    this._activeClip = { label: String(label || ''), startedAt: defaultNow() };
    return true;
  }

  // 停止并入库当前片段；无进行中片段返回 null
  stopClip() {
    if (!this._activeClip) return null;
    const meta = this._activeClip;
    this._activeClip = null;
    if (this._recorder.recording) this._recorder.stop();
    const { events } = this._recorder.exportRecording();
    this._lastRecording = { version: RECORDING_VERSION, events }; // 与 stopRecording 语义对齐
    return this._clips.add({
      label: meta.label,
      duration: Math.max(0, Math.round(defaultNow() - meta.startedAt)),
      events,
    });
  }

  listClips() {
    return this._clips.list();
  }

  removeClip(id) {
    return this._clips.remove(id);
  }

  clearClips() {
    this._clips.clear();
  }

  // ---------- H2：状态序列化 ----------
  // 导出等价状态（clips / undoLimit / 进度口径 / 封面位图 dataURL 内嵌）；destroyed 返回 null
  exportState() {
    if (this._destroyed) return null;
    const cfg = this.config;
    return {
      version: STATE_VERSION,
      clips: this._clips.toJSON(),
      undoLimit: cfg.undoLimit,
      progress: {
        ratio: this.getProgress(),
        targetRatio: cfg.targetRatio,
        sampling: {
          width: cfg.sampling.width,
          height: cfg.sampling.height,
          alphaCutoff: cfg.sampling.alphaCutoff,
        },
      },
      coverDataUrl: this._coverDataUrl(),
    };
  }

  _coverDataUrl() {
    if (!this._initialized || this.config.enabled === false) return null;
    try {
      return this._coverLayerRaw.getCanvas()._canvas.toDataURL('image/png');
    } catch (err) {
      return null; // 风险 9：跨域 taint 面无法导出，位图字段置空
    }
  }

  // 恢复等价状态。H4：playing/recording 中一律拒绝（返回 false），不中断；
  // destroyed / 未初始化同样拒绝。接受 JSON 字符串或已解析对象。
  importState(json) {
    if (this._destroyed || !this._initialized) return false;
    if (this.playing || this._recorder.recording) return false;
    const state = parseState(json);
    if (!state) return false;
    this.reset(); // 中断当前笔划/reveal，回到干净 idle（与手动 reset 同路径）
    if (state.undoLimit !== undefined) {
      const limit = Math.max(0, state.undoLimit | 0);
      this.config.undoLimit = limit;
      if (this._history) {
        this._history.limit = limit;
        this._history.enabled = limit > 0;
      }
    }
    if (state.clips) this._clips.replaceAll(state.clips);
    if (state.coverDataUrl) this._restoreCoverBitmap(state.coverDataUrl);
    return true;
  }

  // 封面位图异步回绘：完成后以恢复位图重新采样，progress 与直接操作同口径
  _restoreCoverBitmap(dataUrl) {
    const token = ++this._coverToken;
    const img = new Image();
    img.onload = () => {
      if (this._destroyed || token !== this._coverToken) return;
      if (this.state !== STATES.IDLE) return; // 等待期间状态已变：放弃位图恢复
      this._cover.paintImage(img);
      this._resyncProgress();
    };
    img.onerror = () => {}; // 坏 dataURL：保持 reset 后的全新封面
    img.src = dataUrl;
  }

  // 幂等销毁：移除全部原生监听、释放 capture、取消 rAF/定时器、解绑媒体查询
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.state = STATES.DESTROYED;
    this._activeClip = null; // H1：进行中的片段随销毁丢弃，不入库
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
    if (this._player) this._player.stop(); // 中断回放、取消 rAF 句柄（不泄漏）
    if (this._pointer) this._pointer.destroy();
    if (this._analyzer) this._analyzer.destroy();
    if (this._sampleGrid) this._sampleGrid.destroy();
    if (this._history) this._history.destroy(); // 释放全部快照离屏 canvas
    if (this._cover) this._cover.destroy();
    if (this._stage) this._stage.destroy(); // 移除 content DOM、释放 canvas（Stage.js:226-238）
    this._pendingSegments = [];
    this._emit(EVENTS.DESTROYED, {});
    this._listeners.clear();
  }
}
