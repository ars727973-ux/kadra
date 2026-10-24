// Контроллер приложения: действия (меню + горячие клавиши), жизненный цикл
// проекта, диалоги. Все пункты меню и сочетания клавиш описаны один раз в
// таблице действий ниже.

import { store } from './core/store.js';
import { createProject, createSequence, sequenceDuration, findClip, clipEnd, TRACK_KIND, MARKER_COLORS } from './core/model.js';
import { formatTC, parseTC, snapToFrame, formatBytes, SEQUENCE_FPS, EPS } from './core/time.js';
import * as ops from './core/timelineOps.js';
import { transport } from './engine/transport.js';
import { exportSequence, exportRange, detectEncoders, ExportAborted } from './engine/exporter.js';
import { activeVideoLayers } from './engine/layers.js';
import { mediaCache } from './media/mediaCache.js';
import { importFiles, relinkMedia, removeMedia } from './media/importer.js';
import { ACCEPT_ATTR } from './media/probe.js';
import { saveProject, loadProject, listProjects, deleteProject, lastProjectId, exportProjectJSON, readProjectJSON, downloadBlob, safeFileName, Autosave } from './storage/projectStore.js';
import { storageEstimate, requestPersistence } from './storage/idb.js';
import { cloud, cloudSettings, setCloudSettings, saveProjectToCloud, openProjectFromCloud } from './storage/cloud.js';
import { plugins } from './plugins/registry.js';
import { h, pickFiles, prettyKeys } from './ui/dom.js';
import { modal, confirmDialog, promptDialog, progressDialog, toast, status, reportError, uiEvents, isModalOpen, alertDialog } from './ui/dialogs.js';
import { openMenu, closeMenus } from './ui/menu.js';
import { comboFromEvent, parseShortcut, isTypingTarget } from './ui/keys.js';
import { icon, LOGO_SVG } from './ui/icons.js';

export const APP_NAME = 'Kadra';
export const APP_VERSION = '1.0.0';

export class App {
  constructor() {
    this.actions = new Map();
    this.keymap = new Map();
    this.panels = new Map();
    this.layout = null;
    this.autosave = null;
  }

  // =====================================================================
  // Действия
  // =====================================================================

  defineActions() {
    const A = (id, label, shortcut, run, opts = {}) => this.actions.set(id, { id, label, shortcut, run, ...opts });
    const seq = () => store.seq;
    const fps = () => store.seq.fps;
    const src = () => this.panels.get('source');
    const sourceFocused = () => store.ui.focusedPanel === 'source' && !!src().media;
    const hasSel = () => store.ui.selection.size > 0;

    // --- Файл ---
    A('file.new', 'Новый проект', 'Mod+Alt+N', () => this.newProject());
    A('file.open', 'Открыть проект…', 'Mod+O', () => this.projectManager());
    A('file.save', 'Сохранить', 'Mod+S', () => this.save(true));
    A('file.saveAs', 'Сохранить как…', 'Mod+Shift+S', () => this.saveAs());
    A('file.rename', 'Переименовать проект…', null, () => this.renameProject());
    A('file.newSequence', 'Новая секвенция…', 'Mod+N / Alt+N', () => this.newSequenceDialog());
    A('file.import', 'Импорт медиа…', 'Mod+I', async () => this.importFiles(await pickFiles({ accept: ACCEPT_ATTR })));
    A('file.exportJson', 'Экспорт проекта (.json)', null, () => {
      this._syncPlayhead();
      exportProjectJSON(store.project);
      toast('Файл проекта сохранён. Медиафайлы в JSON не входят — при открытии на другом устройстве их нужно будет связать.', 'info', 6000);
    });
    A('file.importJson', 'Импорт проекта (.json)…', null, () => this.importProjectJson());
    A('file.exportMedia', 'Экспорт видео…', 'Mod+M', () => this.exportDialog());
    A('file.exportFrame', 'Экспорт кадра (PNG)', 'Mod+Shift+E', () => this.exportFrame());
    A('file.projectSettings', 'Параметры проекта…', null, () => this.projectSettingsDialog());
    A('cloud.settings', 'Сервер и вход…', null, () => this.serverDialog());
    A('cloud.save', 'Сохранить на сервер', null, () => this.cloudSave());
    A('cloud.open', 'Открыть с сервера…', null, () => this.cloudOpen());

    // --- Правка ---
    A('edit.undo', 'Отменить', 'Mod+Z', () => {
      const c = store.history.undo();
      if (c) status(`Отменено: ${c.label}`);
    }, { label2: () => (store.history.canUndo() ? `Отменить «${store.history.undoStack.at(-1).label}»` : 'Отменить'), enabled: () => store.history.canUndo() });
    A('edit.redo', 'Повторить', 'Mod+Shift+Z / Mod+Y', () => {
      const c = store.history.redo();
      if (c) status(`Повторено: ${c.label}`);
    }, { label2: () => (store.history.canRedo() ? `Повторить «${store.history.redoStack.at(-1).label}»` : 'Повторить'), enabled: () => store.history.canRedo() });
    A('edit.cut', 'Вырезать', 'Mod+X', () => {
      if (!hasSel()) return;
      store.ui.clipboard = ops.copyClips(seq(), [...store.ui.selection]);
      store.mutate('Вырезать', (p, s) => ops.deleteClips(s, [...store.ui.selection]));
    }, { enabled: hasSel });
    A('edit.copy', 'Копировать', 'Mod+C', () => {
      if (!hasSel()) return;
      store.ui.clipboard = ops.copyClips(seq(), [...store.ui.selection]);
      status(`Скопировано клипов: ${store.ui.selection.size}`);
    }, { enabled: hasSel });
    A('edit.paste', 'Вставить', 'Mod+V', () => this._paste('overwrite'), { enabled: () => !!store.ui.clipboard });
    A('edit.pasteInsert', 'Вставить со сдвигом', 'Mod+Shift+V', () => this._paste('insert'), { enabled: () => !!store.ui.clipboard });
    A('edit.clear', 'Удалить', 'Delete / Backspace', () => this._clear(false));
    A('edit.rippleDelete', 'Удалить со сдвигом', 'Shift+Delete / Alt+Backspace / Shift+Backspace', () => this._clear(true), { enabled: hasSel });
    A('edit.selectAll', 'Выделить всё', 'Mod+A', () => {
      if (store.ui.focusedPanel === 'project') {
        store.ui.projectSelection = new Set(store.project.media.map((m) => m.id));
        this.panels.get('project').render();
      } else {
        const ids = [];
        for (const t of seq().tracks) if (!t.locked) for (const c of t.clips) ids.push(c.id);
        store.select(ids, 'set');
      }
    });
    A('edit.deselectAll', 'Снять выделение', 'Mod+Shift+A', () => store.clearSelection());
    A('edit.shortcuts', 'Сочетания клавиш…', 'Mod+Alt+K', () => this.shortcutsDialog());

    // --- Клип ---
    A('clip.speed', 'Скорость/длительность…', 'Mod+R', () => this.speedDialog(), { enabled: hasSel });
    A('clip.enable', 'Включить/выключить', 'Shift+E', () => {
      const clips = store.selectedClips();
      if (!clips.length) return;
      const on = !clips.every((c) => c.clip.enabled);
      store.mutate(on ? 'Включить клип' : 'Выключить клип', (p, s) => {
        for (const { clip } of clips) findClip(s, clip.id).clip.enabled = on;
      });
    }, { enabled: hasSel });
    A('clip.link', 'Связать/разъединить', 'Mod+L', () => store.mutate('Связь клипов', (p, s) => ops.toggleLink(s, [...store.ui.selection])), { enabled: hasSel });
    A('clip.rename', 'Переименовать клип…', null, async () => {
      const c = store.selectedClips()[0]?.clip;
      if (!c) return;
      const name = await promptDialog('Имя клипа', c.name);
      if (name != null) store.mutate('Переименовать клип', (p, s) => (findClip(s, c.id).clip.name = name.trim() || c.name));
    }, { enabled: hasSel });
    A('clip.nudgeLeft', 'Сдвинуть на кадр влево', 'Alt+Left', () => this._nudge(-1), { enabled: hasSel });
    A('clip.nudgeRight', 'Сдвинуть на кадр вправо', 'Alt+Right', () => this._nudge(1), { enabled: hasSel });
    A('clip.matchFrame', 'Совпадение кадра (в источник)', 'F', () => this._matchFrame());
    A('clip.scaleFit', 'Вписать в кадр', null, () => this.setScaling('fit'), { enabled: hasSel });
    A('clip.scaleFill', 'Заполнить кадр', null, () => this.setScaling('fill'), { enabled: hasSel });
    A('clip.scaleNone', 'Без масштабирования', null, () => this.setScaling('none'), { enabled: hasSel });

    // --- Секвенция ---
    A('sequence.settings', 'Параметры секвенции…', null, () => this.sequenceSettingsDialog());
    A('sequence.addEdit', 'Добавить монтажную склейку', 'Mod+K', () => {
      const t = store.ui.playhead;
      store.mutate('Склейка', (p, s) => {
        const sel = [...store.ui.selection];
        const r = sel.length ? ops.razor(s, t, { clipIds: sel, linked: store.ui.linkedSelection }) : ops.razor(s, t);
        return r.length > 0;
      });
    });
    A('sequence.addEditAll', 'Склейка на всех дорожках', 'Mod+Shift+K', () => store.mutate('Склейка на всех дорожках', (p, s) => ops.razor(s, store.ui.playhead).length > 0));
    A('sequence.lift', 'Поднять (In→Out)', ';', () => this._liftExtract(false));
    A('sequence.extract', 'Извлечь (In→Out)', "'", () => this._liftExtract(true));
    A('sequence.rippleTrimPrev', 'Ripple-обрезка начала до плейхеда', 'Q', () => {
      let at = null;
      store.mutate('Ripple-обрезка начала', (p, s) => {
        at = ops.rippleTrimToPlayhead(s, store.ui.playhead, 'prev');
        return at != null;
      });
      if (at != null) store.setPlayhead(at);
    });
    A('sequence.rippleTrimNext', 'Ripple-обрезка конца до плейхеда', 'W', () => store.mutate('Ripple-обрезка конца', (p, s) => ops.rippleTrimToPlayhead(s, store.ui.playhead, 'next') != null));
    A('sequence.snap', 'Прилипание', 'S', () => {
      store.setUi('snapping', !store.ui.snapping);
      status(store.ui.snapping ? 'Прилипание включено' : 'Прилипание выключено');
    }, { checked: () => store.ui.snapping });
    A('sequence.linkedSelection', 'Связанное выделение', null, () => store.setUi('linkedSelection', !store.ui.linkedSelection), { checked: () => store.ui.linkedSelection });
    A('sequence.zoomIn', 'Увеличить', '= / Shift+= / +', () => this.timeline.zoomBy(1.5));
    A('sequence.zoomOut', 'Уменьшить', '-', () => this.timeline.zoomBy(1 / 1.5));
    A('sequence.zoomFit', 'Вся секвенция', '\\', () => this.timeline.zoomToFit());
    A('sequence.addTracks', 'Добавить дорожки…', null, () => this.addTracksDialog());
    A('sequence.nextEdit', 'К следующей точке монтажа', 'Down', () => this._gotoEdit(1));
    A('sequence.prevEdit', 'К предыдущей точке монтажа', 'Up', () => this._gotoEdit(-1));
    A('source.insert', 'Вставка из источника', ',', () => this._fromSource('insert'));
    A('source.overwrite', 'Наложение из источника', '.', () => this._fromSource('overwrite'));

    // --- Маркеры и In/Out ---
    A('marker.add', 'Добавить маркер', 'M', () => this.addMarker());
    A('marker.next', 'К следующему маркеру', 'Shift+M', () => this._gotoMarker(1));
    A('marker.prev', 'К предыдущему маркеру', 'Mod+Shift+M', () => this._gotoMarker(-1));
    A('marker.edit', 'Изменить маркер…', null, () => {
      const m = this._markerAtPlayhead() || store.seq.markers.find((x) => x.id === store.ui.selectedMarkerId);
      if (m) this.editMarker(m.id);
    });
    A('marker.clear', 'Удалить текущий маркер', 'Mod+Alt+M', () => {
      const m = store.seq.markers.find((x) => x.id === store.ui.selectedMarkerId) || this._markerAtPlayhead();
      if (m) store.mutate('Удалить маркер', (p, s) => ops.deleteMarker(s, m.id));
    });
    A('marker.clearAll', 'Удалить все маркеры', 'Mod+Alt+Shift+M', () => store.mutate('Удалить все маркеры', (p, s) => {
      if (!s.markers.length) return false;
      s.markers = [];
    }));
    A('mark.in', 'Отметить вход', 'I', () => (sourceFocused() ? src().markIn() : this._setInOut('inPoint', store.ui.playhead)));
    A('mark.out', 'Отметить выход', 'O', () => (sourceFocused() ? src().markOut() : this._setInOut('outPoint', store.ui.playhead + 1 / fps())));
    A('mark.clip', 'Отметить клип', 'X', () => this._markClip());
    A('mark.goIn', 'Перейти к входу', 'Shift+I', () => {
      if (sourceFocused()) return src().goIn();
      if (seq().inPoint != null) transport.seek(seq().inPoint);
    });
    A('mark.goOut', 'Перейти к выходу', 'Shift+O', () => {
      if (sourceFocused()) return src().goOut();
      if (seq().outPoint != null) transport.seek(seq().outPoint - 1 / fps());
    });
    A('mark.clearIn', 'Очистить вход', 'Mod+Shift+I', () => (sourceFocused() ? src().clearIn() : this._setInOut('inPoint', null)));
    A('mark.clearOut', 'Очистить выход', 'Mod+Shift+O', () => (sourceFocused() ? src().clearOut() : this._setInOut('outPoint', null)));
    A('mark.clearInOut', 'Очистить вход и выход', 'Mod+Shift+X', () => {
      if (sourceFocused()) {
        src().clearIn();
        src().clearOut();
        return;
      }
      store.mutate('Очистить вход и выход', (p, s) => {
        if (s.inPoint == null && s.outPoint == null) return false;
        s.inPoint = null;
        s.outPoint = null;
      });
    });

    // --- Воспроизведение ---
    A('play.toggle', 'Воспроизведение/стоп', 'Space', () => (sourceFocused() ? src().togglePlay() : transport.toggle()));
    A('play.inToOut', 'Воспроизвести от входа до выхода', 'Mod+Shift+Space', () => {
      const s = seq();
      if (s.inPoint == null && s.outPoint == null) return transport.toggle();
      store.setPlayhead(s.inPoint ?? 0);
      transport.play(1, { stopAt: s.outPoint ?? Infinity });
    });
    A('play.shuttleL', 'Вперёд (L)', 'L', () => (sourceFocused() ? src().shuttle(1) : transport.shuttle(1)), { norepeat: true });
    A('play.shuttleJ', 'Назад (J)', 'J', () => (sourceFocused() ? src().shuttle(-1) : transport.shuttle(-1)), { norepeat: true });
    A('play.shuttleK', 'Стоп (K)', 'K', () => (sourceFocused() ? src().shuttle(0) : transport.shuttle(0)));
    A('play.stepBack', 'Кадр назад', 'Left', () => (sourceFocused() ? src().step(-1) : this._step(-1)));
    A('play.stepFwd', 'Кадр вперёд', 'Right', () => (sourceFocused() ? src().step(1) : this._step(1)));
    A('play.step5Back', '5 кадров назад', 'Shift+Left', () => (sourceFocused() ? src().step(-5) : this._step(-5)));
    A('play.step5Fwd', '5 кадров вперёд', 'Shift+Right', () => (sourceFocused() ? src().step(5) : this._step(5)));
    A('play.home', 'В начало', 'Home', () => (sourceFocused() ? src().home() : (transport.seek(0), this.timeline.revealPlayhead())));
    A('play.end', 'В конец', 'End', () => (sourceFocused() ? src().end() : (transport.seek(sequenceDuration(seq())), this.timeline.revealPlayhead())));

    // --- Инструменты ---
    A('tool.select', 'Выделение', 'V', () => store.setTool('select'), { checked: () => store.ui.tool === 'select' });
    A('tool.trackSelect', 'Выделение дорожки вперёд', 'A', () => store.setTool('trackSelect'), { checked: () => store.ui.tool === 'trackSelect' });
    A('tool.ripple', 'Ripple-редактирование', 'B', () => store.setTool('ripple'), { checked: () => store.ui.tool === 'ripple' });
    A('tool.razor', 'Лезвие', 'C', () => store.setTool('razor'), { checked: () => store.ui.tool === 'razor' });
    A('tool.hand', 'Рука', 'H', () => store.setTool('hand'), { checked: () => store.ui.tool === 'hand' });
    A('tool.zoom', 'Масштаб', 'Z', () => store.setTool('zoom'), { checked: () => store.ui.tool === 'zoom' });

    // --- Окно ---
    const panelAction = (pid, key) => A(`window.${pid}`, this.panels.get(pid).title, key, () => this.layout.showPanel(pid), { checked: () => this.layout.isOpen(pid) });
    panelAction('project', 'Shift+1');
    panelAction('source', 'Shift+2');
    panelAction('timeline', 'Shift+3');
    panelAction('program', 'Shift+4');
    panelAction('effectControls', 'Shift+5');
    panelAction('effects', 'Shift+7');
    panelAction('meters', 'Shift+6');
    panelAction('markers', null);
    panelAction('history', null);
    panelAction('tools', null);
    A('window.maximize', 'Развернуть панель', '`', () => this.layout.toggleMaximize());
    A('window.reset', 'Сбросить раскладку', null, () => this.layout.reset());
    A('window.fullscreen', 'Полноэкранный режим', null, () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.()));

    // --- Справка ---
    A('help.about', `О программе ${APP_NAME}`, null, () => this.aboutDialog());

    // карта клавиш
    for (const a of this.actions.values()) for (const c of parseShortcut(a.shortcut)) this.keymap.set(c, a.id);
  }

  run(id) {
    const a = this.actions.get(id);
    if (!a) return console.warn('Нет действия', id);
    if (a.enabled && !a.enabled()) return;
    try {
      const r = a.run();
      if (r?.catch) r.catch((err) => reportError(err));
    } catch (err) {
      reportError(err);
    }
  }

  // =====================================================================
  // Меню
  // =====================================================================

  menus() {
    const m = (id, extra = {}) => {
      const a = this.actions.get(id);
      return { label: a.label2 ? a.label2() : a.label, shortcut: a.shortcut, action: () => this.run(id), disabled: a.enabled ? () => !a.enabled() : false, checked: a.checked, ...extra };
    };
    return [
      ['Файл', () => [
        m('file.new'), m('file.open'), m('file.newSequence'), '-',
        m('file.save'), m('file.saveAs'), m('file.rename'), '-',
        m('file.import'), '-',
        m('file.exportMedia'), m('file.exportFrame'), '-',
        m('file.exportJson'), m('file.importJson'), '-',
        { heading: 'Сервер (необязательно)' }, m('cloud.settings'), m('cloud.save'), m('cloud.open'), '-',
        m('file.projectSettings'),
      ]],
      ['Правка', () => [
        m('edit.undo'), m('edit.redo'), '-',
        m('edit.cut'), m('edit.copy'), m('edit.paste'), m('edit.pasteInsert'), '-',
        m('edit.clear'), m('edit.rippleDelete'), '-',
        m('edit.selectAll'), m('edit.deselectAll'), '-',
        m('edit.shortcuts'),
      ]],
      ['Клип', () => [
        m('clip.speed'), m('clip.enable'), m('clip.link'), m('clip.rename'), '-',
        { label: 'Масштаб по кадру', submenu: [m('clip.scaleFit'), m('clip.scaleFill'), m('clip.scaleNone')] },
        m('clip.nudgeLeft'), m('clip.nudgeRight'), '-',
        m('clip.matchFrame'),
      ]],
      ['Секвенция', () => [
        m('sequence.settings'), '-',
        m('sequence.addEdit'), m('sequence.addEditAll'), '-',
        m('sequence.lift'), m('sequence.extract'), m('sequence.rippleTrimPrev'), m('sequence.rippleTrimNext'), '-',
        m('source.insert'), m('source.overwrite'), '-',
        m('sequence.zoomIn'), m('sequence.zoomOut'), m('sequence.zoomFit'), '-',
        m('sequence.snap'), m('sequence.linkedSelection'), '-',
        m('sequence.addTracks'),
      ]],
      ['Маркеры', () => [
        m('mark.in'), m('mark.out'), m('mark.clip'), '-',
        m('mark.goIn'), m('mark.goOut'), '-',
        m('mark.clearIn'), m('mark.clearOut'), m('mark.clearInOut'), '-',
        m('marker.add'), m('marker.edit'), m('marker.next'), m('marker.prev'), m('marker.clear'), m('marker.clearAll'),
      ]],
      ['Воспроизведение', () => [
        m('play.toggle'), m('play.inToOut'), '-',
        m('play.shuttleJ'), m('play.shuttleK'), m('play.shuttleL'), '-',
        m('play.stepBack'), m('play.stepFwd'), m('play.step5Back'), m('play.step5Fwd'), '-',
        m('play.home'), m('play.end'), m('sequence.prevEdit'), m('sequence.nextEdit'), '-',
        { heading: 'Инструменты' }, m('tool.select'), m('tool.trackSelect'), m('tool.ripple'), m('tool.razor'), m('tool.hand'), m('tool.zoom'),
      ]],
      ['Окно', () => [
        m('window.project'), m('window.source'), m('window.timeline'), m('window.program'), m('window.effectControls'), m('window.effects'), m('window.meters'), m('window.markers'), m('window.history'), m('window.tools'), '-',
        m('window.maximize'), m('window.fullscreen'), m('window.reset'),
      ]],
      ['Справка', () => [m('edit.shortcuts'), m('help.about')]],
    ];
  }

  buildMenubar(root) {
    root.innerHTML = '';
    const brand = h('div.brand', { html: LOGO_SVG }, h('span', APP_NAME.toUpperCase()));
    root.appendChild(brand);
    let openIdx = -1;
    const btns = [];
    const menus = this.menus();
    menus.forEach(([title, items], i) => {
      const b = h('button.menu-btn', { type: 'button' }, title);
      const open = () => {
        openIdx = i;
        btns.forEach((x) => x.classList.toggle('open', x === b));
        openMenu(items, { anchor: b, onClose: () => {
          b.classList.remove('open');
          if (openIdx === i) openIdx = -1;
        } });
      };
      b.addEventListener('click', () => (openIdx === i ? closeMenus() : open()));
      b.addEventListener('pointerenter', () => {
        if (openIdx >= 0 && openIdx !== i) open();
      });
      btns.push(b);
      root.appendChild(h('div.menu-root', b));
    });
    root.appendChild(h('div.spacer'));
    this.titleEl = h('div.project-title');
    root.appendChild(this.titleEl);
    this._updateTitle();
  }

  _updateTitle() {
    if (!this.titleEl) return;
    this.titleEl.replaceChildren(h('b', store.project.name), ' · ', store.seq.name, h('span.save-dot', { class: store.dirty ? 'dirty' : '', title: store.dirty ? 'Есть несохранённые изменения' : 'Сохранено' }));
    document.title = `${store.dirty ? '• ' : ''}${store.project.name} — ${APP_NAME}`;
  }

  // =====================================================================
  // Горячие клавиши
  // =====================================================================

  bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (isModalOpen() || isTypingTarget(e.target)) return;
      if (document.querySelector('.dropdown') && e.key !== 'Escape') return;
      const combo = comboFromEvent(e);
      let id = this.keymap.get(combo);
      // Backspace/Delete в панели «Проект» удаляют элементы проекта
      if (!id) return;
      const a = this.actions.get(id);
      e.preventDefault();
      if (a.norepeat && e.repeat) return;
      if (id === 'edit.clear' && store.ui.focusedPanel === 'project') return this.deleteProjectItems([...store.ui.projectSelection]);
      this.run(id);
    });
  }

  // =====================================================================
  // Жизненный цикл проекта
  // =====================================================================

  async boot() {
    await requestPersistence();
    let project = null;
    try {
      const id = await lastProjectId();
      if (id) project = await loadProject(id);
    } catch (err) {
      console.warn('[boot] не удалось открыть последний проект', err);
    }
    this._setProject(project || createProject('Мой проект'), { fresh: !project });
    this.autosave = new Autosave({
      save: (reason) => this.save(false, reason),
      isDirty: () => store.dirty,
      intervalMs: 60000,
    });
    this.autosave.start();
    window.addEventListener('beforeunload', (e) => {
      if (store.dirty) {
        this.autosave.flush('unload');
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  _setProject(project, { fresh = false } = {}) {
    transport.pause();
    mediaCache.reset();
    store.setProject(project, { dirty: fresh });
    for (const m of store.project.media) mediaCache.loadAux(m).then(() => this.panels.get('project')?.render());
    // проверим доступность файлов (офлайн-медиа)
    Promise.all(store.project.media.map((m) => mediaCache.blob(m))).then(() => {
      const off = store.project.media.filter((m) => mediaCache.isOffline(m.id));
      if (off.length) toast(`Не найдено файлов: ${off.length}. Используйте «Связать медиа…» в панели «Проект».`, 'warn', 7000);
    });
    this._updateTitle();
  }

  _syncPlayhead() {
    store.seq.playhead = store.ui.playhead;
  }

  async save(manual = false, reason = 'manual') {
    this._syncPlayhead();
    await saveProject(store.project);
    store.markClean();
    if (manual) status(`Проект «${store.project.name}» сохранён`);
    else status(`Автосохранение: ${new Date().toLocaleTimeString()}`);
    void reason;
  }

  async newProject() {
    if (store.dirty) await this.save(false);
    const name = await promptDialog('Имя нового проекта', 'Новый проект', { title: 'Новый проект', ok: 'Создать' });
    if (name == null) return;
    this._setProject(createProject(name.trim() || 'Новый проект'), { fresh: true });
    await this.save(false);
  }

  async saveAs() {
    const name = await promptDialog('Имя копии проекта', `${store.project.name} (копия)`, { title: 'Сохранить как' });
    if (name == null) return;
    this._syncPlayhead();
    const copy = structuredClone(store.project);
    copy.id = crypto.randomUUID();
    copy.name = name.trim() || copy.name;
    copy.createdAt = new Date().toISOString();
    copy.cloud = null;
    await saveProject(store.project);
    this._setProject(copy, { fresh: true });
    await this.save(true);
  }

  async renameProject() {
    const name = await promptDialog('Имя проекта', store.project.name, { title: 'Переименовать проект' });
    if (!name?.trim()) return;
    store.mutate('Переименовать проект', (p) => (p.name = name.trim()));
  }

  async projectManager() {
    if (store.dirty) await this.save(false);
    const list = await listProjects();
    const rows = h('div.project-rows');
    let close;
    const render = (items) => {
      rows.replaceChildren(
        ...items.map((p) => {
          const del = h('button.icon-btn', { type: 'button', title: 'Удалить проект' }, icon('trash'));
          del.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!(await confirmDialog(`Удалить проект «${p.name}» из браузера? Неиспользуемые медиафайлы тоже будут удалены.`, { danger: true, ok: 'Удалить' }))) return;
            await deleteProject(p.id, store.project);
            if (p.id === store.project.id) this._setProject(createProject('Мой проект'), { fresh: true });
            render(await listProjects());
          });
          const row = h('div.project-row', h('div.grow', h('div.t', p.name, p.id === store.project.id ? h('span.muted', ' — открыт') : ''), h('div.s', `${p.mediaCount} медиа · ${p.sequences} секв. · ${p.updatedAt ? new Date(p.updatedAt).toLocaleString() : ''}`)), del);
          row.addEventListener('click', async () => {
            close?.(null);
            await this.openProject(p.id);
          });
          return row;
        })
      );
      if (!items.length) rows.appendChild(h('div.empty-hint', 'Сохранённых проектов нет'));
    };
    render(list);
    const est = await storageEstimate();
    await modal({
      title: 'Проекты в браузере',
      wide: true,
      body: h('div', rows, est ? h('div.note', { style: 'margin-top:10px' }, `Занято в хранилище браузера: ${formatBytes(est.usage)} из ${formatBytes(est.quota)}`) : null),
      buttons: [
        { label: 'Импорт .json…', value: 'import', left: true },
        { label: 'Новый проект', value: 'new' },
        { label: 'Закрыть', value: null, primary: true },
      ],
      onMount: (c) => (close = c.close),
    }).then((v) => {
      if (v === 'new') this.newProject();
      if (v === 'import') this.importProjectJson();
    });
  }

  async openProject(id) {
    if (store.dirty) await this.save(false);
    const p = await loadProject(id);
    if (!p) return toast('Проект не найден', 'error');
    this._setProject(p);
    await this.save(false);
    status(`Открыт проект «${p.name}»`);
  }

  async importProjectJson() {
    const [file] = await pickFiles({ accept: '.json,application/json', multiple: false });
    if (!file) return;
    try {
      if (store.dirty) await this.save(false);
      const project = await readProjectJSON(file);
      this._setProject(project, { fresh: true });
      await this.save(false);
      toast(`Проект «${project.name}» импортирован`);
    } catch (err) {
      reportError(err, 'Импорт проекта');
    }
  }

  // =====================================================================
  // Импорт и медиа
  // =====================================================================

  async importFiles(files) {
    const list = [...(files || [])];
    if (!list.length) return [];
    const panel = this.panels.get('project');
    status(`Импорт: ${list.length} файл(ов)…`);
    const { created, errors } = await importFiles(list, {
      onProgress: (i, n, name) => {
        panel?.setProgress(n ? i / n : 1);
        if (name) status(`Импорт ${i + 1}/${n}: ${name}`);
      },
    });
    panel?.setProgress(1);
    if (created.length) {
      status(`Импортировано: ${created.length}`);
      this.layout.showPanel('project');
    }
    for (const e of errors) toast(`Не удалось импортировать «${e.name}»: ${e.error}`, 'error', 6000);
    return created;
  }

  openInSource(mediaId, atTime = null) {
    store.openInSource(mediaId);
    if (atTime != null) setTimeout(() => this.panels.get('source').seek(atTime), 50);
  }

  revealInProject(mediaId) {
    this.layout.showPanel('project');
    this.panels.get('project').reveal(mediaId);
  }

  async deleteProjectItems(ids) {
    if (!ids.length) return;
    const mediaIds = ids.filter((id) => store.getMedia(id));
    const seqIds = ids.filter((id) => store.project.sequences.some((s) => s.id === id));
    const used = store.project.sequences.some((s) => s.tracks.some((t) => t.clips.some((c) => mediaIds.includes(c.mediaId))));
    if (used && !(await confirmDialog('Некоторые элементы используются в секвенциях — соответствующие клипы будут удалены. Продолжить?', { danger: true, ok: 'Удалить' }))) return;
    if (mediaIds.length) removeMedia(mediaIds);
    if (seqIds.length) {
      if (seqIds.length >= store.project.sequences.length) return toast('В проекте должна остаться хотя бы одна секвенция', 'warn');
      store.mutate('Удалить секвенцию', (p) => {
        p.sequences = p.sequences.filter((s) => !seqIds.includes(s.id));
        if (!p.sequences.find((s) => s.id === p.activeSequenceId)) p.activeSequenceId = p.sequences[0].id;
      });
    }
  }

  async renameItem(item) {
    const name = await promptDialog('Новое имя', item.name, { title: 'Переименовать' });
    if (!name?.trim()) return;
    store.mutate('Переименовать', (p) => {
      const target = item.type === 'sequence' ? p.sequences.find((s) => s.id === item.id) : p.media.find((m) => m.id === item.id);
      if (target) target.name = name.trim();
    });
  }

  duplicateSequence(id) {
    store.mutate('Дублировать секвенцию', (p) => {
      const s = p.sequences.find((x) => x.id === id);
      const copy = structuredClone(s);
      copy.id = crypto.randomUUID();
      copy.name = `${s.name} (копия)`;
      for (const t of copy.tracks) {
        t.id = crypto.randomUUID();
        for (const c of t.clips) c.id = crypto.randomUUID();
      }
      for (const m of copy.markers) m.id = crypto.randomUUID();
      p.sequences.push(copy);
    });
  }

  sequenceFromMedia(mediaId) {
    const m = store.getMedia(mediaId);
    if (!m?.hasVideo) return;
    const fps = SEQUENCE_FPS.reduce((a, b) => (Math.abs(b - (m.fps || 30)) < Math.abs(a - (m.fps || 30)) ? b : a), 30);
    let newId;
    store.mutate('Секвенция по клипу', (p) => {
      const s = createSequence({ name: m.name.replace(/\.[^.]+$/, ''), width: m.width || 1920, height: m.height || 1080, fps });
      newId = s.id;
      p.sequences.push(s);
      ops.placeMedia(s, p, m, { at: 0, videoTrackId: s.tracks[0].id, audioTrackId: s.tracks.find((t) => t.kind === TRACK_KIND.AUDIO).id });
    });
    store.setActiveSequence(newId);
    setTimeout(() => this.timeline.zoomToFit(), 50);
  }

  async relink(mediaId) {
    const m = store.getMedia(mediaId);
    const [file] = await pickFiles({ accept: ACCEPT_ATTR, multiple: false });
    if (!file) return;
    if (m.size && file.size !== m.size && !(await confirmDialog(`Размер файла отличается от исходного (${formatBytes(file.size)} против ${formatBytes(m.size)}). Всё равно связать?`))) return;
    await relinkMedia(mediaId, file);
    toast(`Медиа «${m.name}» связано с файлом «${file.name}»`);
  }

  showMediaInfo(mediaId) {
    const m = store.getMedia(mediaId);
    const rows = [
      ['Имя', m.name],
      ['Тип', { video: 'Видео', audio: 'Аудио', image: 'Изображение' }[m.kind]],
      ['Контейнер', m.container || m.mime || '—'],
      ['Длительность', m.kind === 'image' ? '—' : `${formatTC(m.duration, Math.round(m.fps) || 30)} (${m.duration?.toFixed(3)} с)`],
      ['Разрешение', m.width ? `${m.width}×${m.height}` : '—'],
      ['Частота кадров', m.fps ? `${m.fps} к/с` : '—'],
      ['Видеокодек', m.videoCodec ? `${m.videoCodec}${m.videoCodecString ? ` (${m.videoCodecString})` : ''}` : '—'],
      ['Аудиокодек', m.audioCodec ? `${m.audioCodec}, ${m.audioSampleRate || '?'} Гц, ${m.audioChannels || '?'} кан.` : m.hasAudio ? 'есть' : 'нет'],
      ['Размер', formatBytes(m.size)],
      ['Статус', mediaCache.isOffline(m.id) ? 'Офлайн — файл не найден' : 'В хранилище браузера'],
    ];
    modal({ title: 'Свойства медиа', body: h('table.shortcut-table', h('tbody', rows.map(([a, b]) => h('tr', h('td.muted', a), h('td', b))))) });
  }

  setScaling(mode) {
    store.mutate('Масштаб по кадру', (p, s) => {
      for (const { clip } of store.selectedClips()) {
        const c = findClip(s, clip.id).clip;
        if (c.kind === TRACK_KIND.VIDEO) c.scaling = mode;
      }
    });
  }

  applyEffectToSelection(type) {
    const def = plugins.effects.get(type);
    if (!def) return;
    store.mutate(`Эффект «${def.name}»`, (p, s) => {
      let any = false;
      for (const { clip, track } of store.selectedClips()) {
        if ((def.target === 'audio') !== (track.kind === TRACK_KIND.AUDIO)) continue;
        findClip(s, clip.id).clip.effects.push(plugins.instantiateEffect(type));
        any = true;
      }
      return any;
    });
  }

  /** Первый клип в пустой секвенции с другими параметрами — предложить подстроить секвенцию. */
  async checkSequenceMismatch(mediaIds) {
    const seq = store.seq;
    if (sequenceDuration(seq) > 0) return;
    const m = mediaIds.map((id) => store.getMedia(id)).find((x) => x?.kind === 'video' && x.width);
    if (!m) return;
    const fps = SEQUENCE_FPS.reduce((a, b) => (Math.abs(b - (m.fps || seq.fps)) < Math.abs(a - (m.fps || seq.fps)) ? b : a), seq.fps);
    if (m.width === seq.width && m.height === seq.height && fps === seq.fps) return;
    const ok = await modal({
      title: 'Несоответствие параметров',
      body: h('div', { style: 'line-height:1.6' }, `Клип «${m.name}» (${m.width}×${m.height}, ${m.fps ? Math.round(m.fps * 100) / 100 : '?'} к/с) не совпадает с параметрами секвенции (${seq.width}×${seq.height}, ${seq.fps} к/с).`),
      buttons: [
        { label: 'Оставить как есть', value: false },
        { label: 'Изменить параметры секвенции', value: true, primary: true },
      ],
    });
    if (ok) {
      store.mutate('Параметры секвенции по клипу', (p, s) => {
        s.width = m.width;
        s.height = m.height;
        s.fps = fps;
      });
    }
  }

  // =====================================================================
  // Монтажные операции
  // =====================================================================

  _paste(mode) {
    const clip = store.ui.clipboard;
    if (!clip) return;
    let created = [];
    store.mutate(mode === 'insert' ? 'Вставить со сдвигом' : 'Вставить', (p, s) => {
      created = ops.pasteClips(s, clip, store.ui.playhead, { videoTrackId: store.ui.targetVideoTrackId, audioTrackId: store.ui.targetAudioTrackId, mode });
      return created.length > 0;
    });
    if (created.length) {
      store.ui.selection = new Set(created);
      store.emit('selection');
      store.setPlayhead(store.ui.playhead + clip.span);
    }
  }

  _clear(ripple) {
    if (store.ui.focusedPanel === 'project' && !ripple) return this.deleteProjectItems([...store.ui.projectSelection]);
    if (store.ui.selection.size) {
      store.mutate(ripple ? 'Удалить со сдвигом' : 'Удалить', (p, s) => ops.deleteClips(s, [...store.ui.selection], { ripple }));
      return;
    }
    if (store.ui.selectedMarkerId) store.mutate('Удалить маркер', (p, s) => ops.deleteMarker(s, store.ui.selectedMarkerId));
  }

  _nudge(frames) {
    const sel = store.selectedClips();
    const d = frames / store.seq.fps;
    if (sel.some(({ clip }) => clip.start + d < -EPS)) return;
    store.mutate('Сдвиг клипов', (p, s) => ops.moveClips(s, sel.map(({ clip }) => ({ clipId: clip.id, start: clip.start + d }))), { mergeKey: 'nudge' });
  }

  _step(frames) {
    transport.step(frames);
    this.timeline.revealPlayhead();
  }

  _setInOut(key, value) {
    store.mutate(key === 'inPoint' ? (value == null ? 'Очистить вход' : 'Отметить вход') : value == null ? 'Очистить выход' : 'Отметить выход', (p, s) => {
      s[key] = value == null ? null : snapToFrame(value, s.fps);
      if (s.inPoint != null && s.outPoint != null && s.outPoint <= s.inPoint) {
        if (key === 'inPoint') s.outPoint = null;
        else s.inPoint = null;
      }
    });
  }

  _markClip() {
    const seq = store.seq;
    const t = store.ui.playhead;
    let clip = store.selectedClips()[0]?.clip;
    if (!clip) {
      for (const tr of [...seq.tracks].reverse()) {
        const c = tr.clips.find((x) => x.start <= t + EPS && clipEnd(x) > t + EPS);
        if (c) {
          clip = c;
          break;
        }
      }
    }
    if (!clip) return;
    store.mutate('Отметить клип', (p, s) => {
      s.inPoint = clip.start;
      s.outPoint = clipEnd(clip);
    });
  }

  _liftExtract(extract) {
    const s = store.seq;
    if (s.inPoint == null && s.outPoint == null) return toast('Сначала задайте точки входа и выхода (I и O)', 'warn');
    const a = s.inPoint ?? 0;
    const b = s.outPoint ?? sequenceDuration(s);
    store.mutate(extract ? 'Извлечь' : 'Поднять', (p, sq) => (extract ? ops.extractRange(sq, a, b) : ops.liftRange(sq, a, b)));
    if (extract) {
      store.mutate('Очистить вход и выход', (p, sq) => {
        sq.inPoint = null;
        sq.outPoint = null;
      });
      store.setPlayhead(a);
    }
  }

  _gotoEdit(dir) {
    const pts = ops.editPoints(store.seq);
    const t = store.ui.playhead;
    const next = dir > 0 ? pts.find((p) => p > t + EPS) : [...pts].reverse().find((p) => p < t - EPS);
    if (next != null) {
      transport.seek(next);
      this.timeline.revealPlayhead();
    }
  }

  _gotoMarker(dir) {
    const ms = store.seq.markers;
    const t = store.ui.playhead;
    const m = dir > 0 ? ms.find((x) => x.time > t + EPS) : [...ms].reverse().find((x) => x.time < t - EPS);
    if (m) {
      transport.seek(m.time);
      store.ui.selectedMarkerId = m.id;
      store.emit('selection');
      this.timeline.revealPlayhead();
    }
  }

  _markerAtPlayhead() {
    return store.seq.markers.find((m) => Math.abs(m.time - store.ui.playhead) < 0.5 / store.seq.fps) || null;
  }

  addMarker() {
    const existing = this._markerAtPlayhead();
    if (existing) return this.editMarker(existing.id);
    let id;
    store.mutate('Добавить маркер', (p, s) => {
      id = ops.addMarker(s, store.ui.playhead).id;
    });
    store.ui.selectedMarkerId = id;
    store.emit('selection');
  }

  async editMarker(id) {
    const seq = store.seq;
    const m = seq.markers.find((x) => x.id === id);
    if (!m) return;
    const name = h('input', { type: 'text', value: m.name });
    const time = h('input', { type: 'text', value: formatTC(m.time, seq.fps), class: 'mono' });
    const dur = h('input', { type: 'text', value: formatTC(m.duration || 0, seq.fps), class: 'mono' });
    const comment = h('textarea', { rows: 3 }, m.comment || '');
    let color = m.color;
    const sw = h('div.swatches', MARKER_COLORS.map((c) => {
      const el = h('div.swatch', { class: c === color ? 'on' : '', style: { background: c } });
      el.addEventListener('click', () => {
        color = c;
        sw.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === el));
      });
      return el;
    }));
    const res = await modal({
      title: 'Маркер',
      body: h('div.form-grid', h('label', 'Имя'), name, h('label', 'Время'), time, h('label', 'Длительность'), dur, h('label', 'Цвет'), sw, h('label', 'Комментарий'), comment),
      buttons: [
        { label: 'Удалить', value: 'delete', danger: true, left: true },
        { label: 'Отмена', value: null },
        { label: 'OK', value: 'ok', primary: true },
      ],
    });
    if (res === 'delete') store.mutate('Удалить маркер', (p, s) => ops.deleteMarker(s, id));
    if (res === 'ok') {
      const t = parseTC(time.value, seq.fps);
      const d = parseTC(dur.value, seq.fps);
      store.mutate('Изменить маркер', (p, s) => ops.updateMarker(s, id, { name: name.value.trim(), comment: comment.value, color, time: t ? t.value : m.time, duration: d ? Math.max(0, d.value) : m.duration }));
    }
  }

  goToTimecode(text) {
    const r = parseTC(text, store.seq.fps);
    if (!r) return toast('Не удалось разобрать таймкод', 'warn');
    let t = r.value;
    if (r.relative) t = store.ui.playhead + r.value;
    transport.seek(Math.max(0, t));
    this.timeline.revealPlayhead();
  }

  _matchFrame() {
    const seq = store.seq;
    const t = store.ui.playhead;
    let clip = store.selectedClips().find(({ clip: c }) => c.start <= t + EPS && clipEnd(c) > t + EPS)?.clip;
    if (!clip) {
      const layers = activeVideoLayers(store.project, seq, t, (id) => store.getMedia(id));
      clip = layers.filter((l) => l.kind === 'clip').at(-1)?.clip;
    }
    if (!clip) {
      for (const tr of seq.tracks) {
        const c = tr.clips.find((x) => x.start <= t + EPS && clipEnd(x) > t + EPS);
        if (c) {
          clip = c;
          break;
        }
      }
    }
    if (!clip?.mediaId) return;
    this.openInSource(clip.mediaId, clip.in + (t - clip.start) * clip.speed);
  }

  /** Вставка/наложение из Source Monitor (или выделения в Project) в позицию плейхеда. */
  _fromSource(mode) {
    const srcPanel = this.panels.get('source');
    let mediaIds;
    let inP = null;
    let outP = null;
    if (store.ui.focusedPanel === 'project' && store.ui.projectSelection.size) {
      mediaIds = [...store.ui.projectSelection].filter((id) => store.getMedia(id));
    } else if (srcPanel.media) {
      mediaIds = [srcPanel.media.id];
      inP = srcPanel.media.markIn;
      outP = srcPanel.media.markOut;
    }
    if (!mediaIds?.length) return toast('Откройте клип в мониторе источника (двойной щелчок в «Проекте»)', 'warn');
    this._place(mediaIds, mode, inP, outP);
  }

  insertFromProject(mode) {
    const ids = [...store.ui.projectSelection].filter((id) => store.getMedia(id));
    if (ids.length) this._place(ids, mode);
  }

  async _place(mediaIds, mode, inP = null, outP = null) {
    await this.checkSequenceMismatch(mediaIds);
    let end = store.ui.playhead;
    store.mutate(mode === 'insert' ? 'Вставка' : 'Наложение', (p, s) => {
      let at = store.ui.playhead;
      const created = [];
      for (const id of mediaIds) {
        const m = p.media.find((x) => x.id === id);
        const ids = ops.placeMedia(s, p, m, { at, videoTrackId: store.ui.targetVideoTrackId, audioTrackId: store.ui.targetAudioTrackId, mode, inPoint: mediaIds.length === 1 ? inP : null, outPoint: mediaIds.length === 1 ? outP : null });
        const c = ids.length ? findClip(s, ids[0])?.clip : null;
        if (c) at = clipEnd(c);
        created.push(...ids);
      }
      end = at;
      return created.length > 0;
    });
    store.setPlayhead(end);
    this.timeline.revealPlayhead();
  }

  // =====================================================================
  // Диалоги
  // =====================================================================

  async speedDialog() {
    const sel = store.selectedClips();
    if (!sel.length) return;
    const c = sel[0].clip;
    const seq = store.seq;
    const speed = h('input', { type: 'number', min: 1, max: 10000, step: 1, value: Math.round(c.speed * 100) });
    const dur = h('input', { type: 'text', class: 'mono', value: formatTC((c.out - c.in) / c.speed, seq.fps) });
    const ripple = h('input', { type: 'checkbox' });
    const sync = (from) => {
      if (from === 'speed') {
        const sp = Number(speed.value) / 100;
        if (sp > 0) dur.value = formatTC((c.out - c.in) / sp, seq.fps);
      } else {
        const d = parseTC(dur.value, seq.fps);
        if (d && d.value > 0) speed.value = Math.round(((c.out - c.in) / d.value) * 10000) / 100;
      }
    };
    speed.addEventListener('input', () => sync('speed'));
    dur.addEventListener('change', () => sync('dur'));
    const ok = await modal({
      title: 'Скорость/длительность клипа',
      body: h('div.form-grid', h('label', 'Скорость, %'), speed, h('label', 'Длительность'), dur, h('label', ''), h('label.row', ripple, 'Сдвинуть последующие клипы'), h('div.note.full', 'Обратное воспроизведение и сохранение высоты тона — на следующем этапе.')),
      buttons: [{ label: 'Отмена', value: false }, { label: 'OK', value: true, primary: true }],
    });
    if (!ok) return;
    const sp = Number(speed.value) / 100;
    if (!(sp > 0)) return;
    store.mutate('Скорость/длительность', (p, s) => {
      const done = new Set();
      for (const { clip } of sel) {
        if (done.has(clip.id)) continue;
        ops.setClipSpeed(s, p, clip.id, sp, { ripple: ripple.checked, linked: store.ui.linkedSelection });
        done.add(clip.id);
        const f = findClip(s, clip.id)?.clip;
        if (f?.linkId) for (const t of s.tracks) for (const x of t.clips) if (x.linkId === f.linkId) done.add(x.id);
      }
    });
  }

  _sequenceForm(seq, { title }) {
    const name = h('input', { type: 'text', value: seq.name });
    const presets = [
      ['3840x2160', '4K UHD 3840×2160'],
      ['2560x1440', 'QHD 2560×1440'],
      ['1920x1080', 'Full HD 1920×1080'],
      ['1280x720', 'HD 1280×720'],
      ['1080x1920', 'Вертикальное 1080×1920'],
      ['1080x1080', 'Квадрат 1080×1080'],
      ['custom', 'Свой размер'],
    ];
    const key = `${seq.width}x${seq.height}`;
    const preset = h('select', presets.map(([v, l]) => h('option', { value: v, selected: v === key || (v === 'custom' && !presets.some((p) => p[0] === key)) }, l)));
    const w = h('input', { type: 'number', min: 16, max: 7680, step: 2, value: seq.width });
    const hh = h('input', { type: 'number', min: 16, max: 4320, step: 2, value: seq.height });
    preset.addEventListener('change', () => {
      if (preset.value === 'custom') return;
      const [a, b] = preset.value.split('x').map(Number);
      w.value = a;
      hh.value = b;
    });
    const fps = h('select', SEQUENCE_FPS.map((f) => h('option', { value: f, selected: f === seq.fps }, `${f} к/с`)));
    const body = h('div.form-grid', h('label', 'Имя'), name, h('label', 'Кадр'), preset, h('label', 'Размер'), h('div.pair', w, '×', hh), h('label', 'Частота кадров'), fps, h('label', 'Звук'), h('div.muted', '48 кГц, стерео'));
    return {
      body,
      title,
      read: () => ({ name: name.value.trim() || seq.name, width: Math.max(16, Math.round(Number(w.value) / 2) * 2), height: Math.max(16, Math.round(Number(hh.value) / 2) * 2), fps: Number(fps.value) }),
    };
  }

  async sequenceSettingsDialog() {
    const seq = store.seq;
    const f = this._sequenceForm(seq, {});
    const ok = await modal({ title: 'Параметры секвенции', body: f.body, buttons: [{ label: 'Отмена', value: false }, { label: 'OK', value: true, primary: true }] });
    if (!ok) return;
    const v = f.read();
    store.mutate('Параметры секвенции', (p, s) => {
      // при смене размера кадра положения клипов масштабируются пропорционально
      const kx = v.width / s.width;
      const ky = v.height / s.height;
      if (kx !== 1 || ky !== 1) {
        for (const t of s.tracks) for (const c of t.clips) {
          const pos = c.transform?.position;
          if (Array.isArray(pos)) c.transform.position = [pos[0] * kx, pos[1] * ky];
        }
      }
      Object.assign(s, v);
      // время клипов — к новой кадровой сетке
      for (const t of s.tracks) for (const c of t.clips) c.start = snapToFrame(c.start, s.fps);
    });
  }

  async newSequenceDialog() {
    const base = store.seq;
    const f = this._sequenceForm({ ...base, name: `Секвенция ${String(store.project.sequences.length + 1).padStart(2, '0')}` }, {});
    const ok = await modal({ title: 'Новая секвенция', body: f.body, buttons: [{ label: 'Отмена', value: false }, { label: 'Создать', value: true, primary: true }] });
    if (!ok) return;
    let id;
    store.mutate('Новая секвенция', (p) => {
      const s = createSequence(f.read());
      id = s.id;
      p.sequences.push(s);
    });
    store.setActiveSequence(id);
  }

  async addTracksDialog() {
    const v = h('input', { type: 'number', min: 0, max: 20, value: 1 });
    const a = h('input', { type: 'number', min: 0, max: 20, value: 0 });
    const ok = await modal({ title: 'Добавить дорожки', body: h('div.form-grid', h('label', 'Видеодорожки'), v, h('label', 'Аудиодорожки'), a), buttons: [{ label: 'Отмена', value: false }, { label: 'OK', value: true, primary: true }] });
    if (!ok) return;
    store.mutate('Добавить дорожки', (p, s) => {
      ops.addTracks(s, TRACK_KIND.VIDEO, Math.max(0, Number(v.value) | 0));
      ops.addTracks(s, TRACK_KIND.AUDIO, Math.max(0, Number(a.value) | 0));
    });
  }

  async projectSettingsDialog() {
    const st = store.project.settings;
    const dur = h('input', { type: 'number', min: 0.1, max: 600, step: 0.1, value: st.defaultImageDuration });
    const sc = h('select', [['fit', 'Вписать в кадр'], ['fill', 'Заполнить кадр'], ['none', 'Без масштабирования']].map(([v, l]) => h('option', { value: v, selected: st.defaultScaling === v }, l)));
    const ok = await modal({
      title: 'Параметры проекта',
      body: h('div.form-grid', h('label', 'Длительность изображений, с'), dur, h('label', 'Масштаб новых клипов'), sc),
      buttons: [{ label: 'Отмена', value: false }, { label: 'OK', value: true, primary: true }],
    });
    if (!ok) return;
    store.mutate('Параметры проекта', (p) => {
      p.settings.defaultImageDuration = Math.max(0.1, Number(dur.value) || 5);
      p.settings.defaultScaling = sc.value;
    });
  }

  async exportFrame() {
    try {
      const blob = await this.panels.get('program').snapshot();
      const name = `${safeFileName(store.seq.name)}_${formatTC(store.ui.playhead, store.seq.fps).replace(/:/g, '-')}.png`;
      downloadBlob(blob, name);
      toast(`Кадр сохранён: ${name}`);
    } catch (err) {
      reportError(err, 'Экспорт кадра');
    }
  }

  async exportDialog() {
    transport.pause();
    const seq = store.seq;
    if (sequenceDuration(seq) <= 0) return toast('Секвенция пуста — добавьте клипы на таймлайн', 'warn');
    const hasInOut = seq.inPoint != null || seq.outPoint != null;
    const fileName = h('input', { type: 'text', value: safeFileName(seq.name) });
    const format = h('select', h('option', { value: 'mp4' }, 'MP4 (H.264 + AAC)'), h('option', { value: 'webm' }, 'WebM (VP9 + Opus)'));
    const resList = [
      ['seq', `Как в секвенции (${seq.width}×${seq.height})`],
      ['3840x2160', '3840×2160 (4K)'],
      ['2560x1440', '2560×1440'],
      ['1920x1080', '1920×1080'],
      ['1280x720', '1280×720'],
      ['854x480', '854×480'],
      ['custom', 'Свой размер'],
    ];
    const res = h('select', resList.map(([v, l]) => h('option', { value: v }, l)));
    const w = h('input', { type: 'number', min: 16, max: 7680, step: 2, value: seq.width, disabled: true });
    const hh = h('input', { type: 'number', min: 16, max: 4320, step: 2, value: seq.height, disabled: true });
    const fps = h('select', [h('option', { value: seq.fps }, `Как в секвенции (${seq.fps})`), ...SEQUENCE_FPS.map((f) => h('option', { value: f }, `${f} к/с`))]);
    const vbr = h('input', { type: 'number', min: 0.5, max: 200, step: 0.5, value: 8 });
    const abr = h('select', [96, 128, 160, 192, 256, 320].map((k) => h('option', { value: k, selected: k === 192 }, `${k} кбит/с`)));
    const range = h('select', h('option', { value: 'all' }, 'Вся секвенция'), h('option', { value: 'inout', disabled: !hasInOut, selected: hasInOut }, 'От входа до выхода'));
    const engine = h('select', h('option', { value: 'auto' }, 'Авто (WebCodecs, иначе FFmpeg.wasm)'), h('option', { value: 'webcodecs' }, 'WebCodecs (быстро, аппаратно)'), h('option', { value: 'ffmpeg' }, 'FFmpeg.wasm (медленно, совместимость)'));
    const presetSel = plugins.exportPresets.size ? h('select', h('option', { value: '' }, '—'), [...plugins.exportPresets.values()].map((p) => h('option', { value: p.id }, p.name))) : null;
    const info = h('div.note.full', 'Проверка возможностей браузера…');
    const summary = h('div.note.full');
    const dims = () => {
      if (res.value === 'seq') return [seq.width, seq.height];
      if (res.value === 'custom') return [Number(w.value), Number(hh.value)];
      return res.value.split('x').map(Number);
    };
    const autoBitrate = () => {
      const [a, b] = dims();
      const f = Number(fps.value);
      // ~0.1 бит на пиксель: 1080p30 ≈ 6 Мбит/с
      vbr.value = Math.max(1, Math.round((a * b * f * 0.1) / 1e6 * 2) / 2);
    };
    const updSummary = () => {
      const [a, b] = exportRange(seq, range.value);
      const sec = b - a;
      const mb = ((Number(vbr.value) * 1e6 + Number(abr.value) * 1000) * sec) / 8 / 1024 / 1024;
      summary.textContent = `Длительность: ${formatTC(sec, seq.fps)} · ориентировочный размер: ~${mb.toFixed(1)} МБ`;
    };
    res.addEventListener('change', () => {
      const custom = res.value === 'custom';
      w.disabled = hh.disabled = !custom;
      const [a, b] = dims();
      w.value = a;
      hh.value = b;
      autoBitrate();
      updSummary();
    });
    fps.addEventListener('change', () => {
      autoBitrate();
      updSummary();
    });
    for (const el of [vbr, abr, range, w, hh]) el.addEventListener('input', updSummary);
    presetSel?.addEventListener('change', () => {
      const p = plugins.exportPresets.get(presetSel.value)?.settings;
      if (!p) return;
      res.value = 'custom';
      w.disabled = hh.disabled = false;
      w.value = p.width;
      hh.value = p.height;
      if (p.fps) fps.value = p.fps;
      if (p.videoBitrate) vbr.value = p.videoBitrate / 1e6;
      if (p.format) format.value = p.format;
      updSummary();
    });
    autoBitrate();
    updSummary();
    detectEncoders(seq.width, seq.height, 8e6, seq.fps).then((enc) => {
      const parts = [];
      parts.push(enc.h264 ? '✓ H.264 через WebCodecs' : '✗ H.264 через WebCodecs недоступен — будет использован FFmpeg.wasm');
      parts.push(enc.aacNative ? '✓ AAC (нативно)' : '✓ AAC (WASM-кодировщик)');
      if (!enc.vp9) parts.push('✗ VP9 недоступен');
      info.textContent = parts.join(' · ');
    });
    const ok = await modal({
      title: 'Экспорт видео',
      wide: true,
      body: h(
        'div.form-grid',
        presetSel && h('label', 'Пресет'),
        presetSel,
        h('label', 'Имя файла'),
        fileName,
        h('label', 'Формат'),
        format,
        h('label', 'Разрешение'),
        res,
        h('label', 'Свой размер'),
        h('div.pair', w, '×', hh),
        h('label', 'Частота кадров'),
        fps,
        h('label', 'Битрейт видео, Мбит/с'),
        vbr,
        h('label', 'Битрейт звука'),
        abr,
        h('label', 'Диапазон'),
        range,
        h('label', 'Движок кодирования'),
        engine,
        summary,
        info,
        h('div.note.full', 'Экспорт выполняется на вашем устройстве: без сервера, без ограничений и водяных знаков. Не закрывайте вкладку до завершения.')
      ),
      buttons: [{ label: 'Отмена', value: false }, { label: 'Экспорт', value: true, primary: true }],
    });
    if (!ok) return;
    const [W, H] = dims();
    const opts = {
      format: format.value,
      width: W,
      height: H,
      fps: Number(fps.value),
      videoBitrate: Number(vbr.value) * 1e6,
      audioBitrate: Number(abr.value) * 1000,
      range: exportRange(seq, range.value),
      engine: engine.value,
    };
    return this.runExport(opts, safeFileName(fileName.value || seq.name));
  }

  /** Запуск экспорта с окном прогресса (используется и e2e-тестом). */
  async runExport(opts, baseName = 'export') {
    this._syncPlayhead();
    const dlg = progressDialog('Экспорт видео');
    const t0 = performance.now();
    try {
      const result = await exportSequence(store.project, store.seq, opts, {
        signal: dlg.signal,
        onProgress: (p) => {
          const meta = p.eta != null ? `осталось ~${Math.ceil(p.eta)} с` : '';
          dlg.update(p.phase === 'video' ? p.progress : p.phase === 'finalize' ? 1 : p.progress * 0.05, p.label, meta);
        },
      });
      dlg.close();
      const name = `${baseName}.${result.extension}`;
      downloadBlob(result.blob, name);
      this.lastExport = { ...result, name, size: result.blob.size };
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      toast(`Готово: ${name} — ${formatBytes(result.blob.size)}, ${secs} с (${result.engine === 'webcodecs' ? 'WebCodecs' : 'FFmpeg.wasm'})`, 'info', 8000);
      status(`Экспорт завершён: ${name}`);
      return this.lastExport;
    } catch (err) {
      dlg.close();
      if (err instanceof ExportAborted || err?.name === 'ExportAborted') {
        toast('Экспорт отменён', 'warn');
        return null;
      }
      reportError(err, 'Экспорт');
      throw err;
    }
  }

  // ---------- сервер ----------

  async serverDialog() {
    const s = await cloudSettings();
    const url = h('input', { type: 'url', value: s.serverUrl, placeholder: 'https://kadra-server.onrender.com' });
    const user = h('input', { type: 'text', value: s.username || '', autocomplete: 'username' });
    const pass = h('input', { type: 'password', autocomplete: 'current-password' });
    const state = h('div.note.full', s.token ? `Вход выполнен: ${s.username}` : 'Не авторизован. Без сервера редактор работает локально.');
    const check = async () => {
      try {
        const r = await cloud.health(url.value.trim().replace(/\/+$/, ''));
        state.textContent = `Сервер доступен: ${r.name} ${r.version}${s.token ? ` · вход: ${s.username}` : ''}`;
      } catch (err) {
        state.textContent = err.message;
      }
    };
    const res = await modal({
      title: 'Сервер (необязательно)',
      body: h('div.form-grid', h('label', 'Адрес сервера'), url, h('label', 'Логин'), user, h('label', 'Пароль'), pass, state, h('div.note.full', 'Сервер хранит ваши проекты и медиафайлы, чтобы открыть их на другом устройстве. Монтаж и экспорт работают без него.')),
      buttons: [
        { label: 'Проверить', value: 'check', left: true },
        s.token && { label: 'Выйти', value: 'logout' },
        { label: 'Регистрация', value: 'register' },
        { label: 'Войти', value: 'login', primary: true },
      ].filter(Boolean),
    });
    if (!res) return;
    try {
      if (res === 'check') {
        await setCloudSettings({ serverUrl: url.value });
        await check();
        return this.serverDialog();
      }
      if (res === 'logout') {
        await cloud.logout();
        return toast('Вы вышли из аккаунта сервера');
      }
      if (!user.value.trim() || !pass.value) return toast('Введите логин и пароль', 'warn');
      await cloud.login(url.value, user.value.trim(), pass.value, { register: res === 'register' });
      toast(res === 'register' ? 'Аккаунт создан, вход выполнен' : 'Вход выполнен');
    } catch (err) {
      reportError(err, 'Сервер');
    }
  }

  async cloudSave() {
    const s = await cloudSettings();
    if (!s.serverUrl || !s.token) return this.serverDialog();
    this._syncPlayhead();
    const dlg = progressDialog('Сохранение на сервер', { cancellable: false });
    try {
      const { updates, cloud: meta } = await saveProjectToCloud(store.project, { onProgress: (p, label) => dlg.update(p, label) });
      store.mutateSilently((p) => {
        for (const m of p.media) if (updates.has(m.id)) m.cloudAssetId = updates.get(m.id);
        p.cloud = meta;
      });
      await this.save(false);
      dlg.close();
      toast('Проект сохранён на сервере');
    } catch (err) {
      dlg.close();
      reportError(err, 'Сервер');
    }
  }

  async cloudOpen() {
    const s = await cloudSettings();
    if (!s.serverUrl || !s.token) return this.serverDialog();
    let list;
    try {
      list = await cloud.listProjects();
    } catch (err) {
      return reportError(err, 'Сервер');
    }
    let close;
    const rows = h('div.project-rows', list.length ? list.map((p) => {
      const row = h('div.project-row', h('div.grow', h('div.t', p.name), h('div.s', `${new Date(p.updated_at).toLocaleString()} · ${formatBytes(p.size)}`)));
      row.addEventListener('click', async () => {
        close(null);
        if (store.dirty) await this.save(false);
        const dlg = progressDialog('Загрузка проекта с сервера', { cancellable: false });
        try {
          const project = await openProjectFromCloud(p.id, { onProgress: (x, label) => dlg.update(x, label) });
          dlg.close();
          this._setProject(project);
          await this.save(false);
          toast(`Открыт проект «${project.name}» с сервера`);
        } catch (err) {
          dlg.close();
          reportError(err, 'Сервер');
        }
      });
      return row;
    }) : h('div.empty-hint', 'На сервере нет проектов'));
    await modal({ title: 'Проекты на сервере', wide: true, body: rows, buttons: [{ label: 'Закрыть', value: null }], onMount: (c) => (close = c.close) });
  }

  // ---------- справка ----------

  shortcutsDialog() {
    const groups = [
      ['Воспроизведение', 'play.'],
      ['Инструменты', 'tool.'],
      ['Маркеры и вход/выход', 'mark'],
      ['Секвенция', 'sequence.'],
      ['Источник', 'source.'],
      ['Клип', 'clip.'],
      ['Правка', 'edit.'],
      ['Файл', 'file.'],
      ['Окно', 'window.'],
    ];
    const rows = [];
    for (const [title, prefix] of groups) {
      const acts = [...this.actions.values()].filter((a) => a.id.startsWith(prefix) && a.shortcut);
      if (!acts.length) continue;
      rows.push(h('tr', h('td', { colSpan: 2, style: 'padding-top:12px;color:var(--accent);font-weight:600' }, title)));
      for (const a of acts) rows.push(h('tr', h('td', h('kbd', prettyKeys(a.shortcut))), h('td', a.label)));
    }
    modal({
      title: 'Сочетания клавиш',
      wide: true,
      body: h('div', h('div.note', { style: 'margin-bottom:8px' }, 'Клавиши работают в любой раскладке. Действия транспорта (Пробел, J/K/L, I/O, стрелки) относятся к активной панели — «Источник» или «Программа»/«Таймлайн». Некоторые сочетания (например Ctrl+N) браузер может перехватить — для них есть альтернатива.'), h('table.shortcut-table', h('tbody', rows))),
    });
  }

  aboutDialog() {
    alertDialog(
      `${APP_NAME} ${APP_VERSION}\nБесплатный нелинейный видеоредактор, работающий полностью в браузере.\n\nВсё бесплатно: без подписок, лимитов и водяных знаков. Файлы не покидают ваше устройство, если вы сами не сохраните проект на свой сервер.\n\nБиблиотеки: mediabunny 1.62.1 (MPL-2.0), @mediabunny/aac-encoder 1.62.1 (MPL-2.0), @ffmpeg/core 0.12.10 (GPL-2.0+).`,
      'О программе'
    );
  }

  // =====================================================================
  // Инициализация UI
  // =====================================================================

  bindStatusbar(el) {
    const msg = h('div.msg', 'Готово');
    const storage = h('span');
    const seqInfo = h('span.mono');
    el.append(msg, seqInfo, storage);
    let timer;
    uiEvents.on('status', ({ text, kind }) => {
      msg.textContent = text;
      msg.classList.toggle('error', kind === 'error');
      clearTimeout(timer);
      timer = setTimeout(() => {
        msg.textContent = 'Готово';
        msg.classList.remove('error');
      }, 8000);
    });
    const upd = () => {
      const s = store.seq;
      seqInfo.textContent = `${s.width}×${s.height} · ${s.fps} к/с · ${formatTC(sequenceDuration(s), s.fps)}`;
    };
    store.on('change', upd);
    upd();
    const est = async () => {
      const e = await storageEstimate();
      if (e) storage.textContent = `Хранилище: ${formatBytes(e.usage)}`;
    };
    est();
    setInterval(est, 30000);
    store.on('dirty', (d) => {
      this._updateTitle();
      if (!d) est(); // после сохранения — обновить занятое место
    });
    store.on('change', () => this._updateTitle());
  }

  bindFileDrop() {
    const hint = document.getElementById('file-drop-hint');
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      depth++;
      hint.classList.add('show');
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) hint.classList.remove('show');
    });
    window.addEventListener('dragover', (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      depth = 0;
      hint.classList.remove('show');
      // сюда доходят только «необработанные» сбросы: таймлайн и «Проект» останавливают всплытие
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.importFiles(e.dataTransfer.files);
    });
  }
}
