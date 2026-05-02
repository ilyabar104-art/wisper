import React, { useEffect, useRef, useState } from 'react';

interface SettingsData {
  activeModelId: string;
  hotkey: string;
  pasteAfterTranscribe: boolean;
  language: string;
  microphoneDeviceId: string;
}

const LANGUAGES = [
  { code: 'auto', label: 'Auto-detect' },
  { code: 'ru', label: 'Русский' },
  { code: 'en', label: 'English' },
  { code: 'uk', label: 'Українська' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'it', label: 'Italiano' },
  { code: 'zh', label: '中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'pt', label: 'Português' },
  { code: 'ar', label: 'العربية' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'pl', label: 'Polski' },
  { code: 'nl', label: 'Nederlands' },
];

// Layout-independent key resolution. Modifiers use e.key + e.location;
// everything else uses e.code so dead-key combos don't mangle the result.
function resolveKey(e: KeyboardEvent): string | null {
  switch (e.key) {
    case 'Meta':    return e.location === 2 ? 'RightCommand' : 'LeftCommand';
    case 'Alt':     return e.location === 2 ? 'RightAlt'   : 'LeftAlt';
    case 'Control': return e.location === 2 ? 'RightCtrl'  : 'LeftCtrl';
    case 'Shift':   return e.location === 2 ? 'RightShift' : 'LeftShift';
    case 'CapsLock': return 'CapsLock';
    case 'Fn':       return 'Fn';
  }
  const code = e.code;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);          // KeyA -> A
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);        // Digit1 -> 1
  if (/^F\d{1,2}$/.test(code)) return code;                   // F1..F19
  if (/^Arrow(Up|Down|Left|Right)$/.test(code)) return code;
  switch (code) {
    case 'Space': case 'Tab': case 'Backquote': case 'Escape':
    case 'Enter': case 'Backspace': case 'Delete':
    case 'Minus': case 'Equal': case 'BracketLeft': case 'BracketRight':
    case 'Backslash': case 'Semicolon': case 'Quote':
    case 'Comma': case 'Period': case 'Slash':
      return code;
  }
  return null;
}

interface AudioDevice {
  deviceId: string;
  label: string;
}

export default function Settings({
  onHotkeyChange,
  onMicChange,
}: {
  onHotkeyChange: (key: string) => void;
  onMicChange: (deviceId: string) => void;
}) {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captureKeys, setCaptureKeys] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([]);
  const captureRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    window.wisper.getSettings().then((s) => setSettings(s as SettingsData));
    loadAudioDevices();
  }, []);

  async function runAudioDiagnostics() {
    const log = (level: string, msg: string) => window.wisper.logRenderer(level, `[diag] ${msg}`);
    log('info', '=== Audio diagnostics start ===');

    let devices: MediaDeviceInfo[] = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
      log('info', `enumerateDevices: ${devices.length} total, ${devices.filter((d) => d.kind === 'audioinput').length} audio inputs`);
    } catch (e) {
      log('error', `enumerateDevices failed: ${e}`);
    }
    const inputs = devices.filter((d) => d.kind === 'audioinput');

    const tries: Array<[string, MediaStreamConstraints]> = [
      ['audio:true', { audio: true }],
      ['sampleRate:16000', { audio: { sampleRate: 16000 } }],
      ['sampleRate:48000', { audio: { sampleRate: 48000 } }],
      ['sampleRate:44100', { audio: { sampleRate: 44100 } }],
      ['channelCount:1', { audio: { channelCount: 1 } }],
      ['channelCount:2', { audio: { channelCount: 2 } }],
      ['ec:true,ns:true,agc:true', { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }],
      ['ec:false,ns:false,agc:false', { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }],
    ];
    for (const [name, c] of tries) {
      try {
        const s = await navigator.mediaDevices.getUserMedia(c);
        const t = s.getAudioTracks()[0];
        log('info', `OK ${name} → settings=${JSON.stringify(t.getSettings())}`);
        s.getTracks().forEach((tr) => tr.stop());
      } catch (e) {
        const err = e as DOMException;
        log('error', `FAIL ${name} → ${err.name}: ${err.message} constraint=${(err as any).constraint ?? 'n/a'}`);
      }
    }

    for (const dev of inputs) {
      const label = dev.label || dev.deviceId;
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: dev.deviceId } } });
        const t = s.getAudioTracks()[0];
        log('info', `OK device "${label}" → settings=${JSON.stringify(t.getSettings())}`);
        s.getTracks().forEach((tr) => tr.stop());
      } catch (e) {
        const err = e as DOMException;
        log('error', `FAIL device "${label}" → ${err.name}: ${err.message}`);
      }
    }

    // Try AudioContext alone
    try {
      const ctx = new AudioContext();
      log('info', `AudioContext OK sampleRate=${ctx.sampleRate} state=${ctx.state}`);
      ctx.close();
    } catch (e) {
      log('error', `AudioContext failed: ${e}`);
    }

    log('info', '=== Audio diagnostics done ===');
    alert('Diagnostics complete. Open log file to see results.');
  }

  async function loadAudioDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices
        .filter((d) => d.kind === 'audioinput')
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${i + 1}`,
        }));
      setAudioDevices(inputs);
    } catch (e) {
      window.wisper.logRenderer('error', `enumerateDevices failed: ${e}`);
    }
  }

  async function apply(patch: Partial<SettingsData>) {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    await window.wisper.setSettings(patch as Record<string, unknown>);
    if (patch.hotkey) onHotkeyChange(patch.hotkey);
    if (typeof patch.microphoneDeviceId === 'string') onMicChange(patch.microphoneDeviceId);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  function startCapture() {
    setCapturing(true);
    setCaptureKeys([]);

    if (window.wisper.platform === 'win32') {
      // Windows: route through win-hotkey.exe so Win key and all keys are captured
      // globally without losing window focus.
      const held = new Set<string>();

      window.wisper.startHotkeyCapture();
      const unlisten = window.wisper.onHotkeyCaptureKey((keyName, isDown) => {
        if (isDown) {
          held.add(keyName);
          setCaptureKeys([...held]);
        } else {
          // Escape alone → cancel; anything else → commit.
          if (held.size === 1 && held.has('Escape')) {
            cleanup();
          } else if (held.size > 0) {
            const combo = [...held].join('+');
            cleanup();
            apply({ hotkey: combo });
          }
        }
      });

      function cleanup() {
        setCapturing(false);
        setCaptureKeys([]);
        unlisten();
        window.wisper.stopHotkeyCapture();
        captureRef.current = null;
      }

      captureRef.current = cleanup;
      setTimeout(cleanup, 8000);
    } else {
      // macOS / Linux: use DOM events (focus required, but CGEventTap / uiohook
      // means Win key isn't an issue here).
      window.wisper.pauseHotkey();
      const held = new Set<string>();

      function onDown(e: KeyboardEvent) {
        e.preventDefault();
        const k = resolveKey(e);
        if (!k) return;
        held.add(k);
        setCaptureKeys([...held]);
      }

      function onUp(e: KeyboardEvent) {
        e.preventDefault();
        if (held.size > 0) {
          const combo = [...held].join('+');
          cleanup();
          apply({ hotkey: combo });
        }
      }

      function onBlur() { cleanup(); }

      function cleanup() {
        setCapturing(false);
        setCaptureKeys([]);
        window.removeEventListener('keydown', onDown, true);
        window.removeEventListener('keyup', onUp, true);
        window.removeEventListener('blur', onBlur);
        window.wisper.resumeHotkey();
        captureRef.current = null;
      }

      captureRef.current = cleanup;
      window.addEventListener('keydown', onDown, true);
      window.addEventListener('keyup', onUp, true);
      window.addEventListener('blur', onBlur);
      setTimeout(cleanup, 8000);
    }
  }

  function cancelCapture() {
    captureRef.current?.();
  }

  if (!settings) return <p className="muted">Loading…</p>;

  const comboDisplay = settings.hotkey.split('+').map((k, i, arr) => (
    <React.Fragment key={k}>
      <kbd>{k}</kbd>
      {i < arr.length - 1 && <span className="plus">+</span>}
    </React.Fragment>
  ));

  return (
    <div className="settings">
      <h3>Settings</h3>

      <section>
        <h4>Hotkey (hold to record)</h4>
        <p className="hint">
          Works globally in any app. Any combination of keys is supported.
          Requires Accessibility permission on macOS.
        </p>

        <div className="combo-display">{comboDisplay}</div>

        {capturing ? (
          <div className="capture-box">
            <div className="capture-hint">
              {captureKeys.length === 0
                ? 'Hold keys to record, release to confirm…'
                : captureKeys.join(' + ')}
            </div>
            <button className="capture-btn" onClick={cancelCapture}>Cancel</button>
          </div>
        ) : (
          <button className="capture-btn" onClick={startCapture}>
            Record new hotkey
          </button>
        )}
      </section>

      <section>
        <h4>Language</h4>
        <p className="hint">Language spoken during recording. Auto-detect works well for mixed speech.</p>
        <select
          value={settings.language}
          onChange={(e) => apply({ language: e.target.value })}
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>{l.label}</option>
          ))}
        </select>
      </section>

      {audioDevices.length > 0 && (
        <section>
          <h4>Microphone</h4>
          <select
            value={settings.microphoneDeviceId}
            onChange={(e) => apply({ microphoneDeviceId: e.target.value })}
          >
            <option value="">System default</option>
            {audioDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
            ))}
          </select>
        </section>
      )}

      <section>
        <h4>Behavior</h4>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={settings.pasteAfterTranscribe}
            onChange={(e) => apply({ pasteAfterTranscribe: e.target.checked })}
          />
          <span>Auto-paste transcription into active app</span>
        </label>
      </section>

      <section>
        <h4>Diagnostics</h4>
        <button className="capture-btn" onClick={() => window.wisper.logOpen()}>
          Open log file
        </button>
        <button className="capture-btn" style={{ marginLeft: 8 }} onClick={runAudioDiagnostics}>
          Run audio diagnostics
        </button>
      </section>

      {saved && <div className="saved-badge">Saved</div>}
    </div>
  );
}
