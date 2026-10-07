// 片段库（H1/H3）：内存 Map 为权威态，localStorage 为持久镜像。
//
// 存储布局（prefix 可配）：
//   ${prefix}index     → JSON: [{ id, bytes, lastUsed }]（LRU 索引）
//   ${prefix}clip:<id> → JSON: Clip { id, label, duration, events }
//
// 容量：总字节（序列化字符串长度，UTF-16 code unit 近似）超 quota 时按
// lastUsed 升序 LRU 淘汰（内存与存储同步移除）；刚写入的最新片段不淘汰自己，
// 单个片段超过 quota 时保留在内存但不落盘（刷新后丢失，属 documented 取舍）。
//
// 降级：localStorage 不可用（隐私模式/被禁用/写抛错）→ 切纯内存态，
// 经 onStorageError 一次性上报（构造期发现时经 queueMicrotask 延迟，
// 保证构造后同步 on('storage-error') 的订阅者能收到）。

export class ClipStore {
  constructor({ prefix = 'scratch-card:clips:', quota = 2 * 1024 * 1024, onStorageError } = {}) {
    this._prefix = String(prefix);
    this._quota = quota > 0 ? quota : Infinity;
    this._onStorageError = onStorageError || null;
    this._clips = new Map(); // id -> Clip（内存权威）
    this._meta = new Map(); // id -> lastUsed（LRU 时间戳）
    this._errorEmitted = false;
    this._storage = this._detectStorage();
    if (!this._storage) {
      this._downgrade(new Error('localStorage unavailable'), true);
      return;
    }
    try {
      this._load();
    } catch (err) {
      this._clips.clear();
      this._meta.clear();
      this._downgrade(err, true);
    }
  }

  get persistent() {
    return !!this._storage;
  }

  has(id) {
    return this._clips.has(id);
  }

  get(id) {
    return this._clips.get(id) || null;
  }

  // 返回片段副本数组（Map 插入序），调用方改动不影响库内数据
  list() {
    return [...this._clips.values()].map((clip) => ({
      ...clip,
      events: clip.events.slice(),
    }));
  }

  add(clip) {
    this._clips.set(clip.id, clip);
    this._meta.set(clip.id, Date.now());
    this._persist();
  }

  remove(id) {
    if (!this._clips.has(id)) return false;
    this._clips.delete(id);
    this._meta.delete(id);
    if (this._storage) {
      try {
        this._storage.removeItem(this._clipKey(id));
      } catch (err) {
        this._downgrade(err);
      }
    }
    this._persist();
    return true;
  }

  clear() {
    const ids = [...this._clips.keys()];
    this._clips.clear();
    this._meta.clear();
    if (this._storage) {
      try {
        for (const id of ids) this._storage.removeItem(this._clipKey(id));
        this._storage.removeItem(this._indexKey());
      } catch (err) {
        this._downgrade(err);
      }
    }
  }

  // 播放/访问时刷新 LRU 时间戳
  touch(id) {
    if (!this._clips.has(id)) return;
    this._meta.set(id, Date.now());
    this._persist();
  }

  // importState 整体替换：未知/损坏条目忽略，缺 id 的补生成
  replaceAll(clips) {
    const oldIds = [...this._clips.keys()];
    this._clips.clear();
    this._meta.clear();
    let seq = 0;
    for (const raw of clips) {
      if (!raw || !Array.isArray(raw.events)) continue;
      const id =
        typeof raw.id === 'string' && raw.id
          ? raw.id
          : `clip-import-${Date.now().toString(36)}-${seq}`;
      seq += 1;
      this._clips.set(id, {
        id,
        label: typeof raw.label === 'string' ? raw.label : '',
        duration: typeof raw.duration === 'number' ? raw.duration : 0,
        events: raw.events,
      });
      this._meta.set(id, Date.now() + seq); // 保持导入顺序的 LRU 次序
    }
    if (this._storage) {
      try {
        for (const id of oldIds) this._storage.removeItem(this._clipKey(id));
      } catch (err) {
        this._downgrade(err);
      }
    }
    this._persist();
  }

  // ---------- 内部 ----------
  _indexKey() {
    return `${this._prefix}index`;
  }

  _clipKey(id) {
    return `${this._prefix}clip:${id}`;
  }

  _detectStorage() {
    try {
      const storage = globalThis.localStorage;
      if (!storage) return null;
      const probe = `${this._prefix}__probe__`;
      storage.setItem(probe, '1');
      storage.removeItem(probe);
      return storage;
    } catch {
      return null;
    }
  }

  _load() {
    const raw = this._storage.getItem(this._indexKey());
    if (!raw) return;
    const index = JSON.parse(raw);
    if (!Array.isArray(index)) return;
    for (const entry of index) {
      if (!entry || typeof entry.id !== 'string') continue;
      const rawClip = this._storage.getItem(this._clipKey(entry.id));
      if (!rawClip) continue;
      const clip = JSON.parse(rawClip);
      if (!clip || typeof clip.id !== 'string' || !Array.isArray(clip.events)) continue;
      this._clips.set(clip.id, clip);
      this._meta.set(clip.id, entry.lastUsed || 0);
    }
  }

  _persist() {
    if (!this._storage) return;
    try {
      let entries = [...this._clips.values()].map((clip) => ({
        id: clip.id,
        bytes: JSON.stringify(clip).length,
        lastUsed: this._meta.get(clip.id) || 0,
      }));
      let total = entries.reduce((sum, e) => sum + e.bytes, 0);
      if (total > this._quota) {
        const newest = entries.reduce((a, b) => (a.lastUsed >= b.lastUsed ? a : b));
        const sorted = entries.slice().sort((a, b) => a.lastUsed - b.lastUsed);
        for (const entry of sorted) {
          if (total <= this._quota) break;
          if (entry === newest) continue; // 最新片段不淘汰自己
          this._clips.delete(entry.id);
          this._meta.delete(entry.id);
          this._storage.removeItem(this._clipKey(entry.id));
          total -= entry.bytes;
        }
        entries = entries.filter((e) => this._clips.has(e.id));
      }
      // 单片段超配额：保留内存态，不落盘（索引亦不收录）
      const persisted = entries.filter((e) => e.bytes <= this._quota);
      for (const entry of persisted) {
        this._storage.setItem(this._clipKey(entry.id), JSON.stringify(this._clips.get(entry.id)));
      }
      this._storage.setItem(this._indexKey(), JSON.stringify(persisted));
    } catch (err) {
      this._downgrade(err);
    }
  }

  _downgrade(err, deferred = false) {
    this._storage = null;
    if (this._errorEmitted) return;
    this._errorEmitted = true;
    if (deferred) {
      queueMicrotask(() => {
        if (this._onStorageError) this._onStorageError(err);
      });
    } else if (this._onStorageError) {
      this._onStorageError(err);
    }
  }
}
