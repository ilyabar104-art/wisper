/**
 * Microphone recorder → 16 kHz mono PCM16 WAV.
 * Uses a module-level singleton AudioContext so the OS audio device is opened
 * only once (Chromium opens an output stream per AudioContext, capped at 50).
 */

const WORKLET_CODE = `
class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch?.length) this.port.postMessage(ch.slice());
    return true;
  }
}
registerProcessor('recorder-processor', RecorderProcessor);
`;

let sharedCtx: AudioContext | null = null;
let workletReady = false;

async function getCtx(): Promise<AudioContext> {
  if (sharedCtx && sharedCtx.state !== 'closed') return sharedCtx;
  sharedCtx = new AudioContext({ sampleRate: 16000 });
  workletReady = false;
  return sharedCtx;
}

async function ensureWorklet(ctx: AudioContext): Promise<void> {
  if (workletReady) return;
  const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  workletReady = true;
}

export class MicRecorder {
  private stream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private chunks: Float32Array[] = [];

  async start(onLevel?: (rms: number) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    const ctx = await getCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    await ensureWorklet(ctx);

    this.chunks = [];
    this.source = ctx.createMediaStreamSource(this.stream);
    this.workletNode = new AudioWorkletNode(ctx, 'recorder-processor');

    this.workletNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
      this.chunks.push(new Float32Array(e.data));
      if (onLevel) {
        const data = e.data;
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        onLevel(Math.sqrt(sum / data.length));
      }
    };

    // No connection to ctx.destination → no output stream opened.
    this.source.connect(this.workletNode);
  }

  async stop(): Promise<ArrayBuffer> {
    this.workletNode?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());

    // Suspend (not close) the shared context so the device is released
    // but we don't have to re-create it next time.
    if (sharedCtx && sharedCtx.state === 'running') {
      await sharedCtx.suspend();
    }

    const merged = mergeFloat32(this.chunks);
    const samples =
      sharedCtx && sharedCtx.sampleRate === 16000
        ? merged
        : resampleLinear(merged, sharedCtx?.sampleRate ?? 48000, 16000);
    const wav = encodeWav(samples, 16000);

    this.chunks = [];
    this.source = null;
    this.workletNode = null;
    this.stream = null;
    return wav;
  }
}

function mergeFloat32(parts: Float32Array[]): Float32Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function resampleLinear(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    out[i] = input[i0] * (1 - (src - i0)) + input[i1] * (src - i0);
  }
  return out;
}

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const len = 44 + samples.length * 2;
  const buf = new ArrayBuffer(len);
  const v = new DataView(buf);
  const ws = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, len - 8, true);
  ws(8, 'WAVE'); ws(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return buf;
}
