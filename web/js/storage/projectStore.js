// Сохранение проектов в IndexedDB, экспорт/импорт JSON, автосохранение.

import { idb } from './idb.js';
import { uid } from '../core/ids.js';
import { normalizeProject, PROJECT_FORMAT } from '../core/model.js';

const LAST_PROJECT_KEY = 'lastProjectId';

export async function saveProject(project) {
  const copy = structuredClone(project);
  copy.updatedAt = new Date().toISOString();
  await idb.put('projects', copy);
  await idb.meta(LAST_PROJECT_KEY, copy.id);
  project.updatedAt = copy.updatedAt;
  return copy;
}

export async function loadProject(id) {
  const p = await idb.get('projects', id);
  return p ? normalizeProject(p) : null;
}

export async function lastProjectId() {
  return idb.meta(LAST_PROJECT_KEY);
}

export async function listProjects() {
  const all = await idb.getAll('projects');
  return all
    .map((p) => ({
      id: p.id,
      name: p.name,
      updatedAt: p.updatedAt,
      mediaCount: p.media?.length || 0,
      sequences: p.sequences?.length || 0,
    }))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function deleteProject(id, keepProject = null) {
  await idb.delete('projects', id);
  await collectGarbage(keepProject);
}

// ---------- блобы медиа ----------

export async function putMediaBlob(file) {
  const key = uid('blob');
  await idb.put('media', { key, blob: file, name: file.name, type: file.type, size: file.size, lastModified: file.lastModified || Date.now() });
  return key;
}

export async function getMediaBlob(key) {
  if (!key) return null;
  const rec = await idb.get('media', key);
  return rec?.blob || null;
}

export async function hasMediaBlob(key) {
  if (!key) return false;
  // Blob из IndexedDB читается лениво, поэтому get() дёшев
  return !!(await idb.get('media', key));
}

export async function putAux(id, data) {
  await idb.put('aux', { id, ...data });
}

export async function getAux(id) {
  return idb.get('aux', id);
}

/** Удалить блобы и aux-данные, на которые не ссылается ни один проект. */
export async function collectGarbage(currentProject = null) {
  const projects = await idb.getAll('projects');
  if (currentProject) projects.push(currentProject);
  const usedBlobs = new Set();
  const usedMedia = new Set();
  for (const p of projects) {
    for (const m of p.media || []) {
      if (m.blobKey) usedBlobs.add(m.blobKey);
      usedMedia.add(m.id);
    }
  }
  for (const key of await idb.getAllKeys('media')) if (!usedBlobs.has(key)) await idb.delete('media', key);
  for (const key of await idb.getAllKeys('aux')) if (!usedMedia.has(key)) await idb.delete('aux', key);
}

// ---------- JSON ----------

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 4000);
}

export function safeFileName(name) {
  return (name || 'project').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'project';
}

export function projectToJSON(project) {
  const copy = structuredClone(project);
  copy.exportedAt = new Date().toISOString();
  return JSON.stringify(copy, null, 2);
}

export function exportProjectJSON(project) {
  const blob = new Blob([projectToJSON(project)], { type: 'application/json' });
  downloadBlob(blob, `${safeFileName(project.name)}.kadra.json`);
}

/** Прочитать проект из JSON-файла. Если такой id уже есть — выдаётся новый. */
export async function readProjectJSON(file) {
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Файл не является корректным JSON');
  }
  if (data.format !== PROJECT_FORMAT) throw new Error('Это не файл проекта Kadra (.kadra.json)');
  const project = normalizeProject(data);
  delete project.exportedAt;
  const exists = await idb.get('projects', project.id);
  if (exists) project.id = uid();
  return project;
}

// ---------- автосохранение ----------

/**
 * Автосохранение каждые intervalMs (по умолчанию 60 с) и при скрытии вкладки.
 * getState() → { project, dirty }, onSaved() вызывается после успешной записи.
 */
export class Autosave {
  constructor({ save, isDirty, intervalMs = 60000 }) {
    this.save = save;
    this.isDirty = isDirty;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.saving = null;
    this._onVis = () => {
      if (document.visibilityState === 'hidden') this.flush('hidden');
    };
    this._onHide = () => this.flush('pagehide');
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.flush('interval'), this.intervalMs);
    document.addEventListener('visibilitychange', this._onVis);
    window.addEventListener('pagehide', this._onHide);
  }

  stop() {
    clearInterval(this.timer);
    document.removeEventListener('visibilitychange', this._onVis);
    window.removeEventListener('pagehide', this._onHide);
  }

  async flush(reason = 'manual') {
    if (!this.isDirty()) return false;
    if (this.saving) return this.saving;
    this.saving = (async () => {
      try {
        await this.save(reason);
        return true;
      } catch (err) {
        console.error('[autosave]', err);
        return false;
      } finally {
        this.saving = null;
      }
    })();
    return this.saving;
  }
}
