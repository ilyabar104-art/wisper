import { contextBridge, ipcRenderer } from 'electron';

const api = {
  // Recording / transcription
  transcribe: (wavBytes: ArrayBuffer): Promise<{ text: string; durationMs: number }> =>
    ipcRenderer.invoke('transcribe', wavBytes),
  notifyRecordingState: (recording: boolean) =>
    ipcRenderer.send('recording-state', recording),

  // Hotkey events from main
  onHotkeyDown: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('hotkey-down', listener);
    return () => ipcRenderer.removeListener('hotkey-down', listener);
  },
  onHotkeyUp: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('hotkey-up', listener);
    return () => ipcRenderer.removeListener('hotkey-up', listener);
  },
  onHotkeyError: (cb: (msg: string) => void) => {
    const listener = (_: unknown, msg: string) => cb(msg);
    ipcRenderer.on('hotkey-error', listener);
    return () => ipcRenderer.removeListener('hotkey-error', listener);
  },

  // Models
  listModels: () => ipcRenderer.invoke('models:list'),
  downloadModel: (id: string) => ipcRenderer.invoke('models:download', id),
  deleteModel: (id: string) => ipcRenderer.invoke('models:delete', id),
  onModelProgress: (cb: (id: string, pct: number) => void) => {
    const listener = (_: unknown, id: string, pct: number) => cb(id, pct);
    ipcRenderer.on('models:progress', listener);
    return () => ipcRenderer.removeListener('models:progress', listener);
  },
  setActiveModel: (id: string) => ipcRenderer.invoke('models:set-active', id),
  getActiveModel: () => ipcRenderer.invoke('models:get-active'),

  // History
  historyList: (query?: string) => ipcRenderer.invoke('history:list', query),
  historyDelete: (id: number) => ipcRenderer.invoke('history:delete', id),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Record<string, unknown>) =>
    ipcRenderer.invoke('settings:set', patch),

  // Hotkey
  listHotkeys: (): Promise<string[]> => ipcRenderer.invoke('hotkey:list'),
  pauseHotkey: () => ipcRenderer.send('hotkey:pause'),
  resumeHotkey: () => ipcRenderer.send('hotkey:resume'),

  // Accessibility
  checkAccessibility: (): Promise<boolean> => ipcRenderer.invoke('accessibility:check'),
  openAccessibilitySettings: () => ipcRenderer.invoke('accessibility:open-settings'),
};

contextBridge.exposeInMainWorld('wisper', api);

export type WisperApi = typeof api;
