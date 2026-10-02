export const Events = Object.freeze({
  SCRATCH_START: 'scratchstart',
  SCRATCH_MOVE: 'scratchmove',
  SCRATCH_END: 'scratchend',
  PROGRESS: 'progress',
  PROGRESS_ERROR: 'progress-error',
  REVEAL: 'reveal',
  RESET: 'reset',
  DESTROYED: 'destroyed',
});

export const State = Object.freeze({
  IDLE: 'idle',
  SCRATCHING: 'scratching',
  REVEALING: 'revealing',
  REVEALED: 'revealed',
  DESTROYED: 'destroyed',
});
