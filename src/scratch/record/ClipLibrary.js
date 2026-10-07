// 片段库（H1/H3）：命名片段 {id,label,duration,events} 的内存索引 + localStorage 持久化。
//
// 持久化策略：
//  - 单 key 整体序列化（`${storageKeyPrefix}:clips`），quota 为总字节上限；
//  - 写入前检查体积，超限时按 lastUsedAt 升序淘汰（LRU），直至 fit 或仅剩 1 条；
//  - 单条即超限：保留内存态、放弃落盘（不丢数据，刷新后丢失）；
//  - localStorage 探测/读/写任一步抛错 → 永久降级为内存态，onStorageError 恰好回调一次。
//
// quota <= 0 表示关闭持久化（纯内存态），不触发 storage-error。

let clipSeq = 0;

export class ClipLibrary {
  constructor({
    storageKey = 'scratch-card:clips',
    quota = 256 * 1024,
    storage, // 注入点；缺省探测 globalThis.localStorage
    onStorageError = null,
  } = {}) {
    this._key = storageKey;
    this._quota = quota;
    this._onStorageError = onStorageError;
    this._clips = new Map();
    this._errorEmitted = false;
    this._storage = storage !== undefined ? storage : probeLocalStorage();
    this._storageOK = this._storage !== null && this._quota > 0;
    if (this._storageOK) this._load();
  }

  get size() {
    return this._clips.size;
  }

  // 追加片段（id 缺省自动生成）；返回入库后的拷贝
  add(clip) {
    const stored = normalizeClip(clip, genId());
    if (!stored) return null;
    if (this._clips.has(stored.id)) stored.id = genId();
    const now = Date.now();
    stored.createdAt = now;
    stored.lastUsedAt = now;
    this._clips.set(stored.id, stored);
    this._persist();
    return copyClip(stored);
  }

  get(id) {
    const clip = this._clips.get(id);
    return clip ? copyClip(clip) : null;
  }

  // 按创建序返回全部片段拷贝
  list() {
    return [...this._clips.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(copyClip);
  }

  remove(id) {
    if (!this._clips.delete(id)) return false;
    this._persist();
    return true;
  }

  clear() {
    this._clips.clear();
    this._persist();
  }

  // LRU 触碰：播放/读取后更新 lastUsedAt 并落盘
  touch(id) {
    const clip = this._clips.get(id);
    if (!clip) return;
    clip.lastUsedAt = Date.now();
    this._persist();
  }

  // importState：整体替换（入参先经 normalizeClip 白名单清洗）
  replaceAll(clips) {
    this._clips.clear();
    for (const raw of clips || []) {
      const clip = normalizeClip(raw, genId());
      if (!clip) continue;
      if (this._clips.has(clip.id)) clip.id = genId();
      const now = Date.now();
      clip.createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now;
      clip.lastUsedAt = Number.isFinite(raw.lastUsedAt) ? raw.lastUsedAt : now;
      this._clips.set(clip.id, clip);
    }
    this._persist();
  }

  // exportState 用：可 JSON 序列化的片段数组
  toJSON() {
    return this.list();
  }

  // ---------- 持久化 ----------
  _serialize() {
    return JSON.stringify({ clips: this.list() });
  }

  _persist() {
    if (!this._storageOK) return;
    let payload = this._serialize();
    while (byteLength(payload) > this._quota && this._clips.size > 1) {
      this._evictOldest();
      payload = this._serialize();
    }
    if (byteLength(payload) > this._quota) return; // 单条超限：留内存，不落盘
    try {
      this._storage.setItem(this._key, payload);
    } catch (err) {
      this._degrade();
    }
  }

  _load() {
    try {
      const raw = this._storage.getItem(this._key);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const clips = Array.isArray(parsed) ? parsed : parsed && parsed.clips;
      for (const c of Array.isArray(clips) ? clips : []) {
        const clip = normalizeClip(c, genId());
        if (clip && !this._clips.has(clip.id)) {
          clip.createdAt = Number.isFinite(c.createdAt) ? c.createdAt : 0;
          clip.lastUsedAt = Number.isFinite(c.lastUsedAt) ? c.lastUsedAt : 0;
          this._clips.set(clip.id, clip);
        }
      }
    } catch (err) {
      this._degrade();
    }
  }

  _evictOldest() {
    let oldest = null;
    for (const clip of this._clips.values()) {
      if (!oldest || clip.lastUsedAt < oldest.lastUsedAt) oldest = clip;
    }
    if (oldest) this._clips.delete(oldest.id);
  }

  // 降级为内存态；storage-error 每实例仅派发一次
  _degrade() {
    this._storageOK = false;
    if (this._errorEmitted) return;
    this._errorEmitted = true;
    if (this._onStorageError) this._onStorageError();
  }
}

// ---------- 纯函数 ----------
const EVENT_TYPES = new Set(['down', 'move', 'up', 'reset']);

export function genId() {
  return `clip_${Date.now().toString(36)}_${clipSeq++}`;
}

// 白名单清洗：未知字段忽略；事件逐条校验（未知类型丢弃，与 Player 前向兼容一致）
export function normalizeClip(raw, fallbackId) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.events)) return null;
  const events = [];
  for (const ev of raw.events) {
    const norm = normalizeEvent(ev);
    if (norm) events.push(norm);
  }
  const duration = Number.isFinite(raw.duration) && raw.duration >= 0 ? raw.duration : 0;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
    label: typeof raw.label === 'string' ? raw.label : '',
    duration,
    events,
  };
}

function normalizeEvent(ev) {
  if (!ev || typeof ev !== 'object' || !EVENT_TYPES.has(ev.type)) return null;
  const t = Number(ev.t);
  if (!Number.isFinite(t) || t < 0) return null;
  if (ev.type === 'reset') return { t, type: 'reset' };
  return {
    t,
    type: ev.type,
    pointerId: ev.pointerId,
    x: Number(ev.x) || 0,
    y: Number(ev.y) || 0,
  };
}

function copyClip(clip) {
  return { ...clip, events: clip.events.map((ev) => ({ ...ev })) };
}

function byteLength(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str).length;
  return str.length;
}

function probeLocalStorage() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    const probeKey = '__scratch_probe__';
    storage.setItem(probeKey, '1');
    storage.removeItem(probeKey);
    return storage;
  } catch (err) {
    return null;
  }
}
