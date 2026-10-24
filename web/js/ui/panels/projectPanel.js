// Панель «Проект»: библиотека медиа и секвенций (список с метаданными или
// сетка превью с прокруткой при наведении), импорт drag&drop/диалогом,
// перетаскивание на таймлайн, перелинковка офлайн-файлов.

import { h, clear } from '../dom.js';
import { icon } from '../icons.js';
import { contextMenu } from '../menu.js';
import { store } from '../../core/store.js';
import { formatBytes, formatDuration, formatTC } from '../../core/time.js';
import { sequenceDuration } from '../../core/model.js';
import { mediaCache } from '../../media/mediaCache.js';
import { startMediaDrag, endMediaDrag } from '../dnd.js';

export class ProjectPanel {
  constructor(app) {
    this.app = app;
    this.id = 'project';
    this.title = 'Проект';
    this.el = h('div');
    this.view = localStorage.getItem('kadra.projectView') || 'list';
    this.filter = '';
    this._build();
    store.on('change', () => this.render());
    store.on('project-loaded', () => this.render());
    for (const ev of ['aux', 'offline', 'online']) mediaCache.on(ev, () => this._scheduleRender());
  }

  _build() {
    const importBtn = h('button.icon-btn', { type: 'button', title: 'Импорт (Ctrl+I)' }, icon('import'));
    importBtn.addEventListener('click', () => this.app.run('file.import'));
    this.listBtn = h('button.icon-btn', { type: 'button', title: 'Список' }, icon('list'));
    this.gridBtn = h('button.icon-btn', { type: 'button', title: 'Значки' }, icon('grid'));
    this.listBtn.addEventListener('click', () => this.setView('list'));
    this.gridBtn.addEventListener('click', () => this.setView('grid'));
    const search = h('input.search', { type: 'text', placeholder: 'Поиск…' });
    search.addEventListener('input', () => {
      this.filter = search.value.trim().toLowerCase();
      this.render();
    });
    const newSeq = h('button.icon-btn', { type: 'button', title: 'Новая секвенция (Ctrl+N)' }, icon('sequence'));
    newSeq.addEventListener('click', () => this.app.run('file.newSequence'));
    const del = h('button.icon-btn', { type: 'button', title: 'Удалить выбранное' }, icon('trash'));
    del.addEventListener('click', () => this.app.deleteProjectItems([...store.ui.projectSelection]));
    this.progress = h('div.import-progress', { style: 'width:0' });
    this.scroll = h('div.panel-scroll');
    this.countEl = h('span.muted', '');
    this.el.append(
      h('div.panel-toolbar', search, this.listBtn, this.gridBtn),
      this.progress,
      this.scroll,
      h('div.panel-footer', importBtn, newSeq, h('div.grow'), this.countEl, del)
    );
    // перетаскивание файлов в панель
    this.scroll.addEventListener('dragover', (e) => {
      if ([...e.dataTransfer.types].includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    this.scroll.addEventListener('drop', (e) => {
      if (!e.dataTransfer.files?.length) return;
      e.preventDefault();
      e.stopPropagation();
      this.app.importFiles(e.dataTransfer.files);
    });
    this.scroll.addEventListener('pointerdown', (e) => {
      if (e.target === this.scroll || e.target.classList.contains('media-grid') || e.target.classList.contains('empty-hint')) {
        store.ui.projectSelection.clear();
        this.render();
      }
    });
    this.scroll.addEventListener('contextmenu', (e) => {
      if (e.target.closest('[data-id]')) return;
      contextMenu(e, [
        { label: 'Импорт…', shortcut: 'Mod+I', action: () => this.app.run('file.import') },
        { label: 'Новая секвенция…', shortcut: 'Mod+N', action: () => this.app.run('file.newSequence') },
      ]);
    });
    this.render();
  }

  onShow() {
    this.render();
  }

  setView(v) {
    this.view = v;
    localStorage.setItem('kadra.projectView', v);
    this.render();
  }

  setProgress(p) {
    this.progress.style.width = p >= 1 || p <= 0 ? '0' : `${p * 100}%`;
  }

  _scheduleRender() {
    if (this._r) return;
    this._r = requestAnimationFrame(() => {
      this._r = 0;
      this.render();
    });
  }

  _items() {
    const items = [];
    for (const s of store.project.sequences) items.push({ type: 'sequence', id: s.id, name: s.name, seq: s });
    for (const m of store.project.media) items.push({ type: 'media', id: m.id, name: m.name, media: m });
    return this.filter ? items.filter((i) => i.name.toLowerCase().includes(this.filter)) : items;
  }

  _select(e, item, ordered) {
    const sel = store.ui.projectSelection;
    if (e.shiftKey && this._lastClicked) {
      const ids = ordered.map((i) => i.id);
      const a = ids.indexOf(this._lastClicked);
      const b = ids.indexOf(item.id);
      if (a >= 0 && b >= 0) for (const id of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) sel.add(id);
    } else if (e.ctrlKey || e.metaKey) {
      sel.has(item.id) ? sel.delete(item.id) : sel.add(item.id);
      this._lastClicked = item.id;
    } else {
      if (!sel.has(item.id)) {
        sel.clear();
        sel.add(item.id);
      }
      this._lastClicked = item.id;
    }
    // без полной перерисовки: иначе элемент заменится и двойной щелчок не сработает
    this._refreshSelection();
  }

  _refreshSelection() {
    const sel = store.ui.projectSelection;
    for (const el of this.scroll.querySelectorAll('[data-id]')) el.classList.toggle('selected', sel.has(el.dataset.id));
  }

  _open(item) {
    if (item.type === 'sequence') store.setActiveSequence(item.id);
    else this.app.openInSource(item.id);
  }

  _bind(el, item, ordered) {
    el.dataset.id = item.id;
    el.addEventListener('pointerdown', (e) => {
      store.setFocus('project');
      if (e.button === 0) this._select(e, item, ordered);
    });
    el.addEventListener('dblclick', () => this._open(item));
    el.addEventListener('contextmenu', (e) => {
      if (!store.ui.projectSelection.has(item.id)) {
        store.ui.projectSelection.clear();
        store.ui.projectSelection.add(item.id);
        this.render();
      }
      contextMenu(e, this._menu(item));
    });
    if (item.type === 'media') {
      el.draggable = true;
      el.addEventListener('dragstart', (e) => {
        const ids = store.ui.projectSelection.has(item.id) ? [...store.ui.projectSelection].filter((id) => store.getMedia(id)) : [item.id];
        startMediaDrag(e, { mediaIds: ids, takeVideo: true, takeAudio: true });
      });
      el.addEventListener('dragend', endMediaDrag);
    }
  }

  _menu(item) {
    if (item.type === 'sequence') {
      return [
        { label: 'Открыть на таймлайне', action: () => store.setActiveSequence(item.id) },
        { label: 'Параметры секвенции…', action: () => {
          store.setActiveSequence(item.id);
          this.app.run('sequence.settings');
        } },
        { label: 'Переименовать…', action: () => this.app.renameItem(item) },
        { label: 'Дублировать', action: () => this.app.duplicateSequence(item.id) },
        '-',
        { label: 'Удалить', disabled: store.project.sequences.length <= 1, action: () => this.app.deleteProjectItems([item.id]) },
      ];
    }
    const m = item.media;
    const offline = mediaCache.isOffline(m.id);
    return [
      { label: 'Открыть в мониторе источника', action: () => this.app.openInSource(m.id) },
      { label: 'Вставить в секвенцию', shortcut: ',', action: () => this.app.insertFromProject('insert') },
      { label: 'Наложить в секвенцию', shortcut: '.', action: () => this.app.insertFromProject('overwrite') },
      { label: 'Создать секвенцию по клипу', disabled: !m.hasVideo, action: () => this.app.sequenceFromMedia(m.id) },
      '-',
      { label: 'Переименовать…', action: () => this.app.renameItem(item) },
      { label: offline ? 'Связать медиа…' : 'Заменить файл…', action: () => this.app.relink(m.id) },
      { label: 'Свойства…', action: () => this.app.showMediaInfo(m.id) },
      '-',
      { label: 'Удалить', shortcut: 'Delete', action: () => this.app.deleteProjectItems([...store.ui.projectSelection]) },
    ];
  }

  render() {
    if (!this.el.isConnected && this._rendered) return;
    this._rendered = true;
    this.listBtn.setAttribute('aria-pressed', String(this.view === 'list'));
    this.gridBtn.setAttribute('aria-pressed', String(this.view === 'grid'));
    const items = this._items();
    this.countEl.textContent = `${store.project.media.length} медиа · ${store.project.sequences.length} секв.`;
    clear(this.scroll);
    if (!store.project.media.length && !this.filter) {
      this.scroll.appendChild(
        h('div.empty-hint', 'Перетащите сюда видео, звук или изображения', h('br'), 'или нажмите ', h('kbd', 'Ctrl+I'), h('br'), h('span', { style: 'font-size:11px' }, 'MP4 · WebM · MOV · MP3 · WAV · PNG · JPG'))
      );
    }
    if (this.view === 'grid') this._renderGrid(items);
    else this._renderList(items);
  }

  _meta(m) {
    const parts = [];
    if (m.width) parts.push(`${m.width}×${m.height}`);
    if (m.fps) parts.push(`${Math.round(m.fps * 100) / 100} к/с`);
    const codec = [m.videoCodec, m.audioCodec].filter(Boolean).join(' / ');
    return { res: parts.join(', '), codec };
  }

  _renderList(items) {
    const sel = store.ui.projectSelection;
    const tbody = h('tbody');
    for (const item of items) {
      let tr;
      if (item.type === 'sequence') {
        const s = item.seq;
        tr = h(
          'tr',
          { class: [sel.has(item.id) ? 'selected' : ''].join(' ') },
          h('td.name', h('div.name-cell', h('span.kind-badge.sequence'), h('span', { title: s.name }, s.name))),
          h('td.mono', formatTC(sequenceDuration(s), s.fps)),
          h('td', `${s.width}×${s.height}, ${s.fps} к/с`),
          h('td.muted', 'Секвенция'),
          h('td.muted', '')
        );
      } else {
        const m = item.media;
        const meta = this._meta(m);
        const offline = mediaCache.isOffline(m.id);
        tr = h(
          'tr',
          { class: [sel.has(item.id) ? 'selected' : '', offline ? 'offline' : ''].join(' ') },
          h('td.name', h('div.name-cell', h('span.kind-badge', { class: m.kind }), h('span', { title: m.name }, (offline ? '⚠ ' : '') + m.name))),
          h('td.mono', m.kind === 'image' ? '—' : formatTC(m.duration, m.fps ? Math.round(m.fps) || 30 : 30)),
          h('td', meta.res || '—'),
          h('td', { title: m.videoCodecString || '' }, meta.codec || '—'),
          h('td.muted', formatBytes(m.size))
        );
      }
      this._bind(tr, item, items);
      tbody.appendChild(tr);
    }
    const cols = h('colgroup', h('col', { style: 'width:31%' }), h('col', { style: 'width:23%' }), h('col', { style: 'width:20%' }), h('col', { style: 'width:14%' }), h('col', { style: 'width:12%' }));
    this.scroll.appendChild(h('table.media-list', cols, h('thead', h('tr', h('th', 'Имя'), h('th', 'Длительность'), h('th', 'Разрешение'), h('th', 'Кодек'), h('th', 'Размер'))), tbody));
  }

  _renderGrid(items) {
    const sel = store.ui.projectSelection;
    const grid = h('div.media-grid');
    for (const item of items) {
      let card;
      if (item.type === 'sequence') {
        const s = item.seq;
        card = h('div.media-card', { class: sel.has(item.id) ? 'selected' : '' },
          h('div.thumb', { style: 'display:flex;align-items:center;justify-content:center;color:#8f5d3a' }, icon('sequence', { size: 34 }), h('span.dur', formatTC(sequenceDuration(s), s.fps))),
          h('div.meta', h('div.n', s.name), h('div.s', `Секвенция · ${s.width}×${s.height}`))
        );
      } else {
        const m = item.media;
        const aux = mediaCache.auxSync(m.id);
        if (!aux) mediaCache.loadAux(m);
        const thumb = h('div.thumb');
        if (aux?.spriteUrl) {
          const n = aux.spriteCount;
          thumb.style.backgroundImage = `url(${aux.spriteUrl})`;
          thumb.style.backgroundSize = `${n * 100}% 100%`;
          const pos = (i) => (n > 1 ? (i / (n - 1)) * 100 : 0);
          thumb.style.backgroundPosition = `${pos(Math.floor(n * 0.15))}% 0`;
          // прокрутка превью при наведении
          thumb.addEventListener('pointermove', (e) => {
            const r = thumb.getBoundingClientRect();
            const i = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n)));
            thumb.style.backgroundPosition = `${pos(i)}% 0`;
          });
        } else if (m.kind === 'audio' && aux?.peaks) {
          const c = h('canvas', { width: 160, height: 90 });
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#16231a';
          ctx.fillRect(0, 0, 160, 90);
          ctx.fillStyle = '#7fbf6a';
          const p = aux.peaks;
          for (let x = 0; x < 160; x++) {
            const v = p[Math.floor((x / 160) * p.length)] / 255;
            ctx.fillRect(x, 45 - v * 40, 1, v * 80 || 1);
          }
          thumb.appendChild(c);
        }
        if (m.kind !== 'image') thumb.appendChild(h('span.dur', formatDuration(m.duration)));
        if (mediaCache.isOffline(m.id)) thumb.appendChild(h('div.offline-tag', 'Офлайн'));
        const meta = this._meta(m);
        card = h('div.media-card', { class: sel.has(item.id) ? 'selected' : '' }, thumb, h('div.meta', h('div.n', { title: m.name }, m.name), h('div.s', [meta.res, meta.codec].filter(Boolean).join(' · ') || m.kind)));
      }
      this._bind(card, item, items);
      grid.appendChild(card);
    }
    this.scroll.appendChild(grid);
  }

  /** Подсветить элемент (Показать в проекте). */
  reveal(mediaId) {
    store.ui.projectSelection.clear();
    store.ui.projectSelection.add(mediaId);
    this.filter = '';
    this.render();
    this.scroll.querySelector(`[data-id="${mediaId}"]`)?.scrollIntoView({ block: 'nearest' });
  }
}
