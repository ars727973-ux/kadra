// Панель «Таймлайн»: мультитрек с линейкой, плейхедом, маркерами,
// магнитным прилипанием, зумом и инструментами (выбор, выбор дорожки,
// ripple-триммирование, лезвие, рука, масштаб).
//
// Поле клипов и линейка рисуются на canvas (быстро при сотнях клипов),
// заголовки дорожек — DOM. Во время перетаскивания операция применяется к
// копии секвенции (this.preview) — пользователь видит итог заранее; при
// отпускании та же операция выполняется через store.mutate (undo/redo).

import { h, clear, fitCanvas, dragPointer } from '../dom.js';
import { icon } from '../icons.js';
import { contextMenu } from '../menu.js';
import { store } from '../../core/store.js';
import { clipEnd, clipDuration, sequenceDuration, TRACK_KIND, findClip } from '../../core/model.js';
import { formatTC, snapToFrame, EPS } from '../../core/time.js';
import * as ops from '../../core/timelineOps.js';
import { mediaCache } from '../../media/mediaCache.js';
import { transport } from '../../engine/transport.js';
import { dnd, MEDIA_MIME } from '../dnd.js';
import { promptDialog } from '../dialogs.js';

const RULER_H = 30;
const SNAP_PX = 8;
const EDGE_PX = 7;
const COLORS = {
  video: '#3d7b88',
  audio: '#567f47',
  image: '#84703f',
  gen: '#5f6f93',
  offline: '#7d2b2b',
};

const TOOL_CURSOR = { select: 'default', trackSelect: 'e-resize', ripple: 'default', razor: 'crosshair', hand: 'grab', zoom: 'zoom-in' };

export class TimelinePanel {
  constructor(app) {
    this.app = app;
    this.id = 'timeline';
    this.title = 'Таймлайн';
    this.el = h('div.timeline');
    this.pxPerSec = 40;
    this.scrollX = 0;
    this.scrollY = 0;
    this.preview = null; // временная копия секвенции во время перетаскивания
    this.snapLine = null; // время, к которому «прилипли»
    this.marquee = null;
    this.dragInfo = null; // подсказка при трим/перемещении
    this._raf = 0;
    this._fitOnce = true;
    this._build();

    store.on('change', () => {
      this.preview = null;
      this._renderHeaders();
      this._renderTop();
      this._updateScrollbars();
      this.draw();
    });
    store.on('project-loaded', () => {
      // после открытия проекта показываем всю секвенцию
      this._fitOnce = true;
      requestAnimationFrame(() => this.onResize());
    });
    store.on('selection', () => this.draw());
    store.on('playhead', (t) => {
      this._updateTC();
      if (transport.playing) this._follow(t);
      this.draw();
    });
    store.on('tool', () => this._updateCursor());
    store.on('ui', () => {
      this._renderTop();
      this.draw();
    });
    store.on('history', () => this.draw());
    mediaCache.on('aux', () => this.draw());
    mediaCache.on('offline', () => this.draw());
  }

  // ---------- построение DOM ----------

  _build() {
    this.top = h('div.tl-top');
    this.tcEl = h('div.timecode', { title: 'Таймкод плейхеда — щёлкните, чтобы ввести' }, '00:00:00:00');
    this.tcEl.addEventListener('click', () => this._editTC());
    this.rulerCanvas = h('canvas');
    this.ruler = h('div.tl-ruler', this.rulerCanvas);
    this.areaCanvas = h('canvas');
    this.area = h('div.tl-area', { tabIndex: 0 }, this.areaCanvas);
    this.headersInner = h('div.tl-headers-inner');
    this.headers = h('div.tl-headers', this.headersInner);
    this.vInner = h('div');
    this.vscroll = h('div.tl-vscroll', this.vInner);
    this.hInner = h('div');
    this.hscroll = h('div.tl-hscroll', this.hInner);
    this.main = h('div.tl-main', h('div.tl-corner', this.tcEl), this.ruler, this.headers, this.area, this.vscroll, this.hscroll);
    this.el.append(this.top, this.main);

    this.hscroll.addEventListener('scroll', () => {
      if (this._syncing) return;
      this.scrollX = this.hscroll.scrollLeft;
      this.draw();
    });
    this.vscroll.addEventListener('scroll', () => {
      if (this._syncing) return;
      this.scrollY = this.vscroll.scrollTop;
      this.headersInner.style.transform = `translateY(${-this.scrollY}px)`;
      this.draw();
    });
    this.area.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    this.ruler.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    this.headers.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._setScrollY(this.scrollY + e.deltaY);
    }, { passive: false });
    this.area.addEventListener('pointerdown', (e) => this._areaDown(e));
    this.area.addEventListener('pointermove', (e) => this._hoverMove(e));
    this.area.addEventListener('pointerleave', () => (this.area.style.cursor = ''));
    this.area.addEventListener('dblclick', (e) => this._areaDblClick(e));
    this.area.addEventListener('contextmenu', (e) => this._areaContext(e));
    this.ruler.addEventListener('pointerdown', (e) => this._rulerDown(e));
    this.ruler.addEventListener('dblclick', (e) => this._rulerDblClick(e));
    this.ruler.addEventListener('contextmenu', (e) => this._rulerContext(e));
    // drag&drop из Project / Source и файлов из ОС
    this.area.addEventListener('dragover', (e) => this._dragOver(e));
    this.area.addEventListener('dragleave', () => {
      this.preview = null;
      this.draw();
    });
    this.area.addEventListener('drop', (e) => this._drop(e));
    this._renderTop();
    this._renderHeaders();
  }

  get seq() {
    return this.preview || store.seq;
  }

  onResize() {
    const aw = this.area.clientWidth;
    const ah = this.area.clientHeight;
    if (!aw || !ah) return;
    if (this._fitOnce && sequenceDuration(store.seq) > 0) {
      this._fitOnce = false;
      this.zoomToFit();
      return;
    }
    this._fitOnce = false;
    this._updateScrollbars();
    this.draw();
  }

  onShow() {
    this.onResize();
  }

  // ---------- верхняя строка ----------

  _renderTop() {
    clear(this.top);
    const seqTabs = h('div.seq-tabs');
    for (const s of store.project.sequences) {
      const tab = h('div.seq-tab', { class: s.id === store.seq.id ? 'active' : '', title: `${s.width}×${s.height}, ${s.fps} к/с` }, s.name);
      tab.addEventListener('click', () => store.setActiveSequence(s.id));
      tab.addEventListener('dblclick', () => this.app.run('sequence.settings'));
      seqTabs.appendChild(tab);
    }
    const tools = h('div.tools.horizontal');
    for (const [tool, ic, title] of TOOLS) {
      const b = h('button.icon-btn', { type: 'button', title, 'aria-pressed': String(store.ui.tool === tool) }, icon(ic));
      b.addEventListener('click', () => store.setTool(tool));
      tools.appendChild(b);
    }
    const snap = h('button.icon-btn', { type: 'button', title: 'Прилипание (S)', 'aria-pressed': String(store.ui.snapping) }, icon('snap'));
    snap.addEventListener('click', () => this.app.run('sequence.snap'));
    const link = h('button.icon-btn', { type: 'button', title: 'Связанное выделение', 'aria-pressed': String(store.ui.linkedSelection) }, icon('link'));
    link.addEventListener('click', () => this.app.run('sequence.linkedSelection'));
    const marker = h('button.icon-btn', { type: 'button', title: 'Добавить маркер (M)' }, icon('marker'));
    marker.addEventListener('click', () => this.app.run('marker.add'));
    const zoomOut = h('button.icon-btn', { type: 'button', title: 'Уменьшить (−)' }, icon('minus'));
    zoomOut.addEventListener('click', () => this.zoomBy(1 / 1.5));
    const zoomIn = h('button.icon-btn', { type: 'button', title: 'Увеличить (+)' }, icon('plus'));
    zoomIn.addEventListener('click', () => this.zoomBy(1.5));
    const fit = h('button.icon-btn', { type: 'button', title: 'Вся секвенция (\\)' }, icon('fit'));
    fit.addEventListener('click', () => this.zoomToFit());
    this.top.append(seqTabs, h('div.grow'), tools, snap, link, marker, h('span', { style: 'width:8px' }), zoomOut, zoomIn, fit);
  }

  _updateTC() {
    this.tcEl.textContent = formatTC(store.ui.playhead, store.seq.fps);
  }

  async _editTC() {
    const v = await promptDialog('Таймкод (ЧЧ:ММ:СС:КК, или «+30» — сдвиг на 30 кадров):', formatTC(store.ui.playhead, store.seq.fps), { title: 'Перейти к таймкоду' });
    if (v == null) return;
    this.app.goToTimecode(v);
  }

  // ---------- геометрия ----------

  rows() {
    const seq = this.seq;
    const v = seq.tracks.filter((t) => t.kind === TRACK_KIND.VIDEO).reverse();
    const a = seq.tracks.filter((t) => t.kind === TRACK_KIND.AUDIO);
    const out = [];
    let y = 0;
    v.forEach((track, i) => {
      out.push({ track, y, h: track.height, divider: i === v.length - 1 });
      y += track.height;
    });
    y += 6; // разделитель видео/аудио
    for (const track of a) {
      out.push({ track, y, h: track.height });
      y += track.height;
    }
    this._totalH = y + 40;
    return out;
  }

  tx(t) {
    return t * this.pxPerSec - this.scrollX;
  }

  xt(x) {
    return (x + this.scrollX) / this.pxPerSec;
  }

  _contentDuration() {
    return Math.max(sequenceDuration(store.seq), 10) + Math.max(10, this.area.clientWidth / this.pxPerSec * 0.5);
  }

  _updateScrollbars() {
    const w = this.area.clientWidth;
    const content = Math.max(w, this._contentDuration() * this.pxPerSec);
    this._syncing = true;
    this.hInner.style.width = content + 'px';
    this.rows();
    this.vInner.style.height = Math.max(this.area.clientHeight, this._totalH) + 'px';
    this.scrollX = Math.max(0, Math.min(this.scrollX, content - w));
    this.hscroll.scrollLeft = this.scrollX;
    this.vscroll.scrollTop = this.scrollY;
    this._syncing = false;
  }

  _setScrollX(x) {
    const w = this.area.clientWidth;
    const content = Math.max(w, this._contentDuration() * this.pxPerSec);
    this.scrollX = Math.max(0, Math.min(x, content - w));
    this._updateScrollbars();
    this.draw();
  }

  _setScrollY(y) {
    this.scrollY = Math.max(0, Math.min(y, Math.max(0, this._totalH - this.area.clientHeight)));
    this.headersInner.style.transform = `translateY(${-this.scrollY}px)`;
    this._updateScrollbars();
    this.draw();
  }

  // ---------- зум ----------

  _clampZoom(z) {
    const fps = store.seq.fps;
    const minZ = Math.max(0.5, (this.area.clientWidth || 800) / (Math.max(sequenceDuration(store.seq), 30) * 4));
    return Math.min(fps * 60, Math.max(minZ, z));
  }

  zoomAt(z, anchorX) {
    const t = this.xt(anchorX);
    this.pxPerSec = this._clampZoom(z);
    this.scrollX = Math.max(0, t * this.pxPerSec - anchorX);
    this._updateScrollbars();
    this.draw();
  }

  zoomBy(f) {
    // как в Premiere: относительно плейхеда, если он виден
    const px = this.tx(store.ui.playhead);
    const anchor = px >= 0 && px <= this.area.clientWidth ? px : this.area.clientWidth / 2;
    this.zoomAt(this.pxPerSec * f, anchor);
  }

  zoomToFit() {
    const dur = sequenceDuration(store.seq) || 30;
    const w = this.area.clientWidth || 800;
    this.pxPerSec = this._clampZoom((w - 40) / dur);
    this.scrollX = 0;
    this._updateScrollbars();
    this.draw();
  }

  _onWheel(e) {
    e.preventDefault();
    const rect = this.area.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+колесо — зум вокруг курсора
      const f = Math.exp(-e.deltaY * 0.0022);
      this.zoomAt(this.pxPerSec * f, e.clientX - rect.left);
    } else if (e.shiftKey) {
      this._setScrollY(this.scrollY + e.deltaY);
    } else {
      // колесо — горизонтальная прокрутка (как в монтажках)
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      this._setScrollX(this.scrollX + d);
    }
  }

  _follow(t) {
    const x = this.tx(t);
    const w = this.area.clientWidth;
    if (x > w - 16 || x < 0) this._setScrollX(t * this.pxPerSec - 40);
  }

  /** Показать плейхед (после перехода по маркерам/точкам монтажа). */
  revealPlayhead() {
    const x = this.tx(store.ui.playhead);
    const w = this.area.clientWidth;
    if (x < 0 || x > w) this._setScrollX(store.ui.playhead * this.pxPerSec - w / 3);
  }

  // ---------- заголовки дорожек ----------

  _renderHeaders() {
    clear(this.headersInner);
    const seq = store.seq;
    for (const r of this.rows()) {
      const tr = r.track;
      const isV = tr.kind === TRACK_KIND.VIDEO;
      const targeted = isV ? store.ui.targetVideoTrackId === tr.id : store.ui.targetAudioTrackId === tr.id;
      const patch = h('div.patch', { class: targeted ? 'on' : '', title: 'Целевая дорожка (вставка из Source, вставка из буфера)' }, isV ? 'V' : 'A');
      patch.addEventListener('click', () => {
        store.setUi(isV ? 'targetVideoTrackId' : 'targetAudioTrackId', tr.id);
        this._renderHeaders();
      });
      const lock = h('button.icon-btn', { type: 'button', title: tr.locked ? 'Разблокировать дорожку' : 'Заблокировать дорожку', class: tr.locked ? 'lockon' : '' }, icon(tr.locked ? 'lock' : 'unlock'));
      lock.addEventListener('click', () => store.mutate(tr.locked ? 'Разблокировать дорожку' : 'Заблокировать дорожку', (p, s) => {
        s.tracks.find((t) => t.id === tr.id).locked = !tr.locked;
      }));
      const items = [patch, lock];
      if (isV) {
        const eye = h('button.icon-btn', { type: 'button', title: tr.hidden ? 'Показать дорожку' : 'Скрыть дорожку (вывод)' }, icon(tr.hidden ? 'eyeOff' : 'eye'));
        eye.addEventListener('click', () => store.mutate('Видимость дорожки', (p, s) => {
          const t = s.tracks.find((x) => x.id === tr.id);
          t.hidden = !t.hidden;
        }));
        items.push(eye);
      } else {
        const m = h('button.tb', { type: 'button', title: 'Заглушить дорожку', class: tr.muted ? 'on-m' : '' }, 'M');
        m.addEventListener('click', () => store.mutate('Заглушить дорожку', (p, s) => {
          const t = s.tracks.find((x) => x.id === tr.id);
          t.muted = !t.muted;
        }));
        const so = h('button.tb', { type: 'button', title: 'Соло', class: tr.solo ? 'on-s' : '' }, 'S');
        so.addEventListener('click', () => store.mutate('Соло дорожки', (p, s) => {
          const t = s.tracks.find((x) => x.id === tr.id);
          t.solo = !t.solo;
        }));
        items.push(m, so);
      }
      items.push(h('div.label', tr.name === (isV ? 'V' : 'A') + (seq.tracks.filter((t) => t.kind === tr.kind).indexOf(tr) + 1) ? '' : tr.name));
      items.push(h('div.tname', isV ? `V${seq.tracks.filter((t) => t.kind === tr.kind).indexOf(tr) + 1}` : `A${seq.tracks.filter((t) => t.kind === tr.kind).indexOf(tr) + 1}`));
      const row = h('div.track-hdr', { class: [isV ? 'video' : 'audio', r.divider ? 'divider' : '', tr.locked ? 'locked' : ''].join(' '), style: { top: r.y + 'px', height: r.h + 'px' } }, items);
      row.addEventListener('dblclick', (e) => {
        if (e.target.closest('button,.patch')) return;
        store.mutateSilently((p, s) => {
          const t = s.tracks.find((x) => x.id === tr.id);
          t.height = t.height > 60 ? (isV ? 54 : 50) : 96;
        }, 'ui');
      });
      row.addEventListener('contextmenu', (e) =>
        contextMenu(e, [
          { label: 'Переименовать дорожку…', action: async () => {
            const name = await promptDialog('Имя дорожки', tr.name);
            if (name) store.mutate('Переименовать дорожку', (p, s) => (s.tracks.find((x) => x.id === tr.id).name = name.trim()));
          } },
          { label: 'Добавить видеодорожку', action: () => store.mutate('Добавить дорожку', (p, s) => ops.addTracks(s, TRACK_KIND.VIDEO, 1)) },
          { label: 'Добавить аудиодорожку', action: () => store.mutate('Добавить дорожку', (p, s) => ops.addTracks(s, TRACK_KIND.AUDIO, 1)) },
          '-',
          { label: 'Удалить дорожку', disabled: seq.tracks.filter((t) => t.kind === tr.kind).length <= 1, action: () => store.mutate('Удалить дорожку', (p, s) => ops.deleteTrack(s, tr.id)) },
        ])
      );
      this.headersInner.appendChild(row);
    }
    this.headersInner.style.height = this._totalH + 'px';
  }

  // ---------- отрисовка ----------

  draw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._drawRuler();
      this._drawArea();
    });
  }

  _tickStep() {
    const fps = store.seq.fps;
    const cands = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 3600];
    for (const c of cands) if (c * this.pxPerSec >= 90) return c;
    return 3600;
  }

  _drawRuler() {
    const w = this.ruler.clientWidth;
    const hgt = this.ruler.clientHeight;
    if (!w || !hgt) return;
    const ctx = fitCanvas(this.rulerCanvas, w, hgt);
    const seq = store.seq;
    const fps = seq.fps;
    ctx.fillStyle = '#1c1d21';
    ctx.fillRect(0, 0, w, hgt);
    // In/Out
    if (seq.inPoint != null || seq.outPoint != null) {
      const a = this.tx(seq.inPoint ?? 0);
      const b = this.tx(seq.outPoint ?? sequenceDuration(seq));
      ctx.fillStyle = 'rgba(240,165,58,0.22)';
      ctx.fillRect(a, hgt - 9, b - a, 9);
      ctx.fillStyle = '#f0a53a';
      if (seq.inPoint != null) ctx.fillRect(a, hgt - 12, 2, 12);
      if (seq.outPoint != null) ctx.fillRect(b - 2, hgt - 12, 2, 12);
    }
    const step = this._tickStep();
    const minor = step >= 1 ? step / 5 : step / (step * fps >= 5 ? 5 : 1);
    const t0 = Math.floor(this.xt(0) / step) * step;
    const t1 = this.xt(w);
    ctx.strokeStyle = '#4a4c54';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let t = Math.floor(this.xt(0) / minor) * minor; t <= t1; t += minor) {
      const x = Math.round(this.tx(t)) + 0.5;
      ctx.moveTo(x, hgt - 5);
      ctx.lineTo(x, hgt);
    }
    ctx.stroke();
    ctx.strokeStyle = '#8b8f98';
    ctx.fillStyle = '#9da1aa';
    ctx.font = '10px ' + getComputedStyle(document.body).getPropertyValue('--mono');
    ctx.beginPath();
    for (let t = t0; t <= t1; t += step) {
      if (t < 0) continue;
      const x = Math.round(this.tx(t)) + 0.5;
      ctx.moveTo(x, hgt - 13);
      ctx.lineTo(x, hgt);
      ctx.fillText(formatTC(t, fps), x + 3, 11);
    }
    ctx.stroke();
    // маркеры
    for (const m of seq.markers) {
      const x = this.tx(m.time);
      if (x < -20 || x > w + 20) continue;
      const sel = store.ui.selectedMarkerId === m.id;
      if (m.duration > 0) {
        ctx.fillStyle = m.color + '55';
        ctx.fillRect(x, 13, this.tx(m.time + m.duration) - x, 7);
      }
      ctx.fillStyle = m.color;
      ctx.beginPath();
      ctx.moveTo(x - 5, 13);
      ctx.lineTo(x + 5, 13);
      ctx.lineTo(x + 5, 19);
      ctx.lineTo(x, 24);
      ctx.lineTo(x - 5, 19);
      ctx.closePath();
      ctx.fill();
      if (sel) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
    // плейхед
    const px = this.tx(store.ui.playhead);
    ctx.fillStyle = '#ff9a2e';
    ctx.beginPath();
    ctx.moveTo(px - 6, 0);
    ctx.lineTo(px + 6, 0);
    ctx.lineTo(px + 6, hgt - 10);
    ctx.lineTo(px, hgt);
    ctx.lineTo(px - 6, hgt - 10);
    ctx.closePath();
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  _clipColor(clip, media) {
    if (clip.generator) return COLORS.gen;
    if (media && mediaCache.isOffline(media.id)) return COLORS.offline;
    if (!media) return COLORS.offline;
    if (clip.kind === TRACK_KIND.AUDIO) return COLORS.audio;
    return media.kind === 'image' ? COLORS.image : COLORS.video;
  }

  _drawArea() {
    const w = this.area.clientWidth;
    const hgt = this.area.clientHeight;
    if (!w || !hgt) return;
    const ctx = fitCanvas(this.areaCanvas, w, hgt);
    const seq = this.seq;
    ctx.fillStyle = '#17181b';
    ctx.fillRect(0, 0, w, hgt);
    const rows = this.rows();
    const tStart = this.xt(0);
    const tEnd = this.xt(w);
    // фон дорожек
    for (const r of rows) {
      const y = r.y - this.scrollY;
      if (y > hgt || y + r.h < 0) continue;
      ctx.fillStyle = r.track.kind === TRACK_KIND.VIDEO ? '#1b1c20' : '#1a1c1a';
      ctx.fillRect(0, y, w, r.h - 1);
      ctx.fillStyle = '#121315';
      ctx.fillRect(0, y + r.h - 1, w, 1);
      if (r.divider) {
        ctx.fillStyle = '#0b0c0d';
        ctx.fillRect(0, y + r.h, w, 6);
      }
    }
    // In/Out
    if (seq.inPoint != null || seq.outPoint != null) {
      const a = Math.max(0, this.tx(seq.inPoint ?? 0));
      const b = this.tx(seq.outPoint ?? sequenceDuration(seq));
      ctx.fillStyle = 'rgba(240,165,58,0.05)';
      ctx.fillRect(a, 0, b - a, hgt);
    }
    // клипы
    const sel = store.ui.selection;
    for (const r of rows) {
      const y = r.y - this.scrollY;
      if (y > hgt || y + r.h < 0) continue;
      for (const clip of r.track.clips) {
        const end = clipEnd(clip);
        if (end < tStart || clip.start > tEnd) continue;
        this._drawClip(ctx, clip, r, y, sel.has(clip.id), w);
      }
      if (r.track.locked) {
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(0, y, w, r.h - 1);
      }
    }
    // линия прилипания
    if (this.snapLine != null) {
      const x = Math.round(this.tx(this.snapLine)) + 0.5;
      ctx.strokeStyle = '#3fb7a7';
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, hgt);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // рамка выделения
    if (this.marquee) {
      const { x0, y0, x1, y1 } = this.marquee;
      ctx.fillStyle = 'rgba(240,165,58,0.1)';
      ctx.strokeStyle = 'rgba(240,165,58,0.8)';
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    }
    // плейхед
    const px = Math.round(this.tx(store.ui.playhead)) + 0.5;
    ctx.strokeStyle = '#ff9a2e';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, hgt);
    ctx.stroke();
    // подсказка при перетаскивании
    if (this.dragInfo) {
      const { x, y, text } = this.dragInfo;
      ctx.font = '11px ' + getComputedStyle(document.body).getPropertyValue('--mono');
      const tw = ctx.measureText(text).width + 12;
      const bx = Math.min(w - tw - 4, Math.max(4, x + 12));
      const by = Math.max(4, y - 28);
      ctx.fillStyle = 'rgba(20,20,22,0.92)';
      ctx.fillRect(bx, by, tw, 20);
      ctx.strokeStyle = '#4a4c54';
      ctx.strokeRect(bx + 0.5, by + 0.5, tw, 20);
      ctx.fillStyle = '#e7e7e7';
      ctx.fillText(text, bx + 6, by + 14);
    }
  }

  _drawClip(ctx, clip, row, y, selected, viewW) {
    const media = clip.mediaId ? store.getMedia(clip.mediaId) : null;
    const x0 = this.tx(clip.start);
    const x1 = this.tx(clipEnd(clip));
    const cx0 = Math.max(-4, x0);
    const cx1 = Math.min(viewW + 4, x1);
    const h = row.h;
    const top = y + 1;
    const ch = h - 3;
    const width = Math.max(1, x1 - x0);
    const base = this._clipColor(clip, media);
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x0 + 0.5, top + 0.5, Math.max(1, width - 1), ch, 3);
    ctx.clip();
    ctx.fillStyle = base;
    ctx.fillRect(cx0, top, cx1 - cx0, ch);
    // содержимое: превью / волна
    const aux = media ? mediaCache.auxSync(media.id) : null;
    const bodyTop = top + 15;
    const bodyH = ch - 15;
    if (clip.kind === TRACK_KIND.VIDEO && aux?.spriteBitmap && bodyH > 8 && width > 20) {
      const fw = aux.frameW;
      const fh = aux.frameH;
      const tileW = Math.max(16, (bodyH * fw) / fh);
      ctx.globalAlpha = clip.enabled ? 0.85 : 0.35;
      const firstTile = Math.floor((cx0 - x0) / tileW);
      for (let tx = x0 + firstTile * tileW; tx < cx1; tx += tileW) {
        const tlTime = this.xt(tx + tileW / 2);
        const src = clip.in + (tlTime - clip.start) * clip.speed;
        const idx = media.kind === 'image' ? 0 : Math.max(0, Math.min(aux.spriteCount - 1, Math.floor((src / media.duration) * aux.spriteCount)));
        ctx.drawImage(aux.spriteBitmap, idx * fw, 0, fw, fh, tx, bodyTop, tileW, bodyH);
      }
      ctx.globalAlpha = 1;
    } else if (clip.kind === TRACK_KIND.AUDIO && aux?.peaks && bodyH > 6) {
      const peaks = aux.peaks;
      const rate = aux.peaksRate;
      const mid = bodyTop + bodyH / 2;
      const amp = (bodyH / 2) * 0.95;
      const vol = typeof clip.audio?.volume === 'number' ? Math.min(2, clip.audio.volume) : 1;
      ctx.fillStyle = clip.enabled ? '#b9e0a6' : '#6d7d66';
      for (let px = Math.floor(cx0); px < cx1; px++) {
        const t = this.xt(px);
        const src = clip.in + (t - clip.start) * clip.speed;
        const i0 = Math.floor(src * rate);
        const i1 = Math.max(i0 + 1, Math.floor((clip.in + (this.xt(px + 1) - clip.start) * clip.speed) * rate));
        let v = 0;
        for (let i = i0; i < i1 && i < peaks.length; i++) if (i >= 0 && peaks[i] > v) v = peaks[i];
        const a = (v / 255) * amp * vol;
        if (a > 0.3) ctx.fillRect(px, mid - a, 1, a * 2);
      }
    }
    // полоса заголовка клипа
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(cx0, top, cx1 - cx0, 15);
    if (!clip.enabled) {
      ctx.fillStyle = 'rgba(20,20,22,0.55)';
      ctx.fillRect(cx0, top, cx1 - cx0, ch);
    }
    // подпись
    if (width > 24) {
      ctx.fillStyle = clip.enabled ? '#f1f1f1' : '#9a9a9a';
      ctx.font = '11px ' + getComputedStyle(document.body).getPropertyValue('--font');
      let label = (clip.effects?.length ? 'fx ' : '') + (clip.name || media?.name || '—');
      if (clip.speed !== 1) label += ` [${Math.round(clip.speed * 100)}%]`;
      if (media && mediaCache.isOffline(media.id)) label = 'ОФЛАЙН · ' + label;
      ctx.fillText(label, Math.max(x0, 0) + 5, top + 11, Math.max(10, cx1 - Math.max(x0, 0) - 10));
    }
    ctx.restore();
    // рамка
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeStyle = selected ? '#ffd27a' : 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.roundRect(x0 + (selected ? 1 : 0.5), top + (selected ? 1 : 0.5), Math.max(1, width - (selected ? 2 : 1)), ch - (selected ? 1 : 0), 3);
    ctx.stroke();
  }

  // ---------- хит-тест ----------

  rowAt(y) {
    const yy = y + this.scrollY;
    return this.rows().find((r) => yy >= r.y && yy < r.y + r.h) || null;
  }

  hitTest(x, y) {
    const row = this.rowAt(y);
    const t = this.xt(x);
    if (!row) return { row: null, clip: null, t };
    for (const clip of row.track.clips) {
      const x0 = this.tx(clip.start);
      const x1 = this.tx(clipEnd(clip));
      if (x >= x0 - 1 && x <= x1 + 1) {
        let edge = null;
        const wide = x1 - x0 > EDGE_PX * 3;
        if (wide && x - x0 <= EDGE_PX) edge = 'start';
        else if (wide && x1 - x <= EDGE_PX) edge = 'end';
        else if (!wide && x - x0 < (x1 - x0) / 3) edge = 'start';
        else if (!wide && x1 - x < (x1 - x0) / 3) edge = 'end';
        return { row, clip, t, edge };
      }
    }
    return { row, clip: null, t };
  }

  _pos(e) {
    const r = this.area.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _hoverMove(e) {
    if (e.buttons) return;
    const { x, y } = this._pos(e);
    const tool = store.ui.tool;
    const hit = this.hitTest(x, y);
    let cur = TOOL_CURSOR[tool] || 'default';
    if ((tool === 'select' || tool === 'ripple') && hit.clip && hit.edge && !hit.row.track.locked) cur = tool === 'ripple' || e.ctrlKey ? 'col-resize' : 'ew-resize';
    if (tool === 'zoom' && e.altKey) cur = 'zoom-out';
    this.area.style.cursor = cur;
  }

  _updateCursor() {
    this.area.style.cursor = TOOL_CURSOR[store.ui.tool] || 'default';
    this._renderTop();
  }

  // ---------- прилипание ----------

  snapPoints(excludeIds = new Set()) {
    const seq = store.seq;
    const pts = [0, store.ui.playhead];
    if (seq.inPoint != null) pts.push(seq.inPoint);
    if (seq.outPoint != null) pts.push(seq.outPoint);
    for (const m of seq.markers) pts.push(m.time);
    for (const t of seq.tracks) for (const c of t.clips) if (!excludeIds.has(c.id)) pts.push(c.start, clipEnd(c));
    return pts;
  }

  /** Прилипание набора кандидатных времён: возвращает поправку и точку. */
  snapDelta(times, excludeIds, force = false) {
    if (!store.ui.snapping && !force) return { delta: 0, at: null };
    const pts = this.snapPoints(excludeIds);
    const maxDt = SNAP_PX / this.pxPerSec;
    let best = { delta: 0, at: null, d: Infinity };
    for (const t of times) {
      for (const p of pts) {
        const d = Math.abs(p - t);
        if (d < maxDt && d < best.d) best = { delta: p - t, at: p, d };
      }
    }
    return best;
  }

  // ---------- мышь: поле клипов ----------

  _areaDown(e) {
    if (e.button === 2) return; // контекстное меню
    if (e.button === 1) return this._pan(e);
    this.area.focus({ preventScroll: true });
    store.setFocus('timeline');
    const { x, y } = this._pos(e);
    const tool = store.ui.tool;
    const hit = this.hitTest(x, y);
    if (tool === 'hand') return this._pan(e);
    if (tool === 'zoom') {
      this.zoomAt(this.pxPerSec * (e.altKey ? 1 / 2 : 2), x);
      return;
    }
    if (tool === 'razor') {
      if (!hit.clip || hit.row.track.locked) return;
      const snapped = this.snapDelta([hit.t], new Set());
      const t = snapToFrame(hit.t + snapped.delta, store.seq.fps);
      store.mutate('Разрезать', (p, s) => {
        const r = e.shiftKey ? ops.razor(s, t) : ops.razor(s, t, { clipIds: [hit.clip.id], linked: store.ui.linkedSelection });
        return r.length ? true : false;
      });
      return;
    }
    if (tool === 'trackSelect') {
      const seq = store.seq;
      const ids = [];
      for (const tr of seq.tracks) {
        if (!e.shiftKey && hit.row && tr.id !== hit.row.track.id) continue;
        for (const c of tr.clips) if (clipEnd(c) > hit.t + EPS) ids.push(c.id);
      }
      store.select(ids, 'set');
      return;
    }
    // select / ripple
    if (hit.clip) {
      if (hit.row.track.locked) return;
      if (hit.edge && (tool === 'select' || tool === 'ripple')) {
        if (!store.ui.selection.has(hit.clip.id)) store.select([hit.clip.id], 'set');
        return this._trimDrag(e, hit, tool === 'ripple' || e.ctrlKey || e.metaKey);
      }
      if (e.shiftKey) {
        store.select([hit.clip.id], 'toggle');
        return;
      }
      if (!store.ui.selection.has(hit.clip.id)) {
        if (e.altKey) {
          // Alt — выделить только этот клип, игнорируя связь
          store.ui.selection.clear();
          store.ui.selection.add(hit.clip.id);
          store.emit('selection');
        } else store.select([hit.clip.id], 'set');
      }
      return this._moveDrag(e, hit);
    }
    // пустое место — рамка выделения
    this._marqueeDrag(e, x, y);
  }

  _pan(e) {
    const sx = this.scrollX;
    const sy = this.scrollY;
    this.area.style.cursor = 'grabbing';
    dragPointer(e, {
      onMove: (dx, dy) => {
        this._setScrollX(sx - dx);
        this._setScrollY(sy - dy);
      },
      onUp: () => (this.area.style.cursor = TOOL_CURSOR[store.ui.tool]),
    });
  }

  _marqueeDrag(e, x, y) {
    const additive = e.shiftKey;
    const base = additive ? new Set(store.ui.selection) : new Set();
    if (!additive) store.clearSelection();
    this.marquee = { x0: x, y0: y, x1: x, y1: y };
    dragPointer(e, {
      onMove: (dx, dy) => {
        this.marquee.x1 = x + dx;
        this.marquee.y1 = y + dy;
        const t0 = this.xt(Math.min(x, x + dx));
        const t1 = this.xt(Math.max(x, x + dx));
        const ya = Math.min(y, y + dy) + this.scrollY;
        const yb = Math.max(y, y + dy) + this.scrollY;
        const ids = new Set(base);
        for (const r of this.rows()) {
          if (r.y + r.h < ya || r.y > yb || r.track.locked) continue;
          for (const c of r.track.clips) if (clipEnd(c) > t0 && c.start < t1) ids.add(c.id);
        }
        store.ui.selection = ids;
        store.emit('selection');
      },
      onUp: (ev, dx, dy) => {
        this.marquee = null;
        if (Math.abs(dx) < 3 && Math.abs(dy) < 3 && !additive) store.clearSelection();
        else if (store.ui.linkedSelection) store.select([...store.ui.selection], 'add');
        this.draw();
      },
    });
  }

  _kindIndex(track) {
    const list = store.seq.tracks.filter((t) => t.kind === track.kind);
    return list.indexOf(track);
  }

  _moveDrag(e, hit) {
    const seq = store.seq;
    const selected = store.selectedClips().filter(({ track }) => !track.locked);
    if (!selected.length) return;
    const ids = new Set(selected.map((s) => s.clip.id));
    const items = selected.map(({ clip, track }) => ({ id: clip.id, start: clip.start, end: clipEnd(clip), kind: track.kind, idx: this._kindIndex(track) }));
    const vCount = seq.tracks.filter((t) => t.kind === TRACK_KIND.VIDEO).length;
    const aCount = seq.tracks.filter((t) => t.kind === TRACK_KIND.AUDIO).length;
    const dragKind = hit.row.track.kind;
    const dragIdx = this._kindIndex(hit.row.track);
    const minStart = Math.min(...items.map((i) => i.start));
    const duplicate = e.altKey;
    let state = null;
    const startX = e.clientX;
    dragPointer(e, {
      onMove: (dx, dy, ev) => {
        if (!state && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
        const { y } = this._pos(ev);
        let dt = dx / this.pxPerSec;
        dt = Math.max(dt, -minStart);
        const snap = this.snapDelta(items.flatMap((i) => [i.start + dt, i.end + dt]), ids);
        dt += snap.delta;
        this.snapLine = snap.at;
        dt = snapToFrame(dt, store.seq.fps);
        // вертикальный сдвиг по индексу дорожки своего типа
        const row = this.rowAt(y);
        let dIdx = 0;
        if (row && row.track.kind === dragKind) dIdx = this._kindIndex(row.track) - dragIdx;
        const minIdx = (k) => Math.min(...items.filter((i) => i.kind === k).map((i) => i.idx), Infinity);
        const maxIdx = (k) => Math.max(...items.filter((i) => i.kind === k).map((i) => i.idx), -Infinity);
        // клип нельзя увести за пределы существующих дорожек
        dIdx = Math.max(dIdx, -Math.min(minIdx('video'), minIdx('audio')));
        if (Number.isFinite(maxIdx('video'))) dIdx = Math.min(dIdx, vCount - 1 - maxIdx('video'));
        if (Number.isFinite(maxIdx('audio'))) dIdx = Math.min(dIdx, aCount - 1 - maxIdx('audio'));
        const mode = ev.ctrlKey || ev.metaKey ? 'insert' : 'overwrite';
        state = { dt, dIdx, mode };
        this._applyPreview((s) => this._applyMove(s, items, state, duplicate));
        const sign = dt >= 0 ? '+' : '−';
        this.dragInfo = { ...this._pos(ev), text: `${sign}${formatTC(Math.abs(dt), store.seq.fps)}${mode === 'insert' ? '  вставка' : ''}${duplicate ? '  копия' : ''}` };
        this.draw();
      },
      onUp: () => {
        this.snapLine = null;
        this.dragInfo = null;
        this.preview = null;
        if (!state || (state.dt === 0 && state.dIdx === 0 && !duplicate)) return this.draw();
        store.mutate(duplicate ? 'Дублировать клипы' : 'Переместить клипы', (p, s) => this._applyMove(s, items, state, duplicate));
      },
    });
    void startX;
  }

  _applyMove(seq, items, { dt, dIdx, mode }, duplicate) {
    const v = seq.tracks.filter((t) => t.kind === TRACK_KIND.VIDEO);
    const a = seq.tracks.filter((t) => t.kind === TRACK_KIND.AUDIO);
    if (duplicate) {
      // копии остаются на месте, перемещаются оригиналы
      const linkMap = new Map();
      for (const it of items) {
        const f = findClip(seq, it.id);
        if (!f) continue;
        const copy = structuredClone(f.clip);
        copy.id = crypto.randomUUID();
        if (copy.linkId) {
          if (!linkMap.has(copy.linkId)) linkMap.set(copy.linkId, 'lnk_' + crypto.randomUUID());
          copy.linkId = linkMap.get(copy.linkId);
        }
        f.track.clips.push(copy);
      }
    }
    const moves = items.map((it) => ({ clipId: it.id, start: it.start + dt, trackId: (it.kind === TRACK_KIND.VIDEO ? v : a)[it.idx + dIdx]?.id }));
    return ops.moveClips(seq, moves, { mode });
  }

  _applyPreview(fn) {
    const copy = structuredClone(store.seq);
    fn(copy);
    for (const t of copy.tracks) t.clips.sort((x, y) => x.start - y.start);
    this.preview = copy;
  }

  _trimDrag(e, hit, ripple) {
    const clip = hit.clip;
    const edge = hit.edge;
    const edgeTime = edge === 'start' ? clip.start : clipEnd(clip);
    let target = edgeTime;
    let moved = false;
    dragPointer(e, {
      cursor: ripple ? 'col-resize' : 'ew-resize',
      onMove: (dx, dy, ev) => {
        moved = true;
        let t = edgeTime + dx / this.pxPerSec;
        const snap = this.snapDelta([t], new Set([clip.id]));
        t += snap.delta;
        this.snapLine = snap.at;
        target = snapToFrame(t, store.seq.fps);
        this._applyPreview((s) => ops.trimClip(s, store.project, clip.id, edge, target, { ripple, linked: store.ui.linkedSelection }));
        const c = findClip(this.preview, clip.id)?.clip;
        const d = c ? clipDuration(c) : 0;
        this.dragInfo = { ...this._pos(ev), text: `${ripple ? 'Ripple ' : ''}${edge === 'start' ? 'начало' : 'конец'}  длит. ${formatTC(d, store.seq.fps)}` };
        this.draw();
      },
      onUp: () => {
        this.snapLine = null;
        this.dragInfo = null;
        this.preview = null;
        if (!moved || Math.abs(target - edgeTime) < EPS) return this.draw();
        store.mutate(ripple ? 'Ripple-триммирование' : 'Триммирование', (p, s) => ops.trimClip(s, p, clip.id, edge, target, { ripple, linked: store.ui.linkedSelection }));
      },
    });
  }

  _areaDblClick(e) {
    const { x, y } = this._pos(e);
    const hit = this.hitTest(x, y);
    if (hit.clip?.mediaId) {
      const media = store.getMedia(hit.clip.mediaId);
      if (media) this.app.openInSource(media.id, hit.clip.in + (hit.t - hit.clip.start) * hit.clip.speed);
    }
  }

  _areaContext(e) {
    const { x, y } = this._pos(e);
    const hit = this.hitTest(x, y);
    const run = (id) => () => this.app.run(id);
    if (hit.clip) {
      if (!store.ui.selection.has(hit.clip.id)) store.select([hit.clip.id], 'set');
      const c = hit.clip;
      contextMenu(e, [
        { label: 'Вырезать', shortcut: 'Mod+X', action: run('edit.cut') },
        { label: 'Копировать', shortcut: 'Mod+C', action: run('edit.copy') },
        { label: 'Удалить', shortcut: 'Delete', action: run('edit.clear') },
        { label: 'Удалить со сдвигом', shortcut: 'Shift+Delete', action: run('edit.rippleDelete') },
        '-',
        { label: 'Включить', shortcut: 'Shift+E', checked: c.enabled, action: run('clip.enable') },
        { label: c.linkId ? 'Разъединить' : 'Связать', shortcut: 'Mod+L', action: run('clip.link') },
        { label: 'Скорость/длительность…', shortcut: 'Mod+R', action: run('clip.speed') },
        { label: 'Переименовать…', action: run('clip.rename') },
        c.kind === TRACK_KIND.VIDEO && {
          label: 'Масштаб',
          submenu: [
            { label: 'Без масштабирования', checked: c.scaling === 'none', action: () => this.app.setScaling('none') },
            { label: 'Вписать в кадр', checked: c.scaling === 'fit', action: () => this.app.setScaling('fit') },
            { label: 'Заполнить кадр', checked: c.scaling === 'fill', action: () => this.app.setScaling('fill') },
          ],
        },
        '-',
        { label: 'Открыть в мониторе источника', shortcut: 'F', action: run('clip.matchFrame') },
        { label: 'Показать в проекте', action: () => this.app.revealInProject(c.mediaId) },
      ]);
      return;
    }
    const gap = hit.row ? ops.gapAt(hit.row.track, hit.t) : null;
    contextMenu(e, [
      gap && { label: 'Удалить промежуток со сдвигом', action: () => store.mutate('Удалить промежуток', (p, s) => ops.rippleDeleteGap(s, hit.row.track.id, hit.t)) },
      { label: 'Вставить', shortcut: 'Mod+V', disabled: !store.ui.clipboard, action: run('edit.paste') },
      { label: 'Вставить со сдвигом', shortcut: 'Mod+Shift+V', disabled: !store.ui.clipboard, action: run('edit.pasteInsert') },
      '-',
      { label: 'Выделить всё', shortcut: 'Mod+A', action: run('edit.selectAll') },
      { label: 'Добавить маркер', shortcut: 'M', action: run('marker.add') },
    ]);
  }

  // ---------- линейка ----------

  _markerAt(x) {
    const seq = store.seq;
    let best = null;
    for (const m of seq.markers) {
      const d = Math.abs(this.tx(m.time) - x);
      if (d <= 6 && (!best || d < best.d)) best = { m, d };
    }
    return best?.m || null;
  }

  _rulerDown(e) {
    if (e.button !== 0) return;
    store.setFocus('timeline');
    const r = this.ruler.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const marker = y < 26 ? this._markerAt(x) : null;
    if (marker) {
      store.ui.selectedMarkerId = marker.id;
      store.emit('selection');
      const t0 = marker.time;
      let moved = false;
      dragPointer(e, {
        onMove: (dx) => {
          moved = true;
          let t = Math.max(0, t0 + dx / this.pxPerSec);
          const sn = this.snapDelta([t], new Set());
          t = snapToFrame(t + sn.delta, store.seq.fps);
          this._markerDragTime = t;
          this._applyPreview((s) => ops.updateMarker(s, marker.id, { time: t }));
          this._drawRulerPreview();
        },
        onUp: () => {
          this.preview = null;
          if (moved && this._markerDragTime != null) store.mutate('Переместить маркер', (p, s) => ops.updateMarker(s, marker.id, { time: this._markerDragTime }));
          else transport.seek(marker.time);
          this._markerDragTime = null;
          this.draw();
        },
      });
      return;
    }
    if (transport.playing) transport.pause();
    const seek = (cx, shift) => {
      let t = Math.max(0, this.xt(cx));
      if (shift || store.ui.snapping) {
        const sn = this.snapDelta([t], new Set(), shift);
        if (shift || Math.abs(sn.delta) * this.pxPerSec < 4) t += sn.delta;
      }
      store.setPlayhead(t);
    };
    seek(x, e.shiftKey);
    dragPointer(e, {
      onMove: (dx, dy, ev) => {
        seek(x + dx, ev.shiftKey);
        // автопрокрутка у краёв
        const lx = ev.clientX - r.left;
        if (lx > r.width - 10) this._setScrollX(this.scrollX + 12);
        else if (lx < 10) this._setScrollX(this.scrollX - 12);
      },
    });
  }

  _drawRulerPreview() {
    // маркеры рисуются из store.seq — временно подменяем
    const real = store.seq;
    const idx = store.project.sequences.indexOf(real);
    store.project.sequences[idx] = this.preview;
    this._drawRuler();
    store.project.sequences[idx] = real;
  }

  _rulerDblClick(e) {
    const r = this.ruler.getBoundingClientRect();
    const m = this._markerAt(e.clientX - r.left);
    if (m) this.app.editMarker(m.id);
  }

  _rulerContext(e) {
    const r = this.ruler.getBoundingClientRect();
    const m = this._markerAt(e.clientX - r.left);
    const run = (id) => () => this.app.run(id);
    contextMenu(e, [
      m && { label: 'Изменить маркер…', action: () => this.app.editMarker(m.id) },
      m && { label: 'Удалить маркер', action: () => store.mutate('Удалить маркер', (p, s) => ops.deleteMarker(s, m.id)) },
      m && '-',
      { label: 'Добавить маркер', shortcut: 'M', action: run('marker.add') },
      { label: 'Удалить все маркеры', action: run('marker.clearAll'), disabled: !store.seq.markers.length },
      '-',
      { label: 'Отметить вход', shortcut: 'I', action: run('mark.in') },
      { label: 'Отметить выход', shortcut: 'O', action: run('mark.out') },
      { label: 'Очистить вход и выход', shortcut: 'Mod+Shift+X', action: run('mark.clearInOut') },
    ]);
  }

  // ---------- drag&drop медиа ----------

  _dropTargets(y) {
    const seq = store.seq;
    const row = this.rowAt(y);
    const v = seq.tracks.filter((t) => t.kind === TRACK_KIND.VIDEO);
    const a = seq.tracks.filter((t) => t.kind === TRACK_KIND.AUDIO);
    let vi = 0;
    let ai = 0;
    if (row) {
      const idx = this._kindIndex(row.track);
      if (row.track.kind === TRACK_KIND.VIDEO) {
        vi = idx;
        ai = Math.min(idx, a.length - 1);
      } else {
        ai = idx;
        vi = Math.min(idx, v.length - 1);
      }
    }
    return { videoTrackId: v[vi]?.id, audioTrackId: a[ai]?.id };
  }

  _placePayload(seq, payload, at, targets, mode) {
    let cursor = at;
    const created = [];
    for (const id of payload.mediaIds) {
      const media = store.project.media.find((m) => m.id === id);
      if (!media) continue;
      const ids = ops.placeMedia(seq, store.project, media, {
        at: cursor,
        ...targets,
        mode,
        takeVideo: payload.takeVideo !== false,
        takeAudio: payload.takeAudio !== false,
        inPoint: payload.mediaIds.length === 1 ? payload.inPoint : null,
        outPoint: payload.mediaIds.length === 1 ? payload.outPoint : null,
      });
      created.push(...ids);
      const c = ids.length ? findClip(seq, ids[0])?.clip : null;
      if (c) cursor = clipEnd(c);
    }
    return created;
  }

  _payloadDuration(payload) {
    let d = 0;
    for (const id of payload.mediaIds) {
      const m = store.getMedia(id);
      if (!m) continue;
      if (payload.mediaIds.length === 1 && payload.outPoint != null) d += payload.outPoint - (payload.inPoint || 0);
      else d += m.kind === 'image' ? store.project.settings.defaultImageDuration : (m.markOut ?? m.duration) - (m.markIn ?? 0);
    }
    return d;
  }

  _dragOver(e) {
    const types = [...(e.dataTransfer?.types || [])];
    if (dnd.effectType) {
      // эффект из панели «Эффекты» (этап 2) — бросается на клип
      const { x, y } = this._pos(e);
      if (this.hitTest(x, y).clip) e.preventDefault();
      return;
    }
    const isMedia = types.includes(MEDIA_MIME) && dnd.payload;
    const isFiles = types.includes('Files');
    if (!isMedia && !isFiles) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!isMedia) return;
    const { x, y } = this._pos(e);
    let at = Math.max(0, this.xt(x));
    const dur = this._payloadDuration(dnd.payload);
    const sn = this.snapDelta([at, at + dur], new Set());
    at = snapToFrame(at + sn.delta, store.seq.fps);
    this.snapLine = sn.at;
    const mode = e.ctrlKey || e.metaKey ? 'insert' : 'overwrite';
    const targets = this._dropTargets(y);
    this._dropState = { at, targets, mode };
    this._applyPreview((s) => this._placePayload(s, dnd.payload, at, targets, mode));
    this.draw();
  }

  async _drop(e) {
    e.preventDefault();
    this.preview = null;
    this.snapLine = null;
    const { x, y } = this._pos(e);
    if (dnd.effectType) {
      const type = dnd.effectType;
      dnd.effectType = null;
      const hit = this.hitTest(x, y);
      if (hit.clip) {
        store.select([hit.clip.id], 'set');
        this.app.applyEffectToSelection(type);
      }
      return;
    }
    if (dnd.payload && this._dropState) {
      const payload = dnd.payload;
      const { at, targets, mode } = this._dropState;
      this._dropState = null;
      dnd.payload = null;
      await this.app.checkSequenceMismatch(payload.mediaIds);
      store.mutate(mode === 'insert' ? 'Вставка' : 'Наложение', (p, s) => {
        const ids = this._placePayload(s, payload, at, targets, mode);
        if (ids.length) store.ui.selection = new Set(ids);
        return ids.length > 0;
      });
      return;
    }
    // файлы из системы — импорт и размещение
    if (e.dataTransfer?.files?.length) {
      e.stopPropagation();
      const at = Math.max(0, snapToFrame(this.xt(x), store.seq.fps));
      const targets = this._dropTargets(y);
      const created = await this.app.importFiles(e.dataTransfer.files);
      if (!created.length) return;
      const payload = { mediaIds: created.map((m) => m.id) };
      await this.app.checkSequenceMismatch(payload.mediaIds);
      store.mutate('Разместить на таймлайне', (p, s) => this._placePayload(s, payload, at, targets, 'overwrite').length > 0);
    }
  }
}

export const TOOLS = [
  ['select', 'select', 'Выделение (V)'],
  ['trackSelect', 'trackSelect', 'Выделение дорожки вперёд (A)'],
  ['ripple', 'ripple', 'Ripple-редактирование (B)'],
  ['razor', 'razor', 'Лезвие (C)'],
  ['hand', 'hand', 'Рука (H)'],
  ['zoom', 'zoom', 'Масштаб (Z)'],
];
