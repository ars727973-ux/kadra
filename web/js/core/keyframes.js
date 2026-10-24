// Ключевые кадры параметров.
//
// Параметр может быть статическим значением (число, массив чисел, строка)
// или анимированным: { kf: [{ t, v, ease }] }, где t — время относительно
// начала клипа (сек, по таймлайну), ease — 'linear' | 'hold' | 'ease'.
//
// На этапе 1 интерфейс задаёт только статические значения, но рендерер и
// аудиодвижок уже вызывают resolveParam() для каждого кадра — поэтому
// анимация (этап 2) подключается без изменения движка.

export function isAnimated(p) {
  return !!p && typeof p === 'object' && !Array.isArray(p) && Array.isArray(p.kf);
}

const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

function lerp(a, b, k) {
  if (Array.isArray(a)) return a.map((av, i) => av + ((b?.[i] ?? av) - av) * k);
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * k;
  return k < 1 ? a : b; // строки/булевы — ступенчато
}

/** Значение параметра в локальный момент времени клипа. */
export function resolveParam(p, localTime) {
  if (!isAnimated(p)) return p;
  const kf = p.kf;
  if (!kf.length) return p.value;
  if (localTime <= kf[0].t) return kf[0].v;
  const last = kf[kf.length - 1];
  if (localTime >= last.t) return last.v;
  for (let i = 0; i < kf.length - 1; i++) {
    const a = kf[i];
    const b = kf[i + 1];
    if (localTime >= a.t && localTime < b.t) {
      if (a.ease === 'hold') return a.v;
      let k = (localTime - a.t) / (b.t - a.t);
      if (a.ease === 'ease') k = easeInOut(k);
      return lerp(a.v, b.v, k);
    }
  }
  return last.v;
}

/** Удобство: разрешить все параметры объекта. */
export function resolveAll(params, localTime) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) out[k] = resolveParam(v, localTime);
  return out;
}

/** Статическое значение для UI (если параметр анимирован — значение в момент t). */
export function staticValue(p, localTime = 0) {
  return resolveParam(p, localTime);
}
