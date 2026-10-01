# 刮刮卡 Konva.js 技术方案设计

> 版本依据：`konva@10.7.0`（`package-lock.json` 锁定）。所有源码引用路径为 `node_modules/konva/lib/**`，行号对应该版本真实文件。

## 必答问题（结论先行）

### Q1 一个 Layer 内 destination-out 的 Rect 能否擦除另一个 Layer 的奖品图像？

**结论：不能。** 每个 `Layer` 持有自己独立的 `<canvas>` 元素，`globalCompositeOperation` 的作用域是单个 canvas 的 2D context，跨 Layer 即跨 canvas，擦除无法穿透。

源码证据：

- `Layer.js:41-44` — Layer 构造时自建独立画布：
  ```js
  this.canvas = new SceneCanvas();
  this.hitCanvas = new HitCanvas({ pixelRatio: 1 });
  ```
- `Stage.js:287-289` — `_toKonvaCanvas` 内官方注释直述：
  ```js
  // every layer renders on its own canvas, like on screen, so a
  // globalCompositeOperation inside a layer does not reach the layers below
  ```
- `Context.js:647-653` — GCO 只是对当前 context 设属性：
  ```js
  _applyGlobalCompositeOperation(node) {
      const op = node.attrs.globalCompositeOperation;
      ...
      this.setAttr('globalCompositeOperation', op);
  }
  ```

**对方案的影响：** 覆盖层（刮奖膜）与奖品层必须分两个 Layer（奖品在下、覆盖膜在上），刮除操作是"在覆盖膜所在 Layer 内用 destination-out 把膜擦透明"，透出下方 Layer 的奖品。这恰好也是 Konva 官方推荐的刮刮卡结构。

### Q2 Konva 10 中 Group 的 isolated 默认值？true/false 时子节点合成模式生效范围的区别？

**结论：默认 `false`。**

源码证据：

- `Group.js:83`：
  ```js
  Factory.addGetterSetter(Group, 'isolated', false, getBooleanValidator());
  ```
- `Group.js:57-60` 文档注释：
  > An isolated group draws its children into a transparent canvas on each scene draw. The group opacity and globalCompositeOperation apply once to the completed image. Child blend modes and erasing affect only the content inside that canvas.
- `Group.js:24-50` `_drawChildNodes`：`isolated() === true` 且为 scene 绘制时，子节点先画进 `canvas._prepareIsolationCanvas(...)` 的隔离画布，再整体 `_drawDeviceBuffer` 回主画布。

**区别：**

- `isolated: false`（默认）：子节点的 GCO 直接作用于 Layer 主画布。`destination-out` 的子节点会擦除**同 Layer 内先于它绘制的所有内容**（包括兄弟节点）。
- `isolated: true`：子节点的 GCO 只在隔离画布内部生效，合成回主画布时只应用 Group 自身的 opacity/GCO 一次。擦除被"关进笼子"。

**对方案的影响：** 刮膜 Layer 内若除笔迹外还有其他装饰节点（边框、logo），必须把它们放进 `isolated: true` 的 Group，或把笔迹放在独立子树最上层并保证绘制顺序，防止笔迹误擦装饰。反之，笔迹 Line 节点自身**不要**放进 isolated Group，否则 destination-out 失效。

### Q3 对 destination-out 节点调用 cache() 会怎样？

**结论：擦除失效（节点变透明/无擦除效果），禁止对刮除笔迹节点 cache。**

机制（源码证据）：

- `Node.js:306` — `cache()` 把节点画进一张**全新的空白** cache 画布：
  ```js
  this.drawScene(cachedSceneCanvas, this);
  ```
- `Shape.js:525-530` — 自缓存绘制时**不应用** GCO：
  ```js
  // if we are caching self, we don't need to apply opacity and global composite operation
  // because it will be applied in the cache
  if (!cachingSelf) {
      context._applyOpacity(this);
      context._applyGlobalCompositeOperation(this);
  }
  ```
  于是 destination-out 的笔迹在空白 cache 画布上以默认 `source-over` 画成实心笔迹（即使应用了 destination-out，对空白画布擦除结果也是全透明——两种路径都不产生期望效果）。
- `Node.js:445-455` — cache 回贴时才应用 GCO，但作用对象已是整张 cache 位图：
  ```js
  context._applyOpacity(this);
  context._applyGlobalCompositeOperation(this);
  ...
  context.drawImage(cacheCanvas._canvas, 0, 0, ...);
  ```

**对方案的影响：** ADR-1 规定笔迹节点永不 `cache()`。性能靠"控制笔迹节点数量 + 定期位图烘焙"解决（见 ADR-3），而非 cache。

### Q4 globalCompositeOperation 是否影响节点 hit graph？对 R4 意味着什么？

**结论：不影响。** hit graph 完全忽略 GCO。

源码证据：

- `Node.js:2503` 官方注释：
  > globalCompositeOperation DOESN'T affect hit graph of nodes. So they are still trigger to events as they have default "source-over" globalCompositeOperation.
- `Shape.js:558-592` `drawHit()`：全函数无任何 `_applyGlobalCompositeOperation` 调用（对比 `drawScene` 在 529/540 行有）。
- `Context.js:795-806` `HitContext._fill`：hit 画布只用 `shape.colorKey` 实心填充：
  ```js
  this.setAttr('fillStyle', shape.colorKey);
  ```
- `Layer.js:364` — 命中检测就是读 hit 画布单像素颜色：
  ```js
  const p = this.hitCanvas.context.getImageData(Math.floor(pos.x * ratio), ...).data;
  ```

**对 R4 的意义（关键）：** 即使覆盖膜被 visually 刮透明，它的 hit graph 仍然是完整不透明的——用户在"已刮开"区域点击，命中的是膜而不是奖品。方案必须：**刮擦期间即将膜层所有节点 `listening(false)`**（刮擦输入走 stage 级 pointer 事件，不依赖膜节点命中），或至少在 `complete` 时 `coverLayer.destroy()` / `listening(false)`，奖品层节点的点击才能生效。奖品节点自身保持 `listening(true)`。

### Q5 getPointerPosition() 处于哪个坐标系？DPR=3 + CSS 缩放 0.5 时到位图像素的换算公式

**结论：返回的是"stage content 左上角为原点、已抵消 CSS 缩放、但不含 stage 自身 transform、也不含 pixelRatio"的逻辑坐标（CSS 像素系）。**

源码证据：

- `Stage.js:241-243` 文档：
  > pointer position doesn't include any transforms (such as scale) of the stage; it is just a plain position of pointer relative to top-left corner of the canvas
- `Stage.js:884-885`（mouse 分支，touch 分支 862-876 同构）：
  ```js
  x = (evt.clientX - contentPosition.left) / contentPosition.scaleX;
  y = (evt.clientY - contentPosition.top) / contentPosition.scaleY;
  ```
- `Stage.js:897-913` `_getContentPosition()`：CSS 缩放通过 `getBoundingClientRect` 与 `clientWidth` 之比补偿：
  ```js
  scaleX: rect.width / this.content.clientWidth || 1,
  ```
- `Canvas.js:108-117` `setSize`：位图尺寸 = `floor(逻辑尺寸 × pixelRatio)`（`Canvas.js:94-96` `_bitmapSize`），且 `context.scale(pixelRatio, pixelRatio)`。pixelRatio 取值链 `Canvas.js:26-31`：`conf.pixelRatio || Konva.pixelRatio || devicePixelRatio || 1`；`Global.js:97` `Konva.pixelRatio = window.devicePixelRatio || 1`。

**精确换算公式（DPR=3，CSS transform scale(0.5)，stage 无自身 transform）：**

```
logicalX = (clientX - rect.left) / 0.5        // Konva 已代算，即 getPointerPosition().x
bitmapX  = ⌊logicalX × pixelRatio⌋ = ⌊logicalX × 3⌋
         = ⌊(clientX - rect.left) × 3 / 0.5⌋ = ⌊(clientX - rect.left) × 6⌋
```

要点：CSS 缩放由 Konva 在 `setPointersPositions` 内自动抵消（R3 的一半）；DPR 由 context 的 `scale(pixelRatio)` 承担，**业务代码在逻辑坐标系工作即可，唯一直接触碰位图坐标的场景是 `getImageData`**（`Context.js:468-470` 是原生透传，参数是位图像素），此时必须手动 `× pixelRatio` 并 `Math.floor`。若 stage 自身有 scale/x/y，需再套 `stage.getAbsoluteTransform().copy().invert().point(pos)`——本方案规定 stage 不做 transform，缩放一律走 CSS，规避此分支。

### Q6 用 getImageData 统计面积：读哪个 canvas？逐事件全量读的开销？两种优化策略

**读哪个 canvas：** 读**覆盖膜 Layer 的 scene canvas**（`coverLayer.getCanvas().getContext()`），它是唯一包含"膜剩余 alpha"真实位图的 canvas。hit canvas 不含刮除信息（Q4），不能读。注意该 canvas 默认**非** `willReadFrequently`（`Canvas.js:233-240` SceneCanvas 默认 `willReadFrequently: false`），频繁 getImageData 会触发 GPU→CPU 同步回读，移动端尤其昂贵。

**逐事件全量读的开销（800×500 逻辑、DPR=3）：** 位图 2400×1500，单次 `getImageData` 搬运 2400×1500×4 = **14.4 MB**；pointermove 每秒 60–120 次 → 每秒 0.86–1.7 GB 回读带宽 + 主线程阻塞，移动端必掉帧。不可行。

**优化策略（量化对比，同上参数）：**

| 策略 | 单次开销 | 触发频率 | 精度 | 结论 |
|---|---|---|---|---|
| 全量读（基准） | 14.4 MB 回读 | 每事件 | 精确 | 禁用 |
| **A. 降采样离屏分析**：把 cover canvas `drawImage` 缩到 200×125 离屏 canvas（仅用于像素分析，符合约束），再 getImageData | 200×125×4 = **100 KB**（≈1/144）+ 一次 GPU 缩放 | 节流至每 100ms 或每 N 个事件 | 误差 <1%，足够阈值判断 | **采用** |
| **B. 解析 bitmask**：不读 canvas，JS 侧维护 100×63 的 `Uint8Array`，每笔迹线段按半径栅格化置位 | 0 回读；每线段写几百字节 | 每事件实时 | 与视觉略有出入（笔帽/接头近似），阈值场景可接受 | **采用（主），A 做校准** |

方案采用 **B 为主、A 兜底校准**：日常统计零回读；每 500ms 或 `pointerup` 时用 A 校准一次，消除解析模型与真实位图的累积偏差。

---

## 一、技术方案

### 1.1 架构图

```
┌─ ScratchCard (src/scratch/ScratchCard.js) ─────────────────────┐
│  container (div, position:relative, touch-action:none)          │
│  └─ Konva.Stage (W×H 逻辑像素, 无 transform)                    │
│     ├─ PrizeLayer   (z-index 下)                                │
│     │   └─ prizeNode (Image/Text/Group, listening:true)  ← R4   │
│     └─ CoverLayer   (z-index 上)                                │
│         ├─ coverRect (Rect/Image 膜, listening:false)           │
│         └─ strokeGroup (isolated:false)                         │
│             └─ Line[]  (destination-out, 永不 cache)            │
├─ ScratchInput    (pointer 事件 → 线段流, coalesced)  src/scratch/input.js
├─ StrokeRenderer  (线段 → Konva.Line 节点, 烘焙合并)  src/scratch/strokes.js
├─ AreaCounter     (bitmask 主统计 + 降采样校准)       src/scratch/area.js
└─ RevealController(阈值判定 / 全清动画 / 回调)        src/scratch/reveal.js
```

### 1.2 模块划分（`src/scratch/**`，后续轮次实现）

- `ScratchCard.js` — 公共门面：组装 Stage/Layer/子模块，暴露 API，持有 `destroy()`。
- `input.js` — 在 stage 上监听 `pointerdown/move/up/cancel`（Konva 已绑定，`Stage.js:12-24`），用 `stage.getPointerPosition()` 取点；通过 `evt.evt.getCoalescedEvents?.()` 展开合并事件；多指按 `pointerId` 分流。
- `strokes.js` — 把点流连成 `Konva.Line`（`strokeWidth`、`lineCap/lineJoin: 'round'`、`globalCompositeOperation: 'destination-out'`、`listening: false`）；负责笔迹烘焙（见 ADR-3）。
- `area.js` — 逻辑坐标系 bitmask（默认 cell = 8 逻辑 px）+ 节流降采样校准；输出 `scratchedRatio ∈ [0,1]`。
- `reveal.js` — 阈值判定、触发全清（Tween 淡出 CoverLayer 后 `destroy()`）、派发回调。
- `index.js` — 纯 re-export。

### 1.3 ScratchCard 公共 API

```js
const card = new ScratchCard({
  container,            // HTMLElement | selector
  width, height,        // 逻辑像素（stage 尺寸；CSS 缩放交给外部样式）
  prize,                // Konva.Node 配置或工厂 (layer)=>Konva.Node
  cover,                // { fill } | { image } | (layer)=>Konva.Node
  brushSize: 40,        // 逻辑像素
  threshold: 0.45,      // 刮开比例阈值，到达自动全清
  sampleCell: 8,        // bitmask 粒度（逻辑 px）
  pixelRatio,           // 可选，默认跟随 devicePixelRatio（Canvas.js:26-31）
  onProgress(ratio),    // 节流后回调
  onComplete(),         // 全清动画结束后回调
  onReveal(),           // 阈值触发瞬间回调（动画前）
});
card.reset();           // 重建膜、清零统计
card.reveal();          // 立即全清
card.destroy();         // stage.destroy() + 解绑全部监听 + 释放离屏 canvas
```

事件约定：所有回调 `this` 指向 ScratchCard；`onProgress` 保证单调不减；`onComplete` 至多触发一次。

### 1.4 关键取舍（ADR）

**ADR-1 擦除渲染：同 Layer 内 destination-out 笔迹 Line，而非直接改位图。**
依据 Q1（跨 Layer 擦除不可能）与约束 3（禁裸 2D 绘制）。膜与笔迹同居 CoverLayer，奖品在 PrizeLayer。笔迹用 `Konva.Line` + `destination-out`，Layer 每帧 `clearBeforeDraw` 重绘（`Layer.js:380-381`）时按"膜 → 笔迹"顺序重放，擦除结果天然正确。代价是笔迹节点累积 → 由 ADR-3 解决。被拒绝项：FastLayer（仍走 Konva 但语义收益为零）、单 Layer 叠放（GCO 会误伤奖品，Q1）。

**ADR-2 面积统计：解析 bitmask 为主、降采样 getImageData 校准为辅。**
依据 Q6：全量回读 14.4 MB/次不可行；bitmask 零回读、可单测（R7）；离屏降采样（100 KB/次）每 500ms 校准消除模型误差。阈值判定只用校准前不超过 500ms 的数据，保证"实时"体感。被拒绝项：纯 getImageData 节流（仍有 GPU 回读毛刺）；纯解析（长期漂移无法自纠）。

**ADR-3 笔迹连续性：coalesced 展开 + 线段插值 + 定期烘焙。**
高速划动时 pointermove 稀疏，直线连接相邻采样点会出现"断点圆"。措施：(a) `getCoalescedEvents()` 展开浏览器合并的样本；(b) 相邻事件点间距 > `brushSize/2` 时按 `brushSize/2` 步长线性插值补点，全部并入同一条 `Konva.Line` 的 `points`（round cap/join 保证接头圆滑）；(c) 每累积 200 个点或 pointerup 时，把既有笔迹**烘焙**：新建一张逻辑尺寸离屏 canvas（仅分析/合成用途）重放旧笔迹 → 生成单张 `Konva.Image`（destination-out）替换全部旧 Line 节点，节点数恒有界，保证 R5 不掉帧。被拒绝项：二次贝塞尔平滑（刮刮卡不需要美观笔迹，徒增插值误差影响面积统计）。

### 1.5 R1–R7 实现要点

- **R1 鼠标+触屏+coalesced**：Konva 已统一绑定 mouse/touch/pointer 三类事件（`Stage.js:10,12-24`）且 `{ passive: false }`（`Stage.js:396`），我们在 stage 的 `pointerdown/pointermove/pointerup/pointercancel` 上取 `evt.evt`（原生 PointerEvent），有 `getCoalescedEvents` 则展开逐点喂给 strokes.js，否则单点。container 样式必须 `touch-action: none`（Konva 源码中无任何 `touch-action` 设置，需自理），由 ScratchCard 构造时写入 inline style，防止浏览器滚动/缩放手势抢走触摸流。
- **R2 实时统计+阈值全清**：area.js 的 bitmask 在每个刮除线段栅格化后立即更新 `scratchedRatio`（零回读，可每事件）；`onProgress` 经 100ms 节流派发。reveal.js 在 `ratio >= threshold` 时冻结输入、触发 `onReveal`，启动 CoverLayer 透明度 Tween（300ms），动画结束 `coverLayer.destroy()` 后触发 `onComplete`。隐藏 tab 场景见风险清单第 5 条。
- **R3 高 DPR + CSS 缩放**：CSS 缩放由 Konva `_getContentPosition` 自动抵消（`Stage.js:909-910`），DPR 由 canvas `context.scale(pixelRatio)` 承担（`Canvas.js:117`），业务全程逻辑坐标。唯二手动点：(a) 面积校准读像素时 `× pixelRatio` 后 `Math.floor`（对齐 `Canvas.js:94-96` 的取整规则）；(b) 禁止对 stage 设 scale/x/y，缩放一律 CSS，保证 Q5 公式退化为单步。
- **R4 奖品可点击**：依据 Q4，膜 hit graph 不随擦除消失。构造时即对 CoverLayer 全部节点 `listening(false)`（刮擦输入走 stage 级事件，不依赖膜命中）；奖品节点 `listening(true)`；`complete` 后 `coverLayer.destroy()` 彻底移除。hit 检测走 `Layer._getIntersection` 读 hit 画布（`Layer.js:357-374`），奖品层 hit 正常。
- **R5 大卡片移动端性能**：(a) 笔迹烘焙使 CoverLayer 子节点数 ≤ 膜 + 1 条活跃 Line + 1 张烘焙 Image（ADR-3）；(b) 统计零回读（ADR-2）；(c) 校准回读仅 100KB/500ms；(d) 不启用任何 filter、不 cache 笔迹（Q3）；(e) `layer.batchDraw()` 由 Konva 合并到单帧。预期每帧 CoverLayer 重绘 = 1 膜 drawImage + ≤2 笔迹绘制，移动端 60fps 无压力。
- **R6 多卡共存**：每张卡独立 Stage/Layer/子模块实例，事件监听挂在各自 `stage.content`（`Stage.js:393`），无共享 DOM 事件；禁改全局 `Konva.pixelRatio`（`Global.js:97`），DPR 差异通过各 Stage 构造参数隔离；离屏分析 canvas 每卡自持，`destroy()` 时置 `width=height=0` 释放。
- **R7 单测方案（零依赖）**：见第三部分"自测计划"。核心是把 area.js 与 reveal.js 设计为**纯函数/纯状态机**——输入线段数组与配置，输出 ratio 与布尔阈值事件，不 import Konva，Node 环境直接断言。

---

## 二、风险与边界清单

| # | 发生条件 | 后果 | 缓解 |
|---|---|---|---|
| 1 | 多指同时刮（`_pointerPositions` 含多个 id，`Stage.js:862-876`） | `getPointerPosition()` 只取 `[0]`（`Stage.js:249`），第二指轨迹丢失或跳变 | input.js 按 `evt.evt.pointerId` 分流，每指维护独立末点；或产品决策仅响应首指、忽略其余 |
| 2 | 未设 `touch-action: none` | 移动端 touchmove 被浏览器滚动劫持，刮两下页面跑了 | 构造时 inline 设置；同时 Konva 监听为 `passive:false`（`Stage.js:396`），必要时 `evt.preventDefault()` |
| 3 | 大图内存：800×500、DPR=3 → 位图 2400×1500×4B ≈ **14.4MB**/scene canvas | 每卡 2 层 scene（28.8MB）+ 2 张 hit（pixelRatio=1，`Layer.js:42-44`，共 3.2MB）+ 隔离缓冲，单卡峰值 ~35–45MB；多卡低端机 OOM/闪退 | 限制同屏卡数；`destroy()` 释放；必要时构造传更低 `pixelRatio`（如 min(dpr,2)，省 ~55% 内存） |
| 4 | 运行时 DPR 变化（拖窗口到副屏、系统缩放调整） | `Konva.pixelRatio` 只在 canvas 创建时读取（`Canvas.js:26-31`），旧 canvas 模糊/坐标换算错位 | 监听 `matchMedia('(resolution: Xdppx)')` change → 调 `setPixelRatio` + `setSize` 重建各层 canvas 并重绘；或整体 `reset()` |
| 5 | 隐藏 tab 时 rAF 停摆 | Tween/Animation 不推进，全清动画"卡住"；且 Chrome 可能清空不可见 canvas 内容 | Konva 已在 `visibilitychange` 时 `batchDraw()` 恢复画面（`Stage.js:101-105`）；reveal.js 的全清在动画外记录目标态，tab 恢复时若动画未完成则直接跳到终态（幂等完成） |
| 6 | 对笔迹节点误调 `cache()` | destination-out 失效，膜变透明洞或笔迹变实心（Q3） | 代码评审红线 + strokes.js 不暴露 cache；如需性能走 ADR-3 烘焙路径 |
| 7 | 笔迹放进 `isolated:true` 的 Group | 擦除被隔离画布吞掉，膜毫发无损（Q2） | 装饰节点才进 isolated Group；笔迹直属 CoverLayer，文档+类型注释固化 |
| 8 | 快速划动采样稀疏 | 直线连接出现未擦断点，面积统计与视觉同时失真 | ADR-3：coalesced 展开 + `brushSize/2` 步长插值 |
| 9 | 阈值判定用未校准 bitmask | 解析模型与真实位图漂移（圆头接头近似误差），极端时 45% 阈值早/晚触发 1–2% | 每 500ms 降采样校准（ADR-2）；阈值判定取校准后值 |
| 10 | 多卡共用全局状态（误改 `Konva.pixelRatio`、共享离屏 canvas） | 卡间互相污染（R6 被破坏） | 全部状态实例化；全局对象只读 |
| 11 | `getImageData` 跨域污染（cover 用外链无 CORS 图片） | 校准时抛 SecurityError，统计停在最后一次成功值 | cover 图片必须同源或 `crossOrigin='anonymous'`；校准失败降级为纯 bitmask 并 warn |
| 12 | destroy 后仍收到事件/动画回调 | 操作已销毁 stage 报错 | destroy 置标志位，所有回调入口短路；Tween 先 `finish()`/`destroy()` |

---

## 三、自测计划

### 3.1 验收用例表（浏览器手工/半自动）

| 用例 | 步骤 | 预期 |
|---|---|---|
| UC1 基本刮除 | 桌面 Chrome，鼠标按住划动 | 膜随轨迹透明，透出奖品；轨迹连续无断点 |
| UC2 触屏刮除 | 手机 Safari/Chrome 单指刮 | 同 UC1；页面不随刮擦滚动 |
| UC3 coalesced | Chrome DevTools 开高刷新模拟快速划动 | 轨迹平滑，无折线感（对比禁用展开的实现） |
| UC4 阈值全清 | 刮开约 45% 面积 | 触发 `onReveal`，膜 300ms 淡出消失，`onComplete` 恰好一次 |
| UC5 进度回调 | 匀速刮擦 | `onProgress` 单调递增，终值 ≈1 |
| UC6 奖品点击 | 刮开后点击奖品区域 | 奖品节点 click 触发；刮开前点击不穿透到奖品 |
| UC7 CSS 缩放 | 外层 `transform: scale(0.5)`，DPR=3 设备刮擦 | 轨迹与指针严格贴合，无漂移 |
| UC8 多卡 | 同页 3 张卡交替刮 | 各自统计/全清互不影响 |
| UC9 多指 | 双指同时刮 | 两指轨迹均正确（或按决策仅首指），无跳线 |
| UC10 隐藏 tab | 刮到阈值瞬间切走 tab 30s 切回 | 回来即见全清终态，无卡住的半透明膜 |
| UC11 大卡片性能 | 800×500、DPR=3 中端安卓连续刮 30s | 无可见掉帧；内存稳定在单卡预算内 |
| UC12 reset/destroy | reset 后再刮；destroy 后操作 | reset 后统计归零、膜复原；destroy 后无报错无回调 |

### 3.2 无浏览器环境的单测策略（零依赖，Node + `node:assert`）

**原则：被测逻辑与 Konva 解耦。** area.js / reveal.js 不 import Konva，只接收纯数据。

- **bitmask 统计（area.js）**：
  - 用例：单条水平线段 → 期望置位数 = `⌊len/cell⌋ × ⌊brush/cell⌋`（±1 cell 容差断言）；
  - 重叠线段不重复计数（ratio ≤ 1 且单调）；
  - 全画面覆盖 → `ratio === 1`；空输入 → `0`；
  - 边界：线段越界裁剪不抛错、不越界写。
- **阈值状态机（reveal.js，注入时钟）**：
  - `ratio` 序列 `[0.3, 0.44, 0.46]` 且 `threshold=0.45` → `onReveal` 恰在第三帧触发一次；
  - 重复上报超阈值 → 回调不重复（幂等）；
  - `reveal()` 直接调用 → 立即进入完成态；隐藏 tab 恢复路径（模拟"动画未完成+恢复"）→ 直接跳终态。
- **mock canvas 策略**：不引入 jsdom。手写最小 stub——`{ width, height, getContext: () => ({ getImageData: (x,y,w,h) => ({ data: new Uint8ClampedArray(w*h*4) }) }) }`——喂给校准模块，预填已知 alpha 图案（如左半 255 右半 0），断言校准后 ratio ≈ 0.5。坐标换算函数（Q5 公式）单独纯函数化，用 `clientX/rect.left/scale/pixelRatio` 参数化断言 `⌊(100−10)×3/0.5⌋ = 540`。
- **集成冒烟（可选，真实浏览器一轮）**：UC 表即验收脚本，不纳入单测。

---

**交付说明**：源码引用基于项目内已安装的 `node_modules/konva`（10.7.0，与 `package-lock.json` 锁定一致），关键行号已抽查核对（`Stage.js:248`、`Group.js:83`、`Node.js:2503`、`Layer.js:41-44`）。后续编码轮次可直接按 1.2 模块划分落地。
