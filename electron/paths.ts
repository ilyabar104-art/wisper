import { app } from 'electron';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

export function userDataDir(): string {
  return app.getPath('userData');
}

export function modelsDir(): string {
  const dir = join(userDataDir(), 'models');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function whisperServerBinPath(): string {
  const exe = process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server';
  if (app.isPackaged) {
    return join(process.resourcesPath, 'bin', exe);
  }
  return join(app.getAppPath(), 'resources', 'bin', exe);
}

export function hotkeyTapBinPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'bin', 'hotkey-tap');
  }
  return join(app.getAppPath(), 'resources', 'bin', 'hotkey-tap');
}

export function winHotkeyBinPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'bin', 'win-hotkey.exe');
  }
  return join(app.getAppPath(), 'resources', 'bin', 'win-hotkey.exe');
}

export function settingsPath(): string {
  return join(userDataDir(), 'settings.json');
}

export function dbPath(): string {
  return join(userDataDir(), 'history.db');
}
