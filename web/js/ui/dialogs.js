// Модальные окна, подтверждения, прогресс и уведомления.

import { h } from './dom.js';
import { Emitter } from '../core/events.js';

export const uiEvents = new Emitter(); // 'status' — сообщения строки состояния

let openModals = 0;
export const isModalOpen = () => openModals > 0;

/**
 * Модальное окно.
 * buttons: [{label, value, primary, danger, left}] — промис разрешается value.
 * Escape → null, Enter → value кнопки primary.
 */
export function modal({ title, body, buttons = [{ label: 'OK', value: true, primary: true }], wide = false, onMount, dismissible = true }) {
  return new Promise((resolve) => {
    openModals++;
    const close = (v) => {
      openModals--;
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      resolve(v);
    };
    const btns = buttons.map((b) =>
      h('button.btn', { class: [b.primary && 'primary', b.danger && 'danger', b.left && 'left'].filter(Boolean).join(' '), type: 'button', on: { click: async () => {
        if (b.validate && !(await b.validate())) return;
        close(typeof b.value === 'function' ? b.value() : b.value);
      } } }, b.label)
    );
    const dlg = h('div.modal', { class: wide ? 'wide' : '', role: 'dialog', 'aria-modal': 'true' },
      h('div.modal-head', h('div.grow', title), dismissible && h('button.icon-btn', { type: 'button', title: 'Закрыть', on: { click: () => close(null) }, html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6L6 18"/></svg>' })),
      h('div.modal-body', body),
      buttons.length ? h('div.modal-foot', btns) : null
    );
    const back = h('div.modal-backdrop', dlg);
    back.addEventListener('pointerdown', (e) => {
      if (e.target === back && dismissible) close(null);
    });
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissible) {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      } else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && !(e.target.tagName === 'BUTTON')) {
        const idx = buttons.findIndex((b) => b.primary);
        if (idx >= 0) {
          e.preventDefault();
          e.stopPropagation();
          btns[idx].click();
        }
      }
      e.stopPropagation(); // горячие клавиши редактора не срабатывают под модалкой
    };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(back);
    const ctl = { close, dialog: dlg, buttons: btns };
    onMount?.(ctl);
    const first = dlg.querySelector('input,select,textarea');
    if (first) setTimeout(() => first.focus(), 0);
  });
}

export async function confirmDialog(text, { title = 'Подтверждение', ok = 'OK', danger = false } = {}) {
  return !!(await modal({
    title,
    body: h('div', { style: 'line-height:1.6' }, text),
    buttons: [
      { label: 'Отмена', value: false },
      { label: ok, value: true, primary: !danger, danger },
    ],
  }));
}

export async function promptDialog(label, value = '', { title = 'Ввод', ok = 'OK' } = {}) {
  const input = h('input', { type: 'text', value, style: 'width:100%' });
  const res = await modal({
    title,
    body: h('div', h('div.note', { style: 'margin-bottom:8px' }, label), input),
    buttons: [
      { label: 'Отмена', value: null },
      { label: ok, value: () => input.value, primary: true },
    ],
    onMount: () => setTimeout(() => input.select(), 0),
  });
  return res;
}

export function alertDialog(text, title = 'Kadra') {
  return modal({ title, body: h('div', { style: 'line-height:1.6;white-space:pre-wrap' }, text) });
}

/** Окно прогресса. Возвращает {update(p, label, meta), close(), signal}. */
export function progressDialog(title, { cancellable = true } = {}) {
  const ctrl = new AbortController();
  const bar = h('div');
  const label = h('span', 'Подготовка…');
  const meta = h('span.mono', '');
  let closeFn;
  modal({
    title,
    body: h('div', h('div.progress', bar), h('div.progress-meta', label, meta)),
    buttons: cancellable ? [{ label: 'Отмена', value: 'cancel' }] : [],
    dismissible: false,
    onMount: (c) => (closeFn = c.close),
  }).then((v) => {
    if (v === 'cancel') ctrl.abort();
  });
  return {
    signal: ctrl.signal,
    update(p, text, m = '') {
      bar.style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 1000) / 10}%`;
      if (text != null) label.textContent = text;
      meta.textContent = m;
    },
    close() {
      closeFn?.(null);
    },
  };
}

export function toast(text, kind = 'info', ms = 3800) {
  const root = document.getElementById('toasts');
  if (!root) return;
  const el = h('div.toast', { class: kind }, text);
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, ms);
}

export function status(text, kind = 'info') {
  uiEvents.emit('status', { text, kind });
}

/** Сообщение об ошибке пользователю (и в консоль). */
export function reportError(err, prefix = 'Ошибка') {
  console.error(err);
  const msg = `${prefix}: ${err?.message || err}`;
  toast(msg, 'error', 6000);
  status(msg, 'error');
}
