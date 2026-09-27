/**
 * The voice model in a worker thread. Synthesis takes seconds of CPU and holds the thread it runs on, so it must
 * not run on the service's own: every other request would wait behind it. The service posts pieces of text; the
 * worker answers with the samples. See kokoro.ts for the protocol and the class that talks to this file.
 */
import { parentPort, workerData } from "node:worker_threads";

type Request = { id: number; type: "load" } | { id: number; type: "synth"; text: string; voice: string; speed: number };

interface KokoroLike {
  generate(text: string, options: { voice: string; speed: number }): Promise<{ audio: Float32Array; sampling_rate: number }>;
}

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const { modelsDir } = workerData as { modelsDir: string };
const port = parentPort!;

let tts: KokoroLike | null = null;
let loading: Promise<KokoroLike> | null = null;

function load(): Promise<KokoroLike> {
  if (tts) return Promise.resolve(tts);
  if (loading) return loading;
  loading = (async () => {
    const [{ env }, { KokoroTTS }] = await Promise.all([import("@huggingface/transformers"), import("kokoro-js")]);
    env.cacheDir = modelsDir;
    let lastLogged = 0;
    const model = (await KokoroTTS.from_pretrained(MODEL, {
      dtype: "q8",
      device: "cpu",
      progress_callback: (progress: { status?: string; file?: string; progress?: number }) => {
        if (progress.status === "progress" && typeof progress.progress === "number" && progress.progress < 100 && progress.progress - lastLogged >= 25) {
          lastLogged = progress.progress;
          port.postMessage({ type: "log", message: `voice model: downloading ${progress.file ?? ""} ${Math.round(progress.progress)}%` });
        }
      },
    })) as unknown as KokoroLike;
    tts = model;
    return model;
  })();
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

port.on("message", async (request: Request) => {
  try {
    if (request.type === "load") {
      await load();
      port.postMessage({ id: request.id, ok: true });
      return;
    }
    const model = await load();
    const audio = await model.generate(request.text, { voice: request.voice, speed: request.speed });
    // The samples move to the service without a copy.
    const samples = audio.audio.buffer.byteLength === audio.audio.byteLength ? audio.audio : audio.audio.slice();
    port.postMessage({ id: request.id, ok: true, samples, sampleRate: audio.sampling_rate }, [samples.buffer as ArrayBuffer]);
  } catch (error) {
    port.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
