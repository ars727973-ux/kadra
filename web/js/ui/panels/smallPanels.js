// Небольшие панели: Эффекты (каталог плагинов), Индикаторы уровня,
// Инструменты, История, Маркеры.

import { h, clear, fitCanvas } from '../dom.js';
import { icon } from '../icons.js';
import { contextMenu } from '../menu.js';
import { store } from '../../core/store.js';
import { formatTC } from '../../core/time.js';
import { plugins } from '../../plugins/registry.js';
import { audioEngine } from '../../engine/audioEngine.js';
import { transport } from '../../engine/transport.js';
import { dnd } from '../dnd.js';
import * as ops from '../../core/timelineOps.js';
import { TOOLS } from './timeline.js';

// ---------- Эффекты ----------

export class EffectsPanel {
  constructor(app) {
    this.app = app;
    this.id = 'effects';
    this.title = 'Эффекты';
    this.el = h('div');
    this.search = h('input.search', { type: 'text', placeholder: 'Поиск эффектов…' });
    this.search.addEventListener('input', () => this.render());
    this.tree = h('div.panel-scroll');
    this.el.append(h('div.panel-toolbar', this.search), this.tree);
    plugins.on('change', () => this.render());
    this.render();
  }

  render() {
    clear(this.tree);
    const q = this.search.value.trim().toLowerCase();
    const groups = new Map();
    const add = (folder, item) => {
      if (q && !item.name.toLowerCase().includes(q)) return;
      if (!groups.has(folder)) groups.set(folder, []);
      groups.get(folder).push(item);
    };
    for (const e of plugins.effects.values()) add((e.target === 'audio' ? 'Аудиоэффекты / ' : 'Видеоэффекты / ') + e.category, { kind: 'effect', ...e });
    for (const t of plugins.transitions.values()) add('Видеопереходы', { kind: 'transition', ...t });
    for (const g of plugins.generators.values()) add('Генераторы', { kind: 'generator', ...g });
    const wrap = h('div.fx-tree');
    for (const [folder, items] of groups) {
      wrap.appendChild(h('div.fx-folder', icon('folder'), folder));
      for (const it of items) {
        const el = h('div.fx-item', { draggable: true, title: 'Перетащите на клип' }, it.name);
        el.addEventListener('dragstart', (e) => {
          dnd.effectType = it.type;
          e.dataTransfer.setData('text/plain', 'kadra-effect');
        });
        el.addEventListener('dragend', () => (dnd.effectType = null));
        el.addEventListener('dblclick', () => this.app.applyEffectToSelection(it.type));
        wrap.appendChild(el);
      }
    }
    if (!groups.size) {
      wrap.appendChild(
        h('div.stage-note', h('b', 'Каталог эффектов'), h('br'), 'Переходы (растворение, затемнение, шторка, сдвиг), титры, цветокоррекция, размытие/резкость/хромакей и аудиоэффекты — следующий этап. Архитектура готова: плагин регистрируется в ', h('span.mono', 'js/plugins/index.js'), ' и сразу появляется здесь, в «Параметрах эффектов», в превью и в экспорте.')
      );
    }
    this.tree.appendChild(wrap);
  }
}

// ---------- Индикаторы уровня ----------

export class MetersPanel {
  constructor() {
    this.id = 'meters';
    this.title = 'Уровни';
    this.canvas = h('canvas');
    this.el = h('div', h('div.meters', this.canvas));
    this.peak = [-Infinity, -Infinity];
    this.hold = [-Infinity, -Infinity];
    this.holdT = [0, 0];
    this._loop = this._loop.bind(this);
    transport.on('state', (s) => {
      if (s.playing) this._start();
    });
    this.draw([-Infinity, -Infinity]);
  }

  onResize() {
    this.draw(this.peak);
  }

  _start() {
    if (this._running) return;
    this._running = true;
    requestAnimationFrame(this._loop);
  }

  _loop() {
    const lv = audioEngine.levels();
    const now = performance.now();
    // плавный спад
    this.peak = this.peak.map((p, i) => Math.max(lv[i], (Number.isFinite(p) ? p : -90) - 1.2));
    this.hold = this.hold.map((p, i) => {
      if (lv[i] >= p || now - this.holdT[i] > 1500) {
        this.holdT[i] = now;
        return lv[i];
      }
      return p;
    });
    this.draw(this.peak);
    if (transport.playing || this.peak.some((p) => p > -60)) requestAnimationFrame(this._loop);
    else {
      this._running = false;
      this.peak = [-Infinity, -Infinity];
      this.draw(this.peak);
    }
  }

  draw(levels) {
    const parent = this.canvas.parentElement;
    const w = parent?.clientWidth || 40;
    const hh = parent?.clientHeight || 100;
    if (!w || !hh) return;
    const ctx = fitCanvas(this.canvas, w - 12, hh - 14);
    const W = w - 12;
    const H = hh - 14;
    ctx.clearRect(0, 0, W, H);
    const minDb = -60;
    const y = (db) => H - Math.max(0, Math.min(1, (db - minDb) / -minDb)) * H;
    const scaleW = W > 48 ? 18 : 0;
    const bw = Math.max(4, (W - scaleW - 6) / 2);
    for (let i = 0; i < 2; i++) {
      const x = scaleW + i * (bw + 4);
      ctx.fillStyle = '#101113';
      ctx.fillRect(x, 0, bw, H);
      const db = levels[i];
      if (Number.isFinite(db)) {
        const top = y(db);
        const g = ctx.createLinearGradient(0, H, 0, 0);
        g.addColorStop(0, '#2e9a63');
        g.addColorStop(0.7, '#9bc94a');
        g.addColorStop(0.88, '#e8b53a');
        g.addColorStop(1, '#e2574c');
        ctx.fillStyle = g;
        ctx.fillRect(x, top, bw, H - top);
      }
      const hd = this.hold[i];
      if (Number.isFinite(hd) && hd > minDb) {
        ctx.fillStyle = hd > -0.5 ? '#ff6b5f' : '#e7e7e7';
        ctx.fillRect(x, y(hd) - 1, bw, 2);
      }
    }
    if (scaleW) {
      ctx.fillStyle = '#7d818a';
      ctx.font = '9px sans-serif';
      for (const db of [0, -6, -12, -18, -24, -36, -48]) ctx.fillText(String(db), 0, Math.max(8, y(db) + 3));
    }
  }
}

// ---------- Инструменты ----------

export class ToolsPanel {
  constructor() {
    this.id = 'tools';
    this.title = 'Инстр.';
    this.el = h('div');
    this.box = h('div.tools');
    this.el.appendChild(this.box);
    store.on('tool', () => this.render());
    this.render();
  }

  render() {
    clear(this.box);
    for (const [tool, ic, title] of TOOLS) {
      const b = h('button.icon-btn', { type: 'button', title, 'aria-pressed': String(store.ui.tool === tool) }, icon(ic));
      b.addEventListener('click', () => store.setTool(tool));
      this.box.appendChild(b);
    }
  }
}

// ---------- История ----------

export class HistoryPanel {
  constructor() {
    this.id = 'history';
    this.title = 'История';
    this.el = h('div');
    this.list = h('ul.list');
    this.el.append(h('div.panel-scroll', this.list));
    store.on('history', () => this.render());
    store.on('project-loaded', () => this.render());
    this.render();
  }

  render() {
    clear(this.list);
    const hist = store.history;
    const open = h('li', { class: hist.undoStack.length === 0 ? 'current' : '' }, icon('folder'), h('span.grow', 'Открытие проекта'));
    open.addEventListener('click', () => hist.jumpTo(-1));
    this.list.appendChild(open);
    hist.undoStack.forEach((c, i) => {
      const li = h('li', { class: i === hist.undoStack.length - 1 ? 'current' : '' }, h('span.grow', c.label));
      li.addEventListener('click', () => hist.jumpTo(i));
      this.list.appendChild(li);
    });
    [...hist.redoStack].reverse().forEach((c, j) => {
      const li = h('li.future', h('span.grow', c.label));
      li.addEventListener('click', () => hist.jumpTo(hist.undoStack.length + j));
      this.list.appendChild(li);
    });
    this.list.lastChild?.scrollIntoView?.({ block: 'nearest' });
  }
}

// ---------- Маркеры ----------

export class MarkersPanel {
  constructor(app) {
    this.app = app;
    this.id = 'markers';
    this.title = 'Маркеры';
    this.el = h('div');
    this.list = h('ul.list');
    this.el.append(h('div.panel-scroll', this.list));
    store.on('change', () => this.render());
    store.on('selection', () => this.render());
    this.render();
  }

  render() {
    clear(this.list);
    const seq = store.seq;
    if (!seq.markers.length) {
      this.list.appendChild(h('li.muted', 'Нет маркеров. Нажмите M, чтобы добавить маркер в позиции плейхеда.'));
      return;
    }
    for (const m of seq.markers) {
      const li = h(
        'li',
        { class: store.ui.selectedMarkerId === m.id ? 'current' : '' },
        h('span.marker-dot', { style: { background: m.color } }),
        h('span.mono', formatTC(m.time, seq.fps)),
        h('span.grow', { title: m.comment || '' }, m.name || h('span.muted', '(без имени)')),
        m.duration > 0 ? h('span.muted.mono', formatTC(m.duration, seq.fps)) : null
      );
      li.addEventListener('click', () => {
        store.ui.selectedMarkerId = m.id;
        store.emit('selection');
        transport.seek(m.time);
        this.app.timeline.revealPlayhead();
      });
      li.addEventListener('dblclick', () => this.app.editMarker(m.id));
      li.addEventListener('contextmenu', (e) =>
        contextMenu(e, [
          { label: 'Изменить…', action: () => this.app.editMarker(m.id) },
          { label: 'Удалить', action: () => store.mutate('Удалить маркер', (p, s) => ops.deleteMarker(s, m.id)) },
        ])
      );
      this.list.appendChild(li);
    }
  }
}
