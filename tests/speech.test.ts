import assert from "node:assert/strict";
import { test } from "node:test";
import { speakable, speakableSummary } from "../web/src/speechText.ts";

test("a reply is read without its markup: code and tables are named, paths are file names, links are their text", () => {
  const markdown = [
    "## Result",
    "",
    "The **parser** test passes again. See `src/parser/explicit.ts:42` and [the notes](https://example.com/notes).",
    "",
    "```ts",
    "const x = 1;",
    "```",
    "",
    "| a | b |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "- first point",
    "- second point with `inline code`",
    "",
    "> quoted line",
    "![screenshot](/tmp/shot.png)",
  ].join("\n");
  assert.equal(
    speakable(markdown),
    "Result. The parser test passes again. See explicit.ts and the notes. A code block. A table. first point. second point with inline code. quoted line. an image, screenshot.",
  );
});

test("read on arrival: the Handoff section when there is one, otherwise the opening sentences with a word about the rest", () => {
  const withHandoff = "Long analysis. More analysis.\n\n## Handoff\n\nTwo files changed. Tests pass.";
  assert.equal(speakableSummary(withHandoff), "Handoff. Two files changed. Tests pass.".replace("Handoff. ", ""));
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i + 1} says something useful.`).join(" ");
  const summary = speakableSummary(long);
  assert.ok(summary.endsWith(" The rest is on screen."));
  assert.ok(summary.length < 800);
  assert.ok(/useful\. The rest is on screen\.$/.test(summary), "cut at a sentence end");
  assert.equal(speakableSummary("Short."), "Short.");
});

test("the speech routes: status starts the model loading, a piece comes back as WAV, and off says so", async (t) => {
  const { loadConfig } = await import("../src/config.ts");
  const { createHttpApp } = await import("../src/server/http.ts");
  const { createTestStack } = await import("./helpers.ts");
  const { KOKORO_VOICES } = await import("../src/speech/kokoro.ts");
  const stack = await createTestStack();
  t.after(() => stack.close());
  const config = loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-speech", ROOMS_PORT: "0" });
  let warmed = 0;
  const asked: Array<{ text: string; voice: string; speed: number }> = [];
  const fake = {
    status: () => ({ state: "ready" as const, error: null, voices: KOKORO_VOICES, defaultVoice: "af_heart" }),
    warm: () => {
      warmed += 1;
    },
    synthesize: async (text: string, voice: string, speed: number) => {
      asked.push({ text, voice, speed });
      return Buffer.from("RIFF....WAVEfmt ");
    },
  };
  const app = createHttpApp(stack, config, "/nonexistent/dist", undefined, fake);
  const status = (await (await app.request("/api/speech/status")).json()) as { available: boolean; state: string; voices: unknown[]; defaultVoice: string };
  assert.deepEqual([status.available, status.state, status.defaultVoice, status.voices.length, warmed], [true, "ready", "af_heart", 28, 1]);
  const wav = await app.request("/api/speech", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Claude. Tests pass.", voice: "bf_emma", speed: 1.2 }) });
  assert.equal(wav.status, 200);
  assert.equal(wav.headers.get("content-type"), "audio/wav");
  assert.equal(Buffer.from(await wav.arrayBuffer()).toString("latin1"), "RIFF....WAVEfmt ");
  assert.deepEqual(asked, [{ text: "Claude. Tests pass.", voice: "bf_emma", speed: 1.2 }]);
  assert.equal((await app.request("/api/speech", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "" }) })).status, 400);
  assert.equal((await app.request("/api/speech", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x".repeat(1300) }) })).status, 413);

  const off = createHttpApp(stack, config, "/nonexistent/dist", undefined, null);
  assert.equal(((await (await off.request("/api/speech/status")).json()) as { available: boolean }).available, false);
  assert.equal((await off.request("/api/speech", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) })).status, 503);
});

test("the box trims the model's silence at both ends of a piece to a short breath, and writes plain 16-bit WAV", async () => {
  const { trimSilence, pcm16Wav } = await import("../src/speech/kokoro.ts");
  const rate = 24000;
  const samples = new Float32Array(rate * 3); // 3 s: 0.5 s quiet, 2 s tone, 0.5 s quiet
  for (let i = Math.round(rate * 0.5); i < Math.round(rate * 2.5); i += 1) samples[i] = 0.5 * Math.sin(i / 10);
  const trimmed = trimSilence(samples, rate);
  const kept = trimmed.length / rate;
  assert.ok(kept > 2.2 && kept < 2.3, `about 2 s of sound plus a short breath at each end, got ${kept.toFixed(2)} s`);
  assert.equal(trimSilence(new Float32Array(100), rate).length, 100, "all silence is left alone");
  const wav = pcm16Wav(new Float32Array([0, 1, -1]), rate);
  assert.equal(wav.subarray(0, 4).toString("latin1"), "RIFF");
  assert.deepEqual([wav.readUInt16LE(20), wav.readUInt16LE(22), wav.readUInt32LE(24), wav.readUInt16LE(34), wav.readUInt32LE(40)], [1, 1, rate, 16, 6], "PCM, mono, 24 kHz, 16-bit, three samples");
  assert.deepEqual([wav.readInt16LE(44), wav.readInt16LE(46), wav.readInt16LE(48)], [0, 32767, -32768]);
});
