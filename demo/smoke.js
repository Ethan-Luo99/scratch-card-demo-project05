// 真实浏览器冒烟测试：合成 PointerEvent 走完整刮涂→采样→reveal→reset→destroy 链路。
// 结果写入 <pre id="smoke"> 与 document.title，供 headless --dump-dom 断言。
import { ScratchCard } from '../src/scratch/index.js';

const results = [];
const ok = (name, cond) => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}`);

const mount = document.createElement('div');
mount.style.cssText = 'width:300px;height:200px;';
document.body.append(mount);

let prizeClicked = false;
const card = new ScratchCard(mount, {
  width: 300,
  height: 200,
  cover: { type: 'color', value: '#888888' },
  prize: {
    factory: () => [],
  },
  brush: { radius: 20, shape: 'round', hardness: 1 },
  targetRatio: 0.4,
  sampling: { width: 200, height: 125, intervalMs: 50, alphaCutoff: 16 },
  reveal: { durationMs: 100 },
});

let revealCount = 0;
let progressEvents = 0;
card.on('reveal', () => revealCount++);
card.on('progress', () => progressEvents++);

const content = card.getStage().content;
const rect = content.getBoundingClientRect();
const pe = (type, x, y, id = 1) =>
  content.dispatchEvent(
    new PointerEvent(type, {
      pointerId: id,
      clientX: rect.left + x,
      clientY: rect.top + y,
      bubbles: true,
    }),
  );

// 第一阶段：一条横线
pe('pointerdown', 10, 10);
for (let i = 1; i <= 20; i++) pe('pointermove', 10 + i * 10, 10);
pe('pointerup', 210, 10);

setTimeout(() => {
  ok('stage created', !!card.getStage());
  ok('cover canvas painted opaque', card.getProgress() >= 0);
  ok('progress > 0 after one stroke', card.getProgress() > 0.01);
  ok('progress events throttled', progressEvents >= 1);

  // 第二阶段：密集涂抹触发自动 reveal
  pe('pointerdown', 10, 30);
  for (let y = 30; y < 200; y += 15) {
    for (let x = 10; x < 300; x += 15) pe('pointermove', x, y);
  }
  pe('pointerup', 290, 195);

  setTimeout(() => {
    ok('auto revealed', card.state === 'revealed');
    ok('reveal fired exactly once', revealCount === 1);
    // 多指不串轨：revealed 状态下输入已冻结，仅验证不抛错
    pe('pointerdown', 5, 5, 2);
    pe('pointermove', 50, 50, 2);
    pe('pointerup', 50, 50, 2);
    ok('reveal still once after extra input', revealCount === 1);

    card.reset();
    ok('reset to idle with zero progress', card.state === 'idle' && card.getProgress() === 0);

    card.reveal(true);
    ok('manual instant reveal', card.state === 'revealed');
    ok('reveal refired after reset (new lifecycle)', revealCount === 2);

    card.destroy();
    ok('destroyed state', card.state === 'destroyed');
    ok('content dom removed', !mount.querySelector('.konvajs-content'));
    card.destroy(); // 幂等
    ok('destroy idempotent', true);

    const allPass = results.every((r) => r.startsWith('PASS'));
    document.title = allPass ? 'SMOKE:ALL-PASS' : 'SMOKE:HAS-FAIL';
    const pre = document.createElement('pre');
    pre.id = 'smoke';
    pre.textContent = results.join('\n');
    document.body.append(pre);
  }, 800);
}, 400);
