// Собственный набор иконок (inline SVG, stroke = currentColor).

const P = {
  select: '<path d="M5 3l13 8-6 1.5L9 19z"/>',
  trackSelect: '<path d="M4 4l8 5-4 1-2 4z"/><path d="M13 13h7M13 17h7M16 10l4 3-4 3"/>',
  ripple: '<path d="M8 4v16"/><path d="M12 8l4 4-4 4"/><path d="M4 8v8"/><path d="M18 4v16"/>',
  razor: '<path d="M4 20L15 9"/><path d="M14 4l6 6-5 1-2-2z"/><circle cx="6.5" cy="17.5" r="1.2"/>',
  hand: '<path d="M8 12V6a1.5 1.5 0 013 0v5M11 11V4.5a1.5 1.5 0 013 0V11M14 11V6a1.5 1.5 0 013 0v7c0 4-2.5 7-6.5 7S5 17 4 14l-1-3a1.4 1.4 0 012.5-1.2L8 13"/>',
  zoom: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5M8 10.5h5M10.5 8v5"/>',
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="5" width="4" height="14" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" fill="currentColor" stroke="none"/>',
  stepBack: '<path d="M17 6v12l-9-6z" fill="currentColor" stroke="none"/><path d="M7 6v12"/>',
  stepFwd: '<path d="M7 6v12l9-6z" fill="currentColor" stroke="none"/><path d="M17 6v12"/>',
  toIn: '<path d="M5 5v14M9 12l9-7v14z"/>',
  toOut: '<path d="M19 5v14M15 12L6 5v14z"/>',
  markIn: '<path d="M9 4H6v16h3"/><path d="M13 12h6"/>',
  markOut: '<path d="M15 4h3v16h-3"/><path d="M5 12h6"/>',
  lift: '<path d="M4 18h16M12 14V4M8 8l4-4 4 4"/>',
  extract: '<path d="M4 18h6M14 18h6M12 14V4M8 8l4-4 4 4"/>',
  insert: '<path d="M4 18h16M12 4v10M8 10l4 4 4-4"/><path d="M4 14v4M20 14v4"/>',
  overwrite: '<rect x="4" y="14" width="16" height="5"/><path d="M12 3v9M8 8l4 4 4-4"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  snap: '<path d="M6 4v7a6 6 0 0012 0V4"/><path d="M6 8h4M14 8h4"/>',
  link: '<path d="M10 14a4 4 0 005.6 0l3-3a4 4 0 00-5.6-5.6l-1 1"/><path d="M14 10a4 4 0 00-5.6 0l-3 3a4 4 0 005.6 5.6l1-1"/>',
  marker: '<path d="M7 3h10v12l-5 5-5-5z"/>',
  eye: '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 6.1A10 10 0 0112 6c6.5 0 10 6 10 6a17 17 0 01-3.2 3.9M6.6 6.6C3.8 8.4 2 12 2 12s3.5 6.5 10 6.5c1.6 0 3-.4 4.2-1"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 017.5-2"/>',
  speaker: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 010 6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  grid: '<rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h1M4 12h1M4 18h1"/>',
  import: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v3h16v-3"/>',
  folder: '<path d="M3 6h7l2 2h9v11H3z"/>',
  newItem: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  reset: '<path d="M4 12a8 8 0 108-8H8"/><path d="M8 1v6h6" transform="translate(-2 0)"/>',
  chevron: '<path d="M8 10l4 4 4-4"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="1.5"/><path d="M16 10l5-3v10l-5-3"/>',
  audio: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><circle cx="9" cy="10" r="2"/><path d="M21 17l-6-6-9 9"/>',
  sequence: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 10h18M8 5v14"/>',
  cloud: '<path d="M7 18a4.5 4.5 0 01-.5-9A6 6 0 0118 9a4.5 4.5 0 01-1 9z"/>',
  maximize: '<path d="M4 9V4h5M20 15v5h-5M20 4l-6 6M4 20l6-6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  fx: '<path d="M6 19c2 0 2.5-2 3-5l1.5-7c.5-2.5 1.5-3 3-3M7 10h7"/><path d="M14 13l5 6M19 13l-5 6"/>',
};

export function icon(name, { size } = {}) {
  const span = document.createElement('span');
  span.style.display = 'contents';
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"${size ? ` width="${size}" height="${size}"` : ''}>${P[name] || ''}</svg>`;
  return span.firstElementChild;
}

export const LOGO_SVG =
  '<svg viewBox="0 0 32 32"><rect x="2" y="5" width="28" height="22" rx="5" fill="none" stroke="#f0a53a" stroke-width="2.2"/><path d="M11 10v12M11 16l8-6M13 15l7 7" stroke="#f0a53a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="24" cy="10" r="1.7" fill="#3fb7a7"/></svg>';
