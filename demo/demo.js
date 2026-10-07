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
    key: 'color',
    title: '封面类型：color（纯色）',
    cover: { type: 'color', value: '#b8860b' },
    prizeText: '¥5 优惠券',
  },
  {
    key: 'image',
    title: '封面类型：image（图片）',
    cover: { type: 'image', src: COVER_SVG },
    prizeText: '免单券 ×1',
  },
  {
    key: 'nodes',
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
    storageKeyPrefix: `scratch-demo-${def.key}`, // H3：每卡独立片段库命名空间
  });

  const say = (msg) => { status.textContent = msg; };
  card.on('progress', ({ ratio }) => say(`progress: ${(ratio * 100).toFixed(1)}%  state: ${card.state}`));
  card.on('reveal', ({ ratio }) => say(`🎉 reveal! ratio=${(ratio * 100).toFixed(1)}%`));
  card.on('reset', () => say('已重置'));
  card.on('destroyed', () => say('已销毁'));
  card.on('progress-error', () => say('采样失败，已降级为笔画估算'));
  card.on('playstart', () => { say('▶ 回放中…（真实输入已锁定）'); refresh(); });
  card.on('playend', () => { say('■ 回放结束'); refresh(); });
  card.on('storage-error', () => say('⚠ localStorage 不可用，片段仅保存在内存（storage-error）'));

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

  // 第四行：片段录制（H1）+ 播放全部（id 数组顺序拼接）
  const row4 = addOpsRow();
  const clipBtn = btn(row4, '● 开始片段', () => {
    if (card.clipActive) {
      const clip = card.stopClip();
      say(clip ? `片段已入库：${clip.label || clip.id}` : '无进行中片段');
    } else {
      const label = prompt('片段标签（可空）', '') ?? '';
      if (card.startClip(label)) say('● 片段录制中…再次点击停止入库');
    }
    renderClips();
    refresh();
  });
  const playAllBtn = btn(row4, '▶ 播放全部片段', () => {
    const ids = card.listClips().map((c) => c.id);
    if (ids.length > 0) card.playRecording({ recording: ids, speed: Number(speedSel.value) });
  });

  // 第五行：状态导出（a[download]）/ 导入（input[type=file]）（H2/H5）
  const row5 = addOpsRow();
  btn(row5, '⬇ 导出 JSON', () => {
    const state = card.exportState();
    if (!state) return;
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `scratch-state-${def.key}-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
    say('已导出状态 JSON（含片段库与封面位图）');
  });
  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = 'application/json,.json';
  importInput.className = 'import-input';
  importInput.title = '导入状态 JSON';
  importInput.onchange = async () => {
    const file = importInput.files && importInput.files[0];
    if (!file) return;
    const ok = card.importState(await file.text());
    say(ok ? '✅ 状态已导入（片段库已替换，封面/进度恢复中）' : '❌ 导入被拒绝（版本不符 / 播放或录制中）');
    importInput.value = '';
    renderClips();
    refresh();
  };
  row5.append(importInput);

  // 片段列表：播放 / 删除（H5）
  const clipList = document.createElement('div');
  clipList.className = 'clip-list';
  ops.append(clipList);

  function renderClips() {
    clipList.innerHTML = '';
    const clips = card.listClips();
    for (const clip of clips) {
      const item = document.createElement('div');
      item.className = 'clip-item';
      const name = document.createElement('span');
      name.className = 'clip-name';
      name.textContent = `${clip.label || clip.id}（${(clip.duration / 1000).toFixed(1)}s）`;
      const play = document.createElement('button');
      play.textContent = '▶';
      play.title = '播放该片段';
      play.onclick = () => card.playRecording({ recording: clip.id, speed: Number(speedSel.value) });
      const del = document.createElement('button');
      del.textContent = '✕';
      del.title = '删除该片段';
      del.onclick = () => {
        card.removeClip(clip.id);
        renderClips();
      };
      item.append(name, play, del);
      clipList.append(item);
    }
    playAllBtn.disabled = clips.length === 0 || card.playing;
  }
  renderClips();

  const refresh = () => {
    const dead = card.state === 'destroyed';
    undoBtn.disabled = dead || !card.canUndo;
    redoBtn.disabled = dead || !card.canRedo;
    recBtn.textContent = card.recording ? '■ 停止录制' : '● 开始录制';
    playBtn.disabled = dead || card.playing || card.recording;
    recBtn.disabled = dead || card.playing;
    speedSel.disabled = dead || card.playing;
    clipBtn.textContent = card.clipActive ? '■ 停止片段' : '● 开始片段';
    clipBtn.disabled = dead || card.playing || (card.recording && !card.clipActive);
    playAllBtn.disabled = dead || card.playing || card.listClips().length === 0;
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
