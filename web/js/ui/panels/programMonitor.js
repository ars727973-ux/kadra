// Панель «Программа» (Program Monitor): превью секвенции через Compositor,
// транспорт, In/Out, Lift/Extract, экспорт кадра и прямая трансформация
// выделенного клипа мышью (перемещение и масштаб за углы рамки).

import { h, fitCanvas, dragPointer } from '../dom.js';
import { icon } from '../icons.js';
import { store } from '../../core/store.js';
import { sequenceDuration, findClip, TRACK_KIND } from '../../core/model.js';
import { formatTC } from '../../core/time.js';
import { activeVideoLayers, flattenClipLayers, upcomingClips } from '../../engine/layers.js';
import { Compositor, clipGeometry } from '../../engine/compositor.js';
import { PreviewSources } from '../../engine/previewSources.js';
import { transport } from '../../engine/transport.js';
import { mediaCache } from '../../media/mediaCache.js';

export class ProgramMonitor {
  constructor(app) {
    this.app = app;
    this.id = 'program';
    this.title = 'Программа';
    this.el = h('div.monitor');
    this.sources = new PreviewSources();
    this.compositor = new Compositor();
    this.zoom = 'fit';
    this._token = 0;
    this._build();
    const getMedia = (id) => store.getMedia(id);
    this.getMedia = getMedia;

    store.on('playhead', () => {
      this._updateTC();
      this._drawScrub();
      if (!transport.playing) this.requestRender();
    });
    store.on('change', () => {
      this._existingClipsPrune();
      this.layout();
      this.requestRender();
      this._drawScrub();
    });
    store.on('selection', () => this.drawOverlay());
    store.on('ui', ({ key }) => {
      if (key === 'programResolution') {
        this.layout();
        this.requestRender();
      }
    });
    transport.on('tick', (t) => this.renderPlaying(t));
    transport.on('state', (s) => {
      this.playBtn.replaceChildren(icon(s.playing && s.rate > 0 ? 'pause' : 'play'));
      if (!s.playing) {
        this.sources.pauseAll();
        this.requestRender();
      }
    });
    for (const ev of ['image', 'online', 'offline', 'aux']) mediaCache.on(ev, () => !transport.playing && this.requestRender());
  }

  _build() {
    this.frame = h('canvas.frame');
    this.overlay = h('canvas.overlay');
    this.view = h('div.monitor-view', this.frame, this.overlay);
    this.overlay.addEventListener('pointerdown', (e) => this._overlayDown(e));
    this.overlay.addEventListener('pointermove', (e) => this._overlayHover(e));
    this.overlay.addEventListener('dblclick', () => this.app.layout.toggleMaximize(this.app.layout.findGroupOf('program')?.id));

    this.tcEl = h('div.timecode', { title: 'Перейти к таймкоду' }, '00:00:00:00');
    this.tcEl.addEventListener('click', () => this.app.timeline._editTC());
    this.durEl = h('div.timecode.dim', { title: 'Длительность (In→Out или секвенция)' });
    const zoomSel = h('select', { title: 'Масштаб' }, ...[['fit', 'Вписать'], ['0.25', '25%'], ['0.5', '50%'], ['0.75', '75%'], ['1', '100%'], ['2', '200%']].map(([v, l]) => h('option', { value: v }, l)));
    zoomSel.addEventListener('change', () => {
      this.zoom = zoomSel.value;
      this.layout();
      this.requestRender();
    });
    const resSel = h('select', { title: 'Качество воспроизведения' }, ...[['1', 'Полное'], ['0.5', '1/2'], ['0.25', '1/4']].map(([v, l]) => h('option', { value: v }, l)));
    resSel.addEventListener('change', () => store.setUi('programResolution', Number(resSel.value)));
    this.bar = h('div.monitor-bar', this.tcEl, h('div.grow'), zoomSel, resSel, h('div.grow'), this.durEl);

    this.scrubCanvas = h('canvas');
    this.scrub = h('div.monitor-scrub', this.scrubCanvas);
    this.scrub.addEventListener('pointerdown', (e) => this._scrubDown(e));

    const b = (ic, title, action) => {
      const btn = h('button.icon-btn', { type: 'button', title }, icon(ic));
      btn.addEventListener('click', () => this.app.run(action));
      return btn;
    };
    this.playBtn = h('button.icon-btn.play', { type: 'button', title: 'Воспроизведение/стоп (Пробел)' }, icon('play'));
    this.playBtn.addEventListener('click', () => {
      store.setFocus('program');
      transport.toggle();
    });
    this.transportEl = h(
      'div.transport',
      b('marker', 'Добавить маркер (M)', 'marker.add'),
      b('markIn', 'Отметить вход (I)', 'mark.in'),
      b('markOut', 'Отметить выход (O)', 'mark.out'),
      h('div.sep'),
      b('toIn', 'К точке входа (Shift+I)', 'mark.goIn'),
      b('stepBack', 'Кадр назад (←)', 'play.stepBack'),
      this.playBtn,
      b('stepFwd', 'Кадр вперёд (→)', 'play.stepFwd'),
      b('toOut', 'К точке выхода (Shift+O)', 'mark.goOut'),
      h('div.sep'),
      b('lift', 'Поднять (;)', 'sequence.lift'),
      b('extract', 'Извлечь (\')', 'sequence.extract'),
      b('camera', 'Экспорт кадра (Ctrl+Shift+E)', 'file.exportFrame')
    );
    this.el.append(this.view, this.bar, this.scrub, this.transportEl);
  }

  onResize() {
    this.layout();
    this._drawScrub();
    this.requestRender();
  }

  onShow() {
    this.onResize();
  }

  /** Расчёт размеров холста под панель. */
  layout() {
    const seq = store.seq;
    const vw = this.view.clientWidth;
    const vh = this.view.clientHeight;
    if (!vw || !vh) return;
    const fitScale = Math.min(vw / seq.width, vh / seq.height);
    const scale = this.zoom === 'fit' ? fitScale : Number(this.zoom);
    const cw = Math.max(2, Math.round(seq.width * scale));
    const ch = Math.max(2, Math.round(seq.height * scale));
    const res = store.ui.programResolution || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // внутреннее разрешение: не больше секвенции × качество, не больше экрана
    const iw = Math.max(2, Math.round(Math.min(seq.width * res, cw * dpr)));
    const ih = Math.max(2, Math.round((iw * seq.height) / seq.width));
    if (this.frame.width !== iw || this.frame.height !== ih) {
      this.frame.width = iw;
      this.frame.height = ih;
    }
    this.frame.style.width = cw + 'px';
    this.frame.style.height = ch + 'px';
    this.frame.style.left = Math.round((vw - cw) / 2) + 'px';
    this.frame.style.top = Math.round((vh - ch) / 2) + 'px';
    this.disp = { x: Math.round((vw - cw) / 2), y: Math.round((vh - ch) / 2), w: cw, h: ch, scale: cw / seq.width };
    fitCanvas(this.overlay, vw, vh);
    this._updateTC();
  }

  _updateTC() {
    const seq = store.seq;
    this.tcEl.textContent = formatTC(store.ui.playhead, seq.fps);
    const dur = seq.inPoint != null && seq.outPoint != null ? seq.outPoint - seq.inPoint : sequenceDuration(seq);
    this.durEl.textContent = formatTC(dur, seq.fps);
  }

  _existingClipsPrune() {
    const ids = new Set();
    for (const t of store.seq.tracks) for (const c of t.clips) ids.add(c.id);
    this.sources.prune(ids);
  }

  // ---------- рендер ----------

  _draw(t, layers) {
    const ctx = this.frame.getContext('2d', { alpha: false });
    this.compositor.render(ctx, store.seq, layers, this.sources, { width: this.frame.width, height: this.frame.height, quality: transport.playing ? 'low' : 'high', time: t });
  }

  renderPlaying(t) {
    const seq = store.seq;
    const layers = activeVideoLayers(store.project, seq, t, this.getMedia);
    const flat = flattenClipLayers(layers);
    this.sources.prepare(flat, upcomingClips(seq, t, 2), this.getMedia);
    this.sources.sync(flat, transport.rate > 0 ? transport.rate : 1);
    this._draw(t, layers);
    this.drawOverlay();
    this._updateTC();
  }

  requestRender() {
    if (this._pending) return;
    this._pending = true;
    requestAnimationFrame(async () => {
      this._pending = false;
      if (!this.frame.isConnected || !this.disp) return;
      const token = ++this._token;
      const t = store.ui.playhead;
      const seq = store.seq;
      const layers = activeVideoLayers(store.project, seq, t, this.getMedia);
      const flat = flattenClipLayers(layers);
      this.sources.prepare(flat, [], this.getMedia);
      for (const l of flat) if (l.media?.kind === 'image') await mediaCache.ensureImage(l.media).catch(() => null);
      this._draw(t, layers);
      await this.sources.seek(flat);
      if (token !== this._token || transport.playing) return;
      this._draw(t, layers);
      this.drawOverlay();
      this.app.emitFrameRendered?.();
    });
  }

  /** Снимок текущего кадра в PNG в полном разрешении секвенции. */
  async snapshot() {
    const seq = store.seq;
    const t = store.ui.playhead;
    const layers = activeVideoLayers(store.project, seq, t, this.getMedia);
    const flat = flattenClipLayers(layers);
    this.sources.prepare(flat, [], this.getMedia);
    for (const l of flat) if (l.media?.kind === 'image') await mediaCache.ensureImage(l.media);
    await this.sources.seek(flat);
    const c = new OffscreenCanvas(seq.width, seq.height);
    this.compositor.render(c.getContext('2d'), seq, layers, this.sources, { width: seq.width, height: seq.height, quality: 'high', time: t });
    return c.convertToBlob({ type: 'image/png' });
  }

  // ---------- рамка трансформации ----------

  _selectedVideoLayer() {
    const seq = store.seq;
    const t = store.ui.playhead;
    for (const id of store.ui.selection) {
      const f = findClip(seq, id);
      if (!f || f.track.kind !== TRACK_KIND.VIDEO) continue;
      const c = f.clip;
      const end = c.start + (c.out - c.in) / c.speed;
      if (t >= c.start - 1e-6 && t < end) return { clip: c, track: f.track, media: c.mediaId ? store.getMedia(c.mediaId) : null, localTime: t - c.start };
    }
    return null;
  }

  _toView([x, y]) {
    return [this.disp.x + x * this.disp.scale, this.disp.y + y * this.disp.scale];
  }

  drawOverlay() {
    if (!this.disp) return;
    const ctx = fitCanvas(this.overlay, this.view.clientWidth, this.view.clientHeight);
    ctx.clearRect(0, 0, this.view.clientWidth, this.view.clientHeight);
    const sel = this._selectedVideoLayer();
    if (!sel || transport.playing || sel.track.locked) {
      this._handles = null;
      return;
    }
    const g = clipGeometry(sel.clip, sel.media, store.seq, sel.localTime);
    const pts = g.corners.map((p) => this._toView(p));
    ctx.strokeStyle = '#f0a53a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = '#1b1306';
    for (const p of pts) {
      ctx.fillRect(p[0] - 4, p[1] - 4, 8, 8);
      ctx.strokeRect(p[0] - 4 + 0.5, p[1] - 4 + 0.5, 8, 8);
    }
    const ap = this._toView(g.anchorPoint);
    ctx.beginPath();
    ctx.arc(ap[0], ap[1], 5, 0, Math.PI * 2);
    ctx.moveTo(ap[0] - 8, ap[1]);
    ctx.lineTo(ap[0] + 8, ap[1]);
    ctx.moveTo(ap[0], ap[1] - 8);
    ctx.lineTo(ap[0], ap[1] + 8);
    ctx.stroke();
    this._handles = { sel, g, pts };
  }

  _hit(e) {
    if (!this._handles) return null;
    const r = this.overlay.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const { pts } = this._handles;
    for (let i = 0; i < pts.length; i++) if (Math.abs(pts[i][0] - x) < 8 && Math.abs(pts[i][1] - y) < 8) return { type: 'corner', i };
    // точка внутри четырёхугольника
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside ? { type: 'move' } : null;
  }

  _overlayHover(e) {
    if (e.buttons) return;
    const hit = this._hit(e);
    this.overlay.style.cursor = hit ? (hit.type === 'corner' ? 'nwse-resize' : 'move') : 'default';
  }

  _overlayDown(e) {
    store.setFocus('program');
    const hit = this._hit(e);
    if (!hit) return;
    e.preventDefault();
    const { sel, g } = this._handles;
    const clipId = sel.clip.id;
    const startPos = [...g.pos];
    const startScale = sel.clip.transform.scale;
    const startScaleW = sel.clip.transform.scaleWidth;
    const ap = this._toView(g.anchorPoint);
    const r = this.overlay.getBoundingClientRect();
    const startDist = Math.hypot(e.clientX - r.left - ap[0], e.clientY - r.top - ap[1]) || 1;
    dragPointer(e, {
      onMove: (dx, dy, ev) => {
        store.mutate(
          hit.type === 'move' ? 'Положение' : 'Масштаб',
          (p, s) => {
            const c = findClip(s, clipId)?.clip;
            if (!c) return false;
            if (hit.type === 'move') {
              let nx = startPos[0] + dx / this.disp.scale;
              let ny = startPos[1] + dy / this.disp.scale;
              if (ev.shiftKey) Math.abs(dx) > Math.abs(dy) ? (ny = startPos[1]) : (nx = startPos[0]);
              c.transform.position = [Math.round(nx * 10) / 10, Math.round(ny * 10) / 10];
            } else {
              const d = Math.hypot(ev.clientX - r.left - ap[0], ev.clientY - r.top - ap[1]);
              const k = d / startDist;
              c.transform.scale = Math.max(0, Math.round(startScale * k * 10) / 10);
              if (c.transform.uniformScale === false) c.transform.scaleWidth = Math.max(0, Math.round(startScaleW * k * 10) / 10);
            }
          },
          { mergeKey: `xf:${clipId}:${hit.type}` }
        );
      },
    });
  }

  // ---------- мини-шкала ----------

  _drawScrub() {
    const w = this.scrub.clientWidth;
    const hh = this.scrub.clientHeight;
    if (!w) return;
    const ctx = fitCanvas(this.scrubCanvas, w, hh);
    const seq = store.seq;
    const dur = Math.max(sequenceDuration(seq), 1);
    ctx.fillStyle = '#17181b';
    ctx.fillRect(0, 0, w, hh);
    const X = (t) => 8 + (t / dur) * (w - 16);
    if (seq.inPoint != null || seq.outPoint != null) {
      ctx.fillStyle = 'rgba(240,165,58,0.25)';
      ctx.fillRect(X(seq.inPoint ?? 0), 6, X(seq.outPoint ?? dur) - X(seq.inPoint ?? 0), hh - 12);
    }
    ctx.fillStyle = '#34363d';
    ctx.fillRect(8, hh / 2 - 1, w - 16, 2);
    for (const m of seq.markers) {
      ctx.fillStyle = m.color;
      ctx.fillRect(X(m.time) - 1, 3, 3, 6);
    }
    const px = X(Math.min(store.ui.playhead, dur));
    ctx.fillStyle = '#ff9a2e';
    ctx.beginPath();
    ctx.moveTo(px - 5, 2);
    ctx.lineTo(px + 5, 2);
    ctx.lineTo(px, 9);
    ctx.fill();
    ctx.fillRect(px - 0.5, 8, 1, hh - 10);
  }

  _scrubDown(e) {
    store.setFocus('program');
    if (transport.playing) transport.pause();
    const r = this.scrub.getBoundingClientRect();
    const dur = Math.max(sequenceDuration(store.seq), 1);
    const seek = (cx) => store.setPlayhead(Math.max(0, Math.min(dur, ((cx - r.left - 8) / (r.width - 16)) * dur)));
    seek(e.clientX);
    dragPointer(e, { onMove: (dx, dy, ev) => seek(ev.clientX) });
  }
}
