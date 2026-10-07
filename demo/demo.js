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
  const clipsBox = document.createElement('ul');
  clipsBox.className = 'clips';
  const status = document.createElement('div');
  status.className = 'status';
  box.append(mount, ops, clipsBox, status);

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
  card.on('clipschange', () => refreshClips());
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

  // 第四行：H1 片段录制 + 全部片段顺序播放
  const row4 = addOpsRow();
  const clipLabel = document.createElement('input');
  clipLabel.placeholder = '片段名';
  clipLabel.size = 8;
  const clipBtn = btn(row4, '● 开始片段', () => {
    if (card.recording) {
      const clip = card.stopClip();
      if (!clip) card.stopRecording();
      say(clip ? `片段已保存：${clip.label || clip.id}（${(clip.duration / 1000).toFixed(1)}s）` : '录制已停止');
    } else {
      card.startClip(clipLabel.value.trim());
      say('● 片段录制中…再次点击停止');
    }
    refresh();
  });
  row4.append(clipLabel);
  const playAllBtn = btn(row4, '▶ 全部片段', () => {
    const ids = card.listClips().map((c) => c.id);
    card.playRecording({ speed: Number(speedSel.value), recording: ids });
  });

  // 第五行：H2 导出 / 导入
  const row5 = addOpsRow();
  btn(row5, '⬇ 导出 JSON', () => {
    const json = card.exportState();
    if (!json) return;
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `scratch-state-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say('已导出状态 JSON');
  });
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'application/json,.json';
  fileInput.style.display = 'none';
  btn(row5, '⬆ 导入 JSON', () => fileInput.click());
  fileInput.onchange = () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const ok = card.importState(String(reader.result));
      say(ok ? '导入成功：封面/片段/进度已恢复' : '导入被拒绝（版本不符或当前状态不可导入）');
      refresh();
    };
    reader.readAsText(file);
  };
  row5.append(fileInput);

  // H1：片段列表（播放 / 删除）
  const refreshClips = () => {
    clipsBox.innerHTML = '';
    for (const clip of card.listClips()) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = `${clip.label || clip.id} · ${(clip.duration / 1000).toFixed(1)}s · ${clip.events.length} 事件`;
      const play = document.createElement('button');
      play.textContent = '▶';
      play.title = '播放该片段';
      play.onclick = () => card.playRecording({ speed: Number(speedSel.value), recording: clip.id });
      const del = document.createElement('button');
      del.textContent = '✕';
      del.title = '删除该片段';
      del.onclick = () => { card.removeClip(clip.id); };
      li.append(name, play, del);
      clipsBox.append(li);
    }
  };

  const refresh = () => {
    const dead = card.state === 'destroyed';
    undoBtn.disabled = dead || !card.canUndo;
    redoBtn.disabled = dead || !card.canRedo;
    recBtn.textContent = card.recording ? '■ 停止录制' : '● 开始录制';
    clipBtn.textContent = card.recording ? '■ 停止片段' : '● 开始片段';
    playBtn.disabled = dead || card.playing || card.recording;
    clipBtn.disabled = dead || card.playing;
    playAllBtn.disabled = dead || card.playing || card.recording;
    recBtn.disabled = dead || card.playing;
    speedSel.disabled = dead || card.playing;
  };
  card.on('scratchend', refresh);
  card.on('reset', refresh);
  card.on('destroyed', refresh);
  refresh();
  refreshClips();
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
