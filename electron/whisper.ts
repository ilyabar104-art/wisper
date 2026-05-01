import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { createServer } from 'net';
import { cpus } from 'os';
import { whisperServerBinPath } from './paths.js';
import { modelPath, isModelInstalled } from './models.js';
import { getSettings } from './settings.js';

export interface TranscribeResult {
  text: string;
  durationMs: number;
}

interface ServerHandle {
  proc: ChildProcess;
  port: number;
  modelId: string;
}

let server: ServerHandle | null = null;
let starting: Promise<ServerHandle> | null = null;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error('failed to acquire port'));
      }
    });
  });
}

async function startServer(modelId: string): Promise<ServerHandle> {
  if (!isModelInstalled(modelId)) {
    throw new Error(`Model "${modelId}" is not installed. Open the Models tab to download it.`);
  }
  const bin = whisperServerBinPath();
  if (!existsSync(bin)) {
    throw new Error(`whisper-server binary not found at ${bin}. Run "npm run setup:whisper".`);
  }

  const port = await freePort();
  const args = [
    '-m', modelPath(modelId),
    '--host', '127.0.0.1',
    '--port', String(port),
    '--inference-path', '/inference',
    '-t', String(Math.max(2, Math.floor((cpus().length || 4) / 2))),
  ];

  console.log('[whisper] spawning server on port', port, 'model', modelId);
  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let readyResolve: (() => void) | null = null;
  let readyReject: ((e: Error) => void) | null = null;
  const ready = new Promise<void>((res, rej) => { readyResolve = res; readyReject = rej; });

  let gpuLogged = false;
  const onLine = (line: string) => {
    if (!gpuLogged) {
      // Metal (macOS)
      if (line.includes('ggml_metal_init: found device')) {
        const m = line.match(/ggml_metal_init: found device: (.+)/);
        console.log('[whisper] Metal —', m ? m[1].trim() : 'GPU');
        gpuLogged = true;
      }
      // Vulkan
      else if (line.includes('ggml_vulkan: Using')) {
        const m = line.match(/ggml_vulkan: Using (.+)/);
        console.log('[whisper] Vulkan —', m ? m[1].trim() : 'GPU');
        gpuLogged = true;
      }
      // CUDA
      else if (line.includes('ggml_cuda_init: found') || line.includes('CUDA: Found')) {
        const m = line.match(/found (\d+) CUDA/i);
        console.log('[whisper] CUDA —', m ? `${m[1]} device(s)` : 'GPU');
        gpuLogged = true;
      }
    }
    if (line.includes('listening') || line.includes('Server is listening')) {
      readyResolve?.();
    }
  };

  let buf = '';
  const onData = (chunk: Buffer) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  };
  proc.stdout?.on('data', onData);
  proc.stderr?.on('data', onData);

  proc.on('exit', (code) => {
    console.warn('[whisper] server exited code', code);
    if (server && server.proc === proc) server = null;
    readyReject?.(new Error(`whisper-server exited ${code} before becoming ready`));
  });

  // Fallback: poll the port — some builds don't print a "listening" line.
  const portPoll = (async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/`, { method: 'GET' });
        // Any response (even 404) means the HTTP server is up.
        if (r.status >= 200) return;
      } catch { /* not ready */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('whisper-server did not become reachable within 30s');
  })();

  await Promise.race([ready, portPoll]);

  return { proc, port, modelId };
}

async function ensureServer(): Promise<ServerHandle> {
  const modelId = getSettings().activeModelId;
  if (server && server.modelId === modelId && !server.proc.killed) return server;

  if (server && server.modelId !== modelId) {
    console.log('[whisper] model changed, restarting server');
    server.proc.kill();
    server = null;
  }

  if (starting) return starting;
  starting = startServer(modelId)
    .then((h) => { server = h; starting = null; return h; })
    .catch((e) => { starting = null; throw e; });
  return starting;
}

export async function transcribeWav(wavBytes: Buffer): Promise<TranscribeResult> {
  const handle = await ensureServer();
  const settings = getSettings();
  const t0 = Date.now();

  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(wavBytes)], { type: 'audio/wav' }),
    'audio.wav',
  );
  form.append('response_format', 'json');
  form.append('language', settings.language || 'auto');
  form.append('temperature', '0');

  const res = await fetch(`http://127.0.0.1:${handle.port}/inference`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`whisper-server ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json() as { text?: string };
  return {
    text: cleanText(data.text ?? ''),
    durationMs: Date.now() - t0,
  };
}

function cleanText(raw: string): string {
  return raw
    .trim()
    // Mid-word segment break (letter\nletter) → join without space
    .replace(/([a-zA-Zа-яёА-ЯЁ])\n([a-zA-Zа-яёА-ЯЁ])/g, '$1$2')
    // Everything else → space
    .replace(/\n+/g, ' ')
    .replace(/ {2,}/g, ' ');
}

/** Pre-spawn the server during app startup so first dictation isn't slow. */
export function warmupWhisper(): void {
  ensureServer().catch((e) => console.warn('[whisper] warmup failed:', e.message));
}

export function shutdownWhisper(): void {
  if (server) {
    try { server.proc.kill(); } catch {}
    server = null;
  }
}
