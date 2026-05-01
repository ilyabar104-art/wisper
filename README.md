# Wisper

Локальная диктовка для macOS и Windows — лёгкий аналог Superwhisper / WhisperFlow.
Работает полностью офлайн: запись с микрофона → транскрипция через Whisper Large-v3-turbo
(или любую другую GGML-модель) → автоматическая вставка текста в активное приложение.

## Возможности

- **Hold-to-talk** глобальный хоткей с поддержкой **любых сочетаний клавиш**
  (буквы, цифры, F1–F19, стрелки, модификаторы — в любом порядке):
  - **macOS** — нативный Objective-C хелпер `hotkey-tap` использует CGEventTap в
    active-режиме (`kCGEventTapOptionDefault`) и **поглощает** keyDown/keyUp для
    целевых клавиш. Space, Tab, ` в комбо больше не печатают символы в активное
    приложение — как у Superwhisper. `flagsChanged` для модификаторов **никогда
    не поглощается**, чтобы не портить системный трекинг состояния модификаторов
    (иначе синтетический Cmd+V после диктовки превращается в Cmd+Alt+V).
  - **Windows / Linux** — fallback на `uiohook-napi` (passive listener).
- **Whisper Large-v3-turbo** через **`whisper-server`** из
  [whisper.cpp](https://github.com/ggerganov/whisper.cpp) с Metal-ускорением на
  Apple Silicon. Сервер запускается **один раз** при старте приложения и держит
  модель загруженной — каждая последующая диктовка ~150–400 мс вместо ~1с со
  spawn-per-request подходом. Доступны tiny / base / small / medium / large-v3 /
  large-v3-turbo в квантизациях q5_0/q5_1/f16.
- **Автовставка** транскрипции в активное поле:
  - **macOS** — `hotkey-tap` принимает stdin-команду `PASTE` и инжектирует Cmd+V
    через `CGEventPost(kCGHIDEventTap)` на HID-уровне. Это работает в **любом**
    приложении, включая Electron-based (VSCode, Telegram, Slack), которые
    игнорируют AppleScript `keystroke` через Accessibility API. На время вставки
    `hotkey-tap` ставится на паузу, чтобы не видеть собственные синтетические
    события.
  - **Windows** — PowerShell `[System.Windows.Forms.SendKeys]::SendWait("^v")`.
  - **Linux** — `xdotool key ctrl+v`.
  - Предыдущий буфер обмена восстанавливается через 600 мс.
  - Если нет Accessibility-разрешения — текст просто кладётся в clipboard, в UI
    показывается баннер с кнопкой открытия системных настроек.
- **Прогресс-индикатор** во время транскрипции: счётчик прошедшего времени и
  анимированный progress-bar; в блоке результата отображается итоговое время
  (`Last transcription (0.3s)`).
- **Менеджер моделей** в UI: список GGML-моделей с размером, кнопкой Download
  (стрим с прогресс-баром с HuggingFace) и переключением активной модели без перезапуска.
- **Настройки в UI**: вкладка Settings для смены хоткея (capture-режим — зажми
  нужные клавиши), языка распознавания и автовставки. Изменения применяются мгновенно.
- **История транскрипций** в SQLite с полнотекстовым поиском (FTS5):
  поиск по подстроке, копирование, удаление.
- **Tray-иконка** в menubar: серый кружок в покое, красный во время записи.
- **Запись микрофона**: `getUserMedia` + `AudioWorkletNode` (singleton AudioContext,
  чтобы не плодить аудио-потоки) → Float32 → линейный ресемплинг до 16 kHz mono →
  PCM16 WAV в памяти → передача в main по IPC.
- **Кросс-платформенность**: macOS (Apple Silicon + Intel) и Windows 10/11.
  Linux — частичная (требуется `xdotool`).

## Архитектура

```
wisper/
├── electron/
│   ├── main.ts            # окно, tray, IPC, запрос permissions, hotkey lifecycle
│   ├── preload.ts         # contextBridge → window.wisper
│   ├── hotkey.ts          # диспетчер: macOS → hotkey-tap, остальные → uiohook-napi
│   ├── whisper.ts         # whisper-server lifecycle + HTTP клиент (multipart)
│   ├── paste.ts           # cross-platform автовставка (macOS — через nativePaste)
│   ├── models.ts          # каталог GGML-моделей + загрузка с HuggingFace
│   ├── history.ts         # SQLite + FTS5 (better-sqlite3)
│   ├── settings.ts        # JSON-настройки в userData
│   └── paths.ts           # cross-platform пути к бинарям/моделям/БД
├── renderer/
│   ├── App.tsx            # вкладки Dictate / Models / History / Settings
│   ├── recorder.ts        # MicRecorder: AudioWorklet → 16 kHz mono PCM16 WAV
│   ├── components/
│   │   ├── ModelPicker.tsx
│   │   ├── History.tsx
│   │   └── Settings.tsx   # capture-режим хоткея, выбор языка, toggle автовставки
│   └── styles.css
├── native/
│   └── hotkey-tap.m       # Objective-C: CGEventTap active-режим + PASTE команда
│                          #   (CGEventPost для Cmd+V в HID-поток)
├── scripts/
│   ├── setup-whisper.sh   # сборка whisper.cpp с Metal (macOS)
│   └── setup-whisper.ps1  # сборка whisper.cpp на Windows (CPU/CUDA/Vulkan)
├── resources/bin/         # whisper-cli + whisper-server + dylibs + hotkey-tap
├── build/                 # entitlements для подписи macOS
└── electron.vite.config.ts
```

### Поток данных при диктовке

0. **При старте приложения:** main процесс спавнит `whisper-server` на свободном
   localhost-порту с активной моделью. Сервер один раз грузит модель + Metal
   (~700 мс) и держит её в памяти до закрытия приложения.
1. **macOS:** `hotkey-tap` ловит keyDown/flagsChanged через CGEventTap. Если
   нажатые клавиши совпадают с целевым комбо — keyDown/keyUp поглощаются,
   `flagsChanged` модификаторов всегда пропускаются. На stdout пишется `DOWN`.
   **Win/Linux:** `uiohook-napi` просто наблюдает.
2. Main процесс читает stdout subprocess'a → IPC `hotkey-down` → renderer.
3. Renderer запускает `MicRecorder.start()`: получает поток с микрофона
   (16 kHz mono), `AudioWorkletNode` накапливает Float32 чанки.
4. На keyUp → IPC `hotkey-up` → `recorder.stop()` собирает чанки, кодирует WAV
   → отдаёт `ArrayBuffer` в main через `wisper.transcribe()`.
5. Main отправляет WAV multipart-POST'ом на `http://127.0.0.1:<port>/inference`,
   получает `{ text }` JSON. Никаких файлов на диске — всё в памяти.
6. Текст → SQLite history → clipboard.
7. **macOS автовставка:** main шлёт `PASTE\n` в stdin `hotkey-tap`, тот вызывает
   `CGEventPost` для Cmd+V на HID-уровне (работает в любом приложении). На
   время вставки `hotkey-tap` ставится на паузу (`SET\n` с пустым списком),
   чтобы не видеть собственные синтетические события.

### IPC API (preload → renderer)

```ts
window.wisper = {
  // recording / transcription
  transcribe(wav: ArrayBuffer): Promise<{ text, durationMs }>,
  notifyRecordingState(on: boolean): void,
  onHotkeyDown(cb), onHotkeyUp(cb),

  // models
  listModels(), downloadModel(id), onModelProgress(cb),
  setActiveModel(id), getActiveModel(),

  // history
  historyList(query?), historyDelete(id),

  // settings
  getSettings(), setSettings(patch),
  listHotkeys(),

  // permissions (macOS)
  checkAccessibility(), openAccessibilitySettings(),
}
```

## Стек

| Слой | Технология |
|------|-----------|
| Runtime | Electron 33 (ESM main + preload, sandbox off), Node 20+ |
| Bundler | electron-vite 5 + Vite 6 |
| UI | React 19 + TypeScript |
| Whisper backend | whisper.cpp (Metal на macOS, CPU/CUDA/Vulkan на Windows) |
| Глобальные хоткеи (macOS) | Нативный CGEventTap-хелпер на Objective-C |
| Глобальные хоткеи (Win/Linux) | uiohook-napi |
| Аудио | AudioWorklet + singleton AudioContext (16 kHz mono) |
| БД | better-sqlite3 + FTS5 |
| Упаковка | electron-builder (.dmg, NSIS) |

## Требования

- **macOS** 12+ (Apple Silicon рекомендуется) или **Windows 10/11**
- Node.js 20+ и npm
- macOS: `cmake` + Xcode Command Line Tools (`brew install cmake`), `clang`
- Windows: CMake + Visual Studio 2022 Build Tools (C++ workload), Git

## Установка и запуск

### macOS

```bash
npm install
npm run setup:whisper      # сборка whisper-cli с Metal в resources/bin/
npm run setup:hotkey-tap   # компиляция CGEventTap-хелпера
npm run rebuild            # пересборка native-модулей под Electron
npm run dev
```

При первом запуске:
1. Разрешить доступ к **микрофону**.
2. **System Settings → Privacy & Security → Accessibility** → включить Wisper
   (нужно и для CGEventTap, и для автовставки). При отсутствии разрешения в UI
   появляется баннер с кнопкой открытия настроек.
3. Открыть вкладку **Models**, скачать `large-v3-turbo (q5_0)` (~547 МБ).
4. Открыть **Settings**, при необходимости задать другой хоткей через
   **Record new hotkey** (зажми нужные клавиши, отпусти — комбо запишется).
5. Удерживать хоткей, говорить, отпустить — текст вставится в активное поле.

### Windows

```powershell
npm install
npm run setup:whisper:win
npm run rebuild
npm run dev
```

Заметки:
- Хоткей `RightAlt` на многих раскладках = AltGr — поменяй в Settings.
- На Windows используется `uiohook-napi` (passive). Для комбо рекомендуется
  ограничиваться модификаторами (Alt/Ctrl/Shift).
- Для GPU-ускорения добавь `-DGGML_CUDA=ON` или `-DGGML_VULKAN=ON` в
  [scripts/setup-whisper.ps1](scripts/setup-whisper.ps1).

## Сборка инсталляторов

```bash
npm run dist        # macOS: .dmg в release/
npm run dist:win    # Windows: NSIS .exe (запускать на Windows)
```

## Настройки

Файл `<userData>/settings.json`:

```json
{
  "activeModelId": "large-v3-turbo-q5_0",
  "hotkey": "LeftAlt+Space",
  "pasteAfterTranscribe": true,
  "language": "auto"
}
```

Hotkey — строка вида `Key1+Key2+...`, порядок не важен. Поддерживаются:

- Модификаторы: `LeftAlt`, `RightAlt`, `LeftCtrl`, `RightCtrl`, `LeftShift`,
  `RightShift`, `CapsLock`, `Fn`
- Клавиши символов (только macOS поглощает их корректно): `Space`, `Tab`, `Backquote`
- Функциональные: `F13`–`F19`

Примеры: `RightAlt`, `LeftAlt+Space`, `RightCtrl+RightShift`, `Fn+F13`.

## Расположение данных

- `<userData>/models/` — скачанные GGML-модели
- `<userData>/audio/` — временные WAV (удаляются после транскрипции)
- `<userData>/history.db` — SQLite с историей и FTS5-индексом
- `<userData>/settings.json` — настройки

`<userData>` на macOS = `~/Library/Application Support/Wisper`,
на Windows = `%APPDATA%\Wisper`.

## Что осталось

- Подпись и нотаризация для дистрибуции вне Mac App Store (с упаковкой
  `hotkey-tap` и `whisper-cli` + dylibs во `extraResources` уже готовы).
- Иконки tray в нативных PNG-template (сейчас inline SVG).
- Streaming-транскрипция (отложено: turbo достаточно быстр для batch).
- Тестирование на реальном Windows-хосте (PowerShell-скрипт сборки не запускался).
- Windows-аналог CGEventTap (RegisterHotKey / low-level keyboard hook с
  блокировкой) — пока используется passive uiohook-napi, что не блокирует
  Space/Tab.

## План проекта

[/Users/ila/.claude/plans/fuzzy-beaming-creek.md](/Users/ila/.claude/plans/fuzzy-beaming-creek.md)


## Задачи на следующую сессию

1. **Вставка текста в активное поле** — убедиться, что после исправлений с хоткеем (LeftAlt+Space, consume-логика) автовставка через osascript Cmd+V корректно работает во всех целевых приложениях (Safari, VSCode, Telegram, Terminal). Проверить сценарии: окно Wisper в фокусе, окно другого приложения в фокусе, нет Accessibility-разрешения.

2. **Прогресс-бар обработки аудио** — добавить визуальную индикацию в renderer между окончанием записи и появлением результата. Сейчас UI просто ждёт без обратной связи. Варианты: спиннер / progress-bar с этапами «Uploading → Transcribing → Done».

3. **Проверка Metal-ускорения на macOS** — убедиться, что `whisper-cli` скомпилирован с флагом `GGML_METAL=1` и реально использует GPU. Проверить через `sudo powermetrics --samplers gpu_power` во время транскрипции или логи Metal в stderr whisper-cli. Если Metal не активен — починить флаги сборки в `scripts/setup-whisper.sh`.

4. **Готовность под Windows** — пройтись по всем компонентам:
   - сборка `whisper-cli` через `setup-whisper.ps1` (CPU / CUDA / Vulkan);
   - `uiohook-napi` как hotkey-бэкенд (вместо CGEventTap);
   - автовставка через PowerShell SendKeys;
   - пути (`paths.ts`) и упаковка через electron-builder NSIS.
   Если нет реального Windows-хоста — добавить хотя бы smoke-тест пути.# wisper
