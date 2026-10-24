// Композитинг кадра секвенции на Canvas 2D.
//
// Конвейер для каждого видеослоя (снизу вверх):
//   источник кадра (видео / изображение / генератор этапа 2)
//     → цепочка видеоэффектов клипа (плагины этапа 2, apply(frame))
//     → «Движение»: позиция, масштаб, поворот, опорная точка
//     → «Непрозрачность» и режим наложения
//     → холст секвенции
// Переходы (этап 2) получают два полнокадровых слоя и progress 0..1.

import { resolveAll, resolveParam } from '../core/keyframes.js';
import { plugins } from '../plugins/registry.js';

/** Размер исходника слоя в пикселях. */
export function sourceSize(clip, media, seq) {
  if (clip.generator) {
    const def = plugins.generators.get(clip.generator.type);
    const sz = def?.size?.(clip.generator.params, seq);
    return sz || [seq.width, seq.height];
  }
  return [media?.width || seq.width, media?.height || seq.height];
}

/**
 * Геометрия клипа в координатах секвенции: используется рендером и
 * рамкой трансформации в Program Monitor.
 */
export function clipGeometry(clip, media, seq, localTime = 0) {
  const [w, h] = sourceSize(clip, media, seq);
  const tr = clip.transform || {};
  const pos = resolveParam(tr.position, localTime) || [seq.width / 2, seq.height / 2];
  const scalePct = resolveParam(tr.scale, localTime) ?? 100;
  const scaleWPct = tr.uniformScale === false ? resolveParam(tr.scaleWidth, localTime) ?? scalePct : scalePct;
  const rotation = resolveParam(tr.rotation, localTime) || 0;
  const anchor = resolveParam(tr.anchor, localTime) || [w / 2, h / 2];
  let fit = 1;
  if (clip.scaling === 'fit') fit = Math.min(seq.width / w, seq.height / h);
  else if (clip.scaling === 'fill') fit = Math.max(seq.width / w, seq.height / h);
  const sx = (scaleWPct / 100) * fit;
  const sy = (scalePct / 100) * fit;
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // точка исходника → координаты секвенции
  const map = (x, y) => {
    const dx = (x - anchor[0]) * sx;
    const dy = (y - anchor[1]) * sy;
    return [pos[0] + dx * cos - dy * sin, pos[1] + dx * sin + dy * cos];
  };
  return {
    w,
    h,
    pos,
    anchor,
    sx,
    sy,
    fit,
    rotation,
    rad,
    corners: [map(0, 0), map(w, 0), map(w, h), map(0, h)],
    anchorPoint: map(anchor[0], anchor[1]),
    map,
    opacity: (resolveParam(tr.opacity, localTime) ?? 100) / 100,
    blend: tr.blend || 'normal',
  };
}

export class Compositor {
  constructor() {
    this._pool = new Map(); // временные холсты: ключ → OffscreenCanvas
  }

  _canvas(key, w, h) {
    let c = this._pool.get(key);
    if (!c) {
      c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
      this._pool.set(key, c);
    }
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    return c;
  }

  /**
   * Отрисовать кадр.
   *  ctx — 2D-контекст целевого холста размером width×height
   *  layers — результат activeVideoLayers()
   *  provider.frame(layer) → { image, width, height } | null
   *  provider.isOffline(layer) → boolean
   */
  render(ctx, seq, layers, provider, { width, height, quality = 'high', time = 0 } = {}) {
    const s = Math.min(width / seq.width, height / seq.height);
    const ox = (width - seq.width * s) / 2;
    const oy = (height - seq.height * s) / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = quality;
    const base = [s, 0, 0, s, ox, oy];
    for (const layer of layers) {
      if (layer.kind === 'transition') this._drawTransition(ctx, seq, layer, provider, base, { width, height, quality, time });
      else this._drawClip(ctx, seq, layer, provider, base, time);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Источник слоя с применёнными эффектами. */
  _layerImage(seq, layer, provider, time) {
    const { clip, media } = layer;
    let image = null;
    let w;
    let h;
    if (clip.generator) {
      const def = plugins.generators.get(clip.generator.type);
      if (!def) return null;
      [w, h] = sourceSize(clip, media, seq);
      const c = this._canvas('gen:' + clip.id, Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
      const gctx = c.getContext('2d');
      gctx.clearRect(0, 0, c.width, c.height);
      def.render({ canvas: c, ctx: gctx, width: c.width, height: c.height }, resolveAll(clip.generator.params, layer.localTime), { time, localTime: layer.localTime, clip, sequence: seq });
      image = c;
    } else {
      const fr = provider.frame(layer);
      if (!fr) return provider.isOffline?.(layer) ? 'offline' : null;
      image = fr.image;
      [w, h] = sourceSize(clip, media, seq);
    }
    const effects = (clip.effects || []).filter((e) => e.enabled !== false && plugins.effects.get(e.type)?.target !== 'audio' && plugins.effects.has(e.type));
    if (!effects.length) return { image, w, h };
    // эффекты применяются к слою в пикселях исходника
    const lw = Math.max(1, Math.round(w));
    const lh = Math.max(1, Math.round(h));
    let canvas = this._canvas('fx:' + clip.id, lw, lh);
    let lctx = canvas.getContext('2d');
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, lw, lh);
    lctx.drawImage(image, 0, 0, lw, lh);
    for (const e of effects) {
      const def = plugins.effects.get(e.type);
      const frame = { canvas, ctx: lctx, width: lw, height: lh };
      const res = def.apply(frame, resolveAll(e.params, layer.localTime), { time, localTime: layer.localTime, clip, sequence: seq, effect: e });
      if (res && res !== canvas && res.width) {
        canvas = res;
        lctx = canvas.getContext('2d');
      }
    }
    return { image: canvas, w, h };
  }

  _drawClip(ctx, seq, layer, provider, base, time) {
    const src = this._layerImage(seq, layer, provider, time);
    if (!src) return;
    if (src === 'offline') {
      drawOffline(ctx, seq, base);
      return;
    }
    const g = clipGeometry(layer.clip, layer.media, seq, layer.localTime);
    if (g.opacity <= 0) return;
    ctx.setTransform(...base);
    ctx.globalAlpha = g.opacity;
    ctx.globalCompositeOperation = g.blend === 'normal' ? 'source-over' : g.blend;
    ctx.translate(g.pos[0], g.pos[1]);
    if (g.rad) ctx.rotate(g.rad);
    ctx.scale(g.sx, g.sy);
    ctx.translate(-g.anchor[0], -g.anchor[1]);
    try {
      ctx.drawImage(src.image, 0, 0, src.w, src.h);
    } catch {
      /* кадр ещё не готов */
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  _drawTransition(ctx, seq, layer, provider, base, opts) {
    // Слои A и B рендерятся в полнокадровые холсты, затем переход смешивает их
    const { width, height, time } = opts;
    const mk = (key, l) => {
      const c = this._canvas(key, width, height);
      const cctx = c.getContext('2d');
      cctx.setTransform(1, 0, 0, 1, 0, 0);
      cctx.clearRect(0, 0, width, height);
      if (l) this._drawClip(cctx, seq, l, provider, base, time);
      return c;
    };
    const a = mk('trA', layer.a);
    const b = mk('trB', layer.b);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    layer.def.render(ctx, a, b, layer.progress, resolveAll(layer.transition.params || {}, 0), { time, sequence: seq, width, height, transition: layer.transition });
  }
}

function drawOffline(ctx, seq, base) {
  ctx.setTransform(...base);
  ctx.fillStyle = '#7a1f1f';
  ctx.fillRect(0, 0, seq.width, seq.height);
  ctx.fillStyle = '#fff';
  ctx.font = `600 ${Math.round(seq.height / 14)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Медиа офлайн', seq.width / 2, seq.height / 2);
}
