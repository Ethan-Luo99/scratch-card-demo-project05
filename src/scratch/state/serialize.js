// 状态序列化（H2）：exportState/importState 的纯函数部分。
//
// 版本兼容策略：
//  - STATE_VERSION 为主版本号；解析时主版本不一致（含缺失/非数）一律拒绝（返回 null）；
//  - 未知字段忽略：仅按白名单提取 clips / undoLimit / coverDataUrl；
//  - clips 逐条经 normalizeClip 清洗（未知事件类型丢弃）。
//
// 状态格式（exportState 输出，可 JSON.stringify）：
//   {
//     version: 1,
//     clips: [{ id, label, duration, events, createdAt, lastUsedAt }],
//     undoLimit: 20,
//     progress: { ratio, targetRatio, sampling: { width, height, alphaCutoff } }, // 进度口径
//     coverDataUrl: 'data:image/png;base64,...' | null,
//   }

import { normalizeClip, genId } from '../record/ClipLibrary.js';

export const STATE_VERSION = 1;

// 解析并校验导入载荷；接受 JSON 字符串或已解析对象。非法/版本不符 → null。
export function parseState(json) {
  let raw = json;
  if (typeof json === 'string') {
    try {
      raw = JSON.parse(json);
    } catch (err) {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object') return null;
  const major = Math.floor(Number(raw.version));
  if (!Number.isFinite(major) || major !== STATE_VERSION) return null; // 未知主版本拒绝
  const state = {};
  if (Array.isArray(raw.clips)) {
    state.clips = raw.clips.map((c) => normalizeClip(c, genId())).filter(Boolean);
  }
  if (Number.isFinite(raw.undoLimit)) state.undoLimit = raw.undoLimit;
  if (typeof raw.coverDataUrl === 'string' && raw.coverDataUrl.startsWith('data:')) {
    state.coverDataUrl = raw.coverDataUrl;
  }
  return state;
}

// H1：多片段顺序拼接为单一事件流，节拍连续——后一片段的时间戳整体偏移
// 前序片段 duration 之和（duration 缺失/过小时回退为该片段最大事件时间戳）。
export function concatClipEvents(clips) {
  const events = [];
  let offset = 0;
  for (const clip of clips) {
    let maxT = 0;
    for (const ev of clip.events) {
      events.push({ ...ev, t: ev.t + offset });
      if (ev.t > maxT) maxT = ev.t;
    }
    const duration =
      Number.isFinite(clip.duration) && clip.duration >= maxT ? clip.duration : maxT;
    offset += duration;
  }
  return events;
}
