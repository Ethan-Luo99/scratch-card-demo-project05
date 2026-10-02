import Konva from 'konva';
import { resolvePixelRatio } from './pixelRatio.js';

const MAX_BITMAP_SIDE = 4096;

// 位图边长钳制（风险清单 13）：老旧 iOS 超限会静默空白
export function clampPixelRatio(pixelRatio, { width, height }) {
  const longest = Math.max(width, height) || 1;
  if (longest * pixelRatio > MAX_BITMAP_SIDE) {
    return Math.max(1, Math.floor(MAX_BITMAP_SIDE / longest));
  }
  return pixelRatio;
}

export function createStage(container, { width, height, pixelRatioCap = 2 }) {
  const pixelRatio = clampPixelRatio(resolvePixelRatio(pixelRatioCap), { width, height });

  const stage = new Konva.Stage({ container, width, height });
  const prizeLayer = new Konva.Layer({ listening: true });
  const coverLayer = new Konva.Layer({ listening: false });
  stage.add(prizeLayer);
  stage.add(coverLayer);

  applyPixelRatio({ prizeLayer, coverLayer }, pixelRatio);

  return { stage, prizeLayer, coverLayer, pixelRatio };
}

export function applyPixelRatio({ prizeLayer, coverLayer }, pixelRatio) {
  prizeLayer.getCanvas().setPixelRatio(pixelRatio);
  coverLayer.getCanvas().setPixelRatio(pixelRatio);
}
