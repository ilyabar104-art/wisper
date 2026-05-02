# Wisper

Локальная диктовка для macOS и Windows — лёгкий аналог Superwhisper / WhisperFlow.
Работает полностью офлайн: запись с микрофона → транскрипция через Whisper Large-v3-turbo
(или любую другую GGML-модель) → автоматическая вставка текста в активное приложение.

## Возможности

- **Hold-to-talk** глобальный хоткей с поддержкой **любых сочетаний клавиш**
  (буквы, цифры, F1–F19, стрелки, модификаторы — в любом порядке):
  - **macOS** — нативный Objective-C хелпер `hotkey-tap` использует CGEventTap в
    active-режиме и **поглощает** keyDown/keyUp целевых клавиш.
  - **Windows** — нативный C хелпер `win-hotkey.exe` использует `WH_KEYBOARD_LL`
    low-level hook, **поглощает** клавиши (пробел/Tab не печатаются в фоновом окне),
    поддерживает захват хоткея через глобальный `CAPBEGIN`-режим.
  - **Linux** — fallback на `uiohook-napi` (passive listener).
- **Whisper Large-v3-turbo** через **`whisper-server`** из
  [whisper.cpp](https://github.com/ggerganov/whisper.cpp). Сервер запускается
  **один раз** при старте и держит модель в памяти — каждая последующая диктовка
  не требует повторной загрузки модели. Поддерживаются tiny / base / small /
  medium / large-v3 / large-v3-turbo в квантизациях q5_0/q5_1/f16.
- **Автовставка** транскрипции в активное поле:
  - **macOS** — `hotkey-tap` инжектирует Cmd+V через `CGEventPost(kCGHIDEventTap)`.
  - **Windows** — PowerShell `SendKeys`.
  - **Linux** — `xdotool key ctrl+v`.
- **Менеджер моделей**: список GGML-моделей с размером, скачивание с HuggingFace,
  переключение без перезапуска.
- **Настройки в UI**: смена хоткея через capture-режим, язык распознавания, автовставка.
- **История транскрипций** в SQLite с полнотекстовым поиском (FTS5).
- **Tray-иконка**: серый кружок в покое, красный во время записи.
- **Кросс-платформенность**: macOS 12+ и Windows 10/11. Linux — частичная.

## Архитектура

```
wisper/
├── electron/
│   ├── main.ts            # окно, tray, IPC, hotkey lifecycle
│   ├── preload.ts         # contextBridge → window.wisper
│   ├── hotkey.ts          # диспетчер: macOS → hotkey-tap, Win → win-hotkey.exe, Linux → uiohook-napi
│   ├── whisper.ts         # whisper-server lifecycle + HTTP клиент (multipart POST /inference)
│   ├── paste.ts           # cross-platform автовставка
│   ├── models.ts          # каталог GGML-моделей + загрузка с HuggingFace
│   ├── history.ts         # SQLite + FTS5 (better-sqlite3)
│   ├── settings.ts        # JSON-настройки в userData
│   └── paths.ts           # cross-platform пути к бинарям/моделям/БД
├── renderer/
│   ├── App.tsx            # вкладки Dictate / Models / History / Settings
│   ├── recorder.ts        # MicRecorder: AudioWorklet → 16 kHz mono PCM16 WAV
│   └── components/
│       ├── ModelPicker.tsx
│       ├── History.tsx
│       └── Settings.tsx   # capture-режим хоткея (Win: CAPBEGIN/KEY/CAPEND через win-hotkey.exe)
├── native/
│   ├── hotkey-tap.m       # macOS: CGEventTap active-режим + PASTE команда
│   └── win-hotkey.c       # Windows: WH_KEYBOARD_LL + SET/CAPBEGIN/CAPEND/QUIT протокол
├── scripts/
│   ├── setup-whisper.sh   # сборка whisper.cpp с Metal (macOS)
│   └── setup-whisper.ps1  # сборка whisper.cpp на Windows (CPU / CUDA / Vulkan)
├── resources/bin/         # whisper-server(.exe) + DLL + hotkey-tap / win-hotkey.exe
└── electron.vite.config.ts
```

### Поток данных при диктовке

0. **При старте:** main спавнит `whisper-server(.exe)` на свободном localhost-порту,
   ждёт до 60 с пока сервер загрузит модель (до 2 мин на CPU cold start).
1. **Хоткей вниз:** `hotkey-tap` / `win-hotkey.exe` пишет `DOWN` в stdout →
   main по IPC → renderer → `MicRecorder.start()`.
2. **Запись:** `AudioWorkletNode` накапливает Float32 чанки при 16 kHz mono.
3. **Хоткей вверх:** `UP` → renderer → `recorder.stop()` кодирует PCM16 WAV →
   main → multipart POST на `http://127.0.0.1:<port>/inference` → `{ text }`.
4. Текст → SQLite history → clipboard → автовставка.

### Протокол win-hotkey.exe (stdin/stdout)

```
stdin  → SET <vk1,vk2,...>   # задать целевые VK-коды (0 кодов = выкл)
         CAPBEGIN             # войти в режим захвата (все клавиши → KEY events)
         CAPEND               # выйти из режима захвата
         QUIT                 # завершить процесс

stdout ← READY               # хук установлен
         DOWN                 # целевая комбинация нажата
         UP                   # комбинация отпущена
         KEY <vk> D|U         # клавиша в capture-режиме (D=down, U=up)
         CAPREADY             # capture-режим подтверждён
         CAPEND               # capture-режим завершён
         ERROR <msg>          # ошибка
```

## Стек

| Слой | Технология |
|------|-----------|
| Runtime | Electron 33 (ESM main + preload), Node 20+ |
| Bundler | electron-vite 5 + Vite 6 |
| UI | React 19 + TypeScript |
| Whisper backend | whisper.cpp (Metal на macOS, CPU/CUDA/Vulkan на Windows) |
| Глобальные хоткеи macOS | Objective-C `hotkey-tap` (CGEventTap active) |
| Глобальные хоткеи Windows | C `win-hotkey.exe` (WH_KEYBOARD_LL) |
| Глобальные хоткеи Linux | uiohook-napi (passive) |
| Аудио | AudioWorklet + singleton AudioContext (16 kHz mono) |
| БД | better-sqlite3 + FTS5 |
| Упаковка | electron-builder (.dmg, NSIS) |

## Требования

- **macOS** 12+ или **Windows 10/11**
- Node.js 20+ и npm
- macOS: CMake + Xcode CLT (`brew install cmake`)
- Windows: CMake + Visual Studio 2022 Build Tools (C++), Git

## Установка и запуск

### macOS

```bash
npm install
npm run setup:whisper      # сборка whisper-server с Metal
npm run setup:hotkey-tap   # компиляция CGEventTap-хелпера
npm run rebuild            # пересборка native-модулей под Electron
npm run dev
```

При первом запуске: разрешить микрофон → добавить Wisper в
**System Settings → Privacy → Accessibility** → скачать модель во вкладке **Models**.

### Windows

```powershell
npm install
npm run setup:whisper:win   # сборка whisper-server (CPU по умолчанию)
# Для Vulkan (GPU): npm run setup:whisper:win -- -Backend vulkan
npm run setup:win-hotkey    # компиляция win-hotkey.exe (требует cl.exe из VS Build Tools)
npm run rebuild
npm run dev
```

Заметки:
- Whisper-сервер при **первом запуске** грузит модель с диска (~1–3 мин на CPU).
  После прогрева (warmup при старте) последующие диктовки быстрее.
- Хоткей по умолчанию: `RightAlt`. **Win-клавишу** (`LeftCommand`) использовать
  не рекомендуется — она имеет системный приоритет в Windows.
- Пути с кириллицей (имя пользователя) обрабатываются автоматически через 8.3
  short paths (`Scripting.FileSystemObject`).

## Настройки

Файл `<userData>/settings.json`:

```json
{
  "activeModelId": "large-v3-turbo-q5_0",
  "hotkey": "RightAlt",
  "pasteAfterTranscribe": true,
  "language": "auto"
}
```

Hotkey — строка `Key1+Key2+...`. Поддерживаемые имена клавиш: `LeftAlt`,
`RightAlt`, `LeftCtrl`, `RightCtrl`, `LeftShift`, `RightShift`, `CapsLock`,
`A`–`Z`, `0`–`9`, `F1`–`F19`, `ArrowUp/Down/Left/Right`, `Space`, `Tab`,
`Enter`, `Escape` и др.

`<userData>` → macOS: `~/Library/Application Support/wisper`,
Windows: `%APPDATA%\wisper`.

---

## План разработки

### Сделано

- [x] Базовая диктовка macOS: CGEventTap + whisper-server + автовставка Cmd+V
- [x] Менеджер моделей (скачивание с HuggingFace, переключение без перезапуска)
- [x] История транскрипций (SQLite + FTS5)
- [x] Настройки в UI (хоткей capture, язык, автовставка)
- [x] Windows: `win-hotkey.exe` (WH_KEYBOARD_LL) — замена uiohook-napi,
      корректное поглощение клавиш, global capture-режим для смены хоткея
- [x] Windows: `whisper-server.exe` с поддержкой путей с кириллицей (8.3 short path)
- [x] Windows: исправлен `language=auto` (вешал сервер), recovery при ECONNRESET
- [x] Windows: исправлен перезапуск `win-hotkey.exe` при любом выходе (не только код ≠ 0)
- [x] **Vulkan-ускорение на Windows** — `whisper-server.exe` пересобран с
      `-DGGML_VULKAN=ON`. Требует Vulkan SDK + GPU-драйвер с Vulkan.
      Warmup при старте держит модель в памяти — повторные диктовки < 1 с.
      ```powershell
      # Сборка вручную (если нужно пересобрать):
      Remove-Item resources\bin\whisper-server.exe
      cmake -S .cache\whisper.cpp -B .cache\whisper.cpp\build -DGGML_VULKAN=ON \
        -DVulkan_INCLUDE_DIR="C:\VulkanSDK\<ver>\Include" \
        -DVulkan_LIBRARY="C:\VulkanSDK\<ver>\Lib\vulkan-1.lib" \
        -DVulkan_GLSLC_EXECUTABLE="C:\VulkanSDK\<ver>\Bin\glslc.exe"
      cmake --build .cache\whisper.cpp\build --config Release --target whisper-server -j
      ```
- [x] **Автовставка на Windows** — реализована через `PASTE`-команду в
      `win-hotkey.exe` (`SendInput`). Не крадёт фокус, работает в любом окне.
- [x] **Корректное поглощение хоткея на Windows** — все клавиши (включая
      модификаторы Alt/Ctrl/Shift/Win) пропускаются насквозь до срабатывания комбо.
      При срабатывании инжектируются F24 + synthetic-up для отмены Alt/Win-меню.
      Фикс бага: `savedCombo` теперь заполняется через `setCombo()` — хоткей
      корректно восстанавливается после каждой вставки.
- [x] **Убрана строка меню** из окна приложения (`win.setMenu(null)`).
- [x] **Исправлена ошибка скрипта** при автовставке через `mshta.exe` (VBScript
      синтаксис) — теперь используется `SendInput` через `win-hotkey.exe`.
- [x] **Windows NSIS-установщик** — `npm run dist:win` собирает `Wisper Setup
      x.x.x.exe` (x64). Модель не входит в дистрибутив — скачивается при первом
      запуске через вкладку Models.

### Следующие шаги

- [ ] **Streaming-транскрипция** — передавать результат по частям во время
  обработки (whisper.cpp поддерживает chunked inference). Снизит воспринимаемую
  задержку с CPU-only.

- [ ] **Индикатор прогресса транскрипции** — сейчас UI молча ждёт. Добавить
  «Transcribing… 3.2s» или progress-bar с этапами.

- [ ] **Меньшие модели для скорости** — добавить в UI рекомендацию `small-q5_1`
  для тех кто хочет < 1 с latency на CPU.

- [ ] **Fallback CPU-сборка** — определять при старте, доступен ли Vulkan
  (`ggml-vulkan.dll` + GPU-драйвер), и автоматически переключаться на
  CPU-версию `whisper-server.exe` если Vulkan недоступен.

- [ ] **Подпись и нотаризация** для macOS дистрибуции вне App Store (entitlements
  уже настроены в `build/`).

- [ ] **Иконки tray в PNG-template** вместо inline SVG.

- [ ] **Linux** — проверить `uiohook-napi` + `xdotool` полный цикл.
