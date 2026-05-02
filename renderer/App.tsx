import React, { useEffect, useRef, useState } from 'react';
import { MicRecorder } from './recorder';
import ModelPicker from './components/ModelPicker';
import History from './components/History';
import Settings from './components/Settings';

type Tab = 'main' | 'models' | 'history' | 'settings';
type Status = 'idle' | 'recording' | 'transcribing' | 'error';

export default function App() {
  const [tab, setTab] = useState<Tab>('main');
  const [status, setStatus] = useState<Status>('idle');
  const [level, setLevel] = useState(0);
  const [lastText, setLastText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [activeModel, setActiveModel] = useState<string>('');
  const [hotkey, setHotkey] = useState<string>('RightAlt');
  const [micDeviceId, setMicDeviceId] = useState<string>('');
  const [hasAccessibility, setHasAccessibility] = useState<boolean>(true);
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);
  const [transcribeMs, setTranscribeMs] = useState(0);
  const [lastDurationMs, setLastDurationMs] = useState(0);
  const transcribeStartRef = useRef<number>(0);
  const transcribeEndRef = useRef<number>(0);

  const recorderRef = useRef<MicRecorder | null>(null);
  const startingRef = useRef(false);

  useEffect(() => {
    window.wisper.getActiveModel().then(setActiveModel);
    window.wisper.getSettings().then((s: any) => {
      setHotkey(s.hotkey ?? 'RightAlt');
      setMicDeviceId(s.microphoneDeviceId ?? '');
    });
    window.wisper.checkAccessibility().then(setHasAccessibility);
    const offDown = window.wisper.onHotkeyDown(() => startRecording());
    const offUp = window.wisper.onHotkeyUp(() => stopAndTranscribe());
    const offErr = window.wisper.onHotkeyError((msg: string) => {
      setHotkeyError(msg);
      setHasAccessibility(false);
    });
    return () => {
      offDown();
      offUp();
      offErr();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startRecording() {
    if (startingRef.current || status === 'recording' || status === 'transcribing') return;
    startingRef.current = true;
    setError(null);
    try {
      const rec = new MicRecorder();
      await rec.start((rms) => setLevel(rms), micDeviceId || undefined);
      recorderRef.current = rec;
      setStatus('recording');
      window.wisper.notifyRecordingState(true);
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
    } finally {
      startingRef.current = false;
    }
  }

  async function stopAndTranscribe() {
    const rec = recorderRef.current;
    if (!rec) return;
    recorderRef.current = null;
    window.wisper.notifyRecordingState(false);
    setStatus('transcribing');
    transcribeStartRef.current = Date.now();
    setTranscribeMs(0);
    try {
      const wav = await rec.stop();
      const result = await window.wisper.transcribe(wav);
      transcribeEndRef.current = Date.now();
      setLastDurationMs(transcribeEndRef.current - transcribeStartRef.current);
      setLastText(result.text);
      setStatus('idle');
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
    }
  }

  // Elapsed-time ticker during transcription.
  useEffect(() => {
    if (status !== 'transcribing') return;
    const id = setInterval(() => {
      setTranscribeMs(Date.now() - transcribeStartRef.current);
    }, 100);
    return () => clearInterval(id);
  }, [status]);

  return (
    <div className="app">
      <nav className="tabs">
        <button className={tab === 'main' ? 'active' : ''} onClick={() => setTab('main')}>
          Dictate
        </button>
        <button
          className={tab === 'models' ? 'active' : ''}
          onClick={() => setTab('models')}
        >
          Models
        </button>
        <button
          className={tab === 'history' ? 'active' : ''}
          onClick={() => setTab('history')}
        >
          History
        </button>
        <button
          className={tab === 'settings' ? 'active' : ''}
          onClick={() => setTab('settings')}
        >
          Settings
        </button>
      </nav>

      <main className="content">
        {tab === 'main' && (
          <div className="dictate">
            <div className={`orb status-${status}`}>
              <div
                className="orb-ring"
                style={{ transform: `scale(${1 + Math.min(level * 6, 1.5)})` }}
              />
              <div className="orb-core">
                {status === 'recording' && '●'}
                {status === 'transcribing' && '…'}
                {(status === 'idle' || status === 'error') && '🎙'}
              </div>
            </div>
            <div className="status-line">
              {status === 'idle' && 'Hold the hotkey and speak.'}
              {status === 'recording' && 'Recording — release hotkey to transcribe.'}
              {status === 'transcribing' && `Transcribing… ${(transcribeMs / 1000).toFixed(1)}s`}
              {status === 'error' && (error ?? 'Error')}
            </div>
            {status === 'transcribing' && (
              <div className="progress-track">
                <div className="progress-bar" />
              </div>
            )}
            <button
              className="big-btn"
              onMouseDown={startRecording}
              onMouseUp={stopAndTranscribe}
              onMouseLeave={() => status === 'recording' && stopAndTranscribe()}
            >
              Hold to record
            </button>
            {!hasAccessibility && (
              <div className="warning-bar">
                {hotkeyError
                  ? 'Hotkeys disabled — Accessibility permission required.'
                  : 'Auto-paste requires Accessibility permission.'}{' '}
                <button
                  className="link-btn"
                  onClick={() => {
                    window.wisper.openAccessibilitySettings();
                    // Re-check after a few seconds; hotkey-tap auto-retries on its own.
                    setTimeout(() => window.wisper.checkAccessibility().then((ok) => {
                      setHasAccessibility(ok);
                      if (ok) setHotkeyError(null);
                    }), 3000);
                  }}
                >
                  Open Settings →
                </button>
                {hotkeyError && (
                  <span className="warning-hint"> Restart the app after granting access.</span>
                )}
              </div>
            )}

          {lastText && (
              <div className="last-text">
                <h4>Last transcription {lastDurationMs > 0 && <span className="duration">({(lastDurationMs / 1000).toFixed(1)}s)</span>}</h4>
                <p>{lastText}</p>
              </div>
            )}
            <div className="footer-info">
              Model: <code>{activeModel || 'none'}</code>
              {' · '}Hotkey: <code>{hotkey}</code>
            </div>
          </div>
        )}

        {tab === 'models' && (
          <ModelPicker
            activeModel={activeModel}
            onActiveChange={setActiveModel}
          />
        )}

        {tab === 'history' && <History />}

        {tab === 'settings' && (
          <Settings onHotkeyChange={(k) => setHotkey(k)} onMicChange={(id) => setMicDeviceId(id)} />
        )}
      </main>
    </div>
  );
}
