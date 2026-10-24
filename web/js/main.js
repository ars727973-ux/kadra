// Точка входа Kadra: сборка панелей, раскладки, меню и запуск проекта.

import { App } from './app.js';
import { store } from './core/store.js';
import { loadBuiltinPlugins } from './plugins/index.js';
import { DockLayout } from './ui/layout.js';
import { ProjectPanel } from './ui/panels/projectPanel.js';
import { SourceMonitor } from './ui/panels/sourceMonitor.js';
import { ProgramMonitor } from './ui/panels/programMonitor.js';
import { TimelinePanel } from './ui/panels/timeline.js';
import { EffectControlsPanel } from './ui/panels/effectControls.js';
import { EffectsPanel, MetersPanel, ToolsPanel, HistoryPanel, MarkersPanel } from './ui/panels/smallPanels.js';
import { reportError } from './ui/dialogs.js';

async function main() {
  // Плагины этапа 2 регистрируются до построения интерфейса
  loadBuiltinPlugins();

  const app = new App();
  window.__kadraApp = app; // для отладки и e2e-тестов

  const panels = [
    new ProjectPanel(app),
    new SourceMonitor(app),
    new ProgramMonitor(app),
    new TimelinePanel(app),
    new EffectControlsPanel(app),
    new EffectsPanel(app),
    new MetersPanel(app),
    new ToolsPanel(app),
    new HistoryPanel(app),
    new MarkersPanel(app),
  ];
  for (const p of panels) app.panels.set(p.id, p);
  app.timeline = app.panels.get('timeline');

  app.layout = new DockLayout(document.getElementById('workspace'), app.panels);
  app.defineActions();
  app.buildMenubar(document.getElementById('menubar'));
  app.bindStatusbar(document.getElementById('statusbar'));
  app.bindKeys();
  app.bindFileDrop();
  app.layout.init();
  await app.boot();
  store.setFocus('timeline');
  document.documentElement.dataset.ready = '1';
}

window.addEventListener('error', (e) => console.error('[kadra]', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => console.error('[kadra] unhandled', e.reason));

main().catch((err) => {
  reportError(err, 'Запуск');
});
