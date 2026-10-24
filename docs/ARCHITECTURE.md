# Kadra — архитектура и подключение этапа 2

## 1. Слои приложения

```
┌──────────────────────────── UI (js/ui) ────────────────────────────┐
│ DockLayout (докинг)  Menubar  Dialogs  Panels: Project · Source ·   │
│ Program · Timeline · Effect Controls · Effects · Meters · History…  │
└───────────────┬─────────────────────────────────────┬───────────────┘
                │ действия (app.js: меню = клавиши)   │ события store
┌───────────────▼──────────────┐   ┌──────────────────▼──────────────┐
│ core/                        │   │ engine/                          │
│  store  — проект + UI-state  │   │  layers      — какие клипы видны │
│  history — Command / undo    │──►│  compositor  — кадр на Canvas    │
│  timelineOps — монтаж        │   │  previewSources / exportSources  │
│  model, keyframes, time      │   │  audioEngine — граф WebAudio     │
└───────────────┬──────────────┘   │  transport   — мастер-часы, JKL  │
                │                  │  exporter    — WebCodecs / FFmpeg│
┌───────────────▼──────────────┐   └──────────────────┬──────────────┘
│ storage/  IndexedDB, JSON,   │                      │
│ автосохранение, cloud-клиент │   ┌──────────────────▼──────────────┐
└──────────────────────────────┘   │ plugins/registry — эффекты,      │
┌──────────────────────────────┐   │ переходы, генераторы, пресеты    │
│ media/  probe, importer,     │   │ (ЭТАП 2 = регистрация плагинов)  │
│ mediaCache (спрайты, пики)   │   └─────────────────────────────────┘
└──────────────────────────────┘
```

Принципы:

* **Единственный источник правды** — `store.project` (JSON). Панели не хранят
  копий данных: они подписаны на события `change`, `selection`, `playhead`.
* **Все изменения — через `store.mutate(label, fn)`**: так они попадают в
  undo/redo, помечают проект для автосохранения и перерисовывают UI.
* **Монтажные операции — чистые функции** (`core/timelineOps.js`) над
  секвенцией. Таймлайн во время перетаскивания применяет ту же функцию к копии
  секвенции (превью результата), а при отпускании — к настоящей.
* **Один конвейер кадра для превью и экспорта** (`engine/layers.js` +
  `engine/compositor.js`); различаются только источники кадров: `<video>` в
  превью и точное декодирование WebCodecs (mediabunny) в экспорте. Аналогично
  звук: `buildAudioGraph()` строит граф и для `AudioContext`, и для
  `OfflineAudioContext`.

## 2. Модель данных

```jsonc
{
  "format": "kadra-project", "version": 1,
  "id": "uuid", "name": "Мой проект",
  "settings": { "defaultImageDuration": 5, "defaultScaling": "fit" },
  "media": [{
    "id": "uuid", "name": "clip1.mp4", "kind": "video",       // video | audio | image
    "blobKey": "blob_uuid",                                   // ключ файла в IndexedDB (store "media")
    "duration": 4.0, "width": 1920, "height": 1080, "fps": 30,
    "videoCodec": "H.264", "audioCodec": "AAC", "hasVideo": true, "hasAudio": true,
    "markIn": null, "markOut": null,                          // In/Out монитора «Источник»
    "cloudAssetId": null                                      // id ассета на сервере
  }],
  "activeSequenceId": "uuid",
  "sequences": [{
    "id": "uuid", "name": "Секвенция 01", "width": 1920, "height": 1080, "fps": 30, "sampleRate": 48000,
    "inPoint": null, "outPoint": null, "playhead": 0,
    "markers": [{ "id": "…", "time": 2.0, "duration": 0, "name": "Сцена 1", "color": "#5bb974", "comment": "" }],
    "transitions": [],                                        // ЭТАП 2: { type, trackId, at, duration, alignment, params }
    "tracks": [{
      "id": "…", "kind": "video", "name": "V1", "locked": false, "hidden": false,
      "muted": false, "solo": false, "volume": 1, "pan": 0, "effects": [], "height": 54,
      "clips": [{
        "id": "…", "kind": "video", "mediaId": "uuid", "name": "clip1.mp4",
        "start": 0,        // позиция на таймлайне, с
        "in": 0, "out": 4, // диапазон исходника, с;  длительность = (out - in) / speed
        "speed": 1, "enabled": true, "linkId": "lnk_…",       // связь видео+звук
        "scaling": "fit",                                     // none | fit | fill
        "transform": { "position": [960, 540], "scale": 100, "uniformScale": true, "scaleWidth": 100,
                       "rotation": 0, "anchor": [960, 540], "opacity": 100, "blend": "normal" },
        "effects": [],     // ЭТАП 2: [{ id, type, enabled, params }]
        "generator": null  // ЭТАП 2: синтетический клип (титр/цвет) { type, params }
      }]
    }]
  }]
}
```

Время хранится в секундах; все правки квантуются по кадровой сетке секвенции
(`snapToFrame`). Любой числовой параметр (`transform.*`, `audio.volume`,
`effects[].params.*`) может быть статическим значением **или анимацией**
`{ "kf": [{ "t": 0, "v": 100, "ease": "linear" }, …] }` — рендерер и
аудиодвижок уже вызывают `resolveParam()` на каждый кадр (`core/keyframes.js`).

Хранилище IndexedDB `kadra`: `projects` (JSON), `media` (Blob файлов),
`aux` (спрайты превью и пики аудио — не попадают в JSON и в undo), `meta`.

## 3. Undo / Redo

`core/history.js` — командная модель: `Command { do(), undo() }`.
`store.mutate()` создаёт `SnapshotCommand` с «слепками» проекта до и после
операции (JSON-строки по несколько КБ, т.к. тяжёлые данные вынесены в `aux`).
Глубина — 200 шагов. Непрерывные жесты (перетаскивание числа, рамки) с
одинаковым `mergeKey` склеиваются в один шаг. Для особых случаев этапа 2
можно добавить свою команду: `store.history.push(new MyCommand())`.

## 4. Воспроизведение

* Мастер-часы — `AudioContext.currentTime` (с поправкой на `outputLatency`).
* Звук: для каждого аудиоклипа — `AudioBufferSourceNode` → [эффекты клипа] →
  Gain (громкость) → StereoPanner → шина дорожки (громкость, mute/solo,
  [эффекты дорожки]) → мастер → анализаторы L/R → выход.
* Видео: у каждого видимого клипа свой скрытый `<video>` (аппаратное
  декодирование), его время подтягивается к мастер-часам мягкой коррекцией
  `playbackRate`, при расхождении > 250 мс — seek. Клипы, начинающиеся в
  ближайшие 2 с, заранее открываются и позиционируются. Каждый кадр `Compositor`
  рисует слои на Canvas 2D. На паузе элементы позиционируются точным seek.

## 5. Экспорт

1. Звук всей секвенции сводится `OfflineAudioContext` тем же графом, что и в превью.
2. Для каждого видеоклипа заранее вычисляется монотонный список временных меток
   исходника на все кадры экспорта; `CanvasSink.canvasesAtTimestamps()`
   (mediabunny/WebCodecs) декодирует каждый пакет максимум один раз.
3. Кадр композиции рисуется на `OffscreenCanvas` и кодируется
   `CanvasSource` (H.264/VP9), звук — секундными кусками `AudioBufferSource`
   (AAC: нативный или WASM-кодировщик; Opus для WebM). Контейнер MP4 — fast start.
4. Запасной путь: если `VideoEncoder` не умеет H.264 — FFmpeg.wasm в воркере,
   JPEG-кадры сегментами по 4 с → libx264, склейка concat-демуксером + AAC.

## 6. Как подключить ЭТАП 2

Точка входа — `web/js/plugins/index.js`. Плагин регистрируется в реестре
`plugins` (`web/js/plugins/registry.js`). Зарегистрированный **эффект**
(видео или аудио) после этого автоматически:

* появляется в панели «Эффекты» (перетаскивание на клип или двойной щелчок);
* получает UI параметров в «Параметрах эффектов» (строится по схеме `params`);
* применяется в превью **и** в экспорте (общий `Compositor` / `buildAudioGraph`);
* сохраняется в проекте и участвует в undo/redo.

**Переходы и генераторы** движок рендерит сразу после регистрации (если они
есть в `seq.transitions` / `clip.generator`), а также показывает их в каталоге
«Эффекты». На этапе 2 к ним добавляется только интерфейс создания: бросок
перехода на склейку таймлайна и команда «Новый титр».

Типы параметров схемы: `number` (`min/max/step/unit/digits`), `select`
(`options: [[value, label]]`), `checkbox`, `color`, `text`.

### Видеоэффект (например, «Яркость/контраст», Lumetri-подобный «Color»)

```js
// web/js/plugins/builtin/color.js
import { plugins } from '../registry.js';

plugins.registerEffect({
  type: 'color-basic',
  name: 'Цвет: основное',
  category: 'Цветокоррекция',
  params: [
    { key: 'exposure', label: 'Экспозиция', type: 'number', min: -5, max: 5, step: 0.01, default: 0 },
    { key: 'contrast', label: 'Контраст', type: 'number', min: -100, max: 100, default: 0 },
    { key: 'saturation', label: 'Насыщенность', type: 'number', min: 0, max: 200, default: 100, unit: '%' },
  ],
  // frame = { canvas, ctx, width, height } — слой клипа в пикселях исходника
  apply(frame, p) {
    const { ctx } = frame;
    // Canvas 2D-фильтры работают на GPU; для кривых/LUT — WebGL на frame.canvas
    const tmp = new OffscreenCanvas(frame.width, frame.height);
    const t = tmp.getContext('2d');
    t.filter = `brightness(${2 ** p.exposure}) contrast(${100 + p.contrast}%) saturate(${p.saturation}%)`;
    t.drawImage(frame.canvas, 0, 0);
    return tmp; // можно вернуть новый холст того же размера
  },
});
```

### Переход (cross dissolve, dip to black/white, wipe, slide)

```js
plugins.registerTransition({
  type: 'cross-dissolve',
  name: 'Перекрёстное растворение',
  defaultDuration: 1,
  // a, b — полнокадровые слои уходящего и входящего клипа (с эффектами и «Движением»)
  render(ctx, a, b, progress) {
    ctx.globalAlpha = 1;
    ctx.drawImage(a, 0, 0);
    ctx.globalAlpha = progress;
    ctx.drawImage(b, 0, 0);
    ctx.globalAlpha = 1;
  },
});
// Переход добавляется в секвенцию: seq.transitions.push({ id, type: 'cross-dissolve',
//   trackId, at: <время склейки>, duration: 1, alignment: 'center', params: {} })
// Движок уже берёт кадры за пределами клипов из «ручек» медиа (layers.js).
```

### Титры (генератор)

```js
plugins.registerGenerator({
  type: 'text',
  name: 'Текст',
  params: [
    { key: 'text', label: 'Текст', type: 'text', default: 'Заголовок' },
    { key: 'size', label: 'Размер', type: 'number', min: 8, max: 400, default: 96 },
    { key: 'color', label: 'Цвет', type: 'color', default: '#ffffff' },
  ],
  size: (params, seq) => [seq.width, seq.height],
  render({ ctx, width, height }, p) {
    ctx.fillStyle = p.color;
    ctx.font = `700 ${p.size}px system-ui`;
    ctx.textAlign = 'center';
    ctx.fillText(p.text, width / 2, height / 2);
  },
});
// Клип-титр: createClip({ kind: 'video', generator: { type: 'text', params: {...} }, ... })
```

### Аудиоэффект (эквалайзер, fade)

```js
plugins.registerEffect({
  type: 'eq3', name: 'Эквалайзер (3 полосы)', target: 'audio', category: 'Фильтры',
  params: [{ key: 'low', label: 'Низкие, дБ', type: 'number', min: -24, max: 24, default: 0 }],
  createNode(ctx, p) {
    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf'; low.frequency.value = 250; low.gain.value = p.low;
    return { input: low, output: low, update: (q) => (low.gain.value = q.low) };
  },
});
```

### Ключевые кадры

Данные и интерполяция уже есть (`core/keyframes.js`: `linear`, `hold`,
`ease`). Этап 2 добавляет UI: секундомер у параметра в «Параметрах эффектов»
превращает значение в `{ kf: [...] }`, мини-таймлайн справа показывает точки.
Рендерер (`clipGeometry`, `resolveAll`) и звук (`applyParam` →
`linearRampToValueAtTime`) менять не нужно.

### Пресеты экспорта

```js
plugins.registerExportPreset({ id: 'yt-1080', name: 'YouTube 1080p', settings: { width: 1920, height: 1080, fps: 30, videoBitrate: 12e6, audioBitrate: 256e3, format: 'mp4' } });
plugins.registerExportPreset({ id: 'uhd', name: '4K UHD', settings: { width: 3840, height: 2160, fps: 30, videoBitrate: 45e6, audioBitrate: 320e3, format: 'mp4' } });
```

Список «Пресет» в диалоге экспорта появляется автоматически.

Работоспособность этой цепочки проверена e2e-тестом: тестовый эффект
инверсии и переход-растворение, зарегистрированные «на лету», появились в
«Параметрах эффектов», изменили кадр превью и корректно рассчитали прогресс
перехода (см. `docs/TEST_REPORT.md`, шаг «Архитектура этапа 2»).
