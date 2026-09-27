/**
 * Backroom's own voice: Kokoro, a small neural text-to-speech model, run inside the service on the CPU through ONNX.
 * The UI sends a sentence or two and plays the WAV that comes back, so every device hears the same voice, the phone
 * included, and nothing is installed on the device. The model (about 90 MB) is fetched once from Hugging Face into
 * the data folder; the voices ship with the package.
 *
 * Loading takes a few seconds and synthesis runs at about twice real time on a desktop CPU, so the model is loaded
 * when first asked for (opening the UI asks), one request is synthesised at a time, and recent pieces are kept so a
 * replay costs nothing. The model runs in a worker thread (worker.ts): a piece takes seconds of CPU, and on the
 * service's own thread every other request would wait behind it.
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { Worker } from "node:worker_threads";

export interface SpeechVoice {
  id: string;
  name: string;
  /** "en-us" or "en-gb". */
  language: string;
  gender: string;
  /** Kokoro's own grade for the voice, A to F. */
  grade: string;
}

export interface SpeechStatus {
  state: "idle" | "loading" | "ready" | "failed";
  error: string | null;
  voices: SpeechVoice[];
  defaultVoice: string;
}

/** What the HTTP routes need; the tests give them a fake. */
export interface SpeechSynth {
  status(): SpeechStatus;
  /** Start loading the model if it is not loaded; returns at once. */
  warm(): void;
  /** `text` as a WAV (24 kHz, 16-bit mono). */
  synthesize(text: string, voice: string, speed: number): Promise<Buffer>;
}

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

/** Kokoro's voices with its grades; the better ones first. */
export const KOKORO_VOICES: SpeechVoice[] = [
  { id: "af_heart", name: "Heart", language: "en-us", gender: "female", grade: "A" },
  { id: "af_bella", name: "Bella", language: "en-us", gender: "female", grade: "A-" },
  { id: "af_nicole", name: "Nicole", language: "en-us", gender: "female", grade: "B-" },
  { id: "bf_emma", name: "Emma", language: "en-gb", gender: "female", grade: "B-" },
  { id: "af_aoede", name: "Aoede", language: "en-us", gender: "female", grade: "C+" },
  { id: "af_kore", name: "Kore", language: "en-us", gender: "female", grade: "C+" },
  { id: "af_sarah", name: "Sarah", language: "en-us", gender: "female", grade: "C+" },
  { id: "am_fenrir", name: "Fenrir", language: "en-us", gender: "male", grade: "C+" },
  { id: "am_michael", name: "Michael", language: "en-us", gender: "male", grade: "C+" },
  { id: "am_puck", name: "Puck", language: "en-us", gender: "male", grade: "C+" },
  { id: "af_alloy", name: "Alloy", language: "en-us", gender: "female", grade: "C" },
  { id: "af_nova", name: "Nova", language: "en-us", gender: "female", grade: "C" },
  { id: "bf_isabella", name: "Isabella", language: "en-gb", gender: "female", grade: "C" },
  { id: "bm_george", name: "George", language: "en-gb", gender: "male", grade: "C" },
  { id: "bm_fable", name: "Fable", language: "en-gb", gender: "male", grade: "C" },
  { id: "af_sky", name: "Sky", language: "en-us", gender: "female", grade: "C-" },
  { id: "bm_lewis", name: "Lewis", language: "en-gb", gender: "male", grade: "D+" },
  { id: "af_jessica", name: "Jessica", language: "en-us", gender: "female", grade: "D" },
  { id: "af_river", name: "River", language: "en-us", gender: "female", grade: "D" },
  { id: "am_echo", name: "Echo", language: "en-us", gender: "male", grade: "D" },
  { id: "am_eric", name: "Eric", language: "en-us", gender: "male", grade: "D" },
  { id: "am_liam", name: "Liam", language: "en-us", gender: "male", grade: "D" },
  { id: "am_onyx", name: "Onyx", language: "en-us", gender: "male", grade: "D" },
  { id: "bf_alice", name: "Alice", language: "en-gb", gender: "female", grade: "D" },
  { id: "bf_lily", name: "Lily", language: "en-gb", gender: "female", grade: "D" },
  { id: "bm_daniel", name: "Daniel", language: "en-gb", gender: "male", grade: "D" },
  { id: "am_santa", name: "Santa", language: "en-us", gender: "male", grade: "D-" },
  { id: "am_adam", name: "Adam", language: "en-us", gender: "male", grade: "F+" },
];

const CACHE_ENTRIES = 64;

type Answer = { id: number; ok: true; samples?: Float32Array; sampleRate?: number } | { id: number; ok: false; error: string };
type WorkerReply = Answer | { type: "log"; message: string };

/**
 * The model pads each piece with about a third of a second of silence in front and half a second after. Replies are
 * read as a run of pieces, so that padding is heard as a stumble at every seam: keep a short breath at each end and
 * drop the rest.
 */
export function trimSilence(samples: Float32Array, sampleRate: number, threshold = 0.01, keepLeadMs = 60, keepTrailMs = 180): Float32Array {
  let start = 0;
  while (start < samples.length && Math.abs(samples[start] ?? 0) < threshold) start += 1;
  let end = samples.length;
  while (end > start && Math.abs(samples[end - 1] ?? 0) < threshold) end -= 1;
  if (start >= end) return samples;
  const from = Math.max(0, start - Math.round((keepLeadMs / 1000) * sampleRate));
  const to = Math.min(samples.length, end + Math.round((keepTrailMs / 1000) * sampleRate));
  return samples.subarray(from, to);
}

/** Samples as a 16-bit PCM WAV: half the bytes of the float WAV the model hands back, and every browser plays it. */
export function pcm16Wav(samples: Float32Array, sampleRate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const clipped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    data.writeInt16LE(Math.round(clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export class KokoroSpeech implements SpeechSynth {
  private readonly modelsDir: string;
  private readonly defaultVoice: string;
  private readonly log: (message: string) => void;
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (reply: Answer) => void; reject: (error: Error) => void }>();
  private loading: Promise<void> | null = null;
  private state: SpeechStatus["state"] = "idle";
  private error: string | null = null;
  /** One synthesis at a time: the model is not reentrant and the CPU is better used in order. */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly cache = new Map<string, Buffer>();

  constructor(options: { modelsDir: string; defaultVoice?: string; log?: (message: string) => void }) {
    this.modelsDir = options.modelsDir;
    this.defaultVoice = options.defaultVoice && KOKORO_VOICES.some((v) => v.id === options.defaultVoice) ? options.defaultVoice : "af_heart";
    this.log = options.log ?? (() => undefined);
  }

  status(): SpeechStatus {
    return { state: this.state, error: this.error, voices: KOKORO_VOICES, defaultVoice: this.defaultVoice };
  }

  warm(): void {
    void this.load().catch(() => undefined);
  }

  private spawn(): Worker {
    if (this.worker) return this.worker;
    mkdirSync(this.modelsDir, { recursive: true });
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: { modelsDir: this.modelsDir } });
    worker.on("message", (reply: WorkerReply) => {
      if ("type" in reply) {
        this.log(reply.message);
        return;
      }
      const pending = this.waiting.get(reply.id);
      if (!pending) return;
      this.waiting.delete(reply.id);
      pending.resolve(reply);
    });
    const gone = (reason: string) => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.loading = null;
      this.state = "failed";
      this.error = reason;
      this.log(`voice worker stopped: ${reason}`);
      for (const [id, pending] of this.waiting) {
        this.waiting.delete(id);
        pending.reject(new Error(reason));
      }
    };
    worker.on("error", (error) => gone(error.message));
    worker.on("exit", (code) => gone(`exited with code ${code}`));
    // The worker must not keep the service alive on its own.
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private ask(request: Record<string, unknown>): Promise<Answer> {
    const worker = this.spawn();
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      worker.postMessage({ id, ...request });
    });
  }

  private load(): Promise<void> {
    if (this.state === "ready" && this.worker) return Promise.resolve();
    if (this.loading) return this.loading;
    this.state = "loading";
    this.error = null;
    const started = Date.now();
    this.loading = this.ask({ type: "load" }).then((reply) => {
      if (!reply.ok) throw new Error(reply.error);
      this.state = "ready";
      this.log(`voice ready (${this.defaultVoice}) in ${Date.now() - started} ms`);
    });
    this.loading.catch((error: unknown) => {
      this.state = "failed";
      this.error = error instanceof Error ? error.message : String(error);
      this.loading = null;
      this.log(`voice model failed to load: ${this.error}`);
    });
    return this.loading;
  }

  async synthesize(text: string, voice: string, speed: number): Promise<Buffer> {
    const chosen = KOKORO_VOICES.some((v) => v.id === voice) ? voice : this.defaultVoice;
    const rate = Math.min(2, Math.max(0.5, Number.isFinite(speed) ? speed : 1));
    const key = createHash("sha1").update(`${chosen}\n${rate}\n${text}`).digest("hex");
    const cached = this.cache.get(key);
    if (cached) {
      // Most recently used last.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    await this.load();
    const run = this.chain.then(async () => {
      const reply = await this.ask({ type: "synth", text, voice: chosen, speed: rate });
      if (!reply.ok || !("samples" in reply) || !reply.samples) throw new Error(!reply.ok ? reply.error : "no samples");
      return pcm16Wav(trimSilence(reply.samples, reply.sampleRate ?? 24000), reply.sampleRate ?? 24000);
    });
    this.chain = run.catch(() => undefined);
    const wav = await run;
    this.cache.set(key, wav);
    while (this.cache.size > CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value as string);
    return wav;
  }
}
