// Экспорт секвенции в видеофайл — полностью в браузере, без сервера и водяных знаков.
//
// Основной путь (быстрый): кадры композиции рендерятся на OffscreenCanvas и
// кодируются WebCodecs (H.264 / VP9) через mediabunny, звук сводится
// OfflineAudioContext'ом и кодируется в AAC (нативно или WASM-кодировщиком) /
// Opus; mediabunny упаковывает всё в MP4 (fast start) или WebM.
//
// Запасной путь: если браузер не умеет кодировать H.264 через WebCodecs —
// FFmpeg.wasm (libx264 + AAC) в отдельном воркере, сегментами по 4 секунды.

import { activeVideoLayers } from './layers.js';
import { Compositor } from './compositor.js';
import { ExportSources } from './exportSources.js';
import { renderAudioMix } from './audioEngine.js';
import { encodeWithFfmpeg } from './ffmpegEncoder.js';
import { mediaCache } from '../media/mediaCache.js';
import { ensureAacEncoder, hasWebCodecs, loadMediabunny } from '../media/libs.js';
import { clipEnd, sequenceDuration, TRACK_KIND } from '../core/model.js';

export class ExportAborted extends Error {
  constructor() {
    super('Экспорт отменён');
    this.name = 'ExportAborted';
  }
}

/** Диапазон экспорта: вся секвенция или In/Out. */
export function exportRange(seq, mode) {
  if (mode === 'inout' && seq.inPoint != null && seq.outPoint != null && seq.outPoint > seq.inPoint) return [seq.inPoint, seq.outPoint];
  return [0, sequenceDuration(seq)];
}

/** Какие движки доступны в браузере. */
export async function detectEncoders(width = 1920, height = 1080, bitrate = 8e6, fps = 30) {
  const res = { webcodecs: hasWebCodecs(), h264: false, vp9: false, aacNative: false };
  if (!res.webcodecs) return res;
  try {
    const M = await loadMediabunny();
    res.h264 = await M.canEncodeVideo('avc', { width, height, bitrate, frameRate: fps });
    res.vp9 = await M.canEncodeVideo('vp9', { width, height, bitrate, frameRate: fps });
    res.aacNative = await M.canEncodeAudio('aac', { sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 });
  } catch (err) {
    console.warn('[export] проверка кодеков', err);
  }
  return res;
}

function hasAudioInRange(seq, start, end) {
  return seq.tracks.some((t) => t.kind === TRACK_KIND.AUDIO && !t.muted && t.clips.some((c) => c.enabled && c.start < end && clipEnd(c) > start));
}

/**
 * Экспорт.
 * opts: { format:'mp4'|'webm', width, height, fps, videoBitrate, audioBitrate,
 *         range:[start,end], engine:'auto'|'webcodecs'|'ffmpeg' }
 * Возвращает { blob, engine, audioEncoder, frames, seconds }.
 */
export async function exportSequence(project, seq, opts, { onProgress = () => {}, signal } = {}) {
  const t0 = performance.now();
  const width = Math.max(2, Math.round(opts.width / 2) * 2); // H.264 требует чётные размеры
  const height = Math.max(2, Math.round(opts.height / 2) * 2);
  const fps = opts.fps;
  const [start, end] = opts.range;
  if (!(end > start)) throw new Error('Пустой диапазон экспорта: на таймлайне нет клипов');
  const frameCount = Math.max(1, Math.round((end - start) * fps));
  const frameTimes = Array.from({ length: frameCount }, (_, i) => start + i / fps);
  const getMedia = (id) => project.media.find((m) => m.id === id) || null;
  const check = () => {
    if (signal?.aborted) throw new ExportAborted();
  };

  // ---- выбор движка ----
  let engine = opts.engine || 'auto';
  if (opts.format === 'webm') engine = 'webcodecs';
  if (engine !== 'ffmpeg') {
    const enc = await detectEncoders(width, height, opts.videoBitrate, fps);
    const ok = opts.format === 'webm' ? enc.vp9 : enc.h264;
    if (!ok) {
      if (engine === 'webcodecs' || opts.format === 'webm') throw new Error('Браузер не поддерживает аппаратное/программное кодирование этого формата через WebCodecs. Выберите движок FFmpeg.wasm или формат MP4.');
      engine = 'ffmpeg';
    } else engine = 'webcodecs';
  }

  // ---- подготовка: звук ----
  onProgress({ phase: 'prepare', progress: 0, label: 'Подготовка звука' });
  const audioMedia = new Set();
  for (const t of seq.tracks) if (t.kind === TRACK_KIND.AUDIO) for (const c of t.clips) if (c.enabled && c.start < end && clipEnd(c) > start) audioMedia.add(c.mediaId);
  for (const id of audioMedia) {
    const m = getMedia(id);
    if (m) {
      const buf = await mediaCache.audioBuffer(m);
      if (!buf && mediaCache.isOffline(id)) throw new Error(`Медиа офлайн: ${m.name}`);
    }
    check();
  }
  const withAudio = hasAudioInRange(seq, start, end);
  const mix = withAudio ? await renderAudioMix(seq, start, end, (id) => mediaCache.audioBufferSync(id), 48000) : null;
  check();

  // ---- подготовка: видео ----
  onProgress({ phase: 'prepare', progress: 0.3, label: 'Подготовка декодеров' });
  const sources = new ExportSources(project, seq, frameTimes, getMedia);
  await sources.init((p) => onProgress({ phase: 'prepare', progress: 0.3 + 0.6 * p, label: 'Подготовка декодеров' }));
  check();

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  const compositor = new Compositor();
  const renderFrame = async (i) => {
    await sources.load(i);
    const layers = activeVideoLayers(project, seq, frameTimes[i], getMedia);
    compositor.render(ctx, seq, layers, sources, { width, height, quality: 'high', time: frameTimes[i] });
  };

  let result;
  try {
    if (engine === 'webcodecs') {
      result = await encodeWithMediabunny({ canvas, frameCount, fps, width, height, opts, mix, renderFrame, onProgress, check });
    } else {
      result = await encodeWithFfmpeg({ canvas, frameCount, fps, width, height, opts, mix, renderFrame, onProgress, check });
    }
  } finally {
    sources.dispose();
  }
  return { ...result, engine, frames: frameCount, seconds: (performance.now() - t0) / 1000 };
}

async function encodeWithMediabunny({ canvas, frameCount, fps, width, height, opts, mix, renderFrame, onProgress, check }) {
  const M = await loadMediabunny();
  const isMp4 = opts.format !== 'webm';
  let audioEncoder = null;
  if (mix) audioEncoder = isMp4 ? await ensureAacEncoder(48000, 2) : 'native';
  const quality = (bitrate) => (M.Quality ? { quality: new M.Quality({ bitrate }) } : { bitrate });

  const output = new M.Output({
    format: isMp4 ? new M.Mp4OutputFormat({ fastStart: 'in-memory' }) : new M.WebMOutputFormat(),
    target: new M.BufferTarget(),
  });
  const videoSource = new M.CanvasSource(canvas, {
    codec: isMp4 ? 'avc' : 'vp9',
    ...quality(opts.videoBitrate),
    keyFrameInterval: 2,
  });
  output.addVideoTrack(videoSource, { frameRate: fps });
  let audioSource = null;
  if (mix) {
    audioSource = new M.AudioBufferSource({ codec: isMp4 ? 'aac' : 'opus', ...quality(opts.audioBitrate) });
    output.addAudioTrack(audioSource);
  }
  await output.start();

  // звук добавляем секундными кусками, опережая видео — так mediabunny перемежает дорожки
  let audioPos = 0;
  const sr = mix?.sampleRate || 48000;
  const pushAudioUntil = async (sec) => {
    if (!audioSource) return;
    const target = Math.min(mix.length, Math.ceil(sec * sr));
    while (audioPos < target) {
      const len = Math.min(sr, target - audioPos);
      const slice = new AudioBuffer({ length: len, numberOfChannels: mix.numberOfChannels, sampleRate: sr });
      for (let c = 0; c < mix.numberOfChannels; c++) slice.copyToChannel(mix.getChannelData(c).subarray(audioPos, audioPos + len), c);
      await audioSource.add(slice);
      audioPos += len;
    }
  };

  try {
    const started = performance.now();
    for (let i = 0; i < frameCount; i++) {
      check();
      await renderFrame(i);
      await videoSource.add(i / fps, 1 / fps);
      await pushAudioUntil((i + 1) / fps + 1);
      if (i % 3 === 0 || i === frameCount - 1) {
        const elapsed = (performance.now() - started) / 1000;
        onProgress({ phase: 'video', progress: (i + 1) / frameCount, frame: i + 1, frames: frameCount, eta: (elapsed / (i + 1)) * (frameCount - i - 1), label: `Кадр ${i + 1} из ${frameCount}` });
      }
    }
    await pushAudioUntil(Infinity);
    onProgress({ phase: 'finalize', progress: 1, label: 'Сборка файла' });
    videoSource.close();
    audioSource?.close();
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => {});
    throw err;
  }
  const blob = new Blob([output.target.buffer], { type: isMp4 ? 'video/mp4' : 'video/webm' });
  return { blob, audioEncoder, extension: isMp4 ? 'mp4' : 'webm' };
}
