import { clipboard, systemPreferences, shell } from 'electron';
import { spawn } from 'child_process';
import { nativePaste } from './hotkey.js';

export async function pasteText(text: string): Promise<void> {
  if (!text) return;

  if (process.platform === 'darwin') {
    const trusted = systemPreferences.isTrustedAccessibilityClient(false);
    if (!trusted) {
      console.warn('[paste] Accessibility not granted — clipboard only');
      clipboard.writeText(text);
      return;
    }
  }

  const previous = clipboard.readText();
  clipboard.writeText(text);

  try {
    await sendPaste();
  } catch (e) {
    console.error('[paste] failed:', (e as Error).message);
  }

  setTimeout(() => {
    if (clipboard.readText() === text) clipboard.writeText(previous);
  }, 600);
}

export function openAccessibilitySettings() {
  shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
  );
}

function sendPaste(): Promise<void> {
  if (process.platform === 'darwin') {
    // Use the native hotkey-tap helper which calls CGEventPost from real C —
    // works in every app including Electron (VSCode etc.). AppleScript's
    // `keystroke` is blocked by Electron, JXA's CoreGraphics bridge fails
    // silently. Real C functions through stdin pipe to the helper is the
    // only reliable path.
    if (!nativePaste()) {
      return Promise.reject(new Error('hotkey-tap helper not running'));
    }
    return Promise.resolve();
  }
  if (process.platform === 'win32') {
    // mshta starts ~3x faster than PowerShell — no JIT, no profile loading.
    return run('mshta.exe', [
      'vbscript:CreateObject("WScript.Shell").SendKeys("^v")(window.close)',
    ]);
  }
  return run('xdotool', ['key', '--clearmodifiers', 'ctrl+v']);
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (e) => reject(new Error(`${cmd}: ${e.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`));
    });
  });
}
