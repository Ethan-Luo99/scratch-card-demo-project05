// 演示页：同页 3 张卡（color / image / nodes 三种封面），
// 奖品层可点击按钮 + reset/reveal/destroy 操作区。
import Konva from 'konva';
import { ScratchCard } from '../src/scratch/index.js';
import './demo.css';

const W = 316;
const H = 200;

// data-URI SVG 封面图（无 CORS 问题，演示 image 类型）
const COVER_SVG =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#8e9eab"/><stop offset="1" stop-color="#eef2f3"/>
      </linearGradient></defs>
      <rect width="${W}" height="${H}" fill="url(#g)"/>
      <text x="${W / 2}" y="${H / 2}" font-size="28" text-anchor="middle"
        dominant-baseline="middle" fill="#555">刮 我</text>
    </svg>`,
  );

function makePrize(text) {
  return (prizeLayer) => {
    const bg = new Konva.Rect({
      x: 0, y: 0, width: W, height: H, fill: '#fff8e1',
    });
    const label = new Konva.Text({
      x: 0, y: 40, width: W, align: 'center',
      text, fontSize: 24, fill: '#d84315',
    });
    const btn = new Konva.Group({ x: W / 2 - 60, y: 110 });
    const btnRect = new Konva.Rect({
      width: 120, height: 40, cornerRadius: 6, fill: '#1976d2',
    });
    const btnText = new Konva.Text({
      width: 120, height: 40, align: 'center', verticalAlign: 'middle',
      text: '领取奖励', fontSize: 16, fill: '#fff', listening: false,
    });
    btn.add(btnRect, btnText);
    btn.on('click tap', () => {
      btnRect.fill('#2e7d32');
      btnText.text('已领取 ✓');
      prizeLayer.draw();
    });
    btn.on('mouseenter', () => { document.body.style.cursor = 'pointer'; });
    btn.on('mouseleave', () => { document.body.style.cursor = 'default'; });
    return [bg, label, btn];
  };
}

function makeNodesCover() {
  return () => {
    const nodes = [
      new Konva.Rect({ x: 0, y: 0, width: W, height: H, fill: '#455a64', listening: false }),
    ];
    for (let i = 0; i < 8; i++) {
      nodes.push(
        new Konva.Circle({
          x: 40 + i * 36, y: 100, radius: 14,
          fill: i % 2 ? '#78909c' : '#b0bec5', listening: false,
        }),
      );
    }
    nodes.push(
      new Konva.Text({
        x: 0, y: 30, width: W, align: 'center',
        text: 'NODES 封面', fontSize: 20, fill: '#eceff1', listening: false,
      }),
    );
    return nodes;
  };
}

const CARDS = [
  {
    title: '封面类型：color（纯色）',
    cover: { type: 'color', value: '#b8860b' },
    prizeText: '¥5 优惠券',
  },
  {
    title: '封面类型：image（图片）',
    cover: { type: 'image', src: COVER_SVG },
    prizeText: '免单券 ×1',
  },
  {
    title: '封面类型：nodes（自定义 Konva 节点）',
    cover: { type: 'nodes', factory: makeNodesCover() },
    prizeText: '积分 +200',
  },
];

function mountCard(box, def) {
  const mount = document.createElement('div');
  mount.className = 'card-mount';
  const ops = document.createElement('div');
  ops.className = 'ops';
  const status = document.createElement('div');
  status.className = 'status';
  box.append(mount, ops, status);

  const card = new ScratchCard(mount, {
    width: W,
    height: H,
    cover: def.cover,
    prize: { factory: makePrize(def.prizeText) },
    brush: { radius: 18, shape: 'round', hardness: 1 },
    targetRatio: 0.5,
  });

  const say = (msg) => { status.textContent = msg; };
  card.on('progress', ({ ratio }) => say(`progress: ${(ratio * 100).toFixed(1)}%  state: ${card.state}`));
  card.on('reveal', ({ ratio }) => say(`🎉 reveal! ratio=${(ratio * 100).toFixed(1)}%`));
  card.on('reset', () => say('已重置'));
  card.on('destroyed', () => say('已销毁'));
  card.on('progress-error', () => say('采样失败，已降级为笔画估算'));
  card.on('playstart', () => { say('▶ 回放中…（真实输入已锁定）'); refresh(); });
  card.on('playend', () => { say('■ 回放结束'); refresh(); });

  const addOpsRow = () => {
    const row = document.createElement('div');
    row.className = 'ops';
    ops.append(row);
    return row;
  };
  const btn = (row, label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    row.append(b);
    return b;
  };

  // 第一行：既有 reveal/reset/destroy
  const row1 = addOpsRow();
  btn(row1, 'reset', () => card.reset());
  btn(row1, 'reveal', () => card.reveal());
  btn(row1, 'reveal(instant)', () => card.reveal(true));
  btn(row1, 'destroy', () => card.destroy());

  // 第二行：撤销 / 重做（空历史时禁用）
  const row2 = addOpsRow();
  const undoBtn = btn(row2, '↶ undo', () => { card.undo(); refresh(); });
  const redoBtn = btn(row2, '↷ redo', () => { card.redo(); refresh(); });

  // 第三行：录制 / 回放 + 速度切换
  const row3 = addOpsRow();
  const recBtn = btn(row3, '● 开始录制', () => {
    if (card.recording) {
      card.stopRecording();
      say('录制已停止并保存');
    } else {
      card.startRecording();
      say('● 录制中…再次点击停止');
    }
    refresh();
  });
  const speedSel = document.createElement('select');
  for (const v of ['0.5', '1', '2', '4']) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = `${v}×`;
    if (v === '1') opt.selected = true;
    speedSel.append(opt);
  }
  const playBtn = btn(row3, '▶ 回放', () => {
    card.playRecording({ speed: Number(speedSel.value) });
  });
  row3.append(speedSel);

  const refresh = () => {
    const dead = card.state === 'destroyed';
    undoBtn.disabled = dead || !card.canUndo;
    redoBtn.disabled = dead || !card.canRedo;
    recBtn.textContent = card.recording ? '■ 停止录制' : '● 开始录制';
    playBtn.disabled = dead || card.playing || card.recording;
    recBtn.disabled = dead || card.playing;
    speedSel.disabled = dead || card.playing;
  };
  card.on('scratchend', refresh);
  card.on('reset', refresh);
  card.on('destroyed', refresh);
  refresh();
  return card;
}

export function mountDemo(root) {
  root.innerHTML = '';
  const page = document.createElement('div');
  page.className = 'scratch-demo';
  page.innerHTML = '<h1>刮刮卡 Demo（Konva 10.7.0）— 同页 3 张卡</h1>';
  const cards = document.createElement('div');
  cards.className = 'cards';
  page.append(cards);
  root.append(page);

  const instances = [];
  for (const def of CARDS) {
    const box = document.createElement('div');
    box.className = 'card-box';
    const h2 = document.createElement('h2');
    h2.textContent = def.title;
    box.append(h2);
    cards.append(box);
    instances.push(mountCard(box, def));
  }
  return instances;
}
