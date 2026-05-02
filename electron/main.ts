import {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  systemPreferences,
} from 'electron';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { transcribeWav, warmupWhisper, shutdownWhisper } from './whisper.js';
import { pasteText, openAccessibilitySettings } from './paste.js';
import { startHotkey, stopHotkey, setHotkey, pauseHotkey, resumeHotkey, SUPPORTED_KEYS, startHotkeyCapture, stopHotkeyCapture } from './hotkey.js';
import {
  listModelsWithStatus,
  downloadModel,
  isModelInstalled,
  deleteModel,
} from './models.js';
import { getSettings, updateSettings } from './settings.js';
import { addEntry, listEntries, deleteEntry } from './history.js';

if (process.platform === 'win32') {
  const { default: winca } = await import('win-ca');
  winca({ fallback: true, inject: '+' });
}

const __dirname = dirname(fileURLToPath(import.meta.url));

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let recording = false;

function createWindow() {
  win = new BrowserWindow({
    width: 760,
    height: 560,
    title: 'Wisper',
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  win.setMenu(null);

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'));
  }

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('did-fail-load', code, desc, url);
  });
  win.webContents.on(
    'console-message',
    (_e, _level, message, _line, sourceId) => {
      console.log('[renderer]', sourceId, message);
    }
  );
}

function createTray() {
  // 16x16 dot icon (idle: gray, recording: red) — generated procedurally.
  const icon = nativeImage.createFromDataURL(idleIconDataUrl());
  tray = new Tray(icon);
  tray.setToolTip('Wisper');
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: recording ? '● Recording…' : 'Wisper (idle)',
        enabled: false,
      },
      { type: 'separator' },
      {
        label: 'Show Window',
        click: () => {
          if (!win) createWindow();
          win?.show();
          win?.focus();
        },
      },
      { type: 'separator' },
      { label: 'Quit', role: 'quit' },
    ])
  );
}

function setRecording(on: boolean) {
  recording = on;
  if (tray) {
    const icon = nativeImage.createFromDataURL(
      on ? recordingIconDataUrl() : idleIconDataUrl()
    );
    tray.setImage(icon);
  }
  refreshTrayMenu();
}

// Tiny inline icons so we don't need image assets in MVP.
function idleIconDataUrl() {
  // 16x16 PNG, single gray dot
  return (
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
       <circle cx="8" cy="8" r="4" fill="#888"/></svg>`
    )
  );
}
function recordingIconDataUrl() {
  return (
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
       <circle cx="8" cy="8" r="5" fill="#e23"/></svg>`
    )
  );
}

function registerIpc() {
  ipcMain.handle('transcribe', async (_evt, wavBytes: ArrayBuffer) => {
    const buf = Buffer.from(wavBytes);
    const settings = getSettings();
    const result = await transcribeWav(buf);
    if (result.text) {
      addEntry({
        ts: Date.now(),
        text: result.text,
        duration_ms: result.durationMs,
        model: settings.activeModelId,
      });
      if (settings.pasteAfterTranscribe) {
        // Pause hotkey-tap so it can't see / consume our synthetic Cmd+V
        // events while we paste. Resume right after.
        pauseHotkey();
        try {
          await pasteText(result.text);
        } catch (e) {
          console.error('Paste failed:', e);
        } finally {
          resumeHotkey();
        }
      }
    }
    return result;
  });

  ipcMain.on('recording-state', (_evt, on: boolean) => setRecording(on));

  ipcMain.handle('models:list', () => listModelsWithStatus());
  ipcMain.handle('models:download', async (_evt, id: string) => {
    await downloadModel(id, (pct) => {
      win?.webContents.send('models:progress', id, pct);
    });
    return { ok: true };
  });
  ipcMain.handle('models:delete', (_evt, id: string) => {
    deleteModel(id);
    return { ok: true };
  });
  ipcMain.handle('models:set-active', (_evt, id: string) => {
    updateSettings({ activeModelId: id });
    return getSettings();
  });
  ipcMain.handle('models:get-active', () => getSettings().activeModelId);

  ipcMain.handle('history:list', (_evt, query?: string) => listEntries(query));
  ipcMain.handle('history:delete', (_evt, id: number) => {
    deleteEntry(id);
    return { ok: true };
  });

  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:set', (_evt, patch: Record<string, unknown>) => {
    const updated = updateSettings(patch);
    // Apply hotkey change immediately without restart.
    if (typeof patch.hotkey === 'string') {
      try { setHotkey(patch.hotkey); } catch (e) { console.error(e); }
    }
    return updated;
  });
  ipcMain.handle('hotkey:list', () => SUPPORTED_KEYS);
  ipcMain.on('hotkey:pause', () => pauseHotkey());
  ipcMain.on('hotkey:resume', () => resumeHotkey());
  ipcMain.on('hotkey:capture-start', () => {
    startHotkeyCapture((keyName, isDown) => {
      if (win && !win.isDestroyed()) win.webContents.send('hotkey-capture-key', keyName, isDown);
    });
  });
  ipcMain.on('hotkey:capture-stop', () => stopHotkeyCapture());
  ipcMain.handle('accessibility:check', () =>
    process.platform === 'darwin'
      ? systemPreferences.isTrustedAccessibilityClient(false)
      : true
  );
  ipcMain.handle('accessibility:open-settings', () => openAccessibilitySettings());
}

app.whenReady().then(async () => {
  // Ensure microphone permission is requested up front (macOS-only API;
  // on Windows the OS handles it via renderer's getUserMedia).
  if (process.platform === 'darwin') {
    try {
      await systemPreferences.askForMediaAccess('microphone');
    } catch {
      /* ignore; renderer will retry */
    }
  }

  registerIpc();
  createWindow();
  createTray();
  warmupWhisper(); // load model in background so first dictation is fast

  // Hotkey: hold-to-talk. The renderer drives recording start/stop.
  startHotkey(
    () => {
      if (win && !win.isDestroyed()) win.webContents.send('hotkey-down');
    },
    () => {
      if (win && !win.isDestroyed()) win.webContents.send('hotkey-up');
    },
    (msg) => {
      if (win && !win.isDestroyed()) win.webContents.send('hotkey-error', msg);
    }
  );

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  stopHotkey();
  shutdownWhisper();
});

app.on('window-all-closed', () => {
  // Stay in tray on macOS (don't quit).
  if (process.platform !== 'darwin') app.quit();
});
