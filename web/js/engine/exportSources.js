// Источники кадров для экспорта — точное покадровое декодирование.
//
// Перед рендером проходим по всем кадрам экспорта и для каждого видеоклипа
// составляем монотонный список нужных временных меток исходника. Затем для
// каждого клипа открывается CanvasSink (mediabunny/WebCodecs) и итератор
// canvasesAtTimestamps(), который декодирует каждый пакет максимум один раз.
// Если файл нельзя декодировать через WebCodecs — запасной путь: seek <video>.

import { activeVideoLayers, flattenClipLayers } from './layers.js';
import { mediaCache } from '../media/mediaCache.js';
import { loadMediabunny } from '../media/libs.js';

export class ExportSources {
  constructor(project, seq, frameTimes, getMedia) {
    this.project = project;
    this.seq = seq;
    this.frameTimes = frameTimes;
    this.getMedia = getMedia;
    this.plans = new Map(); // clipId → {media, times:[], frames:[], cursor, iter, current, seeker}
    this.inputs = new Map(); // mediaId → Input
    this.layersCache = null;
  }

  layersAt(i) {
    return activeVideoLayers(this.project, this.seq, this.frameTimes[i], this.getMedia);
  }

  async init(onProgress) {
    // 1. план запросов кадров
    const images = new Set();
    for (let i = 0; i < this.frameTimes.length; i++) {
      for (const l of flattenClipLayers(this.layersAt(i))) {
        const m = l.media;
        if (!m) continue;
        if (m.kind === 'image') {
          images.add(m);
          continue;
        }
        if (!m.hasVideo) continue;
        let plan = this.plans.get(l.clip.id);
        if (!plan) {
          plan = { media: m, times: [], frames: [], cursor: 0, iter: null, current: null, seeker: null };
          this.plans.set(l.clip.id, plan);
        }
        // метки должны быть неубывающими — для итератора; при скорости < 0 (не бывает на этапе 1) — clamp
        const last = plan.times[plan.times.length - 1];
        plan.times.push(last !== undefined ? Math.max(last, l.sourceTime) : l.sourceTime);
        plan.frames.push(i);
      }
    }
    // 2. изображения
    for (const m of images) {
      const bmp = await mediaCache.ensureImage(m);
      if (!bmp) throw new Error(`Медиа офлайн: ${m.name}`);
    }
    // 3. декодеры
    const M = await loadMediabunny().catch(() => null);
    let n = 0;
    for (const [clipId, plan] of this.plans) {
      onProgress?.(n++ / Math.max(1, this.plans.size));
      const blob = await mediaCache.blob(plan.media);
      if (!blob) throw new Error(`Медиа офлайн: ${plan.media.name}`);
      let ok = false;
      if (M) {
        try {
          let input = this.inputs.get(plan.media.id);
          if (!input) {
            input = new M.Input({ formats: M.ALL_FORMATS, source: new M.BlobSource(blob) });
            this.inputs.set(plan.media.id, input);
          }
          const track = await input.getPrimaryVideoTrack();
          if (track && (await track.canDecode())) {
            const sink = new M.CanvasSink(track, { poolSize: 2 });
            plan.iter = sink.canvasesAtTimestamps(plan.times)[Symbol.asyncIterator]();
            ok = true;
          }
        } catch (err) {
          console.warn('[export] WebCodecs-декодирование недоступно для', plan.media.name, err);
        }
      }
      if (!ok) plan.seeker = new ElementSeeker(await mediaCache.url(plan.media));
      plan.clipId = clipId;
    }
  }

  /** Подготовить кадры для кадра экспорта i (вызывать строго по порядку). */
  async load(i) {
    for (const plan of this.plans.values()) {
      if (plan.cursor >= plan.frames.length || plan.frames[plan.cursor] !== i) continue;
      const t = plan.times[plan.cursor];
      plan.cursor++;
      if (plan.iter) {
        const { value, done } = await plan.iter.next();
        if (!done && value) plan.current = { image: value.canvas, width: value.canvas.width, height: value.canvas.height };
      } else if (plan.seeker) {
        plan.current = await plan.seeker.frameAt(t);
      }
      // клип закончился — освобождаем декодер
      if (plan.cursor >= plan.frames.length) {
        plan.iter?.return?.();
        plan.iter = null;
      }
    }
  }

  frame(layer) {
    const m = layer.media;
    if (!m) return null;
    if (m.kind === 'image') {
      const bmp = mediaCache.imageSync(m.id);
      return bmp ? { image: bmp, width: bmp.width, height: bmp.height } : null;
    }
    return this.plans.get(layer.clip.id)?.current || null;
  }

  isOffline(layer) {
    return !!layer.media && mediaCache.isOffline(layer.media.id);
  }

  dispose() {
    for (const plan of this.plans.values()) {
      plan.iter?.return?.();
      plan.seeker?.dispose();
    }
    for (const input of this.inputs.values()) input.dispose?.();
    this.plans.clear();
    this.inputs.clear();
  }
}

/** Запасной точный источник: seek элемента <video> и копия кадра в холст. */
class ElementSeeker {
  constructor(url) {
    this.el = document.createElement('video');
    this.el.muted = true;
    this.el.preload = 'auto';
    this.el.src = url;
    this.canvas = null;
    this.ready = new Promise((res, rej) => {
      this.el.addEventListener('loadeddata', res, { once: true });
      this.el.addEventListener('error', () => rej(new Error('Не удалось открыть видео для экспорта')), { once: true });
    });
  }

  async frameAt(t) {
    await this.ready;
    const el = this.el;
    await new Promise((res) => {
      if (Math.abs(el.currentTime - t) < 1e-4 && !el.seeking) return res();
      el.addEventListener('seeked', res, { once: true });
      el.currentTime = t + 0.001;
    });
    const w = el.videoWidth;
    const h = el.videoHeight;
    if (!this.canvas) this.canvas = new OffscreenCanvas(w, h);
    this.canvas.getContext('2d').drawImage(el, 0, 0, w, h);
    return { image: this.canvas, width: w, height: h };
  }

  dispose() {
    this.el.removeAttribute('src');
    this.el.load();
  }
}
