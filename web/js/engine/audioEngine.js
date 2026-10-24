// Аудиодвижок на WebAudio.
//
// Граф строится одной функцией buildAudioGraph() и для живого воспроизведения
// (AudioContext), и для экспорта (OfflineAudioContext) — звук в файле
// совпадает с превью.
//
//   клип: BufferSource → [аудиоэффекты клипа — этап 2] → Gain(громкость) → Panner ─┐
//   дорожка: Gain(громкость/mute/solo) → Panner → [эффекты дорожки — этап 2] ───────┤
//   мастер: Gain → (анализаторы для индикаторов) → выход ◄────────────────────────────┘
//
// Время воспроизведения (мастер-часы) = AudioContext.currentTime — видео
// подстраивается под звук, а не наоборот.

import { isAnimated, resolveAll, resolveParam } from '../core/keyframes.js';
import { clipEnd, TRACK_KIND } from '../core/model.js';
import { plugins } from '../plugins/registry.js';

/** Применить (возможно анимированный) параметр к AudioParam. */
function applyParam(audioParam, value, map, clip, segStartTL, segEndTL, t0, when, rate) {
  if (!isAnimated(value)) {
    audioParam.value = map(value);
    return;
  }
  // ключевые кадры: дискретизируем с шагом 20 мс и используем линейные рампы
  const step = 0.02;
  audioParam.setValueAtTime(map(resolveParam(value, segStartTL - clip.start)), when + (segStartTL - t0) / rate);
  for (let tl = segStartTL + step; tl <= segEndTL; tl += step) {
    audioParam.linearRampToValueAtTime(map(resolveParam(value, tl - clip.start)), when + (tl - t0) / rate);
  }
}

/**
 * Построить граф и запланировать все аудиоклипы секвенции.
 *  t0   — момент таймлайна, с которого начинается воспроизведение
 *  when — время контекста, соответствующее t0
 *  rate — скорость воспроизведения (L ×2, ×4…)
 *  tEnd — конец диапазона (для экспорта)
 *  getBuffer(mediaId) → AudioBuffer | null
 * Возвращает { sources, nodes, missing } — missing: mediaId без декодированного звука.
 */
export function buildAudioGraph(ctx, seq, { t0, when, rate = 1, tEnd = Infinity, destination, getBuffer }) {
  const sources = [];
  const nodes = [];
  const missing = new Set();
  const aTracks = seq.tracks.filter((t) => t.kind === TRACK_KIND.AUDIO);
  const anySolo = aTracks.some((t) => t.solo);
  for (const track of aTracks) {
    const audible = !track.muted && (!anySolo || track.solo);
    if (!audible) continue;
    const tGain = ctx.createGain();
    tGain.gain.value = track.volume ?? 1;
    const tPan = ctx.createStereoPanner();
    tPan.pan.value = track.pan || 0;
    tGain.connect(tPan);
    let tail = tPan;
    // эффекты дорожки (этап 2)
    for (const e of track.effects || []) {
      const def = plugins.effects.get(e.type);
      if (!def || def.target !== 'audio' || e.enabled === false) continue;
      const n = def.createNode(ctx, resolveAll(e.params, 0), { track, sequence: seq });
      tail.connect(n.input);
      tail = n.output;
      nodes.push(n);
    }
    tail.connect(destination);
    nodes.push(tGain, tPan);

    let used = false;
    for (const clip of track.clips) {
      if (!clip.enabled || !clip.mediaId) continue;
      const end = Math.min(clipEnd(clip), tEnd);
      if (end <= t0 + 1e-6 || clip.start >= tEnd) continue;
      const buffer = getBuffer(clip.mediaId);
      if (!buffer) {
        missing.add(clip.mediaId);
        continue;
      }
      const segStart = Math.max(t0, clip.start);
      const speed = clip.speed || 1;
      const offset = clip.in + (segStart - clip.start) * speed;
      const srcDur = (end - segStart) * speed;
      if (offset >= buffer.duration || srcDur <= 0) continue;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = speed * rate;
      let head = src;
      // аудиоэффекты клипа (этап 2)
      for (const e of clip.effects || []) {
        const def = plugins.effects.get(e.type);
        if (!def || def.target !== 'audio' || e.enabled === false) continue;
        const n = def.createNode(ctx, resolveAll(e.params, segStart - clip.start), { clip, sequence: seq });
        head.connect(n.input);
        head = n.output;
        nodes.push(n);
      }
      const g = ctx.createGain();
      applyParam(g.gain, clip.audio?.volume ?? 1, (v) => Math.max(0, v), clip, segStart, end, t0, when, rate);
      const p = ctx.createStereoPanner();
      applyParam(p.pan, clip.audio?.pan ?? 0, (v) => Math.max(-1, Math.min(1, v)), clip, segStart, end, t0, when, rate);
      head.connect(g);
      g.connect(p);
      p.connect(tGain);
      const startAt = when + (segStart - t0) / rate;
      src.start(Math.max(ctx.currentTime, startAt), offset, Math.min(srcDur, buffer.duration - offset));
      sources.push(src);
      nodes.push(g, p);
      used = true;
    }
    if (!used) {
      tPan.disconnect();
    }
  }
  return { sources, nodes, missing };
}

/** Живое воспроизведение + индикаторы уровня. */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.analysers = null;
    this.graph = null;
  }

  ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive', sampleRate: 48000 });
      this.master = this.ctx.createGain();
      const splitter = this.ctx.createChannelSplitter(2);
      const aL = this.ctx.createAnalyser();
      const aR = this.ctx.createAnalyser();
      aL.fftSize = aR.fftSize = 2048;
      this.master.connect(splitter);
      splitter.connect(aL, 0);
      splitter.connect(aR, 1);
      this.master.connect(this.ctx.destination);
      this.analysers = [aL, aR];
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** Задержка вывода звука — видео смещается на неё для точной синхронизации. */
  get outputLatency() {
    if (!this.ctx) return 0;
    return (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
  }

  schedule(seq, t0, when, rate, getBuffer) {
    this.stop();
    if (rate <= 0) return { missing: new Set() };
    this.master.gain.value = seq.masterVolume ?? 1;
    this.graph = buildAudioGraph(this.ctx, seq, { t0, when, rate, destination: this.master, getBuffer });
    return this.graph;
  }

  stop() {
    if (!this.graph) return;
    for (const s of this.graph.sources) {
      try {
        s.stop();
      } catch {
        /* уже остановлен */
      }
      s.disconnect();
    }
    for (const n of this.graph.nodes) {
      try {
        (n.output || n).disconnect();
      } catch {
        /* */
      }
    }
    this.graph = null;
  }

  /** Пиковые уровни каналов в dBFS (для индикаторов). */
  levels() {
    if (!this.analysers) return [-Infinity, -Infinity];
    const buf = (this._buf ||= new Float32Array(2048));
    return this.analysers.map((a) => {
      a.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i]);
        if (v > peak) peak = v;
      }
      return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    });
  }
}

export const audioEngine = new AudioEngine();

/** Офлайн-сведение звука секвенции в AudioBuffer (для экспорта). */
export async function renderAudioMix(seq, start, end, getBuffer, sampleRate = 48000) {
  const length = Math.max(1, Math.ceil((end - start) * sampleRate));
  const ctx = new OfflineAudioContext(2, length, sampleRate);
  const master = ctx.createGain();
  master.gain.value = seq.masterVolume ?? 1;
  master.connect(ctx.destination);
  buildAudioGraph(ctx, seq, { t0: start, when: 0, rate: 1, tEnd: end, destination: master, getBuffer });
  return ctx.startRendering();
}
