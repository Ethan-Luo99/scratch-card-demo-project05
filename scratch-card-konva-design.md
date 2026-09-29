# 前端刮刮卡效果技术方案（Konva.js 10.7.0）

> 证据基准：所有源码引用均来自本项目已安装的 `node_modules/konva/lib/**`（版本 10.7.0，见 `node_modules/konva/package.json`）。引用格式为 `文件:行号` + 关键片段，行号已在本地实装源码上逐条复核。
>
> 硬性约束遵守声明：渲染全程走 Konva 体系；不在 stage canvas 上裸取 2D context 绘制；唯一的离屏 canvas 仅用于像素分析（getImageData 降采样）。

---

## 一、技术方案

### 1. 总体架构

**核心结论**：刮涂层独占一个 Layer，利用"该 Layer 持久化位图 + `destination-out` 临时笔迹"实现累积擦除；奖品层在另一个 Layer 且始终保留 hit graph；刮涂 Layer 永久 `listening(false)`，刮涂输入走挂在 `stage.content` 上的原生 Pointer Events（含 coalesced），不依赖 Konva hit graph。

```
DOM container (#card)
└── Konva.Stage（scaleX/scaleY 恒为 1；CSS 缩放由外部样式决定，Konva 自动折算）
    ├── prizeLayer  (Layer, listening=true)  奖品图/按钮：Konva.Image / Rect / Group
    └── coverLayer  (Layer, listening=false → hitCanvas 为 0×0，不拦截任何事件)
         位图状态机（scene canvas 持久化）：
           init  : clearBeforeDraw(true)  → 绘制封面 → layer.draw()
                   → 移除封面节点 → clearBeforeDraw(false)
           scratch: 每段笔迹一个临时 Konva.Line({globalCompositeOperation:'destination-out'})
                   add → layer.draw()（不清屏，在原位图上打洞）→ remove 回池
           reveal : CSS opacity 渐隐 layer 原生 canvas → 清空 → layer.draw()
stage.content（div.konvajs-content，内联 touch-action:none）
└── PointerController：pointerdown/move/up/cancel 原生监听
     └── evt.getCoalescedEvents() 逐条 → toLogical() → Map<pointerId,轨迹>
ProgressAnalyzer（rAF/定时器节流）
└── 独立 offscreen 低分辨率采样 canvas（仅用于像素分析）→ drawImage 缩小 → getImageData
```

支撑该架构的关键源码事实：

- 每个 Layer 拥有独立 canvas，Layer 内的合成模式**不会穿透到下层 Layer**。
  - `Stage.js:287-288`（`_toKonvaCanvas` 内注释原文）：
    `// every layer renders on its own canvas, like on screen, so a`
    `// globalCompositeOperation inside a layer does not reach the layers below`
  - `Layer.js:41-44`：`this.canvas = new SceneCanvas();` 与 `this.hitCanvas = new HitCanvas({ pixelRatio: 1 });`
- Layer 默认每帧清屏：`Layer.js:511` 为 `Factory.addGetterSetter(Layer, 'clearBeforeDraw', true);`，清屏发生在 `Layer.js:380-382`（`if (this.clearBeforeDraw()) { canvas.getContext().clear(); }`）。因此"每帧重绘封面+橡皮"的朴素写法无法累积擦除——这是持久化位图方案存在的根因。
- 描边型 `Konva.Line`（无填充、无阴影、opacity=1）不会触发隔离缓冲，合成模式直接作用于 Layer canvas：
  - `Shape.js:299` 起 `_useBufferCanvas` 仅在"填充+描边+半透明/阴影"时返回 true（判定见 `Shape.js:299-322`）；
  - 直绘分支 `Shape.js:533-546`：`context._applyOpacity(this); context._applyGlobalCompositeOperation(this); … drawFunc.call(this, context, this);`
  - `Context.js:647-653`：`_applyGlobalCompositeOperation(node)` 内 `const op = node.attrs.globalCompositeOperation; … this.setAttr('globalCompositeOperation', op);`
  - `shapes/Line.js:111` 起 `_sceneFunc`，开放线条最终走 `context.strokeShape(this)`（`shapes/Line.js:143`）。

### 2. 模块划分（预留 `src/scratch/**`）

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `src/scratch/index.js` | 对外唯一入口 | `ScratchCard` |
| `src/scratch/ScratchCard.js` | 门面类：装配、状态机、事件总线、销毁 | `ScratchCard` |
| `src/scratch/core/createStage.js` | 创建 Stage/Layer、**逐卡** DPR 设置（不写全局 `Konva.pixelRatio`） | `createStage(container, cfg)` |
| `src/scratch/core/pixelRatio.js` | `min(devicePixelRatio, cap)`、DPR 变更监听 | `resolvePixelRatio()` |
| `src/scratch/cover/CoverLayer.js` | 封面初始化、位图状态机、reset、reveal 过渡 | `CoverLayer` |
| `src/scratch/cover/Eraser.js` | 笔迹对象池（复用单个 `Konva.Line`），硬圆头/软圆刷两种 brush | `Eraser` |
| `src/scratch/input/PointerController.js` | 原生 Pointer Events、pointer capture、多指 Map、`touch-action` | `PointerController` |
| `src/scratch/input/coalesce.js` | 纯函数：coalesced 事件展开、轨迹抽稀/中点平滑、段切分 | `flattenEvents()`、`buildSegments()` |
| `src/scratch/input/geometry.js` | 纯函数：client 坐标→stage 逻辑坐标、位图坐标换算 | `toLogicalPoint()`、`toBitmapPixel()` |
| `src/scratch/analysis/ProgressAnalyzer.js` | 节流采样、阈值判定、回调只触发一次 | `ProgressAnalyzer` |
| `src/scratch/analysis/sampleCanvas.js` | offscreen 降采样 canvas（唯一允许的离屏 canvas 用途） | `SampleGrid` |
| `src/scratch/reveal/reveal.js` | 全清渐隐 + 可见性暂停时瞬时完成 | `runReveal()` |
| `src/scratch/core/events.js` | 事件名与状态枚举 | 常量 |


### 3. `ScratchCard` 公共 API

```js
const card = new ScratchCard(container, {
  width: 800,                 // 逻辑像素
  height: 500,
  cover: {                    // 三选一：纯色 / 图片 / 自定义 Konva 节点工厂
    type: 'image', src: '/cover.png',
    // type: 'color', value: '#b8860b'
    // type: 'nodes', factory: (layer) => [/* Konva 节点 */]
  },
  prize: {                    // 业务向 prizeLayer 添加节点；工厂接收 layer
    factory: (prizeLayer) => {
      // imageNode / btnNode ...
      return [imageNode, btnNode];
    },
  },
  brush: { radius: 22, shape: 'round', hardness: 1 }, // hardness<1 用径向渐变圆
  targetRatio: 0.5,           // 刮开比例阈值
  pixelRatioCap: 2,           // 大卡片移动端封顶 DPR，见 ADR-002/风险清单
  sampling: { width: 200, height: 125, intervalMs: 120, alphaCutoff: 16 },
  reveal: { durationMs: 260 },
  touchAction: 'none',        // 设置到 stage.content
  autoReveal: true,
});
```

- 配置：上表字段；另含 `enabled`（false 时直接呈现奖品并禁用输入）。
- 订阅：`on(event, cb)` / `off(event, cb)`。
- 事件：
  - `scratchstart`：`{ pointerId, x, y }`
  - `scratchmove`：`{ pointerId, x, y, progress }`
  - `scratchend`：`{ pointerId, progress }`
  - `progress`：`{ ratio, sampledAt }`（节流后）
  - `reveal`：`{ ratio }`（达阈值自动全清完成后，**保证只触发一次**）
  - `destroyed`
- 方法：`getProgress()`、`reveal(instant=false)`、`reset()`（回到全新封面，可换 cover）、`setEnabled(bool)`、`getStage()`（供业务给奖品节点挂事件）、`destroy()`。
- 状态机：`idle → scratching → revealing → revealed`；`destroyed` 为终态；`reset()` 回到 `idle`。
- 销毁契约：移除全部原生监听、释放 pointer capture、取消 rAF/定时器、解绑 DPR 媒体查询；调用 `stage.destroy()`。
  - `Stage.js:226-238`：`super.destroy()` 后清空 `_pointerStates`、从 DOM 移除 `content`（`content.parentNode.removeChild(content)`）、从 `stages` 摘除、`Util.releaseCanvas(this.bufferHitCanvas._canvas)`。
  - `Layer.js:470-473`：释放 scene/hit/隔离 canvas（`Util.releaseCanvas(this.getNativeCanvasElement(), this.getHitCanvas()._canvas)`）。

### 4. ADR：关键取舍

#### ADR-001 擦除渲染：Layer 持久化位图 + 临时 `destination-out` Line

- **备选 A（采纳）**：封面绘制一次后把封面节点移出图层，`layer.clearBeforeDraw(false)`；每段笔迹用临时 `Konva.Line({ globalCompositeOperation: 'destination-out' })`，`draw()` 后立即 remove 并回池。
  - 依据：清屏默认开启（`Layer.js:511`、清屏动作 `Layer.js:380-382`），关闭后 `layer.draw()` 保留既有像素；描边 Line 直绘 Layer canvas（`Shape.js:533-546` + `Context.js:647-653`），打洞直接落在封面位图上；节点图不增长，每事件开销 O(段长)。
- **备选 B（否决）：`Konva.Group({ isolated: true })` 内放封面 + 橡皮**。isolated 组把子树画进**透明隔离 canvas**，子节点的擦除只影响该隔离面内部，最终再整体合成回 Layer。
  - `Group.js:59-60` 文档原文："The group opacity and globalCompositeOperation apply once to the completed image."；`Group.js:60`："Child blend modes and erasing affect only the content inside that canvas."
  - 实现见 `Group.js:27` 的分支（`if (drawMethod !== 'drawScene' || !this.isolated() || top === this)`）与 `Group.js:33-45`：`canvas._prepareIsolationCanvas(...)` → `super._drawChildNodes(drawMethod, surface, top)` → `context._drawDeviceBuffer(surface)`。
  - 否决原因：每帧都要把整张封面+全部笔迹重绘到隔离面，大卡片开销随笔迹总量线性增长；隔离缓冲还有边界取整与抗锯齿差异，`Group.js:67-69` 文档已声明 "Moving the buffer origin changes native edge coverage … isolation does not promise pixel-identical antialiasing."
- **备选 C（否决）：橡皮节点 `cache()`**。见 Q3：快照只栅格化一次（`Node.js:306`），合成模式在快照回贴时才施加（`Node.js:445-452`），笔迹被冻结；要更新必须每次 `clearCache()` + `cache()` 全量重栅格化。
- **影响**：`CoverLayer` 必须自管"初始化清屏一次 / 之后不清屏 / reset 时恢复"三态；resize/DPR 变化时位图被 `setSize` 重置（`Canvas.js:113-119`：重设 width/height 即重分配 bitmap 并重置 context 状态），必须重绘封面（见风险 4）。

#### ADR-002 面积统计：节流的离屏降采样（默认）+ 脏矩形增量（备选）

- **采纳**：独立小尺寸 offscreen canvas（默认 200×125），每次采样 `drawImage(coverLayer.nativeCanvas → 200×125)` 后 `getImageData`，统计 alpha 通道小于 `alphaCutoff` 的像素占比。offscreen 仅用于像素分析，符合硬性约束；全程不碰 stage canvas 的 2D context。
- **量化（800×500 逻辑、DPR=3，bitmap 2400×1500）**：

| 策略 | 单次读取量 | 频率 | 数据带宽 | CPU 循环 | 误差 |
|---|---|---|---|---|---|
| 全量 `getImageData` | 3,600,000 像素 / 14.4 MB | 每事件 60–120 Hz | 0.86–1.7 GB/s | 360 万次/次 | 0 |
| 降采样 200×125（约 144×） | 25,000 像素 / 100 KB | 每 120 ms + pointerup | ≈0.83 MB/s | 2.5 万次 | 边界量化，实测 <0.5% |
| 脏矩形（Φ44 笔刷） | 约 3 万像素/次 | 每事件 | ~12 MB/s@100Hz | 需去重掩码 | 0，但复杂度高 |

- 阈值容差由 `targetRatio` 与采样粒度共同决定（25k 格时一格 = 0.004%）；在 `pointerup` 立即补采一次保证收口准确；计数提前结束（已数过 target 即停止遍历）。
- **不**对主 scene canvas 标记 `willReadFrequently`：该标志是 canvas 创建期上下文选项，库内仅 HitContext（`Context.js:797-800`）与 cache 的 filter canvas（`Node.js:290-293`，`willReadFrequently: true`）使用；主画面 canvas 由 `Layer.js:41` 无参构造。强行切换到 CPU 后端会拖慢每帧绘制——这正是用独立采样面的另一原因。

#### ADR-003 笔迹连续性：coalesced 展开 + pointerId 分轨 + 段内直线密采

- **采纳**：原生 `pointermove` 上取 `evt.getCoalescedEvents() ?? [evt]`，按 `pointerId` 维护 `Map`；同一指针相邻两点生成一段，点距超过阈值（如 2×brushRadius）时按弧长线性插值补点；Line 统一 `lineCap: 'round', lineJoin: 'round'`，配合高频 coalesced 点消除锯齿缝；可选 `tension` 中点平滑（`shapes/Line.js:119`：tension 分支调用 `context.quadraticCurveTo(...)`）。
- **否决：单个 `Konva.Line` 的 points 无限增长 + 每帧重绘**——在 clearBeforeDraw=false 的持久位图上每帧重画整条线只是重复打洞（无害但 O(n²)），points 数组与脏区无限增长。
- **否决：只监听 Konva 的 `pointermove`**——Konva 不透传 coalesced 事件：`Stage.js:388-396` 仅把原生事件转给 `_pointermove`，全库无 `getCoalescedEvents` 引用；且 `getPointerPosition()` 只返回 `_pointerPositions[0]`（`Stage.js:248-250`），天然不适合多指。

#### ADR-004 hit graph 策略：coverLayer 永久不参与命中，奖品层独立可点

- `coverLayer.listening(false)`：非监听 Layer 的 hitCanvas 保持 0×0（`Layer.js:201-207`：`_syncHitCanvasSize` 中 `this.hitCanvas.setSizeIfChanged((listening ? this.getWidth() : 0) || 0, ...)`），`_getIntersection` 在 hitCanvas 无尺寸时直接返回空（`Layer.js:360-361`：`if (!this.hitCanvas.width || !this.hitCanvas.height) { return {}; }`）。
- Stage 命中检测自顶向下逐层询问（`Stage.js:318-326`：`for (let n = end; n >= 0; n--) { const shape = layers[n].getIntersection(pos); ... }`），刮涂层被穿透，prizeLayer 上的奖品按钮在**刮的过程中也始终可命中**（业务侧可用 `enabled/revealed` 状态决定是否响应点击）。
- 橡皮 Line 作为该 Layer 子节点也永远不进 hit graph，无需逐节点 `listening(false)`。

### 5. 必答问题

#### Q1：在一个 Layer 内对 Rect 设 destination-out，能否擦除另一个 Layer 的奖品图像？为什么？

- **结论**：不能。合成模式只在所属 Layer 自己的 canvas 上与"该 canvas 上已有像素"运算，不能读取也不能改写别的 Layer 的位图。
- **证据**：
  - `Stage.js:287-288` 原文："every layer renders on its own canvas, like on screen, so a globalCompositeOperation inside a layer does not reach the layers below"。
  - `Layer.js:41`：每个 Layer 独立 `this.canvas = new SceneCanvas();`。
  - 合成模式作用点在当前 Layer 的 context 上：`Shape.js:533-541`（else 直绘分支）`context._applyGlobalCompositeOperation(this);` 紧接 `drawFunc.call(this, context, this)`；`Context.js:647-653` 把 `node.attrs.globalCompositeOperation` 设到当前 context。
- **对方案的影响**：擦除只能发生在封面**同一 Layer 内**；"封面 Layer + 奖品 Layer"两 Layer 结构天然安全，绝不会误伤奖品像素；反过来也不能指望用一块橡皮去擦别的 Layer。

#### Q2：Konva 10 中 Group 的 isolated 默认值？true/false 时子节点合成模式生效范围的区别？

- **结论**：默认 `false`。
  - `Group.js:12`：`@param {Boolean} [config.isolated=false] composite children as one live image`
  - `Group.js:83`：`Factory.addGetterSetter(Group, 'isolated', false, getBooleanValidator());`
- **false（默认）**：`_drawChildNodes` 走父类实现（`Group.js:27` 的条件命中即 `return super._drawChildNodes(...)`），子节点按序直接画入父 canvas；子节点的 `destination-out` 会作用于同一绘制面上此前已有的像素（普通 2D 合成语义）。Container 自身的 GCO 仅用 save/restore 包裹子树：`Container.js:378-391`（`hasComposition` 时 `context.save(); context._applyGlobalCompositeOperation(this);` … `finally { context.restore(); }`）。
- **true**：子树改画入一块透明隔离 surface，再整体回贴：`Group.js:33` `const surface = canvas._prepareIsolationCanvas(...)`，`Group.js:39` `super._drawChildNodes(drawMethod, surface, top)`，`Group.js:40-41` `context._applyOpacity(this); context._drawDeviceBuffer(surface)`。子节点的混合/擦除只影响该隔离面内部（`Group.js:60`："Child blend modes and erasing affect only the content inside that canvas."），组自身 opacity/GCO 只在回贴时施加一次（`Group.js:59`）。
- **对方案的影响**：本方案不使用 isolated Group（ADR-001 备选 B 已否决）。若业务要在封面内部把"底纹+文字"作为整体再做层内混合，isolated 是唯一不被橡皮打穿组外内容的手段，但须接受每帧整组重栅格化与边缘像素差异。

#### Q3：对 destination-out 节点调用 cache() 会怎样？为什么？

- **结论**：擦除被冻结成一次性快照，无法随移动累积；且在"缓存自身"的栅格化阶段根本不施加合成模式。
- **证据**：
  - `cache()` 在构建期把节点自绘到一块独立 SceneCanvas：`Node.js:306`：`this.drawScene(cachedSceneCanvas, this);`。
  - `Shape.drawScene` 在 `cachingSelf`（`top === this`）时跳过 opacity 与 GCO：`Shape.js:524-527` 注释原文 "if we are caching self, we don't need to apply opacity and global composite operation because it will be applied in the cache"，对应 `if (!cachingSelf) { context._applyOpacity(this); context._applyGlobalCompositeOperation(this); }`。
  - 快照回贴到目标 canvas 时才施加节点自身的 GCO：`Node.js:445-452`（`_drawCachedSceneCanvas`）：`context._applyOpacity(this); context._applyGlobalCompositeOperation(this); … context.drawImage(cacheCanvas._canvas, 0, 0, cacheCanvas.width / ratio, cacheCanvas.height / ratio);`。
- **对方案的影响**：橡皮节点 cache 后每次绘制都拿同一张栅格快照做一次固定形状打洞；要更新只能 `clearCache()`（`Node.js:205` 声明的 API）后重新全量 `cache()`。封面 Rect 也**不能**预先 cache（否则首帧回贴就自带 destination-out 语义）。方案中 cover/eraser 全部禁 cache。

#### Q4：globalCompositeOperation 是否影响节点 hit graph？对 R4 意味着什么？

- **结论**：不影响。hit graph 绘制在独立的 hitCanvas 上，`Shape.drawHit` 完全不调用 `_applyGlobalCompositeOperation`。
- **证据**：
  - `Shape.js:558-591`（`drawHit`）：只做 transform（`context.transform(o...)`）后直接 `drawFunc.call(this, context, this)`，无任何合成模式设置；hit 填充使用 colorKey（`Context.js:801-806`：`HitContext._fill` 中 `this.setAttr('fillStyle', shape.colorKey); shape._fillFuncHit(this);`）。
  - hitCanvas 与 scene canvas 是两块画布：`Layer.js:41-44`（`new SceneCanvas()` 与 `new HitCanvas({ pixelRatio: 1 })`）。
  - `Group.js:62` 文档直接点明："Hit testing keeps its normal behavior, including hits on erased content."
- **对 R4 的意味**：被 destination-out 擦成全透明的封面，其节点在 hit graph 上**依然会被命中**，不能指望"擦空了自然点穿"。必须显式让封面 Layer `listening(false)`（`Layer.js:201-207` + `Layer.js:360-361`），或在 reveal 后 remove/destroy 封面节点；奖品层保持 `listening(true)` 且位于下层，由 Stage 自顶向下的检测顺序（`Stage.js:318-326`）在封面层无命中时落到奖品节点。

#### Q5：getPointerPosition() 处于哪个坐标系？DPR=3 且 stage 被 CSS 缩放 0.5 时到 bitmap 像素的精确换算公式？

- **结论**：返回 **stage 逻辑坐标系**（单位等同 CSS 像素，原点为 content 左上角），不含 stage 自身 transform；CSS 缩放已在内部折算掉，DPR 不参与该返回值。
- **证据**：
  - `Stage.js:240-247` 注释："returns ABSOLUTE pointer position … pointer position doesn't include any transforms (such as scale) of the stage, it is just a plain position of pointer relative to top-left corner of the canvas"；实现 `Stage.js:248-256` 直接返回 `{ x: pos.x, y: pos.y }`。
  - 坐标生成（pointer/mouse 分支）`Stage.js:881-882`：
    `x = (evt.clientX - contentPosition.left) / contentPosition.scaleX`
    `y = (evt.clientY - contentPosition.top) / contentPosition.scaleY`
  - 其中 CSS 缩放系数来自视口实测：`Stage.js:906-912`：`const rect = this.content.getBoundingClientRect(); … scaleX: rect.width / this.content.clientWidth || 1`。
  - touch 分支同理：`Stage.js:865-866`、`Stage.js:872-873`（`(touch.clientX - contentPosition.left) / contentPosition.scaleX`）。
  - 逻辑 → bitmap：scene canvas 物理像素 = 逻辑 × pixelRatio。`Canvas.js:96`：`return Math.floor((size || 0) * this.pixelRatio);`；`Canvas.js:117`：`context.scale(pixelRatio, pixelRatio);`。
- **本场景（DPR=3，CSS 缩放 0.5；设 content.clientWidth=800，getBoundingClientRect().width=400）**：

```
cssScale = rect.width / content.clientWidth = 0.5

xLogical = (clientX - rect.left) / cssScale             // = 2·(clientX-rect.left)
xBitmap  = Math.floor(xLogical * dpr)                   // = floor(6·(clientX-rect.left))

合并式（client 视口坐标 → scene bitmap 像素）：
xBitmap  = Math.floor((clientX - rect.left) * dpr / cssScale)   // dpr/cssScale = 3/0.5 = 6
yBitmap  = Math.floor((clientY - rect.top)  * dpr / cssScale)
```

  - 反向（分析采样）：`xLogical = xBitmapSample / dpr`。
  - hitCanvas 恒为 `pixelRatio: 1`（`Layer.js:42-44`），命中检测 `Layer.js:326` 为 `Math.floor(pos.x * ratio)` 且 ratio=1，故 hit 坐标就是逻辑坐标，无需 DPR 换算。
  - 方案约束：保持 stage scale 恒为 1，缩放只由外部 CSS 施加（不使用 `stage.scale()`），因此 Konva 的 clientRect 折算与本公式恒成立。

#### Q6：用 getImageData 统计面积：读哪个 canvas？逐事件全量读的开销？两种优化策略并量化对比。

- **读哪个 canvas**：封面 Layer 的 **scene canvas**，即 `coverLayer.getCanvas()._canvas`（物理尺寸 = 逻辑宽高 × 本 Layer pixelRatio）。不能读 hitCanvas：它 `pixelRatio: 1`（`Layer.js:42-44`），且装的是 colorKey 命中色而非真实 alpha。统计量为采样区内 alpha 通道 `< alphaCutoff` 的像素占比；采纳方案读的是从 scene canvas `drawImage` 缩小后的独立分析 canvas（仅像素分析用途）。
- **逐事件全量读开销（800×500、DPR=3，bitmap 2400×1500）**：
  - 每次 `getImageData` 拷贝 2400×1500×4 = **14,400,000 字节 ≈ 14.4 MB**；
  - 100 Hz 事件率 = 1.44 GB/s 内存读回 + 3.6 亿次/秒 alpha 比较；
  - GPU 合成后端上同步 `getImageData` 会强制管线 flush 与 CPU-GPU 回读，单帧 16.7 ms 预算必然击穿。DPR=2 仍有 6.4 MB/次，DPR=1 有 1.6 MB/次，均不可逐事件。
- **策略一（采纳）：离屏降采样 + 时间节流**。
  - 独立 canvas 固定 200×125：单次 100 KB、2.5 万次比较；每 120 ms 采样一次并在 pointerup 补采，带宽 ≈ 0.83 MB/s。
  - 相对"全量@100Hz"：数据量降低 144 倍、频率降低约 12 倍，综合回读开销降低约 **1700 倍**。
  - 误差来自缩放重采样（格精度 1/25000 = 0.004%），阈值前 5% 区间内自动把采样间隔减半加密，pointerup 强制终采。
- **策略二（备选）：脏矩形增量计数**。
  - 维护 1 字节/像素的"已计数"掩码（2400×1500 ≈ 3.6 MB）；每次只在笔刷包围盒内 `getImageData(x, y, w, h)`（Φ44 逻辑笔刷在 DPR=3 下约 132×132 ≈ 7 万像素/次，约 280 KB），仅对未计数像素累加刮开数。
  - 复杂度与笔画长度相关而非总面积，无采样误差；代价是去重/段合并逻辑复杂、掩码常驻内存，作为高精度备选，默认不启用。

### 6. R1–R7 逐条实现要点

- **R1 鼠标+触屏刮涂，支持 coalesced**：只绑 Pointer Events（`pointerdown/move/up/cancel/gotpointercapture/lostpointercapture`），统一鼠标/触摸/笔；pointerdown 时对 `stage.content` 调 `setPointerCapture(pointerId)`；move 中 `Array.from(evt.getCoalescedEvents?.() ?? [evt])` 逐条用 Q5 公式转逻辑坐标喂给分轨 Map。不用 Konva 事件承载坐标（不透传 coalesced：`Stage.js:388-396`；多指针只取第 0 个：`Stage.js:248-250`），但 Konva 的 content DOM 仍可复用。
- **R2 刮开面积实时统计、达阈值自动全清并回调**：`ProgressAnalyzer` 按"时间间隔 + 最小移动距离"双节流，用 ADR-002 降采样计算 ratio 并派发 `progress`；达到 `targetRatio`（连续两次确认）→ 状态机置 `revealing`、冻结输入 → `reveal()`（coverLayer 原生 canvas 的 CSS opacity 渐隐，结束后清空位图）→ `reveal` 事件通过"达标标记 + 状态机"保证恰好一次。
- **R3 高 DPR + CSS 缩放坐标不漂移**：Stage 尺寸用逻辑像素；**逐卡**对两个 Layer 的 scene canvas 调 `setPixelRatio(r)`（`Canvas.js:77-80`，内部 `setSize` 重建位图），不写全局 `Konva.pixelRatio`（`Global.js:97`）；坐标全部走 Q5 公式；外部 CSS 任意 transform 缩放下落点与视觉重合。
- **R4 刮开后奖品层可点击**：prizeLayer `listening(true)` 正常建 hit graph；coverLayer `listening(false)`（hitCanvas 0×0：`Layer.js:201-207`，`_getIntersection` 直接返回空：`Layer.js:360-361`）；奖品按钮用 Konva 节点 `on('click tap')`，刮前/刮中/刮后均可命中，业务在回调中依据 `card.state` 决定"未刮完不可领"。
- **R5 大卡片（≥800×500 逻辑像素）移动端不掉帧**：(1) DPR 封顶 `pixelRatioCap=2`，scene bitmap 上限 1600×1000；(2) 持久化位图，每帧只画一段短 Line，不重绘封面，Line 节点回池复用、节点数恒定；(3) 统计走离屏降采样且节流，主线程零全量回读；(4) 一帧内多段 coalesced 笔迹在同一个 rAF 回调里 `add→draw→remove`，每帧最多一次 `layer.draw()`（Konva 的 `batchDraw` 本身即 rAF 合并：`Layer.js:277-289` + `Util.requestAnimFrame` 每窗口每帧只调度一次，`Util.js:576-588`）；(5) 不使用 filter/cache/shadow/isolated。
- **R6 同页多张互不干扰**：每卡独立 Stage、container、原生监听、rAF/定时器、pointer Map；DPR 只设置本卡两个 canvas（`Canvas.js:77`），禁止改 `Konva.pixelRatio` 全局（`Global.js:97`）；模块内无可变单例；销毁时 content DOM 被移除（`Stage.js:233-234`）；多卡采样时刻按实例序号加微抖动错峰，避免同一帧集中回读。
- **R7 面积统计与阈值逻辑的单测方案（不引入依赖）**：见第三部分。几何换算、coalesced 展开、阈值状态机、采样计数全部实现为不 import konva 的纯函数/可注入模块（canvas 工厂、时钟、rAF 均由构造参数注入），用 Node 内置 `node:test` + `node:assert/strict` 与手写 canvas stub 测试。

---

## 二、风险与边界清单

格式：**发生条件 → 后果 → 缓解**。

1. **多指触控串轨 / 指针泄漏**：两指及以上同时刮，或 `pointerup`/`pointercancel` 因浏览器异常丢失 → 轨迹从一指跳到另一指、`Map<pointerId>` 无限增长、已抬起的指的最后位置被复用。缓解：按 `pointerId` 分轨；`pointerup`、`pointercancel`、`lostpointercapture` 三路统一清理；Konva 自身只暴露第 0 个指针位置（`Stage.js:248-250`），故输入必须走原生事件自管，不依赖 `getPointerPosition()`。
2. **touch-action 与页面滚动冲突**：容器位于可滚动页面且未声明 touch-action → 浏览器接管纵向手势，pointermove 流被掐断（touch-action 非 none 时触摸序列会被取消）。缓解：由 `PointerController` 在 `stage.content` 上设置内联 `touch-action: none`（配置项 `touchAction`），仅刮刮卡区域阻断滚动手势，卡片外区域滚动不受影响；不依赖对 passive 监听 `preventDefault()`（Konva 内部绑定虽为 `{ passive: false }`，见 `Stage.js:393-395`，我们自己的监听也显式声明 passive:false 但只在必要时 preventDefault）。
3. **大图内存估算（宽×高×DPR²×4 字节）**：800×500、DPR=3 单卡 → cover scene bitmap 2400×1500×4 = **14.4 MB**；prize scene 同尺寸 = 14.4 MB；hitCanvas 恒为 DPR=1（`Layer.js:42-44`）= 800×500×4 = 1.6 MB，但 coverLayer `listening(false)` 时为 0×0 不占（`Layer.js:201-207`）；单卡合计约 **30.4 MB**，N 张同屏约 30.4N MB；离屏采样面 200×125×4 ≈ 0.1 MB。缓解：`pixelRatioCap=2`（单卡降到 2×800×500×4 + 1.6 MB ≈ 14.4 MB）；多卡懒挂载，滚出视口的卡片 `destroy()` 或临时降到 cap=1.5；封面/奖品一律不 cache（避免再复制一份全尺寸位图，见 Q3）。
4. **devicePixelRatio 运行时变化**：跨显示器拖窗、浏览器缩放、移动端外接屏/旋转触发 DPR 改变 → `Canvas.setSize` 重新分配 bitmap 并重置全部 context 状态（`Canvas.js:113-119` 注释原文："Assigning a dimension reallocates the bitmap and resets the whole context state"），持久化封面与已刮洞全部清空，统计归零且 `clearBeforeDraw(false)` 状态下不会自动补画。缓解：`matchMedia('(resolution: Xdppx)')` change + 容器 `resize`（去抖 200ms）统一走 rebuild：重设 pixelRatio → CoverLayer 回到 NEEDS_PAINT 重绘全新封面 → 状态/进度 reset 并通知业务；刮涂中途 DPR 变化属极端边界，明确选择"重置"而非位图迁移。
5. **隐藏 tab 时 rAF 停摆影响全清动画**：达阈值瞬间或 reveal 渐隐中途切到后台标签页 → rAF 挂起（`Util.js:459-467`：底层就是 `window.requestAnimationFrame`），渐隐冻结在半透明、`reveal` 回调迟迟不发。缓解：reveal 优先用 CSS transition（不占 JS 帧）+ `transitionend` 与 `durationMs×1.2` 兜底定时器双完成路径；监听 `document.visibilitychange`，进入 hidden 时立即跳到终态（opacity=0、清空、触发一次 `reveal`）。
6. **clearBeforeDraw=false 的状态污染**：reset 后忘记恢复首帧清屏，或 resize 隐式清空位图后仍以为封面存在 → 旧刮痕残留，或封面被系统清掉后橡皮在空位图上"擦空气"。缓解：CoverLayer 显式三态 `NEEDS_PAINT / PERSISTENT / DESTROYED`；reset/rebuild 一律先 `clearBeforeDraw(true)` 重绘首帧再切 false（开关定义 `Layer.js:511`，清屏动作 `Layer.js:380-382`），转换只能走单一入口。
7. **快速划线断续/空洞**：不支持 coalesced 的旧内核或高刷屏单帧位移大于笔刷半径 → 相邻圆点不相交，出现虚线状漏擦。缓解：相邻点距离 > `brushRadius` 时沿线段按 0.5×半径步长线性插值补点；`lineCap/lineJoin: 'round'`；必要时开 `tension:0.5` 二次曲线平滑（`shapes/Line.js:119`）。
8. **软边笔刷导致阈值口径抖动**：`hardness<1` 径向渐变边缘产生大量半透明像素，alpha 在 `alphaCutoff` 附近徘徊 → progress 在阈值上下振荡、重复触发全清。缓解：状态机保证 `reveal` 只发一次；`alphaCutoff` 固定常量（默认 16）；达标需连续两次采样确认，pointerup 立即终采收口。
9. **跨域图片污染 canvas**：封面/奖品 `Image` 未带 CORS 响应头 → drawImage 后 canvas 被标记 tainted，`getImageData` 抛 SecurityError，统计永久失效（库内对同类污染有报错先例：`Canvas.js:138-150` 的 toDataURL taint 错误处理）。缓解：图片服务端配置 CORS 并设置 `crossOrigin='anonymous'`；采样器 try/catch，失败时降级为"笔迹覆盖并集估算"（基于笔画几何面积）并派发 `progress-error` 事件，不抛未捕获异常。
10. **零尺寸容器初始化**：卡片在 `display:none`/折叠面板/未布局完成时初始化 → clientWidth 为 0（`Stage.js:910-912` 对此有 scale 回退 1，但坐标仍失真），canvas 位图为空、CSS 缩放比例无意义。缓解：构造时断言容器宽高 >0，否则不创建 Stage，改用 `ResizeObserver`/`IntersectionObserver` 等首次获得非零尺寸再初始化。
11. **监听/定时器/rAF 泄漏**：SPA 反复挂载卸载但未调用 destroy → 原生监听、媒体查询、采样定时器、rAF 句柄累积。缓解：`destroy()` 幂等：移除全部原生监听、取消定时器/rAF、`stage.destroy()` 移除 content DOM（`Stage.js:226-238`）、释放 canvas（`Layer.js:470-473`）；提供 `destroyed` 状态防止销毁后入队绘制。
12. **跨卡 pointer capture 边界**：一卡 capture 后手指滑到相邻卡片 → 后续 move 全部路由给首卡，第二张卡无响应。缓解：认定为预期（一次刮涂会话从属于一张卡），pointerup/cancel 释放后恢复；不做跨卡笔迹续接；文档中明确该交互边界。
13. **canvas 面积/边长上限**：老旧 iOS Safari 对 bitmap 边长或总面积有上限，超限后 canvas 静默退化为空白 → 封面不显示且坐标看似正常。缓解：逻辑尺寸与 `pixelRatioCap` 双重钳制（bitmap 最大边 ≤ 4096，超大屏再降 cap）；初始化后做一次 1×1 `getImageData`（在采样面上）探活。
14. **120Hz 高刷屏事件洪峰**：ProMotion 类设备 coalesced 事件翻倍 → add/draw 过频挤占主线程。缓解：渲染与采样解耦——事件只入轨迹队列，所有 add→draw→remove 收敛到每帧一个 rAF（每帧最多一次 layer.draw）；采样仍按固定 120ms 时间窗。
15. **误用 isolated/cache 的回归风险**：后续维护者给封面套 isolated Group 或给橡皮加 cache → 前者性能逐帧劣化且边缘像素不一致（`Group.js:67-69`），后者笔迹冻结（Q3）。缓解：在 CoverLayer/Eraser 模块顶部注释固化禁用项；代码评审清单检查；单测断言 Eraser 产出节点不存在 `_canvasCache` 且 Group 的 isolated 恒为默认 false。

---

## 三、自测计划

### 1. 验收用例表

| 用例 | 步骤 | 预期 |
|---|---|---|
| UC1 基础鼠标刮涂 | 桌面浏览器在卡片上按下拖动约 1s | 出现连续无断点圆头轨迹，松键停止；轨迹处封面透明、露出奖品 |
| UC2 触屏刮涂 | 移动端单指涂抹约 40% 面积 | 轨迹跟手；触摸期间页面不滚动；`progress` 持续上升 |
| UC3 快速划线/高刷 | 触摸模拟下快速横扫 | 无空洞（插值补点生效），轨迹为连续带状 |
| UC4 coalesced 展开 | 派发一个携带 5 个 `getCoalescedEvents()` 的伪 pointermove | 5 个点全部落线；段长度/点数与事件序列一致 |
| UC5 达阈自动全清 | 刮至 ≥ targetRatio（50%） | 触发一次渐隐全清；`reveal` 恰好触发 1 次；此后涂抹不再产生擦除 |
| UC6 阈值抖动 | mock 采样结果在 49%/51% 间往返 3 次 | 未连续确认不全清；一旦确认只触发一次，不重复 |
| UC7 高 DPR + CSS 缩放 | DPR=3、容器 `transform: scale(0.5)`，点按视觉中心 | 落点与视觉中心误差 ≤1 物理像素；用 Q5 公式对账一致 |
| UC8 DPR 运行时变化 | 模拟 resolution 媒体查询变化 | 封面重绘为初始态、进度归零、状态 reset、无残留洞 |
| UC9 奖品点击（R4） | 刮透一小块后点按其中"领奖"按钮 | 命中按钮并触发其 click/tap；未刮透区域点按封面无反应 |
| UC10 reveal 前后点击 | 分别在未刮时与全清后点按奖品按钮 | hit graph 始终只在 prizeLayer；业务依状态门控生效 |
| UC11 大卡性能 | 800×500、cap=2，移动端连续刮 60s | 交互帧无明显掉帧；无长任务持续 >16.7ms；scene bitmap 内存符合估算 |
| UC12 多卡并存 | 同页放置 ≥10 张卡，分别刮第 1/5/10 张 | 三张卡进度、全清、重置互不影响；全局 `Konva.pixelRatio` 未被修改 |
| UC13 多指触控 | 双指同刮 → 抬起一指 → 余指继续 | 两指轨迹各自连续不串轨；抬指后余指正常；Map 无残留 |
| UC14 touch-action | 卡片区域纵向滑动 / 卡片外区域滚动 | 卡内不滚页；卡外页面正常滚动 |
| UC15 隐藏标签页 | reveal 渐隐中途切后台 2s 再切回 | 回来时已是全清终态，`reveal` 已触发，不卡在半透明 |
| UC16 销毁 | `destroy()` 后再派发事件并检查 DOM | content 节点已移除（`Stage.js:233-234`）、监听/定时器全清；重复 destroy 幂等 |
| UC17 重置 | 刮 30% 后 `reset()` | 封面完整恢复、progress=0、状态回 idle、可重新刮 |
| UC18 跨域图降级 | 封面图无 CORS 响应头 | 采样器捕获异常、派发 `progress-error` 并走几何估算降级，无未捕获异常 |
| UC19 零尺寸容器 | 在 `display:none` 容器中构造，稍后显示 | 不在 0 尺寸时建 Stage；首次获得尺寸后自动初始化且功能正常 |

### 2. 无浏览器环境 mock canvas 的单测策略（零新增依赖）

- **运行载体**：Node 内置 `node:test` + `node:assert/strict`（当前 Node 环境自带，无需安装）。测试文件放 `src/scratch/__tests__/`，以 `node --test` 直接运行；不修改 `package.json`、不新增任何依赖。
- **分层原则**：
  1. 纯逻辑模块（`geometry.js`、`coalesce.js`、采样计数、阈值状态机、CoverLayer 状态机）**不 import konva**，Konva 适配层薄到只做对象组装；
  2. 所有环境能力（canvas 工厂、`now()`、rAF、媒体查询、事件绑定目标）通过构造参数注入，测试中传入 stub；
  3. 真实像素合成语义（destination-out、hit graph 行为）不试图在 mock 中复刻，改由本方案源码引用 + UC1–UC19 浏览器验收兜底。
- **最小 2D context stub（手写约 60 行）**：记录调用序列，并用一个可程序化挖洞的 alpha 网格模拟 `drawImage` 降采样与 `getImageData`：

```js
function createCtxStub(width, height) {
  const alpha = new Uint8Array(width * height).fill(255);
  const calls = [];
  return {
    _alpha: alpha, _w: width, _h: height, calls,
    canvas: { width, height },
    save() { calls.push('save'); },
    restore() { calls.push('restore'); },
    scale() {}, translate() {}, transform() {}, setTransform() {},
    clear() {}, clearRect() {},
    beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {},
    strokeShape() {}, drawImage() { calls.push('drawImage'); },
    getImageData(x, y, w, h) {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        const px = x + (i % w), py = y + Math.floor(i / w);
        data[i * 4 + 3] = alpha[py * this._w + px];
      }
      return { data, width: w, height: h };
    },
    set globalCompositeOperation(v) { calls.push(['gco', v]); },
    get globalCompositeOperation() { return 'source-over'; },
  };
}
// 降采样 stub 的 drawImage：把"源 alpha 网格"按最近邻写入自身缓冲，
// 使 ProgressAnalyzer 的计数结果可精确预期。
```

- **测试用例与断言**：
  1. **坐标换算**（`geometry.js`）：参数化 DPR ∈ {1,2,3} × cssScale ∈ {0.5,1,1.25}，断言 Q5 的 logical/bitmap 公式（含 `Math.floor`）；与 UC7 真机结果交叉对账。
  2. **coalesced/分轨**（`coalesce.js`）：1 原生事件 + N 个 coalesced → 段数、点序正确；两 pointerId 交错事件 → 不串轨；100px 跳跃 → 插值点数 = `ceil(dist / step)+1`。
  3. **阈值状态机**（`ProgressAnalyzer`）：注入假时钟；验证 120ms 内多次 move 只采一次；阈值附近需连续两次确认；达标后停止计数且 `reveal` 回调计数恒为 1；pointerup 触发立即终采。
  4. **采样计数**（`sampleCanvas.js`）：用 alpha 网格构造已知孔洞比例，断言结果在量化误差带内（≤ 1/格数 + 0.5%）；全不透明=0、全透明=1；异常（stub 抛 SecurityError）→ 派发 `progress-error` 并走降级。
  5. **CoverLayer 状态机**：假 Layer 双桩记录 `clearBeforeDraw/draw/add/remove/setPixelRatio` 调用序，断言：init 首帧清屏并画封面、随后切持久态；scratch 每段严格按 add→draw→remove；reset/rebuild 回到 NEEDS_PAINT；Eraser 产出节点不带 `_canvasCache`（防 Q3 回归）。
  6. **PointerController**：content stub 记录 `addEventListener/removeEventListener/setPointerCapture`；断言绑定事件名集合、destroy 全部解绑、`touch-action` 内联样式被设置；派发伪 pointer 事件链验证多指 Map 生命周期与 cancel 清理。
  7. **reveal**：注入可手动排空的假 rAF 队列与可见性开关；断言正常渐隐到终态、hidden 时立即跳终态、回调只发一次。
- **禁区**：不引入 jsdom/canvas/vitest 等任何依赖；不调用真实 Konva；不修改 `package.json` 的 scripts（必要时在文档中给出 `node --test src/scratch/__tests/` 命令，由执行者按需落地）。

---

## 附：源码证据索引

所有路径相对于 `node_modules/konva/lib/`（版本 10.7.0）。

| 主题 | 位置 | 关键内容 |
|---|---|---|
| Layer 独立 scene/hit canvas | `Layer.js:41-44` | `new SceneCanvas()`；`new HitCanvas({ pixelRatio: 1 })` |
| GCO 不跨 Layer | `Stage.js:287-288` | "globalCompositeOperation inside a layer does not reach the layers below" |
| 默认每帧清屏 / 清屏动作 | `Layer.js:511`；`Layer.js:380-382` | `clearBeforeDraw` 默认 true；`canvas.getContext().clear()` |
| 非监听 Layer 的 hitCanvas 为 0×0 | `Layer.js:201-207`；`Layer.js:360-361` | `_syncHitCanvasSize`；`if (!this.hitCanvas.width || !this.hitCanvas.height) return {}` |
| Stage 自顶向下命中检测 | `Stage.js:315-327` | `for (let n = end; n >= 0; n--) layers[n].getIntersection(pos)` |
| 描边 Line 直绘并施加 GCO | `Shape.js:533-546`；`Context.js:647-653`；`shapes/Line.js:111-145` | `_applyGlobalCompositeOperation` 后直接 `drawFunc`；开放线走 `strokeShape` |
| 缓冲画布仅半透明/阴影等场景启用 | `Shape.js:299-322`；`Shape.js:749` | `_useBufferCanvas` 判定；`perfectDrawEnabled` 默认 true |
| drawHit 不施加 GCO | `Shape.js:558-591`；`Context.js:797-806` | hit 路径无合成设置；HitContext 用 colorKey 填充 |
| isolated 默认 false 与隔离绘制 | `Group.js:12`；`Group.js:27-45`；`Group.js:57-70`；`Group.js:83` | 子树画入隔离 surface 再 `_drawDeviceBuffer`；擦除只限组内；hit 行为不变 |
| Container 自身 GCO 的 save/restore | `Container.js:378-391` | `hasComposition` 分支 |
| cache 构建期不施加 GCO | `Node.js:255`；`Node.js:306`；`Shape.js:524-527` | cachingSelf 时跳过 opacity/GCO |
| 缓存快照回贴时才施加 GCO | `Node.js:445-453` | `_drawCachedSceneCanvas` 中 `_applyGlobalCompositeOperation` + `drawImage` |
| clearCache API | `Node.js:205` | `clearCache() {` |
| 指针逻辑坐标与 CSS 缩放折算 | `Stage.js:240-256`；`Stage.js:852`；`Stage.js:865-866`；`Stage.js:881-882`；`Stage.js:897-913` | `(clientX - rect.left) / scaleX`；scaleX = `rect.width/clientWidth` |
| bitmap = 逻辑 × pixelRatio | `Canvas.js:77-80`；`Canvas.js:96`；`Canvas.js:113-119` | `setPixelRatio→setSize`；`_bitmapSize`；分配后 `context.scale(pr,pr)` |
| 全局 pixelRatio 默认值 | `Global.js:97` | `window.devicePixelRatio || 1`（禁止多卡场景改写全局） |
| rAF 调度与批量合并 | `Layer.js:277-289`；`Util.js:459-467`；`Util.js:576-588` | `batchDraw`；底层 `requestAnimationFrame`；每帧共享队列 |
| 原生事件绑定（无 coalesced 透传） | `Stage.js:388-396` | content 上 `{ passive: false }` 绑定，全库无 `getCoalescedEvents` |
| 多指只取第 0 个指针 | `Stage.js:248-250` | `_pointerPositions[0] || _changedPointerPositions[0]` |
| canvas 污染错误先例 | `Canvas.js:136-150` | toDataURL 的 Tainted_Canvas 错误处理 |
| willReadFrequently 仅用于 hit/filter | `Context.js:797-800`；`Node.js:290-293` | HitContext 与 cache filter canvas |
| 销毁释放 | `Stage.js:226-238`；`Layer.js:470-473` | 移除 content DOM、移出 stages、释放各 canvas |
