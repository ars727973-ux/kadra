// Определение активных слоёв кадра: какие клипы (и переходы) видны в момент t.
// Используется и превью (Program Monitor), и экспортом — поэтому результат
// рендера в превью и в файле совпадает.

import { clipEnd, sourceTimeAt, TRACK_KIND } from '../core/model.js';
import { plugins } from '../plugins/registry.js';

const T_EPS = 1e-7;

/** Клип на дорожке в момент t (start <= t < end). Клипы отсортированы по start. */
export function clipAt(track, t) {
  const clips = track.clips;
  let lo = 0;
  let hi = clips.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = clips[mid];
    if (c.start > t + T_EPS) hi = mid - 1;
    else if (clipEnd(c) <= t + T_EPS) lo = mid + 1;
    else return c;
  }
  return null;
}

/** Время исходника, ограниченное диапазоном клипа (или «ручками» медиа — для переходов). */
export function clampedSourceTime(clip, t, media, allowHandles = false) {
  const st = sourceTimeAt(clip, t);
  if (allowHandles) {
    const max = media && media.kind !== 'image' && Number.isFinite(media.duration) ? media.duration - 1e-3 : Infinity;
    return Math.min(Math.max(0, st), max);
  }
  return Math.min(Math.max(clip.in, st), clip.out - 1e-4);
}

/** Границы перехода на таймлайне. */
export function transitionRange(tr) {
  const d = tr.duration;
  if (tr.alignment === 'start') return [tr.at, tr.at + d];
  if (tr.alignment === 'end') return [tr.at - d, tr.at];
  return [tr.at - d / 2, tr.at + d / 2];
}

/**
 * Активные видеослои в момент t, снизу (V1) вверх.
 * Обычный слой: { kind:'clip', track, clip, media, sourceTime, localTime }
 * Переход (этап 2): { kind:'transition', track, transition, def, progress, a, b }
 *   где a/b — обычные слои уходящего/входящего клипа (или null).
 */
export function activeVideoLayers(project, seq, t, getMedia) {
  const layers = [];
  const transitions = seq.transitions || [];
  for (const track of seq.tracks) {
    if (track.kind !== TRACK_KIND.VIDEO || track.hidden) continue;

    // --- переходы (слот этапа 2) ---
    let handled = false;
    for (const tr of transitions) {
      if (tr.trackId !== track.id) continue;
      const def = plugins.transitions.get(tr.type);
      if (!def) continue; // не зарегистрирован — обычная склейка
      const [a, b] = transitionRange(tr);
      if (t < a - T_EPS || t >= b - T_EPS) continue;
      const out = track.clips.find((c) => Math.abs(clipEnd(c) - tr.at) < 1e-4);
      const inc = track.clips.find((c) => Math.abs(c.start - tr.at) < 1e-4);
      const mk = (c) =>
        c && c.enabled
          ? { kind: 'clip', track, clip: c, media: getMedia(c.mediaId), sourceTime: clampedSourceTime(c, t, getMedia(c.mediaId), true), localTime: t - c.start }
          : null;
      layers.push({ kind: 'transition', track, transition: tr, def, progress: (t - a) / (b - a), a: mk(out), b: mk(inc) });
      handled = true;
      break;
    }
    if (handled) continue;

    const clip = clipAt(track, t);
    if (!clip || !clip.enabled) continue;
    const media = clip.mediaId ? getMedia(clip.mediaId) : null;
    if (!media && !clip.generator) continue;
    layers.push({ kind: 'clip', track, clip, media, sourceTime: clampedSourceTime(clip, t, media), localTime: t - clip.start });
  }
  return layers;
}

/** Развернуть слои в список «клиповых» слоёв (включая клипы внутри переходов). */
export function flattenClipLayers(layers) {
  const out = [];
  for (const l of layers) {
    if (l.kind === 'clip') out.push(l);
    else {
      if (l.a) out.push(l.a);
      if (l.b) out.push(l.b);
    }
  }
  return out;
}

/** Ближайшие клипы, которые начнутся в окне (t, t+window] — для предзагрузки. */
export function upcomingClips(seq, t, window = 2) {
  const out = [];
  for (const track of seq.tracks) {
    if (track.kind !== TRACK_KIND.VIDEO || track.hidden) continue;
    for (const c of track.clips) if (c.enabled && c.start > t && c.start <= t + window) out.push(c);
  }
  return out;
}
