// Запасной кодировщик: FFmpeg.wasm (libx264 + AAC → MP4).
// Кадры композиции сжимаются в JPEG и кодируются сегментами по ~4 секунды,
// чтобы ограничить расход памяти WASM; затем сегменты склеиваются без
// перекодирования (concat demuxer) вместе со звуком.

import { ffmpegUrls } from '../media/libs.js';

class FfmpegWorker {
  constructor() {
    this.worker = new Worker(new URL('../workers/ffmpeg-worker.js', import.meta.url));
    this.seq = 0;
    this.pending = new Map();
    this.onLog = null;
    this.worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'log') return this.onLog?.(msg.message);
      if (msg.type === 'progress') return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'Ошибка воркера FFmpeg'));
      this.pending.clear();
    };
  }

  call(type, payload, transfer = []) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload }, transfer);
    });
  }

  async exec(args) {
    const ret = await this.call('exec', { args });
    if (ret !== 0) throw new Error(`FFmpeg завершился с кодом ${ret}: ${args.join(' ')}`);
  }

  terminate() {
    this.worker.terminate();
  }
}

/** PCM 16-bit WAV из AudioBuffer. */
export function audioBufferToWav(buf) {
  const ch = buf.numberOfChannels;
  const len = buf.length;
  const data = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const w = (o, s) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  data.setUint32(4, 36 + len * ch * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, ch, true);
  data.setUint32(24, buf.sampleRate, true);
  data.setUint32(28, buf.sampleRate * ch * 2, true);
  data.setUint16(32, ch * 2, true);
  data.setUint16(34, 16, true);
  w(36, 'data');
  data.setUint32(40, len * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      data.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Uint8Array(data.buffer);
}

const pad = (n) => String(n).padStart(6, '0');

export async function encodeWithFfmpeg({ canvas, frameCount, fps, opts, mix, renderFrame, onProgress, check }) {
  onProgress({ phase: 'prepare', progress: 0.95, label: 'Загрузка FFmpeg.wasm (~32 МБ, один раз)' });
  const ff = new FfmpegWorker();
  try {
    await ff.call('load', ffmpegUrls());
    const segFrames = Math.max(1, Math.round(fps * 4));
    const segments = [];
    const kbps = Math.round(opts.videoBitrate / 1000);
    const started = performance.now();
    for (let segStart = 0, n = 0; segStart < frameCount; segStart += segFrames, n++) {
      const segEnd = Math.min(frameCount, segStart + segFrames);
      for (let i = segStart; i < segEnd; i++) {
        check();
        await renderFrame(i);
        const jpg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
        const data = new Uint8Array(await jpg.arrayBuffer());
        await ff.call('write', { path: `f${pad(i - segStart)}.jpg`, data }, [data.buffer]);
        const elapsed = (performance.now() - started) / 1000;
        onProgress({ phase: 'video', progress: (i + 1) / frameCount, frame: i + 1, frames: frameCount, eta: (elapsed / (i + 1)) * (frameCount - i - 1), label: `Кадр ${i + 1} из ${frameCount} (FFmpeg.wasm)` });
      }
      const seg = `seg${n}.mp4`;
      await ff.exec(['-framerate', String(fps), '-start_number', '0', '-i', 'f%06d.jpg', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`, '-bufsize', `${kbps * 2}k`, '-g', String(fps * 2), '-pix_fmt', 'yuv420p', '-r', String(fps), seg]);
      for (let i = segStart; i < segEnd; i++) await ff.call('unlink', { path: `f${pad(i - segStart)}.jpg` });
      segments.push(seg);
    }
    check();
    onProgress({ phase: 'finalize', progress: 1, label: 'Сборка файла (FFmpeg.wasm)' });
    const list = new TextEncoder().encode(segments.map((s) => `file '${s}'`).join('\n'));
    await ff.call('write', { path: 'list.txt', data: list });
    const args = ['-f', 'concat', '-safe', '0', '-i', 'list.txt'];
    if (mix) {
      await ff.call('write', { path: 'audio.wav', data: audioBufferToWav(mix) });
      args.push('-i', 'audio.wav', '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', `${Math.round(opts.audioBitrate / 1000)}k`, '-shortest');
    }
    args.push('-c:v', 'copy', '-movflags', '+faststart', 'out.mp4');
    await ff.exec(args);
    const out = await ff.call('read', { path: 'out.mp4' });
    return { blob: new Blob([out], { type: 'video/mp4' }), audioEncoder: mix ? 'ffmpeg-aac' : null, extension: 'mp4' };
  } finally {
    ff.terminate();
  }
}
