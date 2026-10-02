import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CoverLayer, CoverState } from '../cover/CoverLayer.js';
import { Eraser } from '../cover/Eraser.js';

// 假 Layer 双桩：记录 clearBeforeDraw/draw/add/remove 调用序
function createLayerStub(log) {
  return {
    clearBeforeDraw(v) { log.push(['clearBeforeDraw', v]); },
    add(node) { log.push(['add', node.id]); },
    draw() { log.push(['draw']); },
  };
}

function createNodeStub(id, log) {
  return {
    id,
    remove() { log.push(['remove', id]); },
  };
}

function makeEraser(log) {
  let seq = 0;
  const makeNode = (kind) => {
    const node = {
      id: `${kind}${seq++}`,
      kind,
      attrs: {},
      cacheCalls: 0,
      setAttrs(a) { Object.assign(this.attrs, a); },
      getClassName() { return kind === 'circle' ? 'Circle' : 'Line'; },
      cache() { this.cacheCalls++; },
      remove() { log.push(['remove', this.id]); },
    };
    return node;
  };
  const eraser = new Eraser({
    createLine: () => makeNode('line'),
    createCircle: () => makeNode('circle'),
  });
  return eraser;
}

function setup() {
  const log = [];
  const layer = createLayerStub(log);
  const eraser = makeEraser(log);
  const cover = new CoverLayer({
    layer,
    eraser,
    createCoverNodes: () => [createNodeStub('cover0', log), createNodeStub('cover1', log)],
  });
  return { log, layer, eraser, cover };
}

test('init 调用序：清屏绘膜 → 移除封面节点 → 切持久态', () => {
  const { log, cover } = setup();
  assert.equal(cover.state, CoverState.NEEDS_PAINT);
  cover.init();
  assert.deepEqual(log, [
    ['clearBeforeDraw', true],
    ['add', 'cover0'],
    ['add', 'cover1'],
    ['draw'],
    ['remove', 'cover0'],
    ['remove', 'cover1'],
    ['clearBeforeDraw', false],
  ]);
  assert.equal(cover.state, CoverState.PERSISTENT);
});

test('scratch 每帧：add 全部笔迹 → 单次 draw → remove 回池', () => {
  const { log, cover, eraser } = setup();
  cover.init();
  log.length = 0;
  cover.scratchSegments(
    [
      [10, 10, 20, 20],
      [30, 30, 40, 40],
    ],
    { radius: 10, hardness: 1 },
  );
  const ops = log.map(([op]) => op);
  assert.deepEqual(ops, ['add', 'add', 'draw', 'remove', 'remove']);
  assert.equal(eraser.poolSize(), 2); // 节点回池复用
  // 对象池复用：下一段不再新建
  cover.scratchSegments([[50, 50, 60, 60]], { radius: 10, hardness: 1 });
  assert.equal(eraser.poolSize(), 2);
});

test('软刷（hardness<1）产出径向渐变圆章，GCO 为 destination-out', () => {
  const { cover, eraser } = setup();
  cover.init();
  cover.scratchSegments([[10, 10, 20, 20]], { radius: 10, hardness: 0.6 });
  // 池中是圆章
  const pooled = eraser._circlePool;
  assert.equal(pooled.length, 2);
  assert.equal(pooled[0].attrs.globalCompositeOperation, 'destination-out');
  assert.deepEqual(pooled[0].attrs.fillRadialGradientColorStops, [
    0, 'rgba(0,0,0,1)',
    0.6, 'rgba(0,0,0,1)',
    1, 'rgba(0,0,0,0)',
  ]);
});

test('Eraser 节点不带 _canvasCache 且从不调用 cache()（防 Q3 回归）', () => {
  const { cover, eraser } = setup();
  cover.init();
  cover.scratchSegments([[1, 1, 2, 2]], { radius: 10, hardness: 1 });
  cover.scratchSegments([[1, 1, 2, 2]], { radius: 10, hardness: 0.5 });
  for (const node of [...eraser._linePool, ...eraser._circlePool]) {
    assert.equal(node._canvasCache, undefined);
    assert.equal(node.cacheCalls, 0);
    assert.equal(node.attrs.globalCompositeOperation, 'destination-out');
    assert.equal(node.attrs.listening, false);
    assert.equal(node.attrs.shadowEnabled, false);
  }
});

test('reset 回到 NEEDS_PAINT 并重新清屏绘膜；destroy 后拒绝操作', () => {
  const { log, cover } = setup();
  cover.init();
  log.length = 0;
  cover.reset();
  assert.equal(log[0][0], 'clearBeforeDraw');
  assert.equal(log[0][1], true); // 重新走首帧清屏
  assert.equal(cover.state, CoverState.PERSISTENT);
  cover.destroy();
  assert.equal(cover.state, CoverState.DESTROYED);
  assert.throws(() => cover.reset(), /destroyed/);
  // 销毁后 scratch 静默
  cover.scratchSegments([[1, 1, 2, 2]], { radius: 10, hardness: 1 });
});

test('clearBitmap：清屏一次后切回持久态', () => {
  const { log, cover } = setup();
  cover.init();
  log.length = 0;
  cover.clearBitmap();
  assert.deepEqual(log, [
    ['clearBeforeDraw', true],
    ['draw'],
    ['clearBeforeDraw', false],
  ]);
  assert.equal(cover.state, CoverState.PERSISTENT);
});
