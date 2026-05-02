import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { uIOhook, UiohookKey } from 'uiohook-napi';
import { getSettings } from './settings.js';
import { hotkeyTapBinPath, winHotkeyBinPath } from './paths.js';

type Listener = () => void;
type ErrorListener = (msg: string) => void;

/**
 * Two key-name systems coexist:
 * - uiohook scancodes (Windows / Linux fallback)
 * - macOS CGKeyCode values (Carbon HIToolbox/Events.h) used by hotkey-tap.
 *
 * KEY_MAP exposes user-friendly names; SUPPORTED_KEYS is the menu shown in UI.
 */
// macOS CGKeyCode values (Carbon HIToolbox/Events.h)
const MACOS_MAP: Record<string, number> = {
  LeftCommand: 55, RightCommand: 54,
  LeftShift: 56, RightShift: 60,
  CapsLock: 57,
  LeftAlt: 58, RightAlt: 61,        // Option
  LeftCtrl: 59, RightCtrl: 62,
  Fn: 63,
  // Letters
  A: 0, B: 11, C: 8, D: 2, E: 14, F: 3, G: 5, H: 4, I: 34, J: 38, K: 40,
  L: 37, M: 46, N: 45, O: 31, P: 35, Q: 12, R: 15, S: 1, T: 17, U: 32,
  V: 9, W: 13, X: 7, Y: 16, Z: 6,
  // Digits
  '0': 29, '1': 18, '2': 19, '3': 20, '4': 21, '5': 23,
  '6': 22, '7': 26, '8': 28, '9': 25,
  // Whitespace / symbols
  Space: 49, Tab: 48, Backquote: 50, Escape: 53,
  Enter: 36, Backspace: 51, Delete: 117,
  Minus: 27, Equal: 24,
  BracketLeft: 33, BracketRight: 30, Backslash: 42,
  Semicolon: 41, Quote: 39, Comma: 43, Period: 47, Slash: 44,
  // Arrows
  ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
  // F-keys
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100,
  F9: 101, F10: 109, F11: 103, F12: 111,
  F13: 105, F14: 107, F15: 113, F16: 106, F17: 64, F18: 79, F19: 80,
};

// Windows Virtual Key codes (winuser.h)
const WIN_VK_MAP: Record<string, number> = {
  LeftShift: 0xA0, RightShift: 0xA1,
  LeftCtrl: 0xA2,  RightCtrl: 0xA3,
  LeftAlt: 0xA4,   RightAlt: 0xA5,
  LeftCommand: 0x5B, RightCommand: 0x5C,  // Win keys
  CapsLock: 0x14,
  // Letters
  A: 0x41, B: 0x42, C: 0x43, D: 0x44, E: 0x45, F: 0x46, G: 0x47, H: 0x48,
  I: 0x49, J: 0x4A, K: 0x4B, L: 0x4C, M: 0x4D, N: 0x4E, O: 0x4F, P: 0x50,
  Q: 0x51, R: 0x52, S: 0x53, T: 0x54, U: 0x55, V: 0x56, W: 0x57, X: 0x58,
  Y: 0x59, Z: 0x5A,
  // Digits
  '0': 0x30, '1': 0x31, '2': 0x32, '3': 0x33, '4': 0x34,
  '5': 0x35, '6': 0x36, '7': 0x37, '8': 0x38, '9': 0x39,
  // Whitespace / symbols
  Space: 0x20, Tab: 0x09, Escape: 0x1B, Enter: 0x0D,
  Backspace: 0x08, Delete: 0x2E,
  Minus: 0xBD, Equal: 0xBB, Backquote: 0xC0,
  BracketLeft: 0xDB, BracketRight: 0xDD, Backslash: 0xDC,
  Semicolon: 0xBA, Quote: 0xDE, Comma: 0xBC, Period: 0xBE, Slash: 0xBF,
  // Arrows
  ArrowLeft: 0x25, ArrowRight: 0x27, ArrowDown: 0x28, ArrowUp: 0x26,
  // F-keys
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75,
  F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7A, F12: 0x7B,
  F13: 0x7C, F14: 0x7D, F15: 0x7E, F16: 0x7F, F17: 0x80, F18: 0x81, F19: 0x82,
};

// Reverse map: Windows VK code → key name (for capture mode)
const WIN_VK_REVERSE: Record<number, string> = {};
for (const [name, vk] of Object.entries(WIN_VK_MAP)) WIN_VK_REVERSE[vk] = name;

// uiohook keycodes (Linux fallback)
const UIOHOOK_MAP: Record<string, number> = {
  RightAlt: UiohookKey.AltRight,
  LeftAlt: UiohookKey.Alt,
  RightCtrl: UiohookKey.CtrlRight,
  LeftCtrl: UiohookKey.Ctrl,
  RightShift: UiohookKey.ShiftRight,
  LeftShift: UiohookKey.Shift,
  LeftCommand: UiohookKey.Meta,
  RightCommand: UiohookKey.MetaRight,
  CapsLock: UiohookKey.CapsLock,
  // Letters
  A: UiohookKey.A, B: UiohookKey.B, C: UiohookKey.C, D: UiohookKey.D,
  E: UiohookKey.E, F: UiohookKey.F, G: UiohookKey.G, H: UiohookKey.H,
  I: UiohookKey.I, J: UiohookKey.J, K: UiohookKey.K, L: UiohookKey.L,
  M: UiohookKey.M, N: UiohookKey.N, O: UiohookKey.O, P: UiohookKey.P,
  Q: UiohookKey.Q, R: UiohookKey.R, S: UiohookKey.S, T: UiohookKey.T,
  U: UiohookKey.U, V: UiohookKey.V, W: UiohookKey.W, X: UiohookKey.X,
  Y: UiohookKey.Y, Z: UiohookKey.Z,
  // Digits
  '0': UiohookKey['0'], '1': UiohookKey['1'], '2': UiohookKey['2'],
  '3': UiohookKey['3'], '4': UiohookKey['4'], '5': UiohookKey['5'],
  '6': UiohookKey['6'], '7': UiohookKey['7'], '8': UiohookKey['8'],
  '9': UiohookKey['9'],
  // Whitespace / symbols
  Space: UiohookKey.Space, Tab: UiohookKey.Tab,
  Backquote: UiohookKey.Backquote, Escape: UiohookKey.Escape,
  Enter: UiohookKey.Enter, Backspace: UiohookKey.Backspace,
  Delete: UiohookKey.Delete,
  Minus: UiohookKey.Minus, Equal: UiohookKey.Equal,
  BracketLeft: UiohookKey.BracketLeft, BracketRight: UiohookKey.BracketRight,
  Backslash: UiohookKey.Backslash, Semicolon: UiohookKey.Semicolon,
  Quote: UiohookKey.Quote, Comma: UiohookKey.Comma,
  Period: UiohookKey.Period, Slash: UiohookKey.Slash,
  // Arrows
  ArrowLeft: UiohookKey.ArrowLeft, ArrowRight: UiohookKey.ArrowRight,
  ArrowDown: UiohookKey.ArrowDown, ArrowUp: UiohookKey.ArrowUp,
  // F-keys
  F1: UiohookKey.F1, F2: UiohookKey.F2, F3: UiohookKey.F3, F4: UiohookKey.F4,
  F5: UiohookKey.F5, F6: UiohookKey.F6, F7: UiohookKey.F7, F8: UiohookKey.F8,
  F9: UiohookKey.F9, F10: UiohookKey.F10, F11: UiohookKey.F11, F12: UiohookKey.F12,
  F13: UiohookKey.F13, F14: UiohookKey.F14, F15: UiohookKey.F15,
  F16: UiohookKey.F16, F17: UiohookKey.F17, F18: UiohookKey.F18,
  F19: UiohookKey.F19,
};

export const SUPPORTED_KEYS = Object.keys(MACOS_MAP);

function parseCombo(combo: string): string[] {
  return combo.split('+').map((s) => s.trim()).filter(Boolean);
}

// ---- Backend abstraction ----------------------------------------------

interface Backend {
  start(onDown: Listener, onUp: Listener, onError?: ErrorListener): void;
  setCombo(keys: string[]): void;
  /** Temporarily disable event consumption (e.g. while capturing a new hotkey). */
  pause(): void;
  resume(): void;
  stop(): void;
  /** Send Cmd+V via the native helper. macOS only; throws on other platforms. */
  paste?(): void;
  /** Enter global key-capture mode (Windows only). */
  beginCapture?(cb: (keyName: string, isDown: boolean) => void): void;
  /** Exit global key-capture mode. */
  endCapture?(): void;
}

// ---- macOS: CGEventTap helper subprocess -------------------------------

class MacBackend implements Backend {
  private proc: ChildProcess | null = null;
  private onDown: Listener | null = null;
  private onUp: Listener | null = null;
  private onError: ErrorListener | null = null;
  private comboActive = false;
  private buffered = '';
  private paused = false;
  private savedCombo: string[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  start(onDown: Listener, onUp: Listener, onError?: ErrorListener): void {
    this.onDown = onDown;
    this.onUp = onUp;
    this.onError = onError ?? null;
    this.stopped = false;
    this._spawn();
  }

  private _spawn(): void {
    if (this.stopped) return;
    const bin = hotkeyTapBinPath();
    if (!existsSync(bin)) {
      const msg = `hotkey-tap binary missing at ${bin}. Run "npm run setup:hotkey-tap".`;
      this.onError?.(msg);
      throw new Error(msg);
    }
    this.proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });

    this.proc.stdout?.on('data', (chunk) => this.handleStdout(chunk.toString()));
    this.proc.stderr?.on('data', (chunk) =>
      console.error('[hotkey-tap stderr]', chunk.toString().trim())
    );
    this.proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopped) return;
      if (code !== 0 && code !== null) {
        console.error(`hotkey-tap exited with code ${code}`);
        // Retry every 5 s — likely a missing Accessibility permission that the
        // user will grant while the app is running.
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this._spawn();
        }, 5000);
      }
    });

    this.setCombo(parseCombo(getSettings().hotkey));
  }

  private handleStdout(data: string): void {
    this.buffered += data;
    let idx;
    while ((idx = this.buffered.indexOf('\n')) >= 0) {
      const line = this.buffered.slice(0, idx).trim();
      this.buffered = this.buffered.slice(idx + 1);
      if (line === 'DOWN') {
        this.comboActive = true;
        this.onDown?.();
      } else if (line === 'UP') {
        this.comboActive = false;
        this.onUp?.();
      } else if (line === 'READY') {
        // installed — clear any pending retry indicator
      } else if (line.startsWith('ERROR')) {
        console.error('[hotkey-tap]', line);
        this.onError?.(line.replace(/^ERROR\s*/, ''));
      }
    }
  }

  setCombo(keys: string[]): void {
    this.savedCombo = keys;
    if (this.paused) return; // will be applied on resume
    this._applyCombo(keys);
  }

  private _applyCombo(keys: string[]): void {
    if (!this.proc?.stdin) return;
    const codes = keys.map((k) => MACOS_MAP[k]).filter((c) => c !== undefined);
    if (codes.length === 0) return;
    this.proc.stdin.write(`SET ${codes.join(',')}\n`);
    if (this.comboActive) {
      this.comboActive = false;
      this.onUp?.();
    }
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    // Send empty SET so hotkey-tap stops tracking / consuming events.
    if (this.proc?.stdin) this.proc.stdin.write('SET\n');
    if (this.comboActive) {
      this.comboActive = false;
      this.onUp?.();
    }
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this._applyCombo(this.savedCombo);
  }

  paste(): void {
    if (this.proc?.stdin) this.proc.stdin.write('PASTE\n');
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    try { this.proc?.stdin?.write('QUIT\n'); } catch {}
    this.proc?.kill();
    this.proc = null;
  }
}

// ---- Windows: win-hotkey.exe subprocess (active, consumes events) ------

class WinBackend implements Backend {
  private proc: ChildProcess | null = null;
  private onDown: Listener | null = null;
  private onUp: Listener | null = null;
  private onError: ErrorListener | null = null;
  private comboActive = false;
  private buffered = '';
  private paused = false;
  private savedCombo: string[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private captureCallback: ((keyName: string, isDown: boolean) => void) | null = null;

  start(onDown: Listener, onUp: Listener, onError?: ErrorListener): void {
    this.onDown = onDown;
    this.onUp = onUp;
    this.onError = onError ?? null;
    this.stopped = false;
    this._spawn();
  }

  private _spawn(): void {
    if (this.stopped) return;
    const bin = winHotkeyBinPath();
    if (!existsSync(bin)) {
      const msg = `win-hotkey.exe missing at ${bin}. Run "npm run setup:win-hotkey".`;
      this.onError?.(msg);
      throw new Error(msg);
    }
    this.proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout?.on('data', (chunk) => this.handleStdout(chunk.toString()));
    this.proc.stderr?.on('data', (chunk) =>
      console.error('[win-hotkey stderr]', chunk.toString().trim())
    );
    this.proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopped) return;
      // Always retry — code 0 can happen when stdin pipe closes unexpectedly.
      console.error(`win-hotkey exited with code ${code}, retrying in 2s`);
      this.retryTimer = setTimeout(() => { this.retryTimer = null; this._spawn(); }, 2000);
    });
    this.setCombo(parseCombo(getSettings().hotkey));
  }

  private handleStdout(data: string): void {
    this.buffered += data;
    let idx;
    while ((idx = this.buffered.indexOf('\n')) >= 0) {
      const line = this.buffered.slice(0, idx).trim();
      this.buffered = this.buffered.slice(idx + 1);
      if (line === 'DOWN') { this.comboActive = true;  this.onDown?.(); }
      else if (line === 'UP') { this.comboActive = false; this.onUp?.(); }
      else if (line === 'READY') { console.log('[win-hotkey] hook installed, listening globally'); }
      else if (line === 'CAPREADY') { /* capture mode confirmed active */ }
      else if (line === 'CAPEND') { /* capture mode ended */ }
      else if (line.startsWith('KEY ')) {
        const parts = line.split(' ');
        const vk = parseInt(parts[1], 10);
        const isDown = parts[2] === 'D';
        const name = WIN_VK_REVERSE[vk];
        if (name && this.captureCallback) this.captureCallback(name, isDown);
      }
      else if (line.startsWith('ERROR')) {
        console.error('[win-hotkey]', line);
        this.onError?.(line.replace(/^ERROR\s*/, ''));
      }
    }
  }

  beginCapture(cb: (keyName: string, isDown: boolean) => void): void {
    this.captureCallback = cb;
    this.proc?.stdin?.write('CAPBEGIN\n');
  }

  endCapture(): void {
    this.captureCallback = null;
    this.proc?.stdin?.write('CAPEND\n');
  }

  paste(): void {
    this.proc?.stdin?.write('PASTE\n');
  }

  setCombo(keys: string[]): void {
    this.savedCombo = keys;
    if (this.paused) return;
    this._applyCombo(keys);
  }

  private _applyCombo(keys: string[]): void {
    if (!this.proc?.stdin) return;
    const codes = keys.map((k) => WIN_VK_MAP[k]).filter((c) => c !== undefined);
    if (codes.length === 0) return;
    this.proc.stdin.write(`SET ${codes.join(',')}\n`);
    if (this.comboActive) { this.comboActive = false; this.onUp?.(); }
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    if (this.proc?.stdin) this.proc.stdin.write('SET\n');
    if (this.comboActive) { this.comboActive = false; this.onUp?.(); }
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this._applyCombo(this.savedCombo);
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== null) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    try { this.proc?.stdin?.write('QUIT\n'); } catch {}
    this.proc?.kill();
    this.proc = null;
  }
}

// ---- Linux fallback: uiohook-napi (passive) ----------------------------

class UiohookBackend implements Backend {
  private started = false;
  private targetCodes: number[] = [];
  private pressed = new Set<number>();
  private active = false;
  private onDown: Listener | null = null;
  private onUp: Listener | null = null;

  start(onDown: Listener, onUp: Listener): void {
    this.onDown = onDown;
    this.onUp = onUp;
    this.setCombo(parseCombo(getSettings().hotkey));

    uIOhook.on('keydown', (e) => {
      this.pressed.add(e.keycode);
      if (!this.active && this.isComboDown()) {
        this.active = true;
        this.onDown?.();
      }
    });
    uIOhook.on('keyup', (e) => {
      this.pressed.delete(e.keycode);
      if (this.active && !this.isComboDown()) {
        this.active = false;
        this.onUp?.();
      }
    });

    if (!this.started) {
      uIOhook.start();
      this.started = true;
    }
  }

  private isComboDown(): boolean {
    return this.targetCodes.length > 0 &&
      this.targetCodes.every((c) => this.pressed.has(c));
  }

  setCombo(keys: string[]): void {
    const codes = keys.map((k) => UIOHOOK_MAP[k]).filter((c) => c !== undefined);
    if (codes.length === 0) throw new Error(`Unsupported hotkey: ${keys.join('+')}`);
    if (this.active) {
      this.active = false;
      this.onUp?.();
    }
    this.pressed.clear();
    this.targetCodes = codes;
  }

  pause(): void { /* uiohook is passive — no consumption to disable */ }
  resume(): void {}

  stop(): void {
    if (this.started) {
      uIOhook.stop();
      this.started = false;
    }
  }
}

// ---- Public API --------------------------------------------------------

let backend: Backend | null = null;

export function startHotkey(onDown: Listener, onUp: Listener, onError?: ErrorListener): void {
  if (process.platform === 'darwin') {
    backend = new MacBackend();
  } else if (process.platform === 'win32' && existsSync(winHotkeyBinPath())) {
    backend = new WinBackend();
  } else {
    backend = new UiohookBackend();
  }
  backend.start(onDown, onUp, onError);
}

export function setHotkey(combo: string): void {
  const keys = parseCombo(combo);
  if (keys.length === 0) throw new Error(`Empty hotkey: "${combo}"`);
  backend?.setCombo(keys);
}

export function pauseHotkey(): void {
  backend?.pause();
}

export function resumeHotkey(): void {
  backend?.resume();
}

export function stopHotkey(): void {
  backend?.stop();
  backend = null;
}

/** Send paste via native helper (macOS: CGEventPost, Windows: SendInput). Returns true if sent. */
export function nativePaste(): boolean {
  if (!backend?.paste) return false;
  backend.paste();
  return true;
}

/** Windows only: enter global key-capture mode. */
export function startHotkeyCapture(cb: (keyName: string, isDown: boolean) => void): void {
  backend?.beginCapture?.(cb);
}

/** Windows only: exit global key-capture mode. */
export function stopHotkeyCapture(): void {
  backend?.endCapture?.();
}
