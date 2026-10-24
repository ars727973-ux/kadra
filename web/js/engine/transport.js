// Транспорт секвенции: Play/Pause, шаттл J/K/L, покадровые шаги.
// Мастер-часы — AudioContext.currentTime (точная синхронизация звука).
// Обратное воспроизведение (J) — покадровое, без звука (как и в большинстве
// браузерных плееров нет отрицательного playbackRate).

import { Emitter } from '../core/events.js';
import { store } from '../core/store.js';
import { sequenceDuration } from '../core/model.js';
import { snapToFrame } from '../core/time.js';
import { audioEngine } from './audioEngine.js';
import { mediaCache } from '../media/mediaCache.js';

const SHUTTLE = [1, 2, 4, 8];
const LEAD = 0.06; // запас на планирование звука, сек

class Transport extends Emitter {
  constructor() {
    super();
    this.playing = false;
    this.rate = 0; // 0 — стоп; >0 — вперёд; <0 — назад
    this._raf = 0;
    this._t0 = 0;
    this._when = 0;
    this._stopAt = Infinity;
    this._reverseTimer = 0;
    this._rescheduleTimer = 0;
    // перепланировать звук при правках во время воспроизведения
    store.on('change', () => {
      if (this.playing && this.rate > 0) this._softReschedule();
    });
    mediaCache.on('audio', () => {
      if (this.playing && this.rate > 0) this._softReschedule();
    });
  }

  get time() {
    if (!this.playing) return store.ui.playhead;
    if (this.rate < 0) return store.ui.playhead;
    const ctxNow = audioEngine.now - audioEngine.outputLatency;
    return this._t0 + Math.max(0, ctxNow - this._when) * this.rate;
  }

  _endTime() {
    return sequenceDuration(store.seq);
  }

  /** Воспроизведение со скоростью rate (по умолчанию 1×). */
  play(rate = 1, { stopAt = Infinity } = {}) {
    if (rate < 0) return this._playReverse(rate);
    this._stopReverse();
    const seq = store.seq;
    const end = this._endTime();
    let t0 = store.ui.playhead;
    if (t0 >= end - 1 / seq.fps && end > 0) t0 = 0; // с конца — в начало, как в Premiere
    audioEngine.ensureContext();
    this._prefetchAudio(seq);
    this.playing = true;
    this.rate = rate;
    this._stopAt = stopAt;
    this._t0 = t0;
    this._when = audioEngine.now + LEAD;
    this._schedule();
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(this._tick);
    this.emit('state', this.state);
  }

  _prefetchAudio(seq) {
    for (const t of seq.tracks) for (const c of t.clips) {
      const m = store.getMedia(c.mediaId);
      if (m && t.kind === 'audio') mediaCache.audioBuffer(m);
    }
  }

  _schedule() {
    const seq = store.seq;
    audioEngine.schedule(seq, this._t0, this._when, this.rate, (id) => mediaCache.audioBufferSync(id));
  }

  _softReschedule() {
    clearTimeout(this._rescheduleTimer);
    this._rescheduleTimer = setTimeout(() => {
      if (!this.playing || this.rate <= 0) return;
      const t = this.time;
      this._t0 = t;
      this._when = audioEngine.now + LEAD;
      this._schedule();
    }, 30);
  }

  _tick = () => {
    if (!this.playing || this.rate <= 0) return;
    let t = this.time;
    const end = Math.min(this._endTime(), this._stopAt);
    if (t >= end) {
      t = end;
      store.setPlayhead(t, { snap: true });
      this.pause();
      return;
    }
    store.setPlayhead(t, { snap: false });
    this.emit('tick', t);
    this._raf = requestAnimationFrame(this._tick);
  };

  _playReverse(rate) {
    this.pause({ silent: true });
    this.playing = true;
    this.rate = rate;
    const fps = store.seq.fps;
    const stepMs = 1000 / (fps * Math.abs(rate));
    let last = performance.now();
    const loop = () => {
      if (!this.playing || this.rate >= 0) return;
      const now = performance.now();
      const frames = Math.max(1, Math.round((now - last) / stepMs));
      last = now;
      const t = Math.max(0, store.ui.playhead - frames / fps);
      store.setPlayhead(t);
      this.emit('tick', t);
      if (t <= 0) return this.pause();
      this._reverseTimer = setTimeout(loop, Math.max(16, stepMs));
    };
    this._reverseTimer = setTimeout(loop, stepMs);
    this.emit('state', this.state);
  }

  _stopReverse() {
    clearTimeout(this._reverseTimer);
  }

  pause({ silent = false } = {}) {
    const wasPlaying = this.playing;
    const t = this.time;
    this.playing = false;
    this.rate = 0;
    cancelAnimationFrame(this._raf);
    this._stopReverse();
    audioEngine.stop();
    if (wasPlaying) store.setPlayhead(snapToFrame(t, store.seq.fps));
    if (!silent) this.emit('state', this.state);
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play(1);
  }

  /** L: вперёд с нарастанием скорости; J: назад; K: стоп. */
  shuttle(dir) {
    if (dir === 0) return this.pause();
    const cur = this.playing ? this.rate : 0;
    let next;
    if (dir > 0) next = cur > 0 ? SHUTTLE[Math.min(SHUTTLE.length - 1, SHUTTLE.indexOf(cur) + 1)] || 1 : 1;
    else next = cur < 0 ? -(SHUTTLE[Math.min(SHUTTLE.length - 1, SHUTTLE.indexOf(-cur) + 1)] || 1) : -1;
    this.play(next);
  }

  step(frames) {
    if (this.playing) this.pause();
    const fps = store.seq.fps;
    store.setPlayhead(snapToFrame(store.ui.playhead, fps) + frames / fps);
  }

  seek(t) {
    const wasPlaying = this.playing && this.rate > 0;
    const rate = this.rate;
    if (wasPlaying) {
      this._t0 = Math.max(0, t);
      this._when = audioEngine.now + LEAD;
      store.setPlayhead(t);
      this._schedule();
      this.emit('seek', t);
      return;
    }
    if (this.playing) this.pause();
    store.setPlayhead(t);
    if (wasPlaying) this.play(rate);
  }

  get state() {
    return { playing: this.playing, rate: this.rate };
  }
}

export const transport = new Transport();
