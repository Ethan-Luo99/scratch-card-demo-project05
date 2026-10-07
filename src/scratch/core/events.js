// 事件名与状态枚举（DESIGN.md §3）
export const EVENTS = Object.freeze({
  SCRATCH_START: 'scratchstart',
  SCRATCH_MOVE: 'scratchmove',
  SCRATCH_END: 'scratchend',
  PROGRESS: 'progress',
  PROGRESS_ERROR: 'progress-error',
  REVEAL: 'reveal',
  RESET: 'reset',
  DESTROYED: 'destroyed',
  // G3 增量：录制回放生命周期（主状态机不变，仅附加标志）
  PLAY_START: 'playstart',
  PLAY_END: 'playend',
  // H3 增量：localStorage 不可用（禁用/满配额写抛错）→ 降级内存态，每实例派发一次
  STORAGE_ERROR: 'storage-error',
});

export const STATES = Object.freeze({
  IDLE: 'idle',
  SCRATCHING: 'scratching',
  REVEALING: 'revealing',
  REVEALED: 'revealed',
  DESTROYED: 'destroyed',
});
