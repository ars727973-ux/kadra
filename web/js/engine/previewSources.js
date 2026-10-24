// Источники кадров для превью (Program Monitor).
//
// Для каждого видеоклипа под плейхедом (и ближайших будущих — предзагрузка)
// создаётся собственный <video> (два клипа одного файла могут идти одновременно).
// Во время воспроизведения элементы играют нативно (аппаратное декодирование —
// 1080p в 30+ fps), а их время подтягивается к мастер-часам WebAudio.
// На паузе элементы позиционируются seek'ом с ожиданием события 'seeked'.

import { mediaCache } from '../media/mediaCache.js';

const MAX_ELEMENTS = 12;

export class PreviewSources {
  constructor() {
    this.videos = new Map(); // clipId → {el, mediaId, lastUsed}
    this.host = document.createElement('div');
    this.host.className = 'hidden-media-host';
    this.host.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this.host);
  }

  _entry(clip, media) {
    let e = this.videos.get(clip.id);
    if (e && e.mediaId !== media.id) {
      this._dispose(clip.id);
      e = null;
    }
    if (!e) {
      const el = document.createElement('video');
      el.muted = true; // звук — только через WebAudio
      el.playsInline = true;
      el.preload = 'auto';
      el.crossOrigin = 'anonymous';
      this.host.appendChild(el);
      e = { el, mediaId: media.id, lastUsed: performance.now(), wanted: null, loading: true };
      this.videos.set(clip.id, e);
      mediaCache.url(media).then((url) => {
        if (!url || !this.videos.has(clip.id)) return;
        el.src = url;
        el.addEventListener('loadeddata', () => (e.loading = false), { once: true });
      });
    }
    e.lastUsed = performance.now();
    return e;
  }

  _dispose(clipId) {
    const e = this.videos.get(clipId);
    if (!e) return;
    e.el.pause();
    e.el.removeAttribute('src');
    e.el.load();
    e.el.remove();
    this.videos.delete(clipId);
  }

  /** Подготовить элементы для активных слоёв и предзагрузить будущие клипы. */
  prepare(clipLayers, upcoming = [], getMedia) {
    const keep = new Set();
    for (const l of clipLayers) {
      if (l.media?.kind === 'video' && l.media.hasVideo) {
        this._entry(l.clip, l.media);
        keep.add(l.clip.id);
      } else if (l.media?.kind === 'image') {
        mediaCache.image(l.media);
      }
    }
    for (const c of upcoming) {
      const m = getMedia(c.mediaId);
      if (!m) continue;
      if (m.kind === 'video' && m.hasVideo) {
        const e = this._entry(c, m);
        keep.add(c.id);
        // заранее ставим элемент на точку входа клипа
        if (e.el.paused && Math.abs(e.el.currentTime - c.in) > 0.05 && e.el.readyState >= 1) e.el.currentTime = c.in;
      } else if (m.kind === 'image') mediaCache.image(m);
    }
    // ограничиваем количество элементов (LRU)
    if (this.videos.size > MAX_ELEMENTS) {
      const sorted = [...this.videos.entries()].filter(([id]) => !keep.has(id)).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      while (this.videos.size > MAX_ELEMENTS && sorted.length) this._dispose(sorted.shift()[0]);
    }
    // ставим на паузу неактивные
    for (const [id, e] of this.videos) if (!keep.has(id) && !e.el.paused) e.el.pause();
  }

  /** Кадр для слоя (синхронно). */
  frame(layer) {
    const m = layer.media;
    if (!m) return null;
    if (m.kind === 'image') {
      const bmp = mediaCache.imageSync(m.id);
      return bmp ? { image: bmp, width: bmp.width, height: bmp.height } : null;
    }
    const e = this.videos.get(layer.clip.id);
    if (!e || e.el.readyState < 2) return null;
    return { image: e.el, width: e.el.videoWidth, height: e.el.videoHeight };
  }

  isOffline(layer) {
    return !!layer.media && mediaCache.isOffline(layer.media.id);
  }

  /**
   * Позиционирование на паузе. Возвращает Promise, который разрешается,
   * когда все элементы показали нужный кадр.
   */
  seek(clipLayers) {
    const waits = [];
    for (const l of clipLayers) {
      const e = this.videos.get(l.clip.id);
      if (!e) continue;
      const el = e.el;
      if (!el.paused) el.pause();
      const target = l.sourceTime + 0.001;
      e.wanted = target;
      const fps = l.media.fps || 30;
      waits.push(
        new Promise((resolve) => {
          const go = () => {
            if (Math.abs(el.currentTime - target) < 0.5 / fps && el.readyState >= 2 && !el.seeking) return resolve();
            const done = () => {
              el.removeEventListener('seeked', done);
              resolve();
            };
            el.addEventListener('seeked', done);
            el.currentTime = target;
            setTimeout(done, 1500); // страховка
          };
          if (el.readyState >= 1) go();
          else el.addEventListener('loadedmetadata', go, { once: true });
          setTimeout(resolve, 3000);
        })
      );
    }
    return Promise.all(waits);
  }

  /** Синхронизация во время воспроизведения с мастер-часами. */
  sync(clipLayers, rate) {
    const active = new Set();
    for (const l of clipLayers) {
      const e = this.videos.get(l.clip.id);
      if (!e || e.el.readyState < 1) continue;
      active.add(l.clip.id);
      const el = e.el;
      const target = l.sourceTime;
      const speed = (l.clip.speed || 1) * rate;
      const drift = el.currentTime - target;
      if (el.paused || Math.abs(drift) > 0.25) {
        if (Math.abs(drift) > 0.05) el.currentTime = target;
        el.playbackRate = Math.min(16, Math.max(0.0625, speed));
        if (el.paused) el.play().catch(() => {});
      } else {
        // мягкая подстройка скорости вместо рывков
        const corr = Math.max(-0.08, Math.min(0.08, -drift * 0.5));
        el.playbackRate = Math.min(16, Math.max(0.0625, speed * (1 + corr)));
      }
    }
    for (const [id, e] of this.videos) if (!active.has(id) && !e.el.paused) e.el.pause();
  }

  pauseAll() {
    for (const e of this.videos.values()) if (!e.el.paused) e.el.pause();
  }

  /** Удалить элементы клипов, которых больше нет. */
  prune(existingClipIds) {
    for (const id of [...this.videos.keys()]) if (!existingClipIds.has(id)) this._dispose(id);
  }

  disposeAll() {
    for (const id of [...this.videos.keys()]) this._dispose(id);
  }
}
