import Konva from 'konva';

// 封面节点工厂（cover 三选一：color / image / nodes）。
export function createCoverNodeBuilder(cover, { width, height }) {
  if (!cover || cover.type === 'color') {
    const value = (cover && cover.value) || '#b8b8b8';
    return () => [new Konva.Rect({ x: 0, y: 0, width, height, fill: value, listening: false })];
  }
  if (cover.type === 'image') {
    let loading = null;
    const load = () => {
      if (!loading) {
        loading = new Promise((resolve, reject) => {
          const img = new window.Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error(`cover image failed to load: ${cover.src}`));
          img.src = cover.src;
        });
      }
      return loading;
    };
    return async () => {
      const img = await load();
      return [new Konva.Image({ image: img, x: 0, y: 0, width, height, listening: false })];
    };
  }
  if (cover.type === 'nodes') {
    return (layer) => cover.factory(layer) || [];
  }
  throw new Error(`unknown cover type: ${cover.type}`);
}
