// Работа со временем: кадровая сетка, таймкод HH:MM:SS:FF.
// Внутри проекта время хранится в секундах (float), но все правки
// квантуются по кадрам секвенции, чтобы избежать дрейфа.

export const EPS = 1e-6;

/** Округлить время до ближайшего кадра. */
export function snapToFrame(t, fps) {
  return Math.round(t * fps) / fps;
}

/** Время → номер кадра. */
export function toFrame(t, fps) {
  return Math.round(t * fps + EPS);
}

/** Номер кадра → время. */
export function fromFrame(f, fps) {
  return f / fps;
}

/** Время в секундах → кадр, на котором находится момент t (floor). */
export function frameAt(t, fps) {
  return Math.floor(t * fps + EPS);
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Форматирование таймкода HH:MM:SS:FF. */
export function formatTC(t, fps) {
  const fr = Math.round(fps);
  let f = Math.max(0, toFrame(t, fps));
  const ff = f % fr;
  f = Math.floor(f / fr);
  const ss = f % 60;
  f = Math.floor(f / 60);
  const mm = f % 60;
  const hh = Math.floor(f / 60);
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

/**
 * Разбор таймкода как в Premiere: можно ввести «1:00:00:00», «10:12»,
 * или просто цифры «1000» (= 00:00:10:00). Префикс «+»/«-» — относительный сдвиг.
 * Возвращает {value, relative} или null.
 */
export function parseTC(str, fps) {
  if (str == null) return null;
  let s = String(str).trim();
  if (!s) return null;
  let sign = 0;
  if (s[0] === '+' || s[0] === '-') {
    sign = s[0] === '+' ? 1 : -1;
    s = s.slice(1);
  }
  let parts;
  if (/[:;.]/.test(s)) {
    parts = s.split(/[:;.]/).map((p) => parseInt(p || '0', 10));
  } else {
    const digits = s.replace(/\D/g, '');
    if (!digits) return null;
    // «1000» → [10, 00]; разбиваем по 2 цифры справа налево
    parts = [];
    for (let i = digits.length; i > 0; i -= 2) {
      parts.unshift(parseInt(digits.slice(Math.max(0, i - 2), i), 10));
    }
  }
  if (parts.some((p) => Number.isNaN(p))) return null;
  while (parts.length < 4) parts.unshift(0);
  const [hh, mm, ss, ff] = parts.slice(-4);
  const value = hh * 3600 + mm * 60 + ss + ff / Math.round(fps);
  return { value: sign ? sign * value : value, relative: sign !== 0 };
}

/** Короткая длительность для библиотеки: 1:05, 1:02:03. */
export function formatDuration(sec) {
  if (!Number.isFinite(sec)) return '—';
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  while (bytes >= 1024 && i < u.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(i ? 1 : 0)} ${u[i]}`;
}

/** Поддерживаемые частоты кадров секвенции (целые — для точного таймкода). */
export const SEQUENCE_FPS = [24, 25, 30, 50, 60];
