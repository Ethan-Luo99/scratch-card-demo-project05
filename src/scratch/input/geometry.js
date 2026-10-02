export function cssScale(rect, contentSize) {
  const scaleX = (rect.width / contentSize.width) || 1;
  const scaleY = (rect.height / contentSize.height) || 1;
  return { scaleX, scaleY };
}

export function toLogicalPoint(clientX, clientY, rect, contentSize) {
  const { scaleX, scaleY } = cssScale(rect, contentSize);
  return {
    x: (clientX - rect.left) / scaleX,
    y: (clientY - rect.top) / scaleY,
  };
}

export function toBitmapPixel(xLogical, yLogical, pixelRatio) {
  return {
    x: Math.floor(xLogical * pixelRatio),
    y: Math.floor(yLogical * pixelRatio),
  };
}

export function clientToBitmap(clientX, clientY, rect, contentSize, pixelRatio) {
  const { scaleX, scaleY } = cssScale(rect, contentSize);
  return {
    x: Math.floor(((clientX - rect.left) * pixelRatio) / scaleX),
    y: Math.floor(((clientY - rect.top) * pixelRatio) / scaleY),
  };
}
