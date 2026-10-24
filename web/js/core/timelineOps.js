// Операции над таймлайном (вызываются внутри store.mutate — становятся
// отменяемыми командами). Все функции чистые по отношению к UI: принимают
// секвенцию/проект и мутируют их.

import { uid } from './ids.js';
import { EPS, snapToFrame } from './time.js';
import { clipDuration, clipEnd, createClip, createMarker, createTrack, findClip, TRACK_KIND } from './model.js';

const q = (seq, t) => snapToFrame(t, seq.fps);

/** Бесконечный ли исходник (изображение, генератор). */
export function isUnlimited(media, clip) {
  return !!clip?.generator || !media || media.kind === 'image';
}

export function mediaLength(media, clip) {
  return isUnlimited(media, clip) ? Infinity : media.duration;
}

function setEnd(c, t) {
  c.out = c.in + (t - c.start) * c.speed;
}

function setStart(c, t) {
  c.in = c.in + (t - c.start) * c.speed;
  c.start = t;
}

/** Детерминированный linkId для правой части разрезанного клипа:
 *  связанные видео+аудио, разрезанные в одной точке, остаются связанными. */
function splitLinkId(linkId, t) {
  return linkId ? `${linkId.split('@')[0]}@${Math.round(t * 1000)}` : null;
}

function cloneClip(c) {
  const n = structuredClone(c);
  n.id = uid();
  return n;
}

/** Удалить «висячие» связи (linkId, встречающийся у одного клипа). */
export function pruneLinks(seq) {
  const count = new Map();
  for (const t of seq.tracks) for (const c of t.clips) if (c.linkId) count.set(c.linkId, (count.get(c.linkId) || 0) + 1);
  for (const t of seq.tracks) for (const c of t.clips) if (c.linkId && count.get(c.linkId) < 2) c.linkId = null;
}

/**
 * Очистить диапазон [a, b) на дорожке (режим overwrite).
 * Клипы, пересекающие границы, обрезаются; охватывающий — разрезается.
 */
export function clearRange(seq, track, a, b, exclude = new Set()) {
  if (track.locked || b - a < EPS) return;
  const out = [];
  for (const c of track.clips) {
    if (exclude.has(c.id)) {
      out.push(c);
      continue;
    }
    const s = c.start;
    const e = clipEnd(c);
    if (e <= a + EPS || s >= b - EPS) {
      out.push(c);
    } else if (s >= a - EPS && e <= b + EPS) {
      // полностью внутри — удаляется
    } else if (s < a && e > b) {
      const right = cloneClip(c);
      right.linkId = splitLinkId(c.linkId, b);
      setStart(right, b);
      setEnd(c, a);
      out.push(c, right);
    } else if (s < a) {
      setEnd(c, a);
      out.push(c);
    } else {
      setStart(c, b);
      out.push(c);
    }
  }
  track.clips = out.sort((x, y) => x.start - y.start);
}

/** Вставить пустое место длительностью dur в точке at (ripple insert) на дорожках. */
export function insertSpace(seq, at, dur, tracks = seq.tracks) {
  if (dur <= EPS) return;
  for (const track of tracks) {
    if (track.locked) continue;
    // разрезаем клип, пересекающий точку вставки
    for (const c of [...track.clips]) {
      if (c.start < at - EPS && clipEnd(c) > at + EPS) splitClip(seq, track, c, at);
    }
    for (const c of track.clips) if (c.start >= at - EPS) c.start = q(seq, c.start + dur);
  }
}

/**
 * Убрать пространство [at, at+dur) со сдвигом последующих клипов влево.
 * Дорожка сдвигается только если в диапазоне на ней нет клипов (иначе — конфликт).
 */
export function removeSpace(seq, at, dur, tracks = seq.tracks) {
  if (dur <= EPS) return;
  const end = at + dur;
  for (const track of tracks) {
    if (track.locked) continue;
    const blocked = track.clips.some((c) => c.start < end - EPS && clipEnd(c) > at + EPS);
    if (blocked) continue;
    for (const c of track.clips) if (c.start >= end - EPS) c.start = q(seq, c.start - dur);
  }
}

/** Разрезать клип в момент t. Возвращает правую часть. */
export function splitClip(seq, track, clip, t) {
  t = q(seq, t);
  if (t <= clip.start + EPS || t >= clipEnd(clip) - EPS) return null;
  const right = cloneClip(clip);
  right.linkId = splitLinkId(clip.linkId, t);
  setStart(right, t);
  setEnd(clip, t);
  const idx = track.clips.indexOf(clip);
  track.clips.splice(idx + 1, 0, right);
  return right;
}

/**
 * Лезвие: разрезать в момент t.
 *  clipIds — конкретные клипы (с учётом связанных), иначе — все клипы под t
 *  на дорожках trackIds (или всех незаблокированных).
 */
export function razor(seq, t, { clipIds = null, trackIds = null, linked = true } = {}) {
  t = q(seq, t);
  const targets = [];
  const ids = new Set(clipIds || []);
  if (clipIds && linked) {
    for (const id of clipIds) {
      const f = findClip(seq, id);
      if (f?.clip.linkId) for (const tr of seq.tracks) for (const c of tr.clips) if (c.linkId === f.clip.linkId) ids.add(c.id);
    }
  }
  for (const track of seq.tracks) {
    if (track.locked) continue;
    if (trackIds && !trackIds.includes(track.id)) continue;
    for (const c of track.clips) {
      if (clipIds && !ids.has(c.id)) continue;
      if (c.start < t - EPS && clipEnd(c) > t + EPS) targets.push([track, c]);
    }
  }
  const created = [];
  for (const [track, c] of targets) {
    const r = splitClip(seq, track, c, t);
    if (r) created.push(r);
  }
  return created;
}

/**
 * Разместить медиа на таймлайне (из Project / Source Monitor).
 * mode: 'overwrite' | 'insert'. Возвращает id созданных клипов.
 */
export function placeMedia(
  seq,
  project,
  media,
  { at, videoTrackId, audioTrackId, inPoint = null, outPoint = null, mode = 'overwrite', takeVideo = true, takeAudio = true }
) {
  at = q(seq, Math.max(0, at));
  const unlimited = media.kind === 'image';
  const srcIn = inPoint ?? media.markIn ?? 0;
  let srcOut = outPoint ?? media.markOut ?? (unlimited ? project.settings.defaultImageDuration : media.duration);
  if (!unlimited) srcOut = Math.min(srcOut, media.duration);
  const dur = q(seq, srcOut - srcIn);
  if (dur <= EPS) return [];

  const vTrack = seq.tracks.find((t) => t.id === videoTrackId && t.kind === TRACK_KIND.VIDEO);
  const aTrack = seq.tracks.find((t) => t.id === audioTrackId && t.kind === TRACK_KIND.AUDIO);
  const wantV = takeVideo && media.hasVideo && vTrack && !vTrack.locked;
  const wantA = takeAudio && media.hasAudio && aTrack && !aTrack.locked;
  if (!wantV && !wantA) return [];

  if (mode === 'insert') insertSpace(seq, at, dur);
  else {
    if (wantV) clearRange(seq, vTrack, at, at + dur);
    if (wantA) clearRange(seq, aTrack, at, at + dur);
  }
  const linkId = wantV && wantA ? uid('lnk') : null;
  const created = [];
  const common = { name: media.name, start: at, inPoint: srcIn, outPoint: srcIn + dur, linkId, seq };
  if (wantV) {
    const c = createClip({
      ...common,
      kind: TRACK_KIND.VIDEO,
      mediaId: media.id,
      srcW: media.width || seq.width,
      srcH: media.height || seq.height,
      scaling: project.settings.defaultScaling,
    });
    vTrack.clips.push(c);
    created.push(c.id);
  }
  if (wantA) {
    const c = createClip({ ...common, kind: TRACK_KIND.AUDIO, mediaId: media.id });
    aTrack.clips.push(c);
    created.push(c.id);
  }
  return created;
}

/**
 * Переместить клипы. moves: [{clipId, start, trackId}].
 * mode 'overwrite' — перекрываемые клипы обрезаются (как в Premiere по умолчанию);
 * mode 'insert' — в месте вставки раздвигаются все дорожки (Ctrl+перетаскивание).
 */
export function moveClips(seq, moves, { mode = 'overwrite' } = {}) {
  const items = [];
  for (const m of moves) {
    const f = findClip(seq, m.clipId);
    if (!f) continue;
    const dest = seq.tracks.find((t) => t.id === (m.trackId || f.track.id));
    if (!dest || dest.kind !== f.track.kind || dest.locked || f.track.locked) continue;
    items.push({ clip: f.clip, from: f.track, dest, start: q(seq, Math.max(0, m.start)) });
  }
  if (!items.length) return false;
  // 1. снимаем клипы с исходных дорожек
  for (const it of items) it.from.clips = it.from.clips.filter((c) => c !== it.clip);
  // 2. освобождаем место
  if (mode === 'insert') {
    const a = Math.min(...items.map((i) => i.start));
    const b = Math.max(...items.map((i) => i.start + clipDuration(i.clip)));
    insertSpace(seq, a, b - a);
  } else {
    for (const it of items) clearRange(seq, it.dest, it.start, it.start + clipDuration(it.clip));
  }
  // 3. ставим клипы
  for (const it of items) {
    it.clip.start = it.start;
    it.dest.clips.push(it.clip);
    it.dest.clips.sort((x, y) => x.start - y.start);
  }
  return true;
}

/** Соседи клипа на дорожке. */
export function neighbours(track, clip) {
  const sorted = track.clips.filter((c) => c !== clip).sort((a, b) => a.start - b.start);
  let prevEnd = 0;
  let nextStart = Infinity;
  for (const c of sorted) {
    if (clipEnd(c) <= clip.start + EPS) prevEnd = Math.max(prevEnd, clipEnd(c));
    if (c.start >= clipEnd(clip) - EPS) nextStart = Math.min(nextStart, c.start);
  }
  return { prevEnd, nextStart };
}

/**
 * Ограничения для триммирования края клипа.
 * Возвращает допустимое время края [min, max] на таймлайне.
 */
export function trimLimits(seq, project, track, clip, edge, { ripple = false } = {}) {
  const media = project.media.find((m) => m.id === clip.mediaId);
  const len = mediaLength(media, clip);
  const frame = 1 / seq.fps;
  const { prevEnd, nextStart } = neighbours(track, clip);
  if (edge === 'start') {
    // Начало: не раньше начала исходника; не позже конца минус 1 кадр.
    // Обычный трим дополнительно ограничен соседом слева и нулём таймлайна.
    // При ripple-триме позиция клипа не меняется (меняется in), сосед не мешает.
    const byMedia = isUnlimited(media, clip) ? -Infinity : clip.start - clip.in / clip.speed;
    const min = ripple ? byMedia : Math.max(prevEnd, byMedia, 0);
    return { min, max: clipEnd(clip) - frame };
  }
  const byMedia = clip.start + (len - clip.in) / clip.speed;
  const max = ripple ? byMedia : Math.min(nextStart, byMedia);
  return { min: clip.start + frame, max };
}

/**
 * Триммировать край клипа до времени time.
 * edge: 'start' | 'end'. ripple — последующие клипы сдвигаются (инструмент Ripple Edit).
 * linked — синхронно триммировать связанные клипы с выровненным краем.
 */
export function trimClip(seq, project, clipId, edge, time, { ripple = false, linked = true } = {}) {
  const f = findClip(seq, clipId);
  if (!f || f.track.locked) return false;
  const { clip, track } = f;
  time = q(seq, time);
  const group = [[clip, track]];
  if (linked && clip.linkId) {
    const edgeTime = edge === 'start' ? clip.start : clipEnd(clip);
    for (const tr of seq.tracks) {
      for (const c of tr.clips) {
        if (c === clip || c.linkId !== clip.linkId || tr.locked) continue;
        const e = edge === 'start' ? c.start : clipEnd(c);
        if (Math.abs(e - edgeTime) < EPS * 10) group.push([c, tr]);
      }
    }
  }
  // общий допустимый диапазон для всей группы
  let lo = -Infinity;
  let hi = Infinity;
  for (const [c, tr] of group) {
    const lim = trimLimits(seq, project, tr, c, edge, { ripple });
    lo = Math.max(lo, lim.min);
    hi = Math.min(hi, lim.max);
  }
  time = Math.min(Math.max(time, lo), hi);
  if (!Number.isFinite(time)) return false;

  const origEnd = clipEnd(clip);
  const origStart = clip.start;
  let delta = 0;
  for (const [c] of group) {
    const media = project.media.find((m) => m.id === c.mediaId);
    if (edge === 'start') {
      if (ripple) {
        // начало остаётся на месте, сдвигается in; хвост дорожек сдвигается
        delta = origStart - time; // >0 — клип стал длиннее
        let newIn = c.in - delta * c.speed;
        if (newIn < 0 && isUnlimited(media, c)) {
          c.out -= newIn;
          newIn = 0;
        }
        c.in = Math.max(0, newIn);
      } else {
        let newIn = c.in + (time - c.start) * c.speed;
        if (newIn < 0 && isUnlimited(media, c)) {
          c.out -= newIn; // у изображений «исходник» бесконечен
          newIn = 0;
        }
        c.in = newIn;
        c.start = time;
      }
    } else {
      setEnd(c, time);
      delta = time - origEnd;
    }
  }
  if (ripple && Math.abs(delta) > EPS) {
    // сдвигаем всё, что начиналось после исходного конца клипа
    const pivot = origEnd;
    const groupClips = new Set(group.map(([c]) => c));
    for (const tr of seq.tracks) {
      if (tr.locked) continue;
      for (const c of tr.clips) if (!groupClips.has(c) && c.start >= pivot - EPS) c.start = q(seq, c.start + delta);
    }
  }
  return true;
}

/** Удалить клипы. ripple=true — сдвинуть последующие (Ripple Delete). */
export function deleteClips(seq, ids, { ripple = false } = {}) {
  const idSet = new Set(ids);
  const ranges = [];
  for (const tr of seq.tracks) {
    if (tr.locked) continue;
    for (const c of tr.clips) if (idSet.has(c.id)) ranges.push([c.start, clipEnd(c)]);
    tr.clips = tr.clips.filter((c) => !idSet.has(c.id));
  }
  if (!ranges.length) return false;
  if (ripple) {
    // объединяем пересекающиеся диапазоны и удаляем пространство справа налево
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1] + EPS) last[1] = Math.max(last[1], r[1]);
      else merged.push([...r]);
    }
    for (const [a, b] of merged.reverse()) removeSpace(seq, a, b - a);
  }
  pruneLinks(seq);
  return true;
}

/** Найти промежуток (gap) на дорожке в момент t. */
export function gapAt(track, t) {
  let prevEnd = 0;
  let nextStart = Infinity;
  for (const c of track.clips) {
    if (c.start <= t + EPS && clipEnd(c) > t + EPS) return null; // под t есть клип
    if (clipEnd(c) <= t + EPS) prevEnd = Math.max(prevEnd, clipEnd(c));
    if (c.start > t + EPS) nextStart = Math.min(nextStart, c.start);
  }
  if (!Number.isFinite(nextStart)) return null;
  return { start: prevEnd, end: nextStart };
}

/** Ripple Delete промежутка. */
export function rippleDeleteGap(seq, trackId, t) {
  const track = seq.tracks.find((x) => x.id === trackId);
  if (!track || track.locked) return false;
  const gap = gapAt(track, t);
  if (!gap) return false;
  const len = gap.end - gap.start;
  // сдвигаем все дорожки, где диапазон свободен
  removeSpace(seq, gap.start, len);
  return true;
}

/** Lift (;) — убрать содержимое диапазона, оставив пустоту. */
export function liftRange(seq, a, b, trackIds = null) {
  if (b - a < EPS) return false;
  for (const tr of seq.tracks) if (!trackIds || trackIds.includes(tr.id)) clearRange(seq, tr, a, b);
  pruneLinks(seq);
  return true;
}

/** Extract (') — убрать содержимое диапазона и сомкнуть. */
export function extractRange(seq, a, b, trackIds = null) {
  if (b - a < EPS) return false;
  const tracks = seq.tracks.filter((t) => !trackIds || trackIds.includes(t.id));
  for (const tr of tracks) clearRange(seq, tr, a, b);
  removeSpace(seq, a, b - a, seq.tracks);
  pruneLinks(seq);
  return true;
}

/** Все точки монтажа (края клипов) секвенции. */
export function editPoints(seq, { trackIds = null } = {}) {
  const pts = new Set([0]);
  for (const tr of seq.tracks) {
    if (trackIds && !trackIds.includes(tr.id)) continue;
    for (const c of tr.clips) {
      pts.add(q(seq, c.start));
      pts.add(q(seq, clipEnd(c)));
    }
  }
  return [...pts].sort((a, b) => a - b);
}

/** Q / W: ripple-триммирование предыдущей/следующей точки монтажа до плейхеда. */
export function rippleTrimToPlayhead(seq, t, direction) {
  const pts = editPoints(seq);
  if (direction === 'prev') {
    const prev = [...pts].reverse().find((p) => p < t - EPS);
    if (prev === undefined) return null;
    extractRange(seq, prev, t);
    return prev;
  }
  const next = pts.find((p) => p > t + EPS);
  if (next === undefined) return null;
  extractRange(seq, t, next);
  return t;
}

/** Скопировать клипы в буфер обмена (структура не зависит от id дорожек). */
export function copyClips(seq, ids) {
  const idSet = new Set(ids);
  const vTracks = seq.tracks.filter((t) => t.kind === TRACK_KIND.VIDEO);
  const aTracks = seq.tracks.filter((t) => t.kind === TRACK_KIND.AUDIO);
  const items = [];
  for (const tr of seq.tracks) {
    for (const c of tr.clips) {
      if (!idSet.has(c.id)) continue;
      const list = tr.kind === TRACK_KIND.VIDEO ? vTracks : aTracks;
      items.push({ clip: structuredClone(c), kind: tr.kind, trackIndex: list.indexOf(tr) });
    }
  }
  if (!items.length) return null;
  const start = Math.min(...items.map((i) => i.clip.start));
  const end = Math.max(...items.map((i) => clipEnd(i.clip)));
  const minV = Math.min(...items.filter((i) => i.kind === TRACK_KIND.VIDEO).map((i) => i.trackIndex), Infinity);
  const minA = Math.min(...items.filter((i) => i.kind === TRACK_KIND.AUDIO).map((i) => i.trackIndex), Infinity);
  for (const it of items) {
    it.offset = it.clip.start - start;
    it.relTrack = it.trackIndex - (it.kind === TRACK_KIND.VIDEO ? minV : minA);
  }
  return { items, span: end - start };
}

/**
 * Вставить из буфера в момент at на целевые дорожки.
 * mode: 'overwrite' (Ctrl+V) | 'insert' (Ctrl+Shift+V).
 */
export function pasteClips(seq, clipboard, at, { videoTrackId, audioTrackId, mode = 'overwrite' } = {}) {
  if (!clipboard?.items?.length) return [];
  at = q(seq, at);
  const vTracks = seq.tracks.filter((t) => t.kind === TRACK_KIND.VIDEO);
  const aTracks = seq.tracks.filter((t) => t.kind === TRACK_KIND.AUDIO);
  const vBase = Math.max(0, vTracks.findIndex((t) => t.id === videoTrackId));
  const aBase = Math.max(0, aTracks.findIndex((t) => t.id === audioTrackId));
  // при нехватке дорожек — добавляем
  for (const it of clipboard.items) {
    const list = it.kind === TRACK_KIND.VIDEO ? vTracks : aTracks;
    const idx = (it.kind === TRACK_KIND.VIDEO ? vBase : aBase) + it.relTrack;
    while (list.length <= idx) {
      const t = createTrack(it.kind, list.length + 1);
      list.push(t);
      seq.tracks.push(t);
    }
  }
  seq.tracks.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === TRACK_KIND.VIDEO ? -1 : 1));
  if (mode === 'insert') insertSpace(seq, at, clipboard.span);
  const linkMap = new Map();
  const created = [];
  for (const it of clipboard.items) {
    const list = it.kind === TRACK_KIND.VIDEO ? vTracks : aTracks;
    const track = list[(it.kind === TRACK_KIND.VIDEO ? vBase : aBase) + it.relTrack];
    if (!track || track.locked) continue;
    const c = structuredClone(it.clip);
    c.id = uid();
    if (c.linkId) {
      if (!linkMap.has(c.linkId)) linkMap.set(c.linkId, uid('lnk'));
      c.linkId = linkMap.get(c.linkId);
    }
    c.start = q(seq, at + it.offset);
    if (mode !== 'insert') clearRange(seq, track, c.start, c.start + clipDuration(c));
    track.clips.push(c);
    created.push(c.id);
  }
  pruneLinks(seq);
  return created;
}

/** Скорость/длительность клипа (Ctrl+R). */
export function setClipSpeed(seq, project, clipId, speed, { ripple = false, linked = true } = {}) {
  speed = Math.min(100, Math.max(0.01, speed));
  const f = findClip(seq, clipId);
  if (!f) return false;
  const group = linked && f.clip.linkId ? seq.tracks.flatMap((t) => t.clips.filter((c) => c.linkId === f.clip.linkId).map((c) => [c, t])) : [[f.clip, f.track]];
  for (const [c, tr] of group) {
    const oldEnd = clipEnd(c);
    c.speed = speed;
    let newEnd = clipEnd(c);
    if (!ripple) {
      const { nextStart } = neighbours(tr, c);
      if (newEnd > nextStart + EPS) {
        // не перекрываем следующий клип — укорачиваем исходный диапазон
        setEnd(c, nextStart);
        newEnd = nextStart;
      }
    } else {
      const d = newEnd - oldEnd;
      for (const c2 of tr.clips) if (c2 !== c && c2.start >= oldEnd - EPS) c2.start = q(seq, c2.start + d);
    }
    c.out = Math.max(c.in + 1 / seq.fps, c.out);
  }
  return true;
}

/** Связать / разъединить клипы (Ctrl+L). */
export function toggleLink(seq, ids) {
  const clips = ids.map((id) => findClip(seq, id)?.clip).filter(Boolean);
  if (!clips.length) return false;
  const allLinked = clips.every((c) => c.linkId && c.linkId === clips[0].linkId);
  if (allLinked || clips.some((c) => c.linkId)) {
    for (const c of clips) c.linkId = null;
  } else {
    const id = uid('lnk');
    for (const c of clips) c.linkId = id;
  }
  pruneLinks(seq);
  return true;
}

// ---------- маркеры ----------

export function addMarker(seq, time, opts = {}) {
  const m = createMarker(q(seq, time), opts);
  seq.markers.push(m);
  seq.markers.sort((a, b) => a.time - b.time);
  return m;
}

export function updateMarker(seq, id, patch) {
  const m = seq.markers.find((x) => x.id === id);
  if (!m) return false;
  Object.assign(m, patch);
  if (patch.time != null) m.time = q(seq, Math.max(0, patch.time));
  seq.markers.sort((a, b) => a.time - b.time);
  return true;
}

export function deleteMarker(seq, id) {
  const n = seq.markers.length;
  seq.markers = seq.markers.filter((m) => m.id !== id);
  return seq.markers.length !== n;
}

// ---------- дорожки ----------

export function addTracks(seq, kind, count = 1) {
  for (let i = 0; i < count; i++) {
    const n = seq.tracks.filter((t) => t.kind === kind).length + 1;
    seq.tracks.push(createTrack(kind, n));
  }
  seq.tracks.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === TRACK_KIND.VIDEO ? -1 : 1));
}

export function deleteTrack(seq, trackId) {
  const tr = seq.tracks.find((t) => t.id === trackId);
  if (!tr) return false;
  if (seq.tracks.filter((t) => t.kind === tr.kind).length <= 1) return false;
  seq.tracks = seq.tracks.filter((t) => t !== tr);
  // переименуем по порядку
  let v = 0;
  let a = 0;
  for (const t of seq.tracks) t.name = t.kind === TRACK_KIND.VIDEO ? `V${++v}` : `A${++a}`;
  pruneLinks(seq);
  return true;
}
