// Глобальное состояние приложения: проект + UI-состояние + история.
// Все изменения проекта идут через store.mutate(), чтобы попасть в undo/redo,
// пометить проект «грязным» (для автосохранения) и оповестить панели.

import { Emitter } from './events.js';
import { History } from './history.js';
import { createProject, findClip, linkedClips, normalizeProject, TRACK_KIND } from './model.js';
import { snapToFrame } from './time.js';

class Store extends Emitter {
  constructor() {
    super();
    this.project = createProject();
    this.history = new History(this, 200);
    this.history.onChange(() => this.emit('history'));
    this.ui = this._freshUi();
    this.dirty = false;
  }

  _freshUi() {
    return {
      selection: new Set(), // id выделенных клипов
      selectedMarkerId: null,
      tool: 'select', // select | trackSelect | ripple | razor | hand | zoom
      snapping: true,
      linkedSelection: true,
      focusedPanel: 'timeline',
      sourceMediaId: null, // медиа, открытое в Source Monitor
      projectSelection: new Set(), // выделение в панели Project
      playhead: 0,
      targetVideoTrackId: null, // «патч» источника: целевые дорожки вставки
      targetAudioTrackId: null,
      clipboard: null,
      programResolution: 1, // 1, 0.5, 0.25 — качество превью
    };
  }

  // ---------- проект ----------

  get seq() {
    const p = this.project;
    return p.sequences.find((s) => s.id === p.activeSequenceId) || p.sequences[0];
  }

  setProject(project, { dirty = false } = {}) {
    this.project = normalizeProject(project);
    this.ui = this._freshUi();
    this.ui.playhead = this.seq.playhead || 0;
    this._ensureTargets();
    this.history.clear();
    this.dirty = dirty;
    this._mediaIndex = null;
    this.emit('project-loaded', this.project);
    this.emit('change', { reason: 'load' });
    this.emit('playhead', this.ui.playhead);
    this.emit('selection');
    this.emit('dirty', this.dirty);
  }

  setActiveSequence(id) {
    if (!this.project.sequences.find((s) => s.id === id)) return;
    this.seq.playhead = this.ui.playhead;
    this.project.activeSequenceId = id;
    this.ui.selection.clear();
    this.ui.playhead = this.seq.playhead || 0;
    this._ensureTargets();
    this.emit('change', { reason: 'sequence' });
    this.emit('selection');
    this.emit('playhead', this.ui.playhead);
  }

  _ensureTargets() {
    const seq = this.seq;
    const v = seq.tracks.filter((t) => t.kind === TRACK_KIND.VIDEO);
    const a = seq.tracks.filter((t) => t.kind === TRACK_KIND.AUDIO);
    if (!v.find((t) => t.id === this.ui.targetVideoTrackId)) this.ui.targetVideoTrackId = v[0]?.id ?? null;
    if (!a.find((t) => t.id === this.ui.targetAudioTrackId)) this.ui.targetAudioTrackId = a[0]?.id ?? null;
  }

  /**
   * Отменяемое изменение проекта.
   * fn(project, seq) — мутирует проект напрямую. Вернуть false = «ничего не поменялось».
   */
  mutate(label, fn, opts = {}) {
    const res = this.history.run(label, () => fn(this.project, this.seq), opts);
    if (res !== false) this._afterChange(opts.reason || 'edit');
    return res;
  }

  /** Неотменяемое изменение (например, метаданные медиа после фонового анализа). */
  mutateSilently(fn, reason = 'meta') {
    fn(this.project, this.seq);
    this._afterChange(reason);
  }

  _afterChange(reason) {
    this._mediaIndex = null;
    for (const s of this.project.sequences) for (const t of s.tracks) t.clips.sort((a, b) => a.start - b.start);
    this._ensureTargets();
    this._pruneSelection();
    this.markDirty();
    this.emit('change', { reason });
  }

  markDirty() {
    if (!this.dirty) {
      this.dirty = true;
      this.emit('dirty', true);
    }
  }

  markClean() {
    if (this.dirty) {
      this.dirty = false;
      this.emit('dirty', false);
    }
  }

  // Интерфейс для History
  takeSnapshot() {
    return JSON.stringify(this.project);
  }

  restoreSnapshot(snap) {
    const activeId = this.project.activeSequenceId;
    this.project = JSON.parse(snap);
    if (!this.project.sequences.find((s) => s.id === this.project.activeSequenceId)) this.project.activeSequenceId = activeId;
    this._afterChange('history');
  }

  _pruneSelection() {
    const seq = this.seq;
    const ids = new Set();
    for (const t of seq.tracks) for (const c of t.clips) ids.add(c.id);
    let changed = false;
    for (const id of [...this.ui.selection]) {
      if (!ids.has(id)) {
        this.ui.selection.delete(id);
        changed = true;
      }
    }
    if (this.ui.selectedMarkerId && !seq.markers.find((m) => m.id === this.ui.selectedMarkerId)) {
      this.ui.selectedMarkerId = null;
      changed = true;
    }
    const mediaIds = new Set(this.project.media.map((m) => m.id));
    for (const id of [...this.ui.projectSelection]) if (!mediaIds.has(id)) this.ui.projectSelection.delete(id);
    if (this.ui.sourceMediaId && !mediaIds.has(this.ui.sourceMediaId)) {
      this.ui.sourceMediaId = null;
      this.emit('source-media', null);
    }
    if (changed) this.emit('selection');
  }

  // ---------- медиа ----------

  getMedia(id) {
    if (!this._mediaIndex) this._mediaIndex = new Map(this.project.media.map((m) => [m.id, m]));
    return this._mediaIndex.get(id) || null;
  }

  // ---------- плейхед ----------

  setPlayhead(t, { snap = true, silent = false } = {}) {
    const fps = this.seq.fps;
    t = Math.max(0, Number.isFinite(t) ? t : 0);
    if (snap) t = snapToFrame(t, fps);
    if (t === this.ui.playhead) return;
    this.ui.playhead = t;
    if (!silent) this.emit('playhead', t);
  }

  // ---------- выделение ----------

  /**
   * Выделение клипов. mode: 'set' | 'add' | 'toggle' | 'remove'.
   * При включённом «связанном выделении» выделяются и связанные клипы (видео+аудио).
   */
  select(ids, mode = 'set') {
    const seq = this.seq;
    const expand = (id) => {
      const found = findClip(seq, id);
      if (!found) return [];
      return this.ui.linkedSelection ? linkedClips(seq, found.clip).map((c) => c.id) : [id];
    };
    const sel = this.ui.selection;
    if (mode === 'set') sel.clear();
    for (const id of ids) {
      const group = expand(id);
      if (mode === 'toggle') {
        const on = sel.has(id);
        for (const g of group) on ? sel.delete(g) : sel.add(g);
      } else if (mode === 'remove') {
        for (const g of group) sel.delete(g);
      } else {
        for (const g of group) sel.add(g);
      }
    }
    if (ids.length) this.ui.selectedMarkerId = null;
    this.emit('selection');
  }

  clearSelection() {
    if (!this.ui.selection.size && !this.ui.selectedMarkerId) return;
    this.ui.selection.clear();
    this.ui.selectedMarkerId = null;
    this.emit('selection');
  }

  selectedClips() {
    const out = [];
    for (const t of this.seq.tracks) for (const c of t.clips) if (this.ui.selection.has(c.id)) out.push({ clip: c, track: t });
    return out;
  }

  // ---------- прочее UI ----------

  setTool(tool) {
    this.ui.tool = tool;
    this.emit('tool', tool);
  }

  setFocus(panel) {
    if (this.ui.focusedPanel === panel) return;
    this.ui.focusedPanel = panel;
    this.emit('focus', panel);
  }

  setUi(key, value) {
    this.ui[key] = value;
    this.emit('ui', { key, value });
  }

  openInSource(mediaId) {
    this.ui.sourceMediaId = mediaId;
    this.emit('source-media', mediaId);
  }
}

export const store = new Store();
// Для отладки и e2e-тестов
if (typeof window !== 'undefined') window.__kadraStore = store;
