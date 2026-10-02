import Konva from 'konva';
import { ScratchCard } from '../src/scratch/index.js';

const CARD_W = 320;
const CARD_H = 180;

const CSS = `
  body { margin: 0; font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; }
  #app { max-width: 1080px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 20px; }
  .grid { display: flex; flex-wrap: wrap; gap: 24px; }
  .card-box { background: #1e293b; border-radius: 12px; padding: 16px; width: 340px; }
  .card-box h2 { font-size: 14px; margin: 0 0 8px; color: #93c5fd; }
  .card-host { width: ${CARD_W}px; height: ${CARD_H}px; border-radius: 8px; overflow: hidden; }
  .scaled .card-host { transform: scale(0.85); transform-origin: top left; }
  .controls { display: flex; gap: 8px; margin: 10px 0; flex-wrap: wrap; }
  .controls button { background: #334155; color: #e2e8f0; border: 0; border-radius: 6px; padding: 6px 10px; cursor: pointer; font-size: 12px; }
  .controls button:hover { background: #475569; }
  .meter { height: 8px; background: #0f172a; border-radius: 4px; overflow: hidden; }
  .meter > div { height: 100%; width: 0%; background: #22c55e; transition: width 120ms; }
  .meta { font-size: 12px; color: #94a3b8; margin-top: 6px; min-height: 16px; }
  .log { font-size: 11px; color: #64748b; margin-top: 6px; height: 48px; overflow-y: auto; white-space: pre-line; }
`;

function makePrizeFactory(getCard, title, log) {
  return () => {
    const bg = new Konva.Rect({ x: 0, y: 0, width: CARD_W, height: CARD_H, fill: '#164e63' });
    const label = new Konva.Text({
      x: 0, y: 40, width: CARD_W, align: 'center',
      text: `🎁 ${title}`, fontSize: 24, fill: '#fef08a',
    });
    const btn = new Konva.Group({ x: CARD_W / 2 - 50, y: 100 });
    btn.add(new Konva.Rect({ width: 100, height: 36, cornerRadius: 18, fill: '#f59e0b' }));
    btn.add(new Konva.Text({ width: 100, height: 36, align: 'center', verticalAlign: 'middle', text: '领奖', fontSize: 16, fill: '#1e293b' }));
    btn.on('click tap', () => {
      const card = getCard();
      log(`奖品按钮命中（state=${card.state}，业务可据此门控）`);
    });
    btn.on('mouseenter', () => { document.body.style.cursor = 'pointer'; });
    btn.on('mouseleave', () => { document.body.style.cursor = 'default'; });
    return [bg, label, btn];
  };
}

function mountCard(root, { title, cover, prizeTitle, scaled, log }) {
  const box = document.createElement('div');
  box.className = 'card-box';
  box.innerHTML = `
    <h2>${title}</h2>
    <div class="card-host"></div>
    <div class="controls">
      <button data-act="reset">reset</button>
      <button data-act="reveal">reveal</button>
      <button data-act="revealInstant">reveal(instant)</button>
      <button data-act="destroy">destroy</button>
    </div>
    <div class="meter"><div></div></div>
    <div class="meta"></div>
    <div class="log"></div>
  `;
  if (scaled) box.classList.add('scaled');
  root.appendChild(box);

  const host = box.querySelector('.card-host');
  const meter = box.querySelector('.meter > div');
  const meta = box.querySelector('.meta');
  const logEl = box.querySelector('.log');
  const say = (msg) => {
    logEl.textContent = `${msg}\n${logEl.textContent}`.slice(0, 400);
    log(msg);
  };

  let card;
  card = new ScratchCard(host, {
    width: CARD_W,
    height: CARD_H,
    cover,
    prize: { factory: makePrizeFactory(() => card, prizeTitle, say) },
    brush: { radius: 18, shape: 'round', hardness: 1 },
    targetRatio: 0.5,
    reveal: { durationMs: 300 },
  });

  card.on('progress', ({ ratio }) => {
    meter.style.width = `${Math.round(ratio * 100)}%`;
    meta.textContent = `state=${card.state} progress=${(ratio * 100).toFixed(1)}%`;
  });
  card.on('scratchstart', ({ pointerId, x, y }) => say(`scratchstart #${pointerId} (${x.toFixed(0)},${y.toFixed(0)})`));
  card.on('scratchend', ({ pointerId, progress }) => say(`scratchend #${pointerId} p=${(progress * 100).toFixed(1)}%`));
  card.on('reveal', ({ ratio }) => say(`🎉 reveal ratio=${(ratio * 100).toFixed(1)}%`));
  card.on('reset', () => say('reset'));
  card.on('progress-error', () => say('⚠️ progress-error（降级为笔画估算）'));
  card.on('destroyed', () => say('destroyed'));

  box.querySelector('.controls').addEventListener('click', (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    if (act === 'reset') card.reset();
    if (act === 'reveal') card.reveal();
    if (act === 'revealInstant') card.reveal(true);
    if (act === 'destroy') card.destroy();
  });

  return card;
}

export function mountDemo(app) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  app.innerHTML = `
    <h1>Konva 刮刮卡 demo（3 张卡：纯色 / 图片 / 自定义节点封面）</h1>
    <div class="grid" id="cards"></div>
  `;
  const grid = app.querySelector('#cards');
  const log = (msg) => console.log('[scratch]', msg);

  const cards = [
    mountCard(grid, {
      title: '卡 1 · 纯色封面',
      prizeTitle: '一等奖',
      cover: { type: 'color', value: '#8a8f98' },
      log,
    }),
    mountCard(grid, {
      title: '卡 2 · 图片封面',
      prizeTitle: '二等奖',
      cover: { type: 'image', src: '/favicon.svg' },
      log,
    }),
    mountCard(grid, {
      title: '卡 3 · 自定义节点封面（外层 CSS scale 0.85）',
      prizeTitle: '谢谢参与',
      scaled: true,
      cover: {
        type: 'nodes',
        factory: () => [
          new Konva.Rect({
            x: 0, y: 0, width: CARD_W, height: CARD_H,
            fillLinearGradientStartPoint: { x: 0, y: 0 },
            fillLinearGradientEndPoint: { x: CARD_W, y: CARD_H },
            fillLinearGradientColorStops: [0, '#a16207', 1, '#78350f'],
            listening: false,
          }),
          new Konva.Text({
            x: 0, y: 78, width: CARD_W, align: 'center',
            text: '刮 我', fontSize: 28, fill: '#fde68a', listening: false,
          }),
        ],
      },
      log,
    }),
  ];
  window.__cards = cards;
  return cards;
}
