// Реестр плагинов — точка расширения для ЭТАПА 2.
//
// Движок (compositor, audioEngine, exporter) и интерфейс (Effects, Effect Controls,
// диалог экспорта) уже работают с этим реестром. На этапе 1 он пуст, поэтому
// эффекты/переходы/титры не применяются, но цепочка обработки существует:
// подключение этапа 2 = регистрация плагинов в plugins/index.js.
//
// ── Видеоэффект ───────────────────────────────────────────────────────────────
// registerEffect({
//   type: 'blur',                       // уникальный id
//   name: 'Размытие по Гауссу',
//   category: 'Размытие и резкость',
//   target: 'video',                    // 'video' | 'audio'
//   params: [                            // схема — Effect Controls строит UI автоматически
//     { key: 'radius', label: 'Радиус', type: 'number', min: 0, max: 200, step: 0.1, default: 10, unit: 'px' },
//   ],
//   // Применение к кадру клипа. frame = { canvas, ctx, width, height } — слой клипа
//   // в пикселях исходника, ДО трансформации «Движение». Мутирует frame на месте
//   // (или возвращает новый canvas того же размера).
//   apply(frame, params, info) { ... },  // info = { time, localTime, clip, sequence, scale }
// })
//
// ── Аудиоэффект ──────────────────────────────────────────────────────────────
// registerEffect({ type: 'eq', target: 'audio', params: [...],
//   createNode(audioCtx, params, info) { return { input, output, update(params){} } } })
//
// ── Переход ───────────────────────────────────────────────────────────────────
// registerTransition({
//   type: 'cross-dissolve', name: 'Перекрёстное растворение', defaultDuration: 1,
//   params: [...],
//   // ctx — целевой контекст секвенции; a/b — полнокадровые слои уходящего и
//   // входящего клипов (с уже применёнными эффектами и «Движением»);
//   // progress — 0..1.
//   render(ctx, a, b, progress, params, info) { ... },
// })
//
// ── Генератор (титры, цветовая подложка) ─────────────────────────────────────
// registerGenerator({
//   type: 'text', name: 'Текст', params: [...],
//   size(params, sequence) { return [w, h]; },        // размер слоя
//   render(frame, params, info) { ... },               // рисует в frame.ctx
// })
//
// ── Пресет экспорта ──────────────────────────────────────────────────────────
// registerExportPreset({ id: 'yt-1080', name: 'YouTube 1080p', settings: { width: 1920, height: 1080, fps: 30, videoBitrate: 12e6, audioBitrate: 256e3, format: 'mp4' } })

import { Emitter } from '../core/events.js';

class Registry extends Emitter {
  constructor() {
    super();
    this.effects = new Map();
    this.transitions = new Map();
    this.generators = new Map();
    this.exportPresets = new Map();
  }

  _check(def, kind) {
    if (!def || typeof def.type !== 'string') throw new Error(`[plugins] ${kind}: нужен строковый type`);
  }

  registerEffect(def) {
    this._check(def, 'effect');
    if (def.target === 'audio' ? typeof def.createNode !== 'function' : typeof def.apply !== 'function') {
      throw new Error(`[plugins] эффект ${def.type}: нужна функция ${def.target === 'audio' ? 'createNode' : 'apply'}`);
    }
    this.effects.set(def.type, { target: 'video', category: 'Прочее', params: [], ...def });
    this.emit('change');
  }

  registerTransition(def) {
    this._check(def, 'transition');
    if (typeof def.render !== 'function') throw new Error(`[plugins] переход ${def.type}: нужна функция render`);
    this.transitions.set(def.type, { defaultDuration: 1, params: [], ...def });
    this.emit('change');
  }

  registerGenerator(def) {
    this._check(def, 'generator');
    if (typeof def.render !== 'function') throw new Error(`[plugins] генератор ${def.type}: нужна функция render`);
    this.generators.set(def.type, { params: [], ...def });
    this.emit('change');
  }

  registerExportPreset(def) {
    if (!def?.id) throw new Error('[plugins] пресет экспорта: нужен id');
    this.exportPresets.set(def.id, def);
    this.emit('change');
  }

  /** Значения параметров по умолчанию из схемы. */
  defaults(schema) {
    const out = {};
    for (const p of schema?.params || []) out[p.key] = structuredClone(p.default);
    return out;
  }

  /** Создать экземпляр эффекта для клипа. */
  instantiateEffect(type) {
    const def = this.effects.get(type);
    if (!def) return null;
    return { id: crypto.randomUUID(), type, enabled: true, params: this.defaults(def) };
  }
}

export const plugins = new Registry();
if (typeof window !== 'undefined') window.__kadraPlugins = plugins;
