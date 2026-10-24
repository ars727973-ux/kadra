// Клиент необязательного сервера (FastAPI на Render): хранение проектов
// пользователя и медиаассетов. Без сервера редактор полностью работает
// локально (IndexedDB); этот модуль используется только из меню «Файл → Сервер».

import { idb } from './idb.js';
import { getMediaBlob, putMediaBlob } from './projectStore.js';
import { normalizeProject } from '../core/model.js';

const META_KEY = 'cloud';

function trimUrl(u) {
  return (u || '').trim().replace(/\/+$/, '');
}

export async function cloudSettings() {
  const saved = (await idb.meta(META_KEY)) || {};
  return { serverUrl: saved.serverUrl || window.KADRA_CONFIG?.serverUrl || '', token: saved.token || null, username: saved.username || null };
}

export async function setCloudSettings(patch) {
  const cur = await cloudSettings();
  const next = { ...cur, ...patch, serverUrl: trimUrl(patch.serverUrl ?? cur.serverUrl) };
  await idb.meta(META_KEY, next);
  return next;
}

async function api(path, { method = 'GET', json, body, token, serverUrl, raw = false } = {}) {
  const s = await cloudSettings();
  const base = trimUrl(serverUrl ?? s.serverUrl);
  if (!base) throw new Error('Сервер не настроен (Файл → Сервер…)');
  const headers = {};
  const tok = token === undefined ? s.token : token;
  if (tok) headers.Authorization = `Bearer ${tok}`;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  let res;
  try {
    res = await fetch(base + path, { method, headers, body });
  } catch (err) {
    throw new Error(`Сервер недоступен: ${err.message}`);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* */
    }
    const err = new Error(`${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  if (raw) return res;
  if (res.status === 204) return null;
  return res.json();
}

export const cloud = {
  async health(serverUrl) {
    return api('/api/health', { serverUrl, token: null });
  },

  async login(serverUrl, username, password, { register = false } = {}) {
    const data = await api(register ? '/api/auth/register' : '/api/auth/login', { method: 'POST', json: { username, password }, serverUrl, token: null });
    await setCloudSettings({ serverUrl, token: data.access_token, username: data.username });
    return data;
  },

  async logout() {
    await setCloudSettings({ token: null, username: null });
  },

  async me() {
    return api('/api/auth/me');
  },

  listProjects() {
    return api('/api/projects');
  },

  getProject(id) {
    return api(`/api/projects/${encodeURIComponent(id)}`);
  },

  putProject(project) {
    return api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'PUT', json: { name: project.name, data: project } });
  },

  deleteProject(id) {
    return api(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async lookupAsset(sha256) {
    try {
      return await api(`/api/assets/lookup?sha256=${sha256}`);
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  },

  /** Загрузка файла с прогрессом (XHR — у fetch нет прогресса отправки). */
  async uploadAsset(blob, filename, onProgress) {
    const s = await cloudSettings();
    const fd = new FormData();
    fd.append('file', blob, filename);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${trimUrl(s.serverUrl)}/api/assets`);
      if (s.token) xhr.setRequestHeader('Authorization', `Bearer ${s.token}`);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
        else reject(new Error(`Загрузка не удалась: ${xhr.status} ${xhr.responseText}`));
      };
      xhr.onerror = () => reject(new Error('Сеть недоступна'));
      xhr.send(fd);
    });
  },

  async downloadAsset(assetId) {
    const res = await api(`/api/assets/${encodeURIComponent(assetId)}`, { raw: true });
    return res.blob();
  },
};

async function sha256Hex(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Сохранить проект на сервер: сначала отсутствующие на сервере медиа
 * (дедупликация по SHA-256), затем JSON проекта со ссылками cloudAssetId.
 */
export async function saveProjectToCloud(project, { onProgress } = {}) {
  const updates = new Map(); // mediaId → cloudAssetId
  const total = project.media.length;
  let i = 0;
  for (const m of project.media) {
    onProgress?.(i / Math.max(1, total), `Медиа: ${m.name}`);
    if (!m.cloudAssetId) {
      const blob = await getMediaBlob(m.blobKey);
      if (!blob) throw new Error(`Файл «${m.name}» отсутствует локально — свяжите медиа перед загрузкой`);
      const sha = await sha256Hex(blob);
      let asset = await cloud.lookupAsset(sha);
      if (!asset) asset = await cloud.uploadAsset(blob, m.name, (p) => onProgress?.((i + p) / Math.max(1, total), `Загрузка: ${m.name}`));
      updates.set(m.id, asset.id);
    }
    i++;
  }
  const copy = structuredClone(project);
  for (const m of copy.media) if (updates.has(m.id)) m.cloudAssetId = updates.get(m.id);
  const s = await cloudSettings();
  copy.cloud = { serverUrl: s.serverUrl, syncedAt: new Date().toISOString() };
  await cloud.putProject(copy);
  onProgress?.(1, 'Готово');
  return { updates, cloud: copy.cloud };
}

/** Открыть проект с сервера: недостающие файлы скачиваются в IndexedDB. */
export async function openProjectFromCloud(id, { onProgress } = {}) {
  const rec = await cloud.getProject(id);
  const project = normalizeProject(rec.data);
  let i = 0;
  for (const m of project.media) {
    onProgress?.(i / Math.max(1, project.media.length), `Медиа: ${m.name}`);
    const local = m.blobKey ? await getMediaBlob(m.blobKey) : null;
    if (!local && m.cloudAssetId) {
      const blob = await cloud.downloadAsset(m.cloudAssetId);
      const file = new File([blob], m.name, { type: m.mime || blob.type });
      m.blobKey = await putMediaBlob(file);
    }
    i++;
  }
  onProgress?.(1, 'Готово');
  return project;
}
