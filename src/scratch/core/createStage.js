// 创建 Stage / prizeLayer / coverLayer，并做逐卡 DPR 设置（不写全局 Konva.pixelRatio）。
// 依据：Canvas.js:77-80 setPixelRatio → setSize 重建位图；Layer.js:41-44 hitCanvas 恒 DPR=1；
//       Layer.js:201-207 非监听 Layer 的 hitCanvas 保持 0×0（ADR-004）。
import Konva from 'konva';

export function createStage(container, { width, height, pixelRatio, touchAction = 'none' }) {
  const stage = new Konva.Stage({ container, width, height });

  const prizeLayer = new Konva.Layer(); // 奖品层：保持 listening(true)，hit graph 全程可命中
  const coverLayer = new Konva.Layer({ listening: false }); // 刮涂层：永久不参与命中
  stage.add(prizeLayer);
  stage.add(coverLayer);

  // 逐卡设置 scene canvas 的 pixelRatio（不影响其他卡，不碰 Konva.pixelRatio 全局）
  prizeLayer.getCanvas().setPixelRatio(pixelRatio);
  coverLayer.getCanvas().setPixelRatio(pixelRatio);

  // 仅刮刮卡区域阻断滚动手势（PointerController 也会设置，双保险保持一致）
  stage.content.style.touchAction = touchAction;

  return { stage, prizeLayer, coverLayer };
}
