// Кэш медиаресурсов во время сессии:
//  • Blob и object URL файла из IndexedDB
//  • ImageBitmap для изображений
//  • декодированный AudioBuffer (48 кГц) для воспроизведения, экспорта и волны
//  • производные данные (aux): спрайт превью для таймлайна/библиотеки, пики аудио
//
// Тяжёлые производные данные хранятся в IDB ('aux'), а не в JSON проекта,
// чтобы слепки undo/redo и экспорт проекта оставались лёгкими.

import { Emitter } from '../core/events.js';
import { getAux, getMediaBlob, putAux } from '../storage/projectStore.js';
import { loadMediabunny } from './libs.js';

export const PEAKS_RATE = 60; // пиков в секунду
const DECODE_RATE = 48000;

class MediaCache extends Emitter {
  constructor() {
    super();
    this.blobs = new Map(); // mediaId → Blob | null
    this.urls = new Map(); // mediaId → objectURL
    this.images = new Map(); // mediaId → Promise<ImageBitmap>
    this.audio = new Map(); // mediaId → Promise<AudioBuffer|null>
    this.aux = new Map(); // mediaId → {spriteBitmap, spriteUrl, spriteCount, frameW, frameH, peaks}
    this.auxPending = new Map();
    this.offline = new Set(); // mediaId без файла
  }

  /** Сброс при смене проекта. */
  reset() {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    for (const a of this.aux.values()) if (a?.spriteUrl) URL.revokeObjectURL(a.spriteUrl);
    this.blobs.clear();
    this.urls.clear();
    this.images.clear();
    this.audio.clear();
    this.aux.clear();
    this.auxPending.clear();
    this.offline.clear();
  }

  forget(mediaId) {
    const url = this.urls.get(mediaId);
    if (url) URL.revokeObjectURL(url);
    const aux = this.aux.get(mediaId);
    if (aux?.spriteUrl) URL.revokeObjectURL(aux.spriteUrl);
    for (const m of [this.blobs, this.urls, this.images, this.audio, this.aux, this.auxPending]) m.delete(mediaId);
    this.offline.delete(mediaId);
  }

  async blob(media) {
    if (!media) return null;
    if (this.blobs.has(media.id)) return this.blobs.get(media.id);
    const blob = await getMediaBlob(media.blobKey);
    this.blobs.set(media.id, blob);
    if (!blob) {
      this.offline.add(media.id);
      this.emit('offline', media.id);
    } else this.offline.delete(media.id);
    return blob;
  }

  /** Подставить блоб напрямую (импорт/перелинковка). */
  setBlob(media, blob) {
    this.forget(media.id);
    this.blobs.set(media.id, blob);
    this.offline.delete(media.id);
    this.emit('online', media.id);
  }

  isOffline(mediaId) {
    return this.offline.has(mediaId);
  }

  async url(media) {
    if (this.urls.has(media.id)) return this.urls.get(media.id);
    const blob = await this.blob(media);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.urls.set(media.id, url);
    return url;
  }

  urlSync(mediaId) {
    return this.urls.get(mediaId) || null;
  }

  image(media) {
    if (!this.images.has(media.id)) {
      const p = (async () => {
        const blob = await this.blob(media);
        return blob ? createImageBitmap(blob) : null;
      })();
      p.then((bmp) => {
        p._value = bmp;
        this.emit('image', media.id);
      }).catch(() => {});
      this.images.set(media.id, p);
    }
    return this.images.get(media.id);
  }

  /** Синхронный доступ к уже загруженному ImageBitmap (для рендера кадра). */
  imageSync(mediaId) {
    const p = this.images.get(mediaId);
    return p?._value ?? null;
  }

  async ensureImage(media) {
    const p = this.image(media);
    const bmp = await p;
    p._value = bmp;
    return bmp;
  }

  /** Декодировать аудиодорожку файла в AudioBuffer (48 кГц). */
  audioBuffer(media) {
    if (!media?.hasAudio) return Promise.resolve(null);
    if (!this.audio.has(media.id)) {
      const p = (async () => {
        const blob = await this.blob(media);
        if (!blob) return null;
        try {
          const ctx = new OfflineAudioContext(2, 1, DECODE_RATE);
          return await ctx.decodeAudioData(await blob.arrayBuffer());
        } catch (err) {
          console.warn('[media] decodeAudioData не справился, пробуем mediabunny', err);
          return decodeWithMediabunny(blob);
        }
      })().then((buf) => {
        p._value = buf;
        this.emit('audio', media.id);
        return buf;
      });
      this.audio.set(media.id, p);
    }
    return this.audio.get(media.id);
  }

  audioBufferSync(mediaId) {
    return this.audio.get(mediaId)?._value ?? null;
  }

  // ---------- производные данные ----------

  auxSync(mediaId) {
    return this.aux.get(mediaId) || null;
  }

  /** Загрузить aux из IDB или сгенерировать. */
  loadAux(media) {
    if (this.aux.has(media.id)) return Promise.resolve(this.aux.get(media.id));
    if (this.auxPending.has(media.id)) return this.auxPending.get(media.id);
    const p = (async () => {
      let rec = await getAux(media.id);
      if (!rec || rec.version !== 2) {
        const blob = await this.blob(media);
        if (!blob) return null;
        rec = await generateAux(media, blob, this);
        await putAux(media.id, rec);
      }
      const aux = { ...rec };
      if (rec.sprite) {
        aux.spriteUrl = URL.createObjectURL(rec.sprite);
        aux.spriteBitmap = await createImageBitmap(rec.sprite).catch(() => null);
      }
      this.aux.set(media.id, aux);
      this.auxPending.delete(media.id);
      this.emit('aux', media.id);
      return aux;
    })().catch((err) => {
      console.warn('[media] не удалось подготовить превью', media.name, err);
      this.auxPending.delete(media.id);
      return null;
    });
    this.auxPending.set(media.id, p);
    return p;
  }
}

/** Декодирование аудио через mediabunny (если decodeAudioData не поддерживает контейнер). */
async function decodeWithMediabunny(blob) {
  const M = await loadMediabunny();
  const input = new M.Input({ formats: M.ALL_FORMATS, source: new M.BlobSource(blob) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    const duration = await input.computeDuration();
    const length = Math.ceil(duration * DECODE_RATE) + DECODE_RATE;
    const sink = new M.AudioBufferSink(track);
    // собираем куски, затем ресемплируем через OfflineAudioContext
    const chunks = [];
    for await (const { buffer, timestamp } of sink.buffers()) chunks.push({ buffer, timestamp });
    if (!chunks.length) return null;
    const ctx = new OfflineAudioContext(2, length, DECODE_RATE);
    for (const { buffer, timestamp } of chunks) {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start(Math.max(0, timestamp));
    }
    return await ctx.startRendering();
  } finally {
    input.dispose?.();
  }
}

/** Пики громкости (0..255) с частотой PEAKS_RATE. */
export function computePeaks(buffer) {
  const n = Math.ceil(buffer.duration * PEAKS_RATE);
  const peaks = new Uint8Array(n);
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  const step = buffer.sampleRate / PEAKS_RATE;
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * step);
    const b = Math.min(buffer.length, Math.floor((i + 1) * step));
    let max = 0;
    for (const ch of chans) {
      for (let j = a; j < b; j += 4) {
        const v = Math.abs(ch[j]);
        if (v > max) max = v;
      }
    }
    peaks[i] = Math.min(255, Math.round(Math.sqrt(max) * 255)); // sqrt — нагляднее тихие участки
  }
  return peaks;
}

/** Генерация спрайта превью (кадры по длительности) и пиков. */
async function generateAux(media, blob, cache) {
  const rec = { version: 2, sprite: null, spriteCount: 0, frameW: 0, frameH: 0, peaks: null, peaksRate: PEAKS_RATE };
  const frameH = 90;
  if (media.kind === 'image') {
    const bmp = await createImageBitmap(blob);
    const frameW = Math.max(16, Math.round((frameH * bmp.width) / bmp.height));
    const c = new OffscreenCanvas(frameW, frameH);
    c.getContext('2d').drawImage(bmp, 0, 0, frameW, frameH);
    rec.sprite = await c.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    Object.assign(rec, { spriteCount: 1, frameW, frameH });
  } else if (media.hasVideo) {
    const aspect = media.width && media.height ? media.width / media.height : 16 / 9;
    const frameW = Math.max(16, Math.round(frameH * aspect));
    const count = Math.max(4, Math.min(40, Math.ceil(media.duration / 1.5)));
    const sprite = new OffscreenCanvas(frameW * count, frameH);
    const sctx = sprite.getContext('2d');
    sctx.fillStyle = '#000';
    sctx.fillRect(0, 0, sprite.width, sprite.height);
    const times = Array.from({ length: count }, (_, i) => Math.min(media.duration - 0.05, ((i + 0.5) / count) * media.duration));
    let ok = false;
    try {
      ok = await spriteWithMediabunny(blob, times, sctx, frameW, frameH);
    } catch (err) {
      console.warn('[aux] mediabunny-превью не удалось, используем <video>', err);
    }
    if (!ok) await spriteWithElement(blob, times, sctx, frameW, frameH);
    rec.sprite = await sprite.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
    Object.assign(rec, { spriteCount: count, frameW, frameH });
  }
  if (media.hasAudio) {
    const buf = await cache.audioBuffer(media);
    if (buf) rec.peaks = computePeaks(buf);
  }
  return rec;
}

async function spriteWithMediabunny(blob, times, sctx, w, h) {
  const M = await loadMediabunny();
  const input = new M.Input({ formats: M.ALL_FORMATS, source: new M.BlobSource(blob) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) return false;
    const sink = new M.CanvasSink(track, { width: w, height: h, fit: 'cover', poolSize: 2 });
    let i = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(times)) {
      if (wrapped) sctx.drawImage(wrapped.canvas, i * w, 0, w, h);
      i++;
    }
    return true;
  } finally {
    input.dispose?.();
  }
}

function spriteWithElement(blob, times, sctx, w, h) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    const url = URL.createObjectURL(blob);
    let i = 0;
    const finish = () => {
      URL.revokeObjectURL(url);
      v.removeAttribute('src');
      v.load();
      resolve();
    };
    v.onseeked = () => {
      sctx.drawImage(v, i * w, 0, w, h);
      i++;
      if (i < times.length) v.currentTime = times[i];
      else finish();
    };
    v.onloadeddata = () => {
      v.currentTime = times[0];
    };
    v.onerror = finish;
    v.src = url;
  });
}

export const mediaCache = new MediaCache();
