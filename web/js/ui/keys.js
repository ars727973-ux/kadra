// Клавиатурные сокращения. Используется e.code (физическая клавиша), поэтому
// сочетания работают при любой раскладке (в т.ч. русской: «J/K/L» = «О/Л/Д»).

const CODE_NAMES = {
  Space: 'Space',
  Equal: '=',
  Minus: '-',
  Backslash: '\\',
  IntlBackslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Backquote: '`',
  Delete: 'Delete',
  Backspace: 'Backspace',
  Home: 'Home',
  End: 'End',
  Enter: 'Enter',
  Escape: 'Escape',
  Slash: '/',
  BracketLeft: '[',
  BracketRight: ']',
  Tab: 'Tab',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  NumpadAdd: '+',
  NumpadSubtract: '-',
  NumpadEnter: 'Enter',
  NumpadDecimal: '.',
};

export function keyName(e) {
  const c = e.code || '';
  if (c.startsWith('Key')) return c.slice(3);
  if (c.startsWith('Digit')) return c.slice(5);
  if (c.startsWith('Arrow')) return c.slice(5);
  if (CODE_NAMES[c]) return CODE_NAMES[c];
  if (c.startsWith('Numpad')) return c.slice(6);
  if (/^F\d+$/.test(c)) return c;
  return (e.key || '').length === 1 ? e.key.toUpperCase() : e.key;
}

export function comboFromEvent(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(keyName(e));
  return parts.join('+');
}

/** 'Mod+Shift+K / Mod+Y' → нормализованные варианты. */
export function parseShortcut(s) {
  if (!s) return [];
  return s.split(' / ').map((c) => {
    const keys = c.split('+');
    const key = keys.pop() || '+';
    const mods = new Set(keys);
    return [mods.has('Mod') && 'Mod', mods.has('Alt') && 'Alt', mods.has('Shift') && 'Shift', key].filter(Boolean).join('+');
  });
}

export function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || el.isContentEditable) return true;
  if (tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const t = (el.type || 'text').toLowerCase();
    return !['checkbox', 'radio', 'range', 'button', 'color'].includes(t);
  }
  return false;
}
