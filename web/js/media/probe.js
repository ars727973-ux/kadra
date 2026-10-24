// Анализ медиафайла: тип, длительность, разрешение, FPS, кодеки.
// Основной путь — mediabunny (читает контейнер: MP4/MOV/WebM/MKV/MP3/WAV/OGG…),
// запасной — метаданные HTMLMediaElement (без кодека).

import { loadMediabunny } from './libs.js';

export const ACCEPT = {
  video: ['mp4', 'm4v', 'webm', 'mov', 'mkv'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'weba'],
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'],
};

export const ACCEPT_ATTR = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'image/png',
  'image/jpeg',
  ...Object.values(ACCEPT)
    .flat()
    .map((e) => '.' + e),
].join(',');

const CODEC_NAMES = {
  avc: 'H.264',
  hevc: 'H.265',
  vp8: 'VP8',
  vp9: 'VP9',
  av1: 'AV1',
  prores: 'ProRes',
  aac: 'AAC',
  opus: 'Opus',
  mp3: 'MP3',
  vorbis: 'Vorbis',
  flac: 'FLAC',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
};

export function codecLabel(codec) {
  if (!codec) return null;
  if (codec.startsWith('pcm')) return 'PCM ' + codec.replace('pcm-', '').toUpperCase();
  return CODEC_NAMES[codec] || codec.toUpperCase();
}

export function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export function guessKind(file) {
  const t = file.type || '';
  const ext = extOf(file.name);
  if (t.startsWith('image/') || ACCEPT.image.includes(ext)) return 'image';
  if (t.startsWith('audio/') || ACCEPT.audio.includes(ext)) return 'audio';
  if (t.startsWith('video/') || ACCEPT.video.includes(ext)) return 'video';
  return null;
}

/** Анализ изображения. */
async function probeImage(file) {
  const bmp = await createImageBitmap(file);
  const info = { kind: 'image', width: bmp.width, height: bmp.height, duration: null, hasVideo: true, hasAudio: false, videoCodec: (extOf(file.name) || 'img').toUpperCase().replace('JPG', 'JPEG') };
  bmp.close?.();
  return info;
}

/** Метаданные через <video>/<audio> (запасной путь). */
function probeElement(file, kind) {
  return new Promise((resolve, reject) => {
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
    const url = URL.createObjectURL(file);
    el.preload = 'metadata';
    el.muted = true;
    const done = (fn) => {
      URL.revokeObjectURL(url);
      el.removeAttribute('src');
      el.load();
      fn();
    };
    el.onloadedmetadata = () =>
      done(() =>
        resolve({
          kind: kind === 'video' && el.videoWidth ? 'video' : 'audio',
          duration: el.duration,
          width: el.videoWidth || null,
          height: el.videoHeight || null,
          fps: null,
          hasVideo: !!el.videoWidth,
          hasAudio: true, // точно неизвестно — считаем, что есть
          videoCodec: null,
          audioCodec: null,
        })
      );
    el.onerror = () => done(() => reject(new Error('Браузер не может прочитать этот файл')));
    el.src = url;
  });
}

/** Анализ через mediabunny. */
async function probeContainer(file) {
  const M = await loadMediabunny();
  const input = new M.Input({ formats: M.ALL_FORMATS, source: new M.BlobSource(file) });
  try {
    const format = await input.getFormat();
    const v = await input.getPrimaryVideoTrack();
    const a = await input.getPrimaryAudioTrack();
    const duration = await input.computeDuration();
    const info = {
      kind: v ? 'video' : 'audio',
      container: format?.name || null,
      duration,
      hasVideo: !!v,
      hasAudio: !!a,
      width: null,
      height: null,
      fps: null,
      videoCodec: null,
      videoCodecString: null,
      audioCodec: null,
      audioSampleRate: null,
      audioChannels: null,
      canDecodeVideo: null,
    };
    if (v) {
      info.width = v.displayWidth;
      info.height = v.displayHeight;
      info.videoCodec = codecLabel(v.codec);
      info.videoCodecString = await v.getCodecParameterString().catch(() => null);
      info.rotation = v.rotation || 0;
      try {
        const stats = await v.computePacketStats(120);
        info.fps = Math.round(stats.averagePacketRate * 1000) / 1000;
        info.videoBitrate = stats.averageBitrate;
      } catch {
        /* FPS неизвестен */
      }
      info.canDecodeVideo = await v.canDecode().catch(() => false);
    }
    if (a) {
      info.audioCodec = codecLabel(a.codec);
      info.audioSampleRate = a.sampleRate;
      info.audioChannels = a.numberOfChannels;
    }
    return info;
  } finally {
    input.dispose?.();
  }
}

/** Главная функция анализа файла. */
export async function probeFile(file) {
  const kind = guessKind(file);
  if (!kind) throw new Error(`Неподдерживаемый формат: ${file.name}`);
  if (kind === 'image') return probeImage(file);
  let info = null;
  try {
    info = await probeContainer(file);
  } catch (err) {
    console.warn('[probe] mediabunny не смог прочитать файл, используем <video>', err);
  }
  // Если контейнер не распознан или нет длительности — спросим у браузера
  if (!info || !Number.isFinite(info.duration) || info.duration <= 0) {
    const el = await probeElement(file, kind);
    info = { ...(info || {}), ...el, videoCodec: info?.videoCodec ?? null, audioCodec: info?.audioCodec ?? null };
  }
  if (kind === 'audio') {
    info.kind = 'audio';
    info.hasVideo = false;
  }
  if (!info.hasVideo && !info.hasAudio) throw new Error(`В файле нет ни видео, ни звука: ${file.name}`);
  return info;
}
