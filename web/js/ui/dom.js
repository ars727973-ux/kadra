// Мини-хелперы DOM без фреймворка.

/**
 * h('div.cls#id', {attrs, on:{click}}, ...children)
 * Атрибуты: class, style (строка/объект), dataset, on, html, прочие → setAttribute/свойство.
 */
export function h(tag, attrs, ...children) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    if (attrs != null) children.unshift(attrs);
    attrs = {};
  }
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag);
  const el = document.createElement(m?.[1] || 'div');
  if (m?.[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g) || []) {
      if (part[0] === '.') el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style') typeof v === 'string' ? (el.style.cssText = v) : Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Холст с учётом devicePixelRatio. Возвращает ctx, уже масштабированный. */
export function fitCanvas(canvas, w, h) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.max(1, Math.round(w * dpr));
  const H = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** Слушатель с автоматической отпиской: возвращает функцию отмены. */
export function listen(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  return () => target.removeEventListener(type, fn, opts);
}

/** Перетаскивание указателем: onMove(dx, dy, e), onUp(e). */
export function dragPointer(e, { onMove, onUp, cursor } = {}) {
  const sx = e.clientX;
  const sy = e.clientY;
  const target = e.currentTarget || e.target;
  try {
    target.setPointerCapture?.(e.pointerId);
  } catch {
    /* */
  }
  if (cursor) document.body.style.cursor = cursor;
  const move = (ev) => onMove?.(ev.clientX - sx, ev.clientY - sy, ev);
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (cursor) document.body.style.cursor = '';
    onUp?.(ev, ev.clientX - sx, ev.clientY - sy);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Отображение сочетания клавиш: 'Mod+Shift+K' → 'Ctrl+Shift+K' / '⌘⇧K'. */
export function prettyKeys(combo) {
  if (!combo) return '';
  return combo
    .split(' / ')
    .map((c) =>
      c
        .split('+')
        .map((k) => {
          if (k === 'Mod') return isMac ? '⌘' : 'Ctrl';
          if (k === 'Alt') return isMac ? '⌥' : 'Alt';
          if (k === 'Shift') return isMac ? '⇧' : 'Shift';
          if (k === 'Space') return 'Пробел';
          if (k === 'Left') return '←';
          if (k === 'Right') return '→';
          if (k === 'Up') return '↑';
          if (k === 'Down') return '↓';
          if (k === 'Delete') return 'Del';
          if (k === 'Backspace') return isMac ? '⌫' : 'Backspace';
          return k;
        })
        .join(isMac ? '' : '+')
    )
    .join(' / ');
}

/** Выбрать файлы через системный диалог. */
export function pickFiles({ accept = '', multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, style: 'display:none' });
    input.addEventListener('change', () => {
      resolve([...input.files]);
      input.remove();
    });
    // если пользователь закрыл диалог — промис просто не разрешится; это нормально
    document.body.appendChild(input);
    input.click();
  });
}
