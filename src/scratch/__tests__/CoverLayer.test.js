import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CoverLayer, CoverState } from '../cover/CoverLayer.js';
import { Eraser } from '../cover/Eraser.js';

function createFakeLayer() {
  const calls = [];
  return {
    calls,
    children: [],
    _cbd: true,
    clearBeforeDraw(v) {
      if (v === undefined) return this._cbd;
      calls.push(['clearBeforeDraw', v]);
      this._cbd = v;
      return this;
    },
    add(node) { calls.push('add'); this.children.push(node); return this; },
    draw() { calls.push('draw'); return this; },
    getContext() {
      return { setAttr: (k, v) => calls.push(['setAttr', k, v]) };
    },
  };
}

function createFakeNode(layer, label) {
  const node = {
    label,
    removed: false,
    destroyed: false,
    remove() {
      node.removed = true;
      layer.calls.push('remove');
      const i = layer.children.indexOf(node);
      if (i >= 0) layer.children.splice(i, 1);
    },
    destroy() { node.destroyed = true; layer.calls.push('destroy'); },
  };
  return node;
}

function createFakeEraser(layer) {
  const acquired = [];
  return {
    nodes: acquired,
    released: [],
    acquireSegment(points) {
      const node = createFakeNode(layer, `seg-${acquired.length}`);
      node.points = points;
      acquired.push(node);
      return [node];
    },
    releaseSegment(nodes) { this.released.push(...nodes); },
    destroy() { this.destroyed = true; },
  };
}

test('init sequence: clear -> add -> draw -> remove -> persist', async () => {
  const layer = createFakeLayer();
  const eraser = createFakeEraser(layer);
  const coverNode = createFakeNode(layer, 'cover');
  const cover = new CoverLayer({ layer, eraser, buildCoverNodes: () => [coverNode] });

  await cover.init();
  assert.equal(cover.state, CoverState.PERSISTENT);
  assert.deepEqual(layer.calls, [
    ['clearBeforeDraw', true],
    ['setAttr', 'globalCompositeOperation', 'source-over'],
    'add',
    'draw',
    'remove',
    'destroy',
    ['clearBeforeDraw', false],
  ]);
  assert.equal(coverNode.destroyed, true);
});

test('scratch: per-frame batch add -> single draw -> remove -> release', async () => {
  const layer = createFakeLayer();
  const eraser = createFakeEraser(layer);
  const cover = new CoverLayer({ layer, eraser, buildCoverNodes: () => [] });
  await cover.init();
  layer.calls.length = 0;

  cover.scratch([[{ x: 0, y: 0 }, { x: 5, y: 5 }], [{ x: 5, y: 5 }, { x: 9, y: 9 }]]);
  assert.deepEqual(layer.calls, [
    'add',
    'add',
    'draw',
    'remove',
    'remove',
    ['setAttr', 'globalCompositeOperation', 'source-over'],
  ]);
  assert.equal(eraser.released.length, 2);
  assert.equal(layer.children.length, 0);
});

test('scratch is a no-op unless PERSISTENT', async () => {
  const layer = createFakeLayer();
  const eraser = createFakeEraser(layer);
  const cover = new CoverLayer({ layer, eraser, buildCoverNodes: () => [] });
  cover.scratch([[{ x: 0, y: 0 }]]); // still NEEDS_PAINT
  assert.equal(layer.calls.length, 0);
  await cover.init();
  cover.destroy();
  cover.scratch([[{ x: 0, y: 0 }]]);
  assert.equal(eraser.nodes.length, 0);
});

test('reset returns to NEEDS_PAINT cycle and repaints', async () => {
  const layer = createFakeLayer();
  const eraser = createFakeEraser(layer);
  let paints = 0;
  const cover = new CoverLayer({
    layer,
    eraser,
    buildCoverNodes: () => { paints += 1; return [createFakeNode(layer, 'cover')]; },
  });
  await cover.init();
  await cover.reset();
  assert.equal(paints, 2);
  assert.equal(cover.state, CoverState.PERSISTENT);
  const cbdCalls = layer.calls.filter((c) => Array.isArray(c) && c[0] === 'clearBeforeDraw');
  assert.deepEqual(cbdCalls, [
    ['clearBeforeDraw', true],
    ['clearBeforeDraw', false],
    ['clearBeforeDraw', true],
    ['clearBeforeDraw', false],
  ]);
});

test('clear empties the persistent bitmap and keeps PERSISTENT state', async () => {
  const layer = createFakeLayer();
  const eraser = createFakeEraser(layer);
  const cover = new CoverLayer({ layer, eraser, buildCoverNodes: () => [] });
  await cover.init();
  layer.calls.length = 0;
  cover.clear();
  assert.deepEqual(layer.calls, [
    ['clearBeforeDraw', true],
    ['setAttr', 'globalCompositeOperation', 'source-over'],
    'draw',
    ['clearBeforeDraw', false],
  ]);
  assert.equal(cover.state, CoverState.PERSISTENT);
});

test('destroy is terminal: init throws, eraser destroyed', async () => {
  const layer = createFakeLayer();
  const eraser = createFakeEraser(layer);
  const cover = new CoverLayer({ layer, eraser, buildCoverNodes: () => [] });
  await cover.init();
  cover.destroy();
  cover.destroy(); // idempotent
  assert.equal(cover.state, CoverState.DESTROYED);
  assert.equal(eraser.destroyed, true);
  await assert.rejects(() => cover.init(), /destroyed/);
});

test('Eraser pool reuses nodes and never produces cached nodes', () => {
  const made = [];
  const eraser = new Eraser({
    brush: { radius: 10, hardness: 1 },
    createLine: () => {
      const node = { _pts: null, points(v) { this._pts = v; } };
      made.push(node);
      return node;
    },
    createDab: () => ({}),
  });
  const [a] = eraser.acquireSegment([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  assert.deepEqual(a._pts, [0, 0, 1, 1]);
  eraser.releaseSegment([a]);
  const [b] = eraser.acquireSegment([{ x: 2, y: 2 }]);
  assert.equal(b, a); // pooled reuse
  assert.equal(made.length, 1);
  assert.ok(!('_canvasCache' in b)); // Q3 regression guard
});

test('Eraser soft brush acquires one dab per point', () => {
  const eraser = new Eraser({
    brush: { radius: 10, hardness: 0.5 },
    createLine: () => ({}),
    createDab: () => {
      const pos = { _x: 0, _y: 0 };
      return { x(v) { pos._x = v; }, y(v) { pos._y = v; }, pos };
    },
  });
  const dabs = eraser.acquireSegment([{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }]);
  assert.equal(dabs.length, 3);
  assert.deepEqual(dabs[2].pos, { _x: 5, _y: 6 });
  eraser.releaseSegment(dabs);
  const again = eraser.acquireSegment([{ x: 0, y: 0 }]);
  assert.equal(again[0], dabs[2]); // pool LIFO reuse
});
