// Панель «Параметры эффектов» (аналог Effect Controls):
//   «Движение» — положение, масштаб (в т.ч. раздельный), поворот, опорная точка, масштаб по кадру;
//   «Непрозрачность» — непрозрачность и режим наложения;
//   «Громкость» — уровень (дБ) и панорама связанного/выделенного аудиоклипа;
//   «Эффекты» — экземпляры плагинов клипа: UI строится по схеме параметров
//   из реестра (этап 2 — без изменений этой панели).
// Числа «скраббируются» перетаскиванием (Shift — ×10, Ctrl — ×0.1), щелчок — ввод.

import { h, clear, dragPointer } from '../dom.js';
import { icon } from '../icons.js';
import { store } from '../../core/store.js';
import { BLEND_MODES, SCALING_MODES, TRACK_KIND, findClip, clipDuration } from '../../core/model.js';
import { formatTC } from '../../core/time.js';
import { isAnimated, staticValue } from '../../core/keyframes.js';
import { plugins } from '../../plugins/registry.js';
import { defaultTransform } from '../../core/model.js';
import { sourceSize } from '../../engine/compositor.js';

const fmt = (v, d = 1) => (Number.isFinite(v) ? (Math.round(v * 10 ** d) / 10 ** d).toFixed(d) : '—');
const toDb = (g) => (g <= 0.00001 ? -Infinity : 20 * Math.log10(g));
const fromDb = (db) => (db <= -96 ? 0 : 10 ** (db / 20));

export class EffectControlsPanel {
  constructor(app) {
    this.app = app;
    this.id = 'effectControls';
    this.title = 'Параметры эффектов';
    this.el = h('div');
    this.scroll = h('div.panel-scroll');
    this.el.append(this.scroll);
    this.collapsed = new Set();
    store.on('selection', () => this.render());
    store.on('change', () => {
      if (!this._editing) this.render();
    });
    plugins.on('change', () => this.render());
    this.render();
  }

  onShow() {
    this.render();
  }

  _clips() {
    const seq = store.seq;
    const sel = store.selectedClips();
    let video = sel.find((s) => s.track.kind === TRACK_KIND.VIDEO) || null;
    let audio = sel.find((s) => s.track.kind === TRACK_KIND.AUDIO && (!video || !video.clip.linkId || s.clip.linkId === video.clip.linkId)) || null;
    if (video && !audio && video.clip.linkId) {
      for (const t of seq.tracks) for (const c of t.clips) if (c.linkId === video.clip.linkId && t.kind === TRACK_KIND.AUDIO) audio = { clip: c, track: t };
    }
    return { video, audio, count: sel.length };
  }

  /** Изменение параметра клипа с объединением шагов undo в рамках жеста. */
  _edit(clipId, label, fn, key) {
    this._editing = true;
    try {
      store.mutate(label, (p, s) => {
        const c = findClip(s, clipId)?.clip;
        if (!c) return false;
        return fn(c, s);
      }, { mergeKey: `ec:${clipId}:${key}` });
    } finally {
      this._editing = false;
    }
    this._refreshValues();
  }

  render() {
    clear(this.scroll);
    this._valueUpdaters = [];
    const { video, audio, count } = this._clips();
    if (!video && !audio) {
      this.scroll.appendChild(h('div.empty-hint', count > 1 ? 'Выделено несколько клипов' : 'Выделите клип на таймлайне, чтобы изменить его параметры'));
      return;
    }
    const main = (video || audio).clip;
    const seq = store.seq;
    this.scroll.appendChild(
      h('div.fx-header', h('span.clip-name', main.name || '—'), h('span.muted.mono', `${formatTC(main.start, seq.fps)} → ${formatTC(main.start + clipDuration(main), seq.fps)}`), main.speed !== 1 ? h('span.fx-badge', `${Math.round(main.speed * 100)}%`) : null)
    );
    if (video) this._renderVideo(video.clip, video.track);
    if (audio) this._renderAudio(audio.clip, audio.track);
    this._renderEffects(video?.clip || audio.clip);
  }

  _refreshValues() {
    for (const u of this._valueUpdaters || []) u();
  }

  _section(key, title, rows, onReset) {
    const sec = h('div.fx-section', { class: this.collapsed.has(key) ? 'collapsed' : '' });
    const reset = onReset ? h('button.icon-btn.fx-reset', { type: 'button', title: 'Сбросить' }, icon('reset')) : null;
    reset?.addEventListener('click', (e) => {
      e.stopPropagation();
      onReset();
    });
    const head = h('div.fx-section-head', h('span.tw', '▾'), h('span.title', title), reset);
    head.addEventListener('click', () => {
      this.collapsed.has(key) ? this.collapsed.delete(key) : this.collapsed.add(key);
      sec.classList.toggle('collapsed');
    });
    sec.append(head, h('div.fx-rows', rows));
    this.scroll.appendChild(sec);
  }

  _row(label, ...val) {
    return h('div.fx-row', h('div.lbl', { title: label }, label), h('div.val', val), h('span'));
  }

  /** Скраббируемое число. get() → текущее значение, set(v, final) — запись. */
  _scrub({ get, set, step = 1, min = -Infinity, max = Infinity, digits = 1, suffix = '' }) {
    const el = h('span.scrub', { tabIndex: 0 });
    const show = () => {
      const v = get();
      el.textContent = (v === -Infinity ? '−∞' : fmt(v, digits)) + suffix;
    };
    show();
    this._valueUpdaters.push(show);
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const start = get();
      let moved = false;
      dragPointer(e, {
        cursor: 'ew-resize',
        onMove: (dx, dy, ev) => {
          if (Math.abs(dx) < 2 && !moved) return;
          moved = true;
          const k = ev.shiftKey ? 10 : ev.ctrlKey || ev.metaKey ? 0.1 : 1;
          const base = Number.isFinite(start) ? start : min;
          const v = Math.min(max, Math.max(min, base + dx * step * k));
          set(Math.round(v * 10 ** digits) / 10 ** digits);
          show();
        },
        onUp: () => {
          if (moved) return;
          // щелчок — ввод значения
          const input = h('input.scrub-input', { type: 'text', value: fmt(get(), digits) });
          el.replaceWith(input);
          input.focus();
          input.select();
          let done = false;
          const commit = (ok) => {
            // Enter вызывает commit, затем blur — второй вызов игнорируем
            if (done) return;
            done = true;
            if (ok) {
              const v = parseFloat(input.value.replace(',', '.'));
              if (Number.isFinite(v)) set(Math.min(max, Math.max(min, v)));
            }
            input.replaceWith(el);
            show();
          };
          input.addEventListener('keydown', (ev) => {
            ev.stopPropagation();
            if (ev.key === 'Enter') commit(true);
            if (ev.key === 'Escape') commit(false);
          });
          input.addEventListener('blur', () => commit(true), { once: true });
        },
      });
    });
    return el;
  }

  _renderVideo(clip, track) {
    const seq = store.seq;
    const media = clip.mediaId ? store.getMedia(clip.mediaId) : null;
    const [sw, sh] = sourceSize(clip, media, seq);
    const t = () => findClip(store.seq, clip.id)?.clip || clip;
    const tr = () => t().transform;
    const lt = store.ui.playhead - clip.start;
    const num = (fnGet) => () => {
      const v = staticValue(fnGet(), lt);
      return typeof v === 'number' ? v : NaN;
    };
    const setTr = (key, label, fn) => (v) => this._edit(clip.id, label, (c) => {
      if (isAnimated(c.transform[key])) return false; // анимация — этап 2
      fn(c.transform, v);
    }, key);
    const locked = track.locked;
    const pos = () => tr().position || [seq.width / 2, seq.height / 2];
    const anchor = () => tr().anchor || [sw / 2, sh / 2];
    const rows = [
      this._row('Положение',
        this._scrub({ get: num(() => pos()[0]), set: setTr('position', 'Положение', (x, v) => (x.position = [v, pos()[1]])), digits: 1 }),
        this._scrub({ get: num(() => pos()[1]), set: setTr('position', 'Положение', (x, v) => (x.position = [pos()[0], v])), digits: 1 })
      ),
      this._row(tr().uniformScale === false ? 'Масштаб по высоте' : 'Масштаб',
        this._scrub({ get: num(() => tr().scale), set: setTr('scale', 'Масштаб', (x, v) => (x.scale = v)), min: 0, max: 10000, step: 0.5, suffix: ' %' })
      ),
    ];
    if (tr().uniformScale === false) {
      rows.push(this._row('Масштаб по ширине', this._scrub({ get: num(() => tr().scaleWidth), set: setTr('scaleWidth', 'Масштаб по ширине', (x, v) => (x.scaleWidth = v)), min: 0, max: 10000, step: 0.5, suffix: ' %' })));
    }
    const uniform = h('input', { type: 'checkbox', checked: tr().uniformScale !== false });
    uniform.addEventListener('change', () => {
      this._edit(clip.id, 'Равномерный масштаб', (c) => {
        c.transform.uniformScale = uniform.checked;
        if (!uniform.checked) c.transform.scaleWidth = staticValue(c.transform.scale);
      }, 'uniform');
      this.render();
    });
    rows.push(this._row('', h('label.row', uniform, 'Равномерный масштаб')));
    rows.push(this._row('Поворот', this._scrub({ get: num(() => tr().rotation), set: setTr('rotation', 'Поворот', (x, v) => (x.rotation = v)), step: 0.5, suffix: '°' })));
    rows.push(
      this._row('Опорная точка',
        this._scrub({ get: num(() => anchor()[0]), set: setTr('anchor', 'Опорная точка', (x, v) => (x.anchor = [v, anchor()[1]])) }),
        this._scrub({ get: num(() => anchor()[1]), set: setTr('anchor', 'Опорная точка', (x, v) => (x.anchor = [anchor()[0], v])) })
      )
    );
    const scaling = h('select', ...SCALING_MODES.map(([v, l]) => h('option', { value: v, selected: clip.scaling === v }, l)));
    scaling.addEventListener('change', () => this._edit(clip.id, 'Масштаб по кадру', (c) => (c.scaling = scaling.value), 'scaling'));
    rows.push(this._row('Размер по кадру', scaling));
    if (locked) rows.unshift(h('div.note.warn', { style: 'padding:6px 26px' }, 'Дорожка заблокирована'));
    this._section('motion', 'Движение', rows, () =>
      this._edit(clip.id, 'Сбросить «Движение»', (c) => {
        const d = defaultTransform(seq.width, seq.height, sw, sh);
        Object.assign(c.transform, { position: d.position, scale: 100, scaleWidth: 100, uniformScale: true, rotation: 0, anchor: d.anchor });
      }, 'resetMotion')
    );

    const blend = h('select', ...BLEND_MODES.map(([v, l]) => h('option', { value: v, selected: (tr().blend || 'normal') === v }, l)));
    blend.addEventListener('change', () => this._edit(clip.id, 'Режим наложения', (c) => (c.transform.blend = blend.value), 'blend'));
    const opacity = this._scrub({ get: num(() => tr().opacity), set: setTr('opacity', 'Непрозрачность', (x, v) => (x.opacity = v)), min: 0, max: 100, step: 0.5, suffix: ' %' });
    const slider = h('input', { type: 'range', min: 0, max: 100, step: 0.5, value: staticValue(tr().opacity) });
    slider.addEventListener('input', () => setTr('opacity', 'Непрозрачность', (x, v) => (x.opacity = v))(Number(slider.value)));
    this._valueUpdaters.push(() => (slider.value = staticValue(tr().opacity)));
    this._section('opacity', 'Непрозрачность', [this._row('Непрозрачность', opacity, slider), this._row('Режим наложения', blend)], () =>
      this._edit(clip.id, 'Сбросить «Непрозрачность»', (c) => {
        c.transform.opacity = 100;
        c.transform.blend = 'normal';
      }, 'resetOpacity')
    );
  }

  _renderAudio(clip) {
    const get = () => findClip(store.seq, clip.id)?.clip || clip;
    const volDb = () => toDb(staticValue(get().audio.volume));
    const vol = this._scrub({
      get: volDb,
      set: (db) => this._edit(clip.id, 'Громкость', (c) => {
        if (isAnimated(c.audio.volume)) return false;
        c.audio.volume = fromDb(db);
      }, 'volume'),
      min: -96,
      max: 15,
      step: 0.1,
      suffix: ' дБ',
    });
    const pan = this._scrub({
      get: () => staticValue(get().audio.pan) * 100,
      set: (v) => this._edit(clip.id, 'Панорама', (c) => {
        if (isAnimated(c.audio.pan)) return false;
        c.audio.pan = v / 100;
      }, 'pan'),
      min: -100,
      max: 100,
      step: 1,
      digits: 0,
    });
    this._section('volume', 'Громкость', [this._row('Уровень', vol), this._row('Панорама (Л −100 … П +100)', pan)], () =>
      this._edit(clip.id, 'Сбросить громкость', (c) => {
        c.audio.volume = 1;
        c.audio.pan = 0;
      }, 'resetVol')
    );
  }

  _renderEffects(clip) {
    const rows = [];
    for (const e of clip.effects || []) {
      const def = plugins.effects.get(e.type);
      if (!def) {
        rows.push(h('div.note.warn', { style: 'padding:6px 26px' }, `Эффект «${e.type}» недоступен (плагин не загружен)`));
        continue;
      }
      const en = h('input', { type: 'checkbox', checked: e.enabled !== false, title: 'Включить эффект' });
      en.addEventListener('change', () => this._edit(clip.id, 'Включить эффект', (c) => (c.effects.find((x) => x.id === e.id).enabled = en.checked), 'fxen' + e.id));
      const del = h('button.icon-btn', { type: 'button', title: 'Удалить эффект' }, icon('trash'));
      del.addEventListener('click', () => {
        this._edit(clip.id, 'Удалить эффект', (c) => (c.effects = c.effects.filter((x) => x.id !== e.id)), 'fxdel' + e.id);
        this.render();
      });
      rows.push(h('div.fx-row', h('div.lbl', h('label.row', en, def.name)), h('div.val'), del));
      for (const p of def.params || []) rows.push(this._paramRow(clip, e, p));
    }
    if (!rows.length) rows.push(h('div.stage-note', 'Эффекты, переходы, титры и цветокоррекция подключаются плагинами (этап 2). Цепочка обработки уже встроена в движок: здесь появятся параметры эффектов клипа.'));
    this._section('effects', 'Эффекты', rows);
  }

  /** Универсальный редактор параметра плагина по схеме. */
  _paramRow(clip, effect, p) {
    const getE = () => findClip(store.seq, clip.id)?.clip.effects.find((x) => x.id === effect.id) || effect;
    const setV = (v) => this._edit(clip.id, p.label, (c) => {
      const e = c.effects.find((x) => x.id === effect.id);
      if (!e || isAnimated(e.params[p.key])) return false;
      e.params[p.key] = v;
    }, `fx:${effect.id}:${p.key}`);
    let ctl;
    if (p.type === 'number') ctl = this._scrub({ get: () => staticValue(getE().params[p.key]), set: setV, min: p.min ?? -Infinity, max: p.max ?? Infinity, step: p.step ?? 1, digits: p.digits ?? 1, suffix: p.unit ? ' ' + p.unit : '' });
    else if (p.type === 'select') {
      ctl = h('select', ...(p.options || []).map(([v, l]) => h('option', { value: v, selected: getE().params[p.key] === v }, l)));
      ctl.addEventListener('change', () => setV(ctl.value));
    } else if (p.type === 'checkbox') {
      ctl = h('input', { type: 'checkbox', checked: !!getE().params[p.key] });
      ctl.addEventListener('change', () => setV(ctl.checked));
    } else if (p.type === 'color') {
      ctl = h('input', { type: 'color', value: getE().params[p.key] || '#ffffff' });
      ctl.addEventListener('input', () => setV(ctl.value));
    } else {
      ctl = h('input', { type: 'text', value: getE().params[p.key] ?? '' });
      ctl.addEventListener('change', () => setV(ctl.value));
    }
    return this._row(p.label, ctl);
  }
}
