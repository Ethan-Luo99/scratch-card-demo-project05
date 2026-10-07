# 刮刮卡模块交付说明（Konva 10.7.0）

架构依据：`scratch-card-konva-design.md`（DESIGN.md）。实现未更改任何 ADR 与 Q1–Q6 结论。

## F1–F8 逐条自验结论

- **F1 门面类**：`src/scratch/ScratchCard.js` 实现 §3 全部 config 字段（width/height/cover 三类型/prize.factory/brush/targetRatio/pixelRatioCap/sampling/reveal/touchAction/autoReveal/enabled）、6 个事件 + `reset`/`progress-error` 两个扩展事件、全部方法、idle→scratching→revealing→revealed 状态机（destroyed 终态）。reveal 事件由 `_revealEmitted` 标记 + 状态机双重保证每生命周期恰好一次（含 49%/51% 抖动场景，单测覆盖 UC6）。✅
- **F2 擦除渲染（ADR-001）**：`cover/CoverLayer.js` 三态 NEEDS_PAINT/PERSISTENT/DESTROYED；init 清屏绘膜→移除封面节点→`clearBeforeDraw(false)`；scratch 每帧 add 全部笔迹→单次 `layer.draw()`→remove 回池；`cover/Eraser.js` 对象池（硬刷 Line / 软刷径向渐变圆章）。✅（单测断言调用序）
- **F3 面积统计（ADR-002）**：`analysis/sampleCanvas.js` 200×125 离屏降采样（仅像素分析用途）；`analysis/ProgressAnalyzer.js` 120ms 时间节流 + pointerup `forceSample()` 强制补采；达 targetRatio（连续两次确认）自动 reveal；progress 事件按节流派发。✅
- **F4 输入层（ADR-003/004）**：`input/PointerController.js` 原生 Pointer Events 挂 `stage.content`，内联 `touch-action:none`、`setPointerCapture`、`getCoalescedEvents` 展开（`input/coalesce.js`）、`Map<pointerId>` 分轨、点距 >2×brushRadius 按 0.5×半径步长插值；`core/createStage.js` 中 coverLayer 恒 `listening(false)`（hitCanvas 0×0），prizeLayer 保持可命中。✅
- **F5 坐标系（Q5）**：`input/geometry.js` 严格实现 `floor((client-rect)×dpr/cssScale)` 合并式（单次 floor）；未对 stage 设任何 scale/transform。9 组合矩阵单测通过。✅
- **F6 边界**：三路清理（pointerup/pointercancel/lostpointercapture）+ destroy 释放残留 capture；DPR 变化经 `matchMedia(resolution)` + 200ms 去抖 → 重设 pixelRatio → 封面重置 + 进度归零 + 广播 `reset`；零尺寸容器经 ResizeObserver 延迟初始化；taint 捕获后降级 `StrokeEstimator` 笔画并集估算并派发 `progress-error`；隐藏 tab 时 reveal 立即跳终态（`reveal/reveal.js`，CSS transition + transitionend + 1.2×时长兜底双路径）；destroy 幂等（浏览器冒烟验证 DOM 移除、重复调用安全）。✅
- **F7 测试**：`src/scratch/__tests__/`，node:test + 手写 canvas stub（`helpers.js`），零新增依赖、未改 package.json。34 个用例全部通过（见下方输出）。✅
- **F8 demo**：`demo/demo.js` 同页 3 张卡（color/image/nodes 三种封面），奖品层含可点击"领取奖励"按钮（刮前/刮中/刮后均可命中），每卡 reset/reveal/reveal(instant)/destroy 操作区；`src/main.js` 接入，`npm run dev` 直接可跑。✅

## 测试运行输出（node --test "src/scratch/__tests__/**/*.test.js"）

```
ℹ tests 34
ℹ pass 34
ℹ fail 0
```

另附真实浏览器冒烟（headless Chromium + 合成 PointerEvent 走完整链路，
`demo/smoke.html`，非交付必须件但保留供回归）：13/13 PASS，含
"auto revealed / reveal fired exactly once / content dom removed / destroy idempotent"。
demo 主页 headless 验证：3 个 konvajs-content、6 个 layer canvas 正常渲染。

## 与 DESIGN.md 的差异清单

1. **computeCssScale 容错加强**：Konva `Stage.js:906-912` 的 `rect.width/clientWidth || 1`
   只兜住 0/0=NaN，零尺寸容器会产生 Infinity。实现对非有限值一并回退 1
   （`src/scratch/input/geometry.js`），行为符合风险 10 意图。
2. **pointerup 强制采样一次定音**：DESIGN.md 要求"连续两次确认"且"pointerup 立即终采收口"，
   二者在"快速刮满一次抬手"场景冲突（只有一次采样机会）。处置：节流采样需连续 2 次确认；
   pointerup 强制采样 ≥target 时一次即确认（`ProgressAnalyzer._sample(t, forced)`）。
3. **采样计数提前结束的返回值**：ADR-002"已数过 target 即停止遍历"会使 ratio 成为
   ≥target 的下界而非精确值（全透明时返回 ≈0.50004 而非 1）。保留该优化（达标即 reveal，
   精确值无意义），单测按"下界 ≥ target"断言。
4. **新增两个事件**：`reset`（DPR 重建/手动重置时广播，F6 要求"广播 reset"）与
   `progress-error`（风险 9 明确要求派发）。§3 的 6 个事件语义不变。
5. **enabled:false 的 reveal 事件**：构造时直接呈现奖品，reveal 事件经 queueMicrotask
   异步派发（ratio=1），保证构造后同步 `on('reveal')` 的订阅者能收到。
6. **单点落笔**：`pointerdown` 即压入 `[x,y,x,y]` 重复端点段——canvas 对仅 moveTo 的
   零长度路径不渲染，重复端点 + round 线帽才能画出圆点。
7. **DPR 重建对 revealed 卡片的处理**：设计未覆盖；选择不重新覆盖封面（保持已揭示状态），
   仅重设 pixelRatio 并清空位图，不派发 reset。

## 已知边界取舍

- 跨卡 pointer capture：一卡 capture 后滑到邻卡，move 归首卡（风险 12，认定为预期）。
- 软边刷（hardness<1）用径向渐变圆章逐点盖印，点距 0.5×半径，性能低于硬刷单 Line；
  圆章池上限 512，超出退化为新建节点（不影响正确性）。
- 降级估算器（StrokeEstimator）是几何并集估算，软刷半透明边缘不计入，口径与
  alphaCutoff 采样略有差异；taint 场景下可接受。
- 多卡错峰用实例序号 ×7ms 偏移首采时刻（R6），非严格随机。
- 测试命令：`node --test "src/scratch/__tests__/**/*.test.js"`
  （Node 24 下 `node --test <目录>` 会被当作入口模块解析，需用 glob）。

## H1–H5 增量（片段库 + 状态序列化恢复）

- **H1 片段库**：`startClip(label)`/`stopClip()` 产出 `Clip{id,label,duration,events}` 入
  `record/ClipStore.js`；`listClips/removeClip/clearClips`；`playRecording` 的 `recording`
  形参扩展为：既有 {version,events}、单个 clip、单个 clip id、clip id 数组（按 duration
  顺移拼接、节拍连续，任一 id 缺失整体拒绝）。录制中 reset → reset 标记入片段事件
  （沿用 G3 语义）；reveal → 片段截断入库；destroy → 进行中的片段丢弃、已入库片段保留。
- **H2 序列化**：`exportState()` 返回 JSON 字符串（version/undoLimit/进度口径/clips/封面
  位图 dataURL 内嵌，taint 时 cover 为 null）；`importState(json)` 接受字符串或对象，
  未知主版本拒绝（false）、未知字段忽略；导入后回 idle、清 undo/redo 栈、按恢复位图
  重采样（taint 时采用导出口径并派发 progress-error）。
- **H3 持久化**：clips 每次变更即写 localStorage（`storagePrefix` 可配，index + 每片段
  一键）；总字节超 `storageQuota` 按 lastUsed LRU 淘汰（最新片段不淘汰自己，单片段超
  配额仅留内存）；localStorage 不可用降级纯内存并派发一次 `storage-error`。
- **H4 交互**：playing/recording/scratching/destroyed 中 `importState` 一律拒绝；
  idle/revealing/revealed 接受；导入后 undo/redo/录制/回放语义与直接操作一致。
- **H5 demo**：每卡新增片段录制行、片段列表（▶ 播放 / ✕ 删除 / 全部顺序播放）、
  导出 JSON（a[download]）、导入（input[type=file]）。
