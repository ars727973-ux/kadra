// Воркер FFmpeg.wasm (однопоточное ядро @ffmpeg/core, без SharedArrayBuffer —
// работает на GitHub Pages без заголовков COOP/COEP).
//
// Собственный минимальный воркер вместо пакета @ffmpeg/ffmpeg: классический
// воркер может загрузить ядро с CDN через importScripts(), а модульный воркер
// пакета не грузится с чужого origin.
//
// Протокол: {id, type, payload} → {id, result} | {id, error}; события {type:'log'|'progress'}.

/* eslint-env worker */
let core = null;

self.onmessage = async (e) => {
  const { id, type, payload } = e.data || {};
  try {
    let result = true;
    const transfer = [];
    switch (type) {
      case 'load': {
        if (!core) {
          importScripts(payload.coreURL);
          // ядро ищет путь к .wasm в JSON после «#» в mainScriptUrlOrBlob
          const hash = btoa(JSON.stringify({ wasmURL: payload.wasmURL }));
          core = await self.createFFmpegCore({ mainScriptUrlOrBlob: `${payload.coreURL}#${hash}` });
          core.setLogger(({ type: kind, message }) => self.postMessage({ type: 'log', kind, message }));
          core.setProgress(({ progress, time }) => self.postMessage({ type: 'progress', progress, time }));
        }
        break;
      }
      case 'exec': {
        core.setTimeout(-1);
        core.exec(...payload.args);
        result = core.ret;
        core.reset();
        break;
      }
      case 'write':
        core.FS.writeFile(payload.path, payload.data);
        break;
      case 'read': {
        const data = core.FS.readFile(payload.path);
        result = data;
        transfer.push(data.buffer);
        break;
      }
      case 'unlink':
        try {
          core.FS.unlink(payload.path);
        } catch {
          result = false;
        }
        break;
      default:
        throw new Error('Неизвестная команда ' + type);
    }
    self.postMessage({ id, result }, transfer);
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
