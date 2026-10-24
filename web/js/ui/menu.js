// Выпадающие и контекстные меню.
// Элемент меню: { label, shortcut, action, checked, disabled, submenu:[...] } | '-' | {heading}

import { h, prettyKeys } from './dom.js';

let current = null;

export function closeMenus() {
  if (current) {
    current.close();
    current = null;
  }
}

function resolveItems(items) {
  return (typeof items === 'function' ? items() : items).filter(Boolean);
}

/** Открыть меню в точке (x, y) или под элементом anchor. */
export function openMenu(items, { x, y, anchor, onClose, keepOthers = false } = {}) {
  if (!keepOthers) closeMenus();
  const list = resolveItems(items);
  const el = h('div.dropdown', { role: 'menu' });
  let sub = null;
  const closeSub = () => {
    sub?.close();
    sub = null;
  };
  for (const it of list) {
    if (it === '-') {
      el.appendChild(h('div.sep'));
      continue;
    }
    if (it.heading) {
      el.appendChild(h('div.heading', it.heading));
      continue;
    }
    const disabled = typeof it.disabled === 'function' ? it.disabled() : it.disabled;
    const checked = typeof it.checked === 'function' ? it.checked() : it.checked;
    const row = h('div.item', { class: disabled ? 'disabled' : '', role: 'menuitem' },
      checked ? h('span.check', '✓') : null,
      h('span.label', it.label),
      it.submenu ? h('span.arrow', '›') : h('span.shortcut', prettyKeys(it.shortcut || ''))
    );
    row.addEventListener('pointerenter', () => {
      if (it.submenu) {
        closeSub();
        const r = row.getBoundingClientRect();
        sub = openMenu(it.submenu, { x: r.right - 2, y: r.top - 4, keepOthers: true });
        row.classList.add('hot');
        sub.el.addEventListener('pointerleave', () => {});
      } else {
        closeSub();
        el.querySelectorAll('.item.hot').forEach((n) => n.classList.remove('hot'));
      }
    });
    if (!it.submenu) {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenus();
        if (!disabled) it.action?.();
      });
    }
    el.appendChild(row);
  }
  document.body.appendChild(el);
  // позиционирование с учётом краёв экрана
  let px = x;
  let py = y;
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    px = r.left;
    py = r.bottom + 2;
  }
  const mw = el.offsetWidth;
  const mh = el.offsetHeight;
  if (px + mw > innerWidth - 4) px = Math.max(4, innerWidth - mw - 4);
  if (py + mh > innerHeight - 4) py = Math.max(4, innerHeight - mh - 4);
  el.style.left = px + 'px';
  el.style.top = py + 'px';

  const api = {
    el,
    close() {
      closeSub();
      el.remove();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', esc, true);
      onClose?.();
    },
  };
  const outside = (e) => {
    if (!e.target.closest('.dropdown') && !e.target.closest('.menu-btn')) closeMenus();
  };
  const esc = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeMenus();
    }
  };
  if (!keepOthers) {
    setTimeout(() => {
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', esc, true);
    }, 0);
    current = api;
  } else {
    const parentClose = current?.close;
    if (current) {
      current.close = () => {
        api.close();
        parentClose?.call(current);
      };
    }
  }
  return api;
}

export function contextMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  return openMenu(items, { x: e.clientX, y: e.clientY });
}
