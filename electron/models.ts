import { createWriteStream, existsSync, statSync, unlinkSync, renameSync } from 'fs';
import { join } from 'path';
import { get } from 'https';
import { modelsDir } from './paths.js';

export interface ModelInfo {
  id: string;
  label: string;
  filename: string;
  url: string;
  sizeMb: number;
}

// Mirror: huggingface.co/ggerganov/whisper.cpp
export const MODELS: ModelInfo[] = [
  {
    id: 'tiny-q5_1',
    label: 'Tiny (q5_1)',
    filename: 'ggml-tiny-q5_1.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny-q5_1.bin',
    sizeMb: 31,
  },
  {
    id: 'base-q5_1',
    label: 'Base (q5_1)',
    filename: 'ggml-base-q5_1.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin',
    sizeMb: 57,
  },
  {
    id: 'small-q5_1',
    label: 'Small (q5_1)',
    filename: 'ggml-small-q5_1.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin',
    sizeMb: 181,
  },
  {
    id: 'medium-q5_0',
    label: 'Medium (q5_0)',
    filename: 'ggml-medium-q5_0.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q5_0.bin',
    sizeMb: 514,
  },
  {
    id: 'large-v3-turbo-q5_0',
    label: 'Large-v3-turbo (q5_0) — recommended',
    filename: 'ggml-large-v3-turbo-q5_0.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
    sizeMb: 547,
  },
  {
    id: 'large-v3-turbo',
    label: 'Large-v3-turbo (f16)',
    filename: 'ggml-large-v3-turbo.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
    sizeMb: 1624,
  },
  {
    id: 'large-v3',
    label: 'Large-v3 (f16)',
    filename: 'ggml-large-v3.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin',
    sizeMb: 3094,
  },
];

export function modelPath(id: string): string {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown model: ${id}`);
  return join(modelsDir(), m.filename);
}

export function isModelInstalled(id: string): boolean {
  try {
    const p = modelPath(id);
    return existsSync(p) && statSync(p).size > 1024 * 1024;
  } catch {
    return false;
  }
}

export function listModelsWithStatus() {
  return MODELS.map((m) => ({ ...m, installed: isModelInstalled(m.id) }));
}

export function deleteModel(id: string): void {
  const p = modelPath(id);
  if (existsSync(p)) unlinkSync(p);
}

export async function downloadModel(
  id: string,
  onProgress: (pct: number) => void
): Promise<void> {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown model: ${id}`);
  const target = modelPath(id);
  if (isModelInstalled(id)) return;

  await follow(m.url, target, onProgress);
}

function follow(
  url: string,
  target: string,
  onProgress: (pct: number) => void,
  redirects = 0
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    const req = get(url, (res) => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        res.resume();
        follow(res.headers.location, target, onProgress, redirects + 1).then(
          resolve,
          reject
        );
        return;
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const total = Number(res.headers['content-length'] ?? 0);
      let downloaded = 0;
      const tmp = target + '.part';
      const file = createWriteStream(tmp);
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total > 0) onProgress(Math.round((downloaded / total) * 100));
      });
      res.pipe(file);
      file.on('finish', () => {
        file.close((err) => {
          if (err) return reject(err);
          try {
            renameSync(tmp, target);
            onProgress(100);
            resolve();
          } catch (e) {
            reject(e as Error);
          }
        });
      });
      file.on('error', (err) => {
        try {
          unlinkSync(tmp);
        } catch {}
        reject(err);
      });
    });
    req.on('error', reject);
  });
}
