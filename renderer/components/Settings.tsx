import React, { useEffect, useRef, useState } from 'react';

interface SettingsData {
  activeModelId: string;
  hotkey: string;
  pasteAfterTranscribe: boolean;
  language: string;
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

export default function Settings({
  onHotkeyChange,
}: {
  onHotkeyChange: (key: string) => void;
}) {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captureKeys, setCaptureKeys] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const captureRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    window.wisper.getSettings().then((s) => setSettings(s as SettingsData));
  }, []);

  async function apply(patch: Partial<SettingsData>) {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    await window.wisper.setSettings(patch as Record<string, unknown>);
    if (patch.hotkey) onHotkeyChange(patch.hotkey);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  function startCapture() {
    setCapturing(true);
    setCaptureKeys([]);
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
      // On any key-up: commit whatever is held right now as the combo.
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

      {saved && <div className="saved-badge">Saved</div>}
    </div>
  );
}
