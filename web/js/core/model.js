// Модель данных проекта (JSON).
//
//  Project
//   ├─ media[]        — медиафайлы библиотеки (метаданные + ключ блоба в IndexedDB)
//   └─ sequences[]    — секвенции
//        ├─ tracks[]  — дорожки V1..Vn, A1..An
//        │    └─ clips[]   — клипы (ссылка на media.id или generator для этапа 2)
//        │         ├─ transform — «Движение»/«Непрозрачность» (как Effect Controls)
//        │         ├─ audio     — громкость/панорама
//        │         └─ effects[] — слот плагинов эффектов (этап 2)
//        ├─ transitions[] — слот переходов (этап 2)
//        └─ markers[]
//
// Любой числовой параметр (transform, effects, audio) может быть либо значением,
// либо объектом {kf:[...]} с ключевыми кадрами — см. core/keyframes.js.

import { uid } from './ids.js';

export const PROJECT_FORMAT = 'kadra-project';
export const PROJECT_VERSION = 1;

export const MEDIA_KIND = { VIDEO: 'video', AUDIO: 'audio', IMAGE: 'image' };
export const TRACK_KIND = { VIDEO: 'video', AUDIO: 'audio' };

export const BLEND_MODES = [
  ['normal', 'Обычный'],
  ['multiply', 'Умножение'],
  ['screen', 'Экран'],
  ['overlay', 'Перекрытие'],
  ['darken', 'Затемнение'],
  ['lighten', 'Осветление'],
  ['color-dodge', 'Осветление основы'],
  ['color-burn', 'Затемнение основы'],
  ['hard-light', 'Жёсткий свет'],
  ['soft-light', 'Мягкий свет'],
  ['difference', 'Разница'],
  ['exclusion', 'Исключение'],
  ['hue', 'Цветовой тон'],
  ['saturation', 'Насыщенность'],
  ['color', 'Цветность'],
  ['luminosity', 'Яркость'],
];

export const SCALING_MODES = [
  ['none', 'Без масштабирования'],
  ['fit', 'Вписать в кадр'],
  ['fill', 'Заполнить кадр'],
];

export function createProject(name = 'Без названия') {
  const seq = createSequence({ name: 'Секвенция 01' });
  const now = new Date().toISOString();
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    id: uid(),
    name,
    createdAt: now,
    updatedAt: now,
    media: [],
    sequences: [seq],
    activeSequenceId: seq.id,
    settings: {
      defaultImageDuration: 5, // сек — длительность неподвижных изображений
      defaultScaling: 'fit', // масштаб по умолчанию при размещении клипа
    },
    cloud: null, // {serverUrl, syncedAt} — заполняется при синхронизации с сервером
  };
}

export function createSequence({
  name = 'Секвенция',
  width = 1920,
  height = 1080,
  fps = 30,
  sampleRate = 48000,
  videoTracks = 3,
  audioTracks = 3,
} = {}) {
  const tracks = [];
  for (let i = 1; i <= videoTracks; i++) tracks.push(createTrack(TRACK_KIND.VIDEO, i));
  for (let i = 1; i <= audioTracks; i++) tracks.push(createTrack(TRACK_KIND.AUDIO, i));
  return {
    id: uid(),
    name,
    width,
    height,
    fps,
    sampleRate,
    tracks,
    markers: [],
    transitions: [], // этап 2: {id, type, trackId, at, duration, alignment, params}
    inPoint: null,
    outPoint: null,
    playhead: 0,
    masterVolume: 1,
  };
}

export function createTrack(kind, index) {
  return {
    id: uid(),
    kind,
    name: (kind === TRACK_KIND.VIDEO ? 'V' : 'A') + index,
    muted: false,
    solo: false,
    locked: false,
    hidden: false, // «глаз» видеодорожки
    volume: 1, // громкость дорожки (линейная), этап 2 — микшер
    pan: 0,
    effects: [], // слот эффектов дорожки (этап 2)
    height: kind === TRACK_KIND.VIDEO ? 54 : 50,
    clips: [],
  };
}

export function defaultTransform(width, height, srcW, srcH) {
  return {
    position: [width / 2, height / 2], // пиксели секвенции
    scale: 100, // %
    uniformScale: true,
    scaleWidth: 100, // % — используется, если uniformScale = false
    rotation: 0, // градусы
    anchor: [srcW / 2, srcH / 2], // пиксели исходника
    opacity: 100, // %
    blend: 'normal',
  };
}

/**
 * Клип на таймлайне.
 *  start — позиция на таймлайне (сек)
 *  in/out — диапазон исходника (сек); длительность на таймлайне = (out - in) / speed
 */
export function createClip({
  kind,
  mediaId = null,
  name = '',
  start = 0,
  inPoint = 0,
  outPoint = 5,
  linkId = null,
  seq,
  srcW = 1920,
  srcH = 1080,
  scaling = 'fit',
  generator = null,
}) {
  const clip = {
    id: uid(),
    kind, // 'video' | 'audio' — тип дорожки, на которой может лежать клип
    mediaId,
    name,
    start,
    in: inPoint,
    out: outPoint,
    speed: 1,
    enabled: true,
    linkId,
    label: null, // цветовая метка (опционально)
    effects: [], // этап 2: [{id, type, enabled, params}]
    generator, // этап 2: синтетический клип (титр/цвет): {type, params}
  };
  if (kind === TRACK_KIND.VIDEO) {
    clip.scaling = scaling;
    clip.transform = defaultTransform(seq?.width ?? 1920, seq?.height ?? 1080, srcW, srcH);
  } else {
    clip.audio = { volume: 1, pan: 0 };
  }
  return clip;
}

export function createMarker(time, { name = '', color = '#5bb974', comment = '', duration = 0 } = {}) {
  return { id: uid(), time, duration, name, color, comment };
}

export const MARKER_COLORS = ['#5bb974', '#e2574c', '#e8a33d', '#d9d14a', '#4fa3d1', '#5fc8c0', '#c06cc5', '#f2f2f2'];

// ---------- Вспомогательные вычисления ----------

export const clipDuration = (clip) => (clip.out - clip.in) / (clip.speed || 1);
export const clipEnd = (clip) => clip.start + clipDuration(clip);

/** Время исходника для момента t таймлайна. */
export function sourceTimeAt(clip, t) {
  return clip.in + (t - clip.start) * (clip.speed || 1);
}

export function sequenceDuration(seq) {
  let end = 0;
  for (const tr of seq.tracks) for (const c of tr.clips || []) end = Math.max(end, clipEnd(c));
  return end;
}

export function videoTracks(seq) {
  return seq.tracks.filter((t) => t.kind === TRACK_KIND.VIDEO);
}

export function audioTracks(seq) {
  return seq.tracks.filter((t) => t.kind === TRACK_KIND.AUDIO);
}

export function findClip(seq, clipId) {
  for (const track of seq.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { clip, track };
  }
  return null;
}

export function linkedClips(seq, clip) {
  if (!clip.linkId) return [clip];
  const out = [];
  for (const track of seq.tracks) for (const c of track.clips) if (c.linkId === clip.linkId) out.push(c);
  return out;
}

/** Нормализация/миграция проекта, загруженного из IDB, JSON или с сервера. */
export function normalizeProject(p) {
  if (!p || typeof p !== 'object') throw new Error('Некорректный файл проекта');
  if (p.format && p.format !== PROJECT_FORMAT) throw new Error('Файл не является проектом Kadra');
  if ((p.version ?? 1) > PROJECT_VERSION) throw new Error('Проект создан более новой версией редактора');
  p.format = PROJECT_FORMAT;
  p.version = PROJECT_VERSION;
  p.id ||= uid();
  p.name ||= 'Без названия';
  p.media ||= [];
  p.settings = { defaultImageDuration: 5, defaultScaling: 'fit', ...(p.settings || {}) };
  if (!Array.isArray(p.sequences) || !p.sequences.length) p.sequences = [createSequence({ name: 'Секвенция 01' })];
  for (const seq of p.sequences) {
    seq.markers ||= [];
    seq.transitions ||= [];
    seq.fps ||= 30;
    seq.sampleRate ||= 48000;
    seq.masterVolume ??= 1;
    seq.playhead ||= 0;
    for (const tr of seq.tracks) {
      tr.clips ||= [];
      tr.effects ||= [];
      tr.volume ??= 1;
      tr.pan ??= 0;
      tr.height ||= tr.kind === TRACK_KIND.VIDEO ? 54 : 50;
      for (const c of tr.clips) {
        c.speed ||= 1;
        c.effects ||= [];
        c.enabled ??= true;
        if (c.kind === TRACK_KIND.VIDEO) {
          c.scaling ||= 'fit';
          c.transform = { ...defaultTransform(seq.width, seq.height, 0, 0), ...(c.transform || {}) };
        } else {
          c.audio = { volume: 1, pan: 0, ...(c.audio || {}) };
        }
      }
      tr.clips.sort((a, b) => a.start - b.start);
    }
  }
  if (!p.sequences.find((s) => s.id === p.activeSequenceId)) p.activeSequenceId = p.sequences[0].id;
  for (const m of p.media) {
    m.markIn ??= null;
    m.markOut ??= null;
  }
  return p;
}
