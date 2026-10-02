// 纯函数：client 视口坐标 → stage 逻辑坐标 → scene bitmap 物理像素。
// 公式依据 DESIGN.md Q5（Stage.js:881-882 / 906-912，Canvas.js:96）：
//   cssScale  = rect.width / content.clientWidth || 1
//   xLogical  = (clientX - rect.left) / cssScale
//   xBitmap   = floor((clientX - rect.left) * dpr / cssScale)
// 约束：stage scale 恒为 1，缩放只由外部 CSS 施加。

export function computeCssScale(rect, contentClientWidth, contentClientHeight) {
  const rawX = rect.width / contentClientWidth;
  const rawY = rect.height / contentClientHeight;
  // 零尺寸/非有限值回退 1（Stage.js:906-912 的 `|| 1` 只覆盖 0/0=NaN，这里一并兜住 Infinity）
  const scaleX = Number.isFinite(rawX) && rawX > 0 ? rawX : 1;
  const scaleY = Number.isFinite(rawY) && rawY > 0 ? rawY : 1;
  return { scaleX, scaleY };
}

export function toLogicalPoint(clientX, clientY, rect, cssScale) {
  return {
    x: (clientX - rect.left) / cssScale.scaleX,
    y: (clientY - rect.top) / cssScale.scaleY,
  };
}

export function toBitmapPixel(logicalX, logicalY, dpr) {
  return {
    x: Math.floor(logicalX * dpr),
    y: Math.floor(logicalY * dpr),
  };
}

// 合并式：client 视口坐标 → scene bitmap 像素（单次 floor，避免二次取整误差）
export function clientToBitmap(clientX, clientY, rect, cssScale, dpr) {
  return {
    x: Math.floor(((clientX - rect.left) * dpr) / cssScale.scaleX),
    y: Math.floor(((clientY - rect.top) * dpr) / cssScale.scaleY),
  };
}
