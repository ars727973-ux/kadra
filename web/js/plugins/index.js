// Точка подключения плагинов.
//
// ЭТАП 1: встроенных эффектов, переходов и титров нет — реестр пуст.
// ЭТАП 2: создать файлы в plugins/builtin/ (например transitions.js, color.js,
// text.js, audio.js) и импортировать их здесь, например:
//
//   import './builtin/transitions.js';   // cross dissolve, dip to black/white, wipe, slide
//   import './builtin/text.js';          // титры
//   import './builtin/color.js';         // цветокоррекция
//   import './builtin/blur.js';          // blur / sharpen / chroma key
//   import './builtin/audio.js';         // эквалайзер, fade
//
// Каждый файл вызывает plugins.register*() — изменения движка не требуются.

import { plugins } from './registry.js';

export { plugins };

export function loadBuiltinPlugins() {
  // этап 1: пусто
  return plugins;
}
