// Панель «Источник» (Source Monitor): предпросмотр медиа из библиотеки,
// собственный транспорт J/K/L, точки входа/выхода исходника, вставка (,)
// и наложение (.) на таймлайн, перетаскивание кадра/«только видео»/«только звук».

import { h, fitCanvas, dragPointer } from '../dom.js';
import { icon } from '../icons.js';
import { store } from '../../core/store.js';
import { formatTC, snapToFrame } from '../../core/time.js';
import { mediaCache } from '../../media/mediaCache.js';
import { startMediaDrag, endMediaDrag } from '../dnd.js';

const SHUTTLE = [1, 2, 4, 8];

export class SourceMonitor {
  constructor(app) {
    this.app = app;
    this.id = 'source';
    this.title = 'Источник';
    this.el = h('div.monitor');
    this.media = null;
    this.time = 0;
    this.rate = 0;
    this._build();
    store.on('source-media', (id) => this.load(id));
    store.on('change', () => {
      if (this.media && !store.getMedia(this.media.id)) this.load(null);
      else if (this.media) {
        this.media = store.getMedia(this.media.id);
        this._drawScrub();
        this._updateTC();
      }
    });
    mediaCache.on('aux', (id) => this.media?.id === id && this._drawWave());
  }

  get fps() {
    return this.media?.fps ? Math.round(this.media.fps) || store.seq.fps : store.seq.fps;
  }

  get duration() {
    if (!this.media) return 0;
    return this.media.kind === 'image' ? store.project.settings.defaultImageDuration : this.media.duration;
  }

  _build() {
    this.video = h('video', { muted: false, playsInline: true, preload: 'auto' });
    this.img = h('img', { alt: '' });
    this.waveCanvas = h('canvas.frame');
    this.empty = h('div.monitor-empty', 'Дважды щёлкните элемент в панели «Проект»,', h('br'), 'чтобы открыть его здесь');
    this.view = h('div.monitor-view', this.empty, this.video, this.img, this.waveCanvas);
    this.video.classList.add('hidden');
    this.img.classList.add('hidden');
    this.waveCanvas.classList.add('hidden');
    // перетаскивание всего кадра на таймлайн
    this.view.draggable = true;
    this.view.addEventListener('dragstart', (e) => this._dragStart(e, true, true));
    this.view.addEventListener('dragend', endMediaDrag);
    this.view.addEventListener('pointerdown', () => store.setFocus('source'));
    this.video.addEventListener('timeupdate', () => {
      if (!this.video.paused) this._syncFromVideo();
    });
    this.video.addEventListener('ended', () => this._setPlaying(false));
    this.video.addEventListener('loadedmetadata', () => this.layout());

    this.nameEl = h('div.muted', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40%' }, '');
    this.tcEl = h('div.timecode', '00:00:00:00');
    this.durEl = h('div.timecode.dim', { title: 'Длительность In→Out' }, '');
    const vDrag = h('div.drag-handle', { draggable: true, title: 'Перетащите на таймлайн — только видео' }, icon('video'), 'Видео');
    const aDrag = h('div.drag-handle', { draggable: true, title: 'Перетащите на таймлайн — только звук' }, icon('audio'), 'Звук');
    vDrag.addEventListener('dragstart', (e) => this._dragStart(e, true, false));
    aDrag.addEventListener('dragstart', (e) => this._dragStart(e, false, true));
    vDrag.addEventListener('dragend', endMediaDrag);
    aDrag.addEventListener('dragend', endMediaDrag);
    this.vDrag = vDrag;
    this.aDrag = aDrag;
    this.bar = h('div.monitor-bar', this.tcEl, this.nameEl, h('div.grow'), h('div.drag-handles', vDrag, aDrag), this.durEl);

    this.scrubCanvas = h('canvas');
    this.scrub = h('div.monitor-scrub', this.scrubCanvas);
    this.scrub.addEventListener('pointerdown', (e) => this._scrubDown(e));

    const b = (ic, title, fn) => {
      const btn = h('button.icon-btn', { type: 'button', title }, icon(ic));
      btn.addEventListener('click', () => {
        store.setFocus('source');
        fn();
      });
      return btn;
    };
    this.playBtn = b('play', 'Воспроизведение/стоп (Пробел)', () => this.togglePlay());
    this.playBtn.classList.add('play');
    this.el.append(
      this.view,
      this.bar,
      this.scrub,
      h(
        'div.transport',
        b('markIn', 'Отметить вход (I)', () => this.markIn()),
        b('markOut', 'Отметить выход (O)', () => this.markOut()),
        h('div.sep'),
        b('toIn', 'К точке входа (Shift+I)', () => this.goIn()),
        b('stepBack', 'Кадр назад (←)', () => this.step(-1)),
        this.playBtn,
        b('stepFwd', 'Кадр вперёд (→)', () => this.step(1)),
        b('toOut', 'К точке выхода (Shift+O)', () => this.goOut()),
        h('div.sep'),
        b('insert', 'Вставка (,)', () => this.app.run('source.insert')),
        b('overwrite', 'Наложение (.)', () => this.app.run('source.overwrite'))
      )
    );
  }

  onResize() {
    this.layout();
    this._drawScrub();
  }

  onShow() {
    this.onResize();
  }

  async load(mediaId, atTime = null) {
    this.pause();
    const media = mediaId ? store.getMedia(mediaId) : null;
    this.media = media;
    this.time = 0;
    for (const el of [this.video, this.img, this.waveCanvas]) el.classList.add('hidden');
    this.empty.textContent = 'Дважды щёлкните элемент в панели «Проект», чтобы открыть его здесь';
    this.empty.classList.toggle('hidden', !!media);
    this.video.removeAttribute('src');
    this.nameEl.textContent = media ? media.name : '';
    if (!media) {
      this._updateTC();
      this._drawScrub();
      return;
    }
    const url = await mediaCache.url(media);
    if (this.media !== media) return;
    if (!url) {
      this.empty.textContent = `Медиа офлайн: ${media.name}`;
      this.empty.classList.remove('hidden');
      return;
    }
    if (media.kind === 'image') {
      this.img.src = url;
      this.img.onload = () => this.layout();
      this.img.classList.remove('hidden');
    } else {
      this.video.src = url;
      this.video.muted = false;
      if (media.hasVideo) this.video.classList.remove('hidden');
      else {
        this.waveCanvas.classList.remove('hidden');
        mediaCache.loadAux(media);
      }
    }
    this.vDrag.classList.toggle('hidden', !media.hasVideo);
    this.aDrag.classList.toggle('hidden', !media.hasAudio);
    this.seek(atTime ?? media.markIn ?? 0);
    this.layout();
    this.app.layout.showPanel('source');
  }

  layout() {
    const vw = this.view.clientWidth;
    const vh = this.view.clientHeight;
    if (!vw || !vh || !this.media) return;
    const w0 = this.media.width || 16;
    const h0 = this.media.height || 9;
    const s = Math.min(vw / w0, vh / h0);
    for (const el of [this.video, this.img]) {
      el.style.width = Math.round(w0 * s) + 'px';
      el.style.height = Math.round(h0 * s) + 'px';
      el.style.left = Math.round((vw - w0 * s) / 2) + 'px';
      el.style.top = Math.round((vh - h0 * s) / 2) + 'px';
    }
    if (!this.media.hasVideo) this._drawWave();
    this._drawScrub();
    this._updateTC();
  }

  _drawWave() {
    if (!this.media || this.media.hasVideo) return;
    const vw = this.view.clientWidth;
    const vh = this.view.clientHeight;
    const ctx = fitCanvas(this.waveCanvas, vw, vh);
    this.waveCanvas.style.left = '0px';
    this.waveCanvas.style.top = '0px';
    ctx.fillStyle = '#0e0f11';
    ctx.fillRect(0, 0, vw, vh);
    const aux = mediaCache.auxSync(this.media.id);
    if (!aux?.peaks) return;
    const n = aux.peaks.length;
    ctx.fillStyle = '#7fbf6a';
    const mid = vh / 2;
    for (let x = 0; x < vw; x++) {
      const i0 = Math.floor((x / vw) * n);
      const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / vw) * n));
      let v = 0;
      for (let i = i0; i < i1; i++) if (aux.peaks[i] > v) v = aux.peaks[i];
      const a = (v / 255) * mid * 0.9;
      ctx.fillRect(x, mid - a, 1, a * 2 || 1);
    }
    const px = (this.time / this.duration) * vw;
    ctx.fillStyle = '#ff9a2e';
    ctx.fillRect(px, 0, 1, vh);
  }

  // ---------- транспорт ----------

  _syncFromVideo() {
    this.time = this.video.currentTime;
    if (this.media?.markOut != null && this.time >= this.media.markOut && this._stopAtOut) {
      this.pause();
      this.seek(this.media.markOut);
    }
    this._updateTC();
    this._drawScrub();
    if (!this.media?.hasVideo) this._drawWave();
  }

  _setPlaying(on) {
    this.playBtn.replaceChildren(icon(on ? 'pause' : 'play'));
    if (!on) {
      this.rate = 0;
      cancelAnimationFrame(this._raf);
      clearInterval(this._rev);
    }
  }

  play(rate = 1) {
    if (!this.media || this.media.kind === 'image') return;
    clearInterval(this._rev);
    if (rate < 0) {
      this.video.pause();
      this.rate = rate;
      const fps = this.fps;
      this._rev = setInterval(() => {
        const t = Math.max(0, this.time - 1 / fps);
        this.seek(t);
        if (t <= 0) this.pause();
      }, 1000 / (fps * Math.abs(rate)));
      this._setPlaying(true);
      return;
    }
    if (this.time >= this.duration - 0.05) this.seek(0);
    this.rate = rate;
    this.video.playbackRate = rate;
    this.video.play().catch(() => {});
    this._setPlaying(true);
    const loop = () => {
      if (this.video.paused) return;
      this._syncFromVideo();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  pause() {
    this.video.pause();
    this._setPlaying(false);
    if (this.media && this.media.kind !== 'image') this.time = snapToFrame(this.video.currentTime || this.time, this.fps);
    this._updateTC();
  }

  togglePlay() {
    this.rate !== 0 ? this.pause() : this.play(1);
  }

  shuttle(dir) {
    if (dir === 0) return this.pause();
    const cur = this.rate;
    let next;
    if (dir > 0) next = cur > 0 ? SHUTTLE[Math.min(3, SHUTTLE.indexOf(cur) + 1)] : 1;
    else next = cur < 0 ? -SHUTTLE[Math.min(3, SHUTTLE.indexOf(-cur) + 1)] : -1;
    this.play(next);
  }

  seek(t) {
    if (!this.media) return;
    this.time = Math.max(0, Math.min(this.duration, t));
    if (this.media.kind !== 'image') {
      try {
        this.video.currentTime = this.time + 0.001;
      } catch {
        /* метаданные ещё не загружены */
      }
    }
    this._updateTC();
    this._drawScrub();
    if (!this.media.hasVideo) this._drawWave();
  }

  step(frames) {
    this.pause();
    this.seek(snapToFrame(this.time, this.fps) + frames / this.fps);
  }

  home() {
    this.seek(0);
  }

  end() {
    this.seek(this.duration - 1 / this.fps);
  }

  _setMark(key, value, label) {
    if (!this.media) return;
    const id = this.media.id;
    store.mutate(label, (p) => {
      const m = p.media.find((x) => x.id === id);
      if (!m) return false;
      m[key] = value;
      if (m.markIn != null && m.markOut != null && m.markOut <= m.markIn) {
        if (key === 'markIn') m.markOut = null;
        else m.markIn = null;
      }
    });
  }

  markIn() {
    this.pause();
    this._setMark('markIn', snapToFrame(this.time, this.fps), 'Вход источника');
  }

  markOut() {
    this.pause();
    this._setMark('markOut', snapToFrame(this.time + 1 / this.fps, this.fps), 'Выход источника');
  }

  clearIn() {
    this._setMark('markIn', null, 'Очистить вход источника');
  }

  clearOut() {
    this._setMark('markOut', null, 'Очистить выход источника');
  }

  goIn() {
    this.pause();
    this.seek(this.media?.markIn ?? 0);
  }

  goOut() {
    this.pause();
    this.seek(this.media?.markOut != null ? this.media.markOut - 1 / this.fps : this.duration);
  }

  _dragStart(e, takeVideo, takeAudio) {
    if (!this.media) return e.preventDefault();
    startMediaDrag(e, { mediaIds: [this.media.id], takeVideo, takeAudio, inPoint: this.media.markIn ?? 0, outPoint: this.media.markOut ?? (this.media.kind === 'image' ? null : this.media.duration) });
  }

  _updateTC() {
    this.tcEl.textContent = formatTC(this.time, this.fps);
    if (this.media) {
      const a = this.media.markIn ?? 0;
      const b = this.media.markOut ?? this.duration;
      this.durEl.textContent = formatTC(b - a, this.fps);
    } else this.durEl.textContent = '';
  }

  _drawScrub() {
    const w = this.scrub.clientWidth;
    const hh = this.scrub.clientHeight;
    if (!w) return;
    const ctx = fitCanvas(this.scrubCanvas, w, hh);
    ctx.fillStyle = '#17181b';
    ctx.fillRect(0, 0, w, hh);
    if (!this.media) return;
    const dur = Math.max(this.duration, 0.001);
    const X = (t) => 8 + (t / dur) * (w - 16);
    const m = this.media;
    if (m.markIn != null || m.markOut != null) {
      ctx.fillStyle = 'rgba(63,183,167,0.3)';
      ctx.fillRect(X(m.markIn ?? 0), 5, X(m.markOut ?? dur) - X(m.markIn ?? 0), hh - 10);
    }
    ctx.fillStyle = '#34363d';
    ctx.fillRect(8, hh / 2 - 1, w - 16, 2);
    const px = X(this.time);
    ctx.fillStyle = '#ff9a2e';
    ctx.beginPath();
    ctx.moveTo(px - 5, 2);
    ctx.lineTo(px + 5, 2);
    ctx.lineTo(px, 9);
    ctx.fill();
    ctx.fillRect(px - 0.5, 8, 1, hh - 10);
  }

  _scrubDown(e) {
    store.setFocus('source');
    if (!this.media) return;
    this.pause();
    const r = this.scrub.getBoundingClientRect();
    const seek = (cx) => this.seek(((cx - r.left - 8) / (r.width - 16)) * this.duration);
    seek(e.clientX);
    dragPointer(e, { onMove: (dx, dy, ev) => seek(ev.clientX) });
  }
}
