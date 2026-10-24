// Ленивая загрузка внешних библиотек с CDN (версии закреплены в import map
// index.html и в config.js). Приложение стартует без них: библиотеки
// подгружаются при первом импорте медиа или экспорте.
//
//   mediabunny@1.62.1            — демультиплексирование, точное покадровое
//                                  декодирование (WebCodecs), мультиплексирование MP4/WebM
//   @mediabunny/aac-encoder@1.62.1 — WASM-кодировщик AAC для браузеров без нативного
//   @ffmpeg/core@0.12.10         — запасной путь кодирования H.264, если WebCodecs недоступен

let mediabunnyPromise = null;
let aacRegistered = false;

export function config() {
  return window.KADRA_CONFIG || {};
}

export function loadMediabunny() {
  if (!mediabunnyPromise) {
    mediabunnyPromise = import('mediabunny').catch((err) => {
      mediabunnyPromise = null;
      throw new Error(`Не удалось загрузить библиотеку mediabunny с CDN: ${err.message}`);
    });
  }
  return mediabunnyPromise;
}

/** Гарантирует наличие AAC-кодировщика. Возвращает 'native' | 'wasm'. */
export async function ensureAacEncoder(sampleRate = 48000, numberOfChannels = 2) {
  const M = await loadMediabunny();
  if (aacRegistered) return 'wasm';
  if (await M.canEncodeAudio('aac', { sampleRate, numberOfChannels, bitrate: 192000 })) return 'native';
  const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
  registerAacEncoder();
  aacRegistered = true;
  return 'wasm';
}

export function ffmpegUrls() {
  const c = config();
  return {
    coreURL: c.ffmpegCoreURL || 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js',
    wasmURL: c.ffmpegWasmURL || 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm',
  };
}

/** Есть ли WebCodecs (минимум для быстрого экспорта). */
export function hasWebCodecs() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}
