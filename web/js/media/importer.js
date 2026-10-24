// Импорт файлов в проект: анализ → блоб в IndexedDB → запись media в проект →
// фоновая генерация превью и пиков.

import { store } from '../core/store.js';
import { uid } from '../core/ids.js';
import { putMediaBlob } from '../storage/projectStore.js';
import { guessKind, probeFile } from './probe.js';
import { mediaCache } from './mediaCache.js';

/**
 * Импортировать файлы. Возвращает массив созданных media.
 * onProgress(i, total, name) — для индикатора.
 */
export async function importFiles(files, { onProgress, onError } = {}) {
  const list = [...files].filter(Boolean);
  const created = [];
  const errors = [];
  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    onProgress?.(i, list.length, file.name);
    try {
      if (!guessKind(file)) throw new Error('формат не поддерживается');
      const info = await probeFile(file);
      const blobKey = await putMediaBlob(file);
      const media = {
        id: uid(),
        name: file.name,
        kind: info.kind,
        mime: file.type || '',
        size: file.size,
        lastModified: file.lastModified || null,
        blobKey,
        duration: info.kind === 'image' ? null : info.duration,
        width: info.width || null,
        height: info.height || null,
        fps: info.fps || null,
        container: info.container || null,
        videoCodec: info.videoCodec || null,
        videoCodecString: info.videoCodecString || null,
        audioCodec: info.audioCodec || null,
        audioSampleRate: info.audioSampleRate || null,
        audioChannels: info.audioChannels || null,
        hasVideo: !!info.hasVideo,
        hasAudio: !!info.hasAudio,
        markIn: null,
        markOut: null,
        importedAt: new Date().toISOString(),
        cloudAssetId: null,
      };
      mediaCache.setBlob(media, file);
      created.push(media);
    } catch (err) {
      console.error('[import]', file.name, err);
      errors.push({ name: file.name, error: err.message || String(err) });
      onError?.(file.name, err);
    }
  }
  if (created.length) {
    store.mutate(created.length > 1 ? `Импорт ${created.length} файлов` : `Импорт «${created[0].name}»`, (p) => {
      p.media.push(...created);
    });
    // фоновые превью/пики — не блокируют интерфейс
    for (const m of created) mediaCache.loadAux(m);
  }
  onProgress?.(list.length, list.length, '');
  return { created, errors };
}

/** Перелинковка «офлайн» медиа к выбранному файлу. */
export async function relinkMedia(mediaId, file) {
  const media = store.getMedia(mediaId);
  if (!media) return;
  const blobKey = await putMediaBlob(file);
  mediaCache.setBlob(media, file);
  store.mutate(`Связать «${media.name}»`, (p) => {
    const m = p.media.find((x) => x.id === mediaId);
    m.blobKey = blobKey;
    m.size = file.size;
  });
  const fresh = store.getMedia(mediaId);
  mediaCache.loadAux(fresh);
}

/** Удалить медиа из проекта вместе с клипами, которые на него ссылаются. */
export function removeMedia(ids) {
  const set = new Set(ids);
  store.mutate(set.size > 1 ? `Удалить ${set.size} элементов` : 'Удалить элемент', (p) => {
    p.media = p.media.filter((m) => !set.has(m.id));
    for (const s of p.sequences) for (const t of s.tracks) t.clips = t.clips.filter((c) => !set.has(c.mediaId));
  });
  for (const id of set) mediaCache.forget(id);
}
