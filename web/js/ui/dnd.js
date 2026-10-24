// Общий канал drag&drop между панелями (Project/Source → Timeline).
// Во время dragover браузер не даёт прочитать dataTransfer, поэтому полезная
// нагрузка хранится здесь.

export const MEDIA_MIME = 'application/x-kadra-media';

export const dnd = {
  /** { mediaIds:[...], takeVideo, takeAudio, inPoint?, outPoint? } */
  payload: null,
  effectType: null, // перетаскивание эффекта из панели Effects (этап 2)
};

export function startMediaDrag(e, payload) {
  dnd.payload = payload;
  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData(MEDIA_MIME, JSON.stringify(payload));
  e.dataTransfer.setData('text/plain', 'kadra-media');
}

export function endMediaDrag() {
  dnd.payload = null;
}
