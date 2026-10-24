// Конфигурация развёртывания (редактируется без пересборки).
// Файл подключается до приложения и не обязателен — значения по умолчанию
// заданы в js/media/libs.js и js/storage/cloud.js.
window.KADRA_CONFIG = {
  // URL сервера (FastAPI на Render) по умолчанию. Пусто — локальный режим.
  // Пользователь может указать сервер в «Файл → Сервер…».
  serverUrl: '',

  // Ядро FFmpeg.wasm (запасной кодировщик). Закреплённая версия на jsDelivr.
  ffmpegCoreURL: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js',
  ffmpegWasmURL: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm',
};
