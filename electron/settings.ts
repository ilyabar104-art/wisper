import { readFileSync, writeFileSync, existsSync } from 'fs';
import { settingsPath } from './paths.js';

export interface Settings {
  activeModelId: string;
  hotkey: string; // e.g. "RightAlt"
  pasteAfterTranscribe: boolean;
  language: string; // "auto" or ISO code
  microphoneDeviceId: string; // "" = system default
}

const DEFAULTS: Settings = {
  activeModelId: 'large-v3-turbo-q5_0',
  hotkey: 'RightAlt',
  pasteAfterTranscribe: true,
  language: 'auto',
  microphoneDeviceId: '',
};

let cache: Settings | null = null;

export function getSettings(): Settings {
  if (cache) return cache;
  const path = settingsPath();
  if (!existsSync(path)) {
    cache = { ...DEFAULTS };
    writeFileSync(path, JSON.stringify(cache, null, 2));
    return cache;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    cache = { ...DEFAULTS, ...parsed };
    return cache!;
  } catch {
    cache = { ...DEFAULTS };
    return cache;
  }
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const current = getSettings();
  cache = { ...current, ...patch };
  writeFileSync(settingsPath(), JSON.stringify(cache, null, 2));
  return cache;
}
