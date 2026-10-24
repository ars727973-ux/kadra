// Докинг-раскладка панелей, как в профессиональных монтажках:
//  • дерево split-узлов (строки/столбцы с долями) и групп вкладок;
//  • вкладку можно перетащить в другую группу (центр) или к краю группы (новый сплит);
//  • разделители меняют размеры; ` (обратный апостроф) разворачивает группу;
//  • раскладка сохраняется в localStorage; на узких экранах (< 900 px) —
//    компактный режим: две группы вкладок одна над другой.

import { h, clear, dragPointer } from './dom.js';
import { icon } from './icons.js';
import { openMenu } from './menu.js';
import { store } from '../core/store.js';

const STORAGE_KEY = 'kadra.layout.v1';
const COMPACT_BP = 900;

let gid = 0;
const group = (panels, active) => ({ type: 'group', id: 'g' + ++gid, panels, active: active || panels[0] });
const split = (dir, children, sizes) => ({ type: 'split', dir, children, sizes: sizes || children.map(() => 1 / children.length) });

export function defaultTree() {
  return split(
    'col',
    [
      split('row', [group(['source', 'effectControls', 'markers']), group(['program'])], [0.44, 0.56]),
      split('row', [group(['project', 'effects', 'history']), group(['tools']), group(['timeline']), group(['meters'])], [0.25, 0.034, 0.676, 0.04]),
    ],
    [0.53, 0.47]
  );
}

export function compactTree() {
  // инструменты в компактном режиме показываются в верхней строке таймлайна
  return split('col', [group(['program', 'source', 'effectControls']), group(['timeline', 'project', 'effects', 'markers', 'history', 'meters'], 'timeline')], [0.46, 0.54]);
}

export class DockLayout {
  constructor(root, panels) {
    this.root = root;
    this.panels = panels; // Map id → panel {id, title, el, onResize?, onShow?}
    this.tree = null;
    this.compact = false;
    this.maximized = null;
    this.groupEls = new Map();
    this._ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const p = e.target._panel;
        if (p && p.el.classList.contains('active')) p.onResize?.();
      }
    });
    for (const p of panels.values()) {
      p.el._panel = p;
      p.el.classList.add('panel');
      p.el.dataset.panel = p.id;
      this._ro.observe(p.el);
      p.el.addEventListener('pointerdown', () => store.setFocus(p.id), true);
    }
    store.on('focus', () => this._markFocus());
    window.addEventListener('resize', () => this._checkCompact());
  }

  init() {
    this.compact = innerWidth < COMPACT_BP;
    this.tree = this.compact ? compactTree() : this._loadTree() || defaultTree();
    this.render();
  }

  _loadTree() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const tree = JSON.parse(raw);
      const seen = new Set();
      const walk = (n) => {
        if (n.type === 'group') {
          n.id = 'g' + ++gid;
          n.panels = n.panels.filter((id) => this.panels.has(id) && !seen.has(id));
          n.panels.forEach((id) => seen.add(id));
          if (!n.panels.includes(n.active)) n.active = n.panels[0];
          return n.panels.length ? n : null;
        }
        n.children = n.children.map(walk);
        const keep = n.children.map((c, i) => [c, n.sizes[i]]).filter(([c]) => c);
        if (!keep.length) return null;
        n.children = keep.map((k) => k[0]);
        const sum = keep.reduce((a, k) => a + k[1], 0) || 1;
        n.sizes = keep.map((k) => k[1] / sum);
        return n.children.length === 1 ? n.children[0] : n;
      };
      const t = walk(tree);
      if (!t) return null;
      // обязательные панели, которых нет в сохранённой раскладке, добавляем в первую группу
      for (const id of ['program', 'timeline', 'project']) if (!seen.has(id)) this._firstGroup(t).panels.push(id);
      return t;
    } catch {
      return null;
    }
  }

  save() {
    if (this.compact) return;
    const strip = (n) => (n.type === 'group' ? { type: 'group', panels: n.panels, active: n.active } : { type: 'split', dir: n.dir, sizes: n.sizes, children: n.children.map(strip) });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(strip(this.tree)));
    } catch {
      /* квота */
    }
  }

  reset() {
    localStorage.removeItem(STORAGE_KEY);
    this.maximized = null;
    this.tree = this.compact ? compactTree() : defaultTree();
    this.render();
  }

  _checkCompact() {
    const c = innerWidth < COMPACT_BP;
    if (c === this.compact) return;
    if (!this.compact) this.save();
    this.compact = c;
    this.maximized = null;
    this.tree = c ? compactTree() : this._loadTree() || defaultTree();
    this.render();
  }

  _firstGroup(n) {
    return n.type === 'group' ? n : this._firstGroup(n.children[0]);
  }

  _groups(n = this.tree, out = []) {
    if (n.type === 'group') out.push(n);
    else n.children.forEach((c) => this._groups(c, out));
    return out;
  }

  findGroupOf(panelId) {
    return this._groups().find((g) => g.panels.includes(panelId)) || null;
  }

  isOpen(panelId) {
    return !!this.findGroupOf(panelId);
  }

  // ---------- рендер ----------

  render() {
    // отсоединяем панели, чтобы не потерять их DOM при очистке
    for (const p of this.panels.values()) p.el.remove();
    clear(this.root);
    this.groupEls.clear();
    this.root.appendChild(this._renderNode(this.tree));
    this._markFocus();
    if (this.maximized) {
      const el = this.groupEls.get(this.maximized);
      if (el) el.classList.add('maximized');
      else this.maximized = null;
    }
    requestAnimationFrame(() => {
      for (const p of this.panels.values()) if (p.el.isConnected && p.el.classList.contains('active')) p.onResize?.();
    });
  }

  _renderNode(n) {
    if (n.type === 'group') return this._renderGroup(n);
    const el = h('div.dock-split', { class: n.dir === 'row' ? 'split-row' : 'split-col' });
    n.children.forEach((c, i) => {
      const cell = h('div.dock-cell', { style: { flex: `${n.sizes[i]} 1 0px` } }, this._renderNode(c));
      el.appendChild(cell);
      if (i < n.children.length - 1) {
        const sp = h('div.dock-splitter');
        sp.addEventListener('pointerdown', (e) => this._dragSplitter(e, n, i, el));
        el.appendChild(sp);
      }
    });
    return el;
  }

  _renderGroup(g) {
    const tabs = h('div.dock-tabs');
    const body = h('div.dock-body');
    const el = h('div.dock-group', { dataset: { group: g.id } }, tabs, body);
    for (const id of g.panels) {
      const p = this.panels.get(id);
      const tab = h('div.dock-tab', { class: id === g.active ? 'active' : '', dataset: { panel: id }, title: p.title }, p.title);
      tab.addEventListener('pointerdown', (e) => this._tabPointerDown(e, g, id, tab));
      tab.addEventListener('dblclick', () => this.toggleMaximize(g.id));
      tabs.appendChild(tab);
      p.el.classList.toggle('active', id === g.active);
      body.appendChild(p.el);
    }
    tabs.appendChild(h('div.tab-spacer'));
    const menuBtn = h('button.icon-btn.group-menu', { type: 'button', title: 'Меню панели' }, icon('menu'));
    menuBtn.addEventListener('click', () =>
      openMenu(
        [
          { label: this.maximized === g.id ? 'Восстановить' : 'Развернуть', shortcut: '`', action: () => this.toggleMaximize(g.id) },
          { label: `Закрыть «${this.panels.get(g.active).title}»`, action: () => this.closePanel(g.active), disabled: () => ['program', 'timeline'].includes(g.active) },
          '-',
          { label: 'Сбросить раскладку', action: () => this.reset() },
        ],
        { anchor: menuBtn }
      )
    );
    tabs.appendChild(menuBtn);
    this.groupEls.set(g.id, el);
    return el;
  }

  _markFocus() {
    const f = store.ui.focusedPanel;
    for (const [id, el] of this.groupEls) {
      const g = this._groups().find((x) => x.id === id);
      el.classList.toggle('focused', !!g && g.active === f);
    }
  }

  _dragSplitter(e, node, i, splitEl) {
    e.preventDefault();
    const cells = [...splitEl.children].filter((c) => c.classList.contains('dock-cell'));
    const a = cells[i].getBoundingClientRect();
    const b = cells[i + 1].getBoundingClientRect();
    const horiz = node.dir === 'row';
    const total = horiz ? a.width + b.width : a.height + b.height;
    const pair = node.sizes[i] + node.sizes[i + 1];
    const startA = horiz ? a.width : a.height;
    const sp = e.currentTarget;
    sp.classList.add('dragging');
    dragPointer(e, {
      cursor: horiz ? 'col-resize' : 'row-resize',
      onMove: (dx, dy) => {
        const min = 40;
        const pa = Math.min(total - min, Math.max(min, startA + (horiz ? dx : dy)));
        node.sizes[i] = (pa / total) * pair;
        node.sizes[i + 1] = pair - node.sizes[i];
        cells[i].style.flex = `${node.sizes[i]} 1 0px`;
        cells[i + 1].style.flex = `${node.sizes[i + 1]} 1 0px`;
      },
      onUp: () => {
        sp.classList.remove('dragging');
        this.save();
      },
    });
  }

  // ---------- вкладки ----------

  activate(g, panelId) {
    g.active = panelId;
    const el = this.groupEls.get(g.id);
    if (el) {
      el.querySelectorAll('.dock-tab').forEach((t) => t.classList.toggle('active', t.dataset.panel === panelId));
      for (const id of g.panels) this.panels.get(id).el.classList.toggle('active', id === panelId);
    }
    const p = this.panels.get(panelId);
    requestAnimationFrame(() => {
      p.onShow?.();
      p.onResize?.();
    });
    store.setFocus(panelId);
    this._markFocus();
    this.save();
  }

  /** Показать панель (Window → …). Если закрыта — добавить в подходящую группу. */
  showPanel(panelId) {
    let g = this.findGroupOf(panelId);
    if (!g) {
      g = this.findGroupOf(panelId === 'program' ? 'source' : 'project') || this._firstGroup(this.tree);
      g.panels.push(panelId);
      this.render();
    }
    this.activate(g, panelId);
  }

  closePanel(panelId) {
    const g = this.findGroupOf(panelId);
    if (!g) return;
    g.panels = g.panels.filter((p) => p !== panelId);
    this.panels.get(panelId).el.remove();
    if (!g.panels.length) this.tree = this._removeGroup(this.tree, g) || defaultTree();
    else if (g.active === panelId) g.active = g.panels[0];
    this.render();
    this.save();
  }

  _removeGroup(n, g) {
    if (n === g) return null;
    if (n.type === 'group') return n;
    const kept = [];
    const sizes = [];
    n.children.forEach((c, i) => {
      const r = this._removeGroup(c, g);
      if (r) {
        kept.push(r);
        sizes.push(n.sizes[i]);
      }
    });
    if (!kept.length) return null;
    if (kept.length === 1) return kept[0];
    const sum = sizes.reduce((a, b) => a + b, 0);
    n.children = kept;
    n.sizes = sizes.map((s) => s / sum);
    return n;
  }

  toggleMaximize(groupId) {
    if (!groupId) {
      const g = this.findGroupOf(store.ui.focusedPanel);
      groupId = g?.id;
    }
    if (!groupId) return;
    for (const el of this.groupEls.values()) el.classList.remove('maximized');
    this.maximized = this.maximized === groupId ? null : groupId;
    if (this.maximized) this.groupEls.get(groupId)?.classList.add('maximized');
    requestAnimationFrame(() => {
      for (const p of this.panels.values()) if (p.el.isConnected && p.el.classList.contains('active')) p.onResize?.();
    });
  }

  _tabPointerDown(e, g, panelId, tab) {
    if (e.button !== 0) return;
    let dragging = false;
    let ghost = null;
    let target = null;
    const overlay = h('div.drop-overlay', h('div.zone'));
    dragPointer(e, {
      onMove: (dx, dy, ev) => {
        if (!dragging && Math.hypot(dx, dy) > 6) {
          dragging = true;
          ghost = h('div.dock-tab.active', { style: 'position:fixed;z-index:2000;pointer-events:none;background:#2a2b31;border:1px solid #f0a53a;height:26px;border-radius:4px' }, this.panels.get(panelId).title);
          document.body.appendChild(ghost);
          document.body.appendChild(overlay);
        }
        if (!dragging) return;
        ghost.style.left = ev.clientX + 10 + 'px';
        ghost.style.top = ev.clientY + 8 + 'px';
        target = this._dropTarget(ev.clientX, ev.clientY);
        const zone = overlay.firstChild;
        if (!target) {
          zone.style.display = 'none';
          return;
        }
        const r = target.rect;
        const box = { left: r.left, top: r.top, width: r.width, height: r.height };
        if (target.zone === 'left') box.width /= 2;
        if (target.zone === 'right') {
          box.left += r.width / 2;
          box.width /= 2;
        }
        if (target.zone === 'top') box.height /= 2;
        if (target.zone === 'bottom') {
          box.top += r.height / 2;
          box.height /= 2;
        }
        Object.assign(zone.style, { display: 'block', position: 'fixed', left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px' });
      },
      onUp: () => {
        ghost?.remove();
        overlay.remove();
        if (!dragging) {
          this.activate(g, panelId);
          return;
        }
        if (target) this.movePanel(panelId, target.group, target.zone);
      },
    });
  }

  _dropTarget(x, y) {
    for (const [id, el] of this.groupEls) {
      const r = el.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const g = this._groups().find((n) => n.id === id);
      const fx = (x - r.left) / r.width;
      const fy = (y - r.top) / r.height;
      let zone = 'center';
      if (y - r.top > 30) {
        const m = Math.min(fx, 1 - fx, fy, 1 - fy);
        if (m < 0.22) zone = m === fx ? 'left' : m === 1 - fx ? 'right' : m === fy ? 'top' : 'bottom';
      }
      return { group: g, zone, rect: r };
    }
    return null;
  }

  movePanel(panelId, targetGroup, zone) {
    const src = this.findGroupOf(panelId);
    if (!src || !targetGroup) return;
    if (src === targetGroup && (zone === 'center' || src.panels.length === 1)) return;
    src.panels = src.panels.filter((p) => p !== panelId);
    if (src.active === panelId) src.active = src.panels[0];
    if (zone === 'center') {
      targetGroup.panels.push(panelId);
      targetGroup.active = panelId;
    } else {
      const fresh = group([panelId]);
      const dir = zone === 'left' || zone === 'right' ? 'row' : 'col';
      const first = zone === 'left' || zone === 'top';
      const replacement = split(dir, first ? [fresh, { ...targetGroup }] : [{ ...targetGroup }, fresh]);
      this.tree = this._replace(this.tree, targetGroup, replacement);
    }
    if (!src.panels.length) this.tree = this._removeGroup(this.tree, src) || defaultTree();
    this.render();
    this.save();
    store.setFocus(panelId);
  }

  _replace(n, target, repl) {
    if (n === target) return repl;
    if (n.type === 'group') return n;
    n.children = n.children.map((c) => this._replace(c, target, repl));
    return n;
  }
}
