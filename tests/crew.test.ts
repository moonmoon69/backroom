/**
 * Each saved crew member's two lines (what it is good at, what to avoid), and the crew as the Consigliere reads it
 * (src/app/crew.ts): the effort level per harness, the listing line, the commands that save the lines, the migrations
 * that add the sentence and make it the first line, and the "Your crew" standing section with its fingerprint
 * (src/briefing/assemble.ts).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crewLine, crewListing } from "../src/app/crew.ts";
import { isEffortOption, selectionEffort } from "../src/domain/effort.ts";
import { changedStanding, crewSection, standingFingerprint, standingText, type StandingInput } from "../src/briefing/assemble.ts";
import { Database, MIGRATIONS } from "../src/db/database.ts";
import { Repos } from "../src/db/repos.ts";
import { PRESET_DESCRIPTION_MAX } from "../src/domain/commands.ts";
import type { ModelSelection, Participant, Preset, Room } from "../src/domain/types.ts";
import { PRESET_DESCRIPTION_MAX as WEB_PRESET_DESCRIPTION_MAX } from "../web/src/types.ts";
import { createTestStack } from "./helpers.ts";

/** The user's eight saved crew members as data/rooms.sqlite holds their model selections. */
const REAL: Array<[string, ModelSelection]> = [
  ["Opus", { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "xhigh" }, { id: "fastMode", value: false }, { id: "contextWindow", value: "1m" }] }],
  ["Fable", { instanceId: "claudeAgent", model: "claude-fable-5-1", options: [{ id: "effort", value: "xhigh" }] }],
  ["Grok", { instanceId: "cursor", model: "grok-4.6", options: [{ id: "reasoning", value: "xhigh" }, { id: "fastMode", value: false }] }],
  ["Gemini", { instanceId: "antigravity", model: "gemini-3.8-flash-high" }],
  ["Astra", { instanceId: "codex", model: "gpt-6-astra", options: [{ id: "reasoningEffort", value: "xhigh" }, { id: "serviceTier", value: "default" }] }],
  ["Sol", { instanceId: "codex", model: "gpt-6.1-sol", options: [{ id: "reasoningEffort", value: "max" }, { id: "serviceTier", value: "default" }] }],
  ["Haiku", { instanceId: "claudeAgent", model: "claude-haiku-5-5", options: [{ id: "effort", value: "max" }] }],
  ["OpusWorker", { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }, { id: "fastMode", value: false }] }],
];

const preset = (name: string, modelSelection: ModelSelection, extra: Partial<Preset> = {}): Preset => ({
  id: `id-${name}`, name, modelSelection, runtimeMode: "full-access", workspaceMode: "local", look: {}, goodAt: "", avoid: "", createdAt: "", updatedAt: "", ...extra,
});

/** A saved crew member's two lines, as the service keeps them: good at, avoid. */
const lines = (stack: { repos: Repos }, id: string) => {
  const saved = stack.repos.getPreset(id);
  return [saved?.goodAt, saved?.avoid];
};

test("the effort level is the effort (Claude), reasoning (Cursor) or reasoningEffort (Codex) option, else none", () => {
  assert.deepEqual(
    REAL.map(([name, selection]) => [name, selectionEffort(selection)]),
    [["Opus", "xhigh"], ["Fable", "xhigh"], ["Grok", "xhigh"], ["Gemini", null], ["Astra", "xhigh"], ["Sol", "max"], ["Haiku", "max"], ["OpusWorker", "high"]],
  );
  assert.equal(selectionEffort({ instanceId: "claudeAgent", model: "m", options: [{ id: "fastMode", value: true }, { id: "contextWindow", value: "1m" }] }), null, "other options are not an effort");
  assert.equal(selectionEffort({ instanceId: "claudeAgent", model: "m", options: [{ id: "effort", value: { level: "high" } }] }), null, "nor a value that is not text");
  assert.equal(selectionEffort({ instanceId: "claudeAgent", model: "m", options: [{ id: "effort", value: "  " }] }), null);
});

test("Cursor's own spellings of the effort option count: reasoning_effort for Grok 4.7, and any case or separator of the same word", () => {
  // The user's Grok preset after the change to grok-4.7 (2026-10-11): Cursor's option id is reasoning_effort there, and the
  // listing said "effort none" with a saved effort of high.
  const grok47: ModelSelection = { instanceId: "cursor", model: "grok-4.7", options: [{ id: "contextWindow", value: "500k" }, { id: "fastMode", value: false }, { id: "reasoning_effort", value: "high" }] };
  assert.equal(selectionEffort(grok47), "high");
  assert.equal(crewLine(preset("Grok", grok47)), "Grok · grok-4.7 · effort high");
  for (const id of ["reasoning-effort", "ReasoningEffort", "REASONING_EFFORT", "Effort"]) {
    assert.equal(selectionEffort({ instanceId: "cursor", model: "m", options: [{ id, value: "xhigh" }] }), "xhigh", id);
    assert.equal(isEffortOption(id), true, id);
  }
  for (const id of ["effortless", "reasoningMode", "thinking", "serviceTier", "contextWindow", ""]) {
    assert.equal(isEffortOption(id), false, id);
  }
});

test("a crew line is name · model · effort · worktree note · good at · avoid, leaving out what is not there", () => {
  assert.deepEqual(crewListing(REAL.map(([name, selection]) => preset(name, selection))), [
    "The user's saved crew (seat one with: rooms-board seat <name>):",
    "Opus · claude-opus-5-5 · effort xhigh",
    "Fable · claude-fable-5-1 · effort xhigh",
    "Grok · grok-4.6 · effort xhigh",
    "Gemini · gemini-3.8-flash-high · effort none",
    "Astra · gpt-6-astra · effort xhigh",
    "Sol · gpt-6.1-sol · effort max",
    "Haiku · claude-haiku-5-5 · effort max",
    "OpusWorker · claude-opus-5-5 · effort high",
  ]);
  const [, opus] = REAL[0]!;
  assert.equal(
    crewLine(preset("Opus", opus, { workspaceMode: "worktree", goodAt: "careful review of risky changes", avoid: "quick lookups; it is slow" })),
    "Opus · claude-opus-5-5 · effort xhigh · works in its own worktree · good at: careful review of risky changes · avoid: quick lookups; it is slow",
  );
  assert.equal(crewLine(preset("Opus", opus, { goodAt: "careful review" })), "Opus · claude-opus-5-5 · effort xhigh · good at: careful review", "good at alone");
  assert.equal(crewLine(preset("Opus", opus, { avoid: "quick lookups" })), "Opus · claude-opus-5-5 · effort xhigh · avoid: quick lookups", "avoid alone");
  assert.equal(crewLine(preset("Opus", opus, { goodAt: "   ", avoid: " " })), "Opus · claude-opus-5-5 · effort xhigh", "blank lines leave no trailing ·");
  assert.deepEqual(crewListing([]), ["The user has no saved crew."]);
});

test("each line is saved on one line within the cap; an update that omits one keeps it, an empty one clears it alone", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, []);
  t.after(() => stack.close());
  const [, opus] = REAL[0]!;
  const plain = (await stack.run({ type: "preset.create", name: "plain", modelSelection: opus })) as { presetId: string };
  assert.deepEqual(lines(stack, plain.presetId), ["", ""], "empty by default");

  const saved = (await stack.run({ type: "preset.create", name: "opus", modelSelection: opus, goodAt: "  careful review\nof risky\t changes  ", avoid: " quick\r\n lookups " })) as { presetId: string };
  const both = () => lines(stack, saved.presetId);
  assert.deepEqual(both(), ["careful review of risky changes", "quick lookups"], "each folded to one line on the server");
  for (const field of ["goodAt", "avoid"] as const) {
    await assert.rejects(stack.run({ type: "preset.create", name: "long", modelSelection: opus, [field]: "x".repeat(PRESET_DESCRIPTION_MAX + 1) }), /300/, field);
    await assert.rejects(stack.run({ type: "preset.update", presetId: saved.presetId, [field]: "x".repeat(PRESET_DESCRIPTION_MAX + 1) }), /300/, field);
  }
  const atCap = (await stack.run({ type: "preset.create", name: "full", modelSelection: opus, goodAt: "g".repeat(PRESET_DESCRIPTION_MAX), avoid: "a".repeat(PRESET_DESCRIPTION_MAX) })) as { presetId: string };
  assert.deepEqual(lines(stack, atCap.presetId).map((line) => line?.length), [PRESET_DESCRIPTION_MAX, PRESET_DESCRIPTION_MAX], "the cap is each line's");
  assert.equal(WEB_PRESET_DESCRIPTION_MAX, PRESET_DESCRIPTION_MAX, "the page's fields have the server's cap");

  await stack.run({ type: "preset.update", presetId: saved.presetId, name: "opus-high", runtimeMode: "auto", workspaceMode: "worktree", look: { hair: "short" } });
  assert.deepEqual(both(), ["careful review of risky changes", "quick lookups"], "a name, mode or look change keeps both");
  await stack.run({ type: "preset.update", presetId: saved.presetId, modelSelection: REAL[1]![1] });
  assert.deepEqual(both(), ["careful review of risky changes", "quick lookups"], "so does a model change");
  await stack.run({ type: "preset.update", presetId: saved.presetId, goodAt: "fast\r\nwriting" });
  assert.deepEqual(both(), ["fast writing", "quick lookups"], "a new good at keeps avoid");
  await stack.run({ type: "preset.update", presetId: saved.presetId, avoid: "reviews" });
  assert.deepEqual(both(), ["fast writing", "reviews"], "a new avoid keeps good at");
  await stack.run({ type: "preset.update", presetId: saved.presetId, goodAt: "" });
  assert.deepEqual(both(), ["", "reviews"], "an empty good at clears it alone");
  await stack.run({ type: "preset.update", presetId: saved.presetId, goodAt: "fast writing", avoid: "" });
  assert.deepEqual(both(), ["fast writing", ""], "an empty avoid clears it alone");
  await assert.rejects(stack.run({ type: "preset.update", presetId: saved.presetId, description: "old" } as never), /description|unrecognized/i, "the old field is not taken");
});

test("the migrations keep a crew member's sentence as what it is good at, avoid empty, and change nothing else", () => {
  const sentence = (index: number) => (index % 2 === 0 ? `Sentence ${index}: careful, slow.` : "");
  // Two databases: one from before the two lines, its sentences saved; one from before the sentence, with none.
  for (const from of ["sentence", "none"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "backroom-crew-migration-"));
    try {
      const path = join(dir, "rooms.sqlite");
      const old = new Database(path);
      const id = (marker: string) => MIGRATIONS.findIndex((sql) => sql.includes(marker)) + 1;
      const twoLines = id("RENAME COLUMN description TO good_at");
      const description = id("ALTER TABLE presets ADD COLUMN description");
      assert.ok(twoLines > description && description > 0, "both migrations are in the list, the two lines' after the sentence's");
      // Every migration applied but the two lines' (and, from before the sentence, the sentence's too).
      old.raw.exec(`ALTER TABLE presets DROP COLUMN avoid; ALTER TABLE presets RENAME COLUMN good_at TO description; DELETE FROM migrations WHERE id = ${twoLines};`);
      if (from === "none") old.raw.exec(`ALTER TABLE presets DROP COLUMN description; DELETE FROM migrations WHERE id = ${description};`);
      const columns = `id, name, name_key, model_selection_json, runtime_mode, workspace_mode, look_json, sort_order, created_at, updated_at${from === "sentence" ? ", description" : ""}`;
      const insert = old.raw.prepare(`INSERT INTO presets (${columns}) VALUES (?, ?, ?, ?, 'full-access', ?, ?, ?, 't', 't'${from === "sentence" ? ", ?" : ""})`);
      REAL.forEach(([name, selection], index) =>
        insert.run(`id-${name}`, name, name.toLowerCase(), JSON.stringify(selection), index === 2 ? "worktree" : "local", index === 0 ? '{"hair":"short"}' : null, index + 1, ...(from === "sentence" ? [sentence(index)] : [])),
      );
      const before = old.raw.prepare("SELECT * FROM presets ORDER BY sort_order").all().map(({ description: _, ...row }) => ({ ...row }));
      old.raw.close();

      const opened = new Database(path);
      try {
        const after = opened.raw.prepare("SELECT * FROM presets ORDER BY sort_order").all() as Array<Record<string, unknown>>;
        assert.ok(after.every((row) => !("description" in row)), "the sentence's column is gone");
        assert.deepEqual(after.map(({ good_at: _, avoid: __, ...rest }) => rest), before, `every other column as it was (${from})`);
        const presets = new Repos(opened).listPresets();
        assert.deepEqual(
          presets.map((p) => [p.name, p.goodAt, p.avoid, p.workspaceMode]),
          REAL.map(([name], index) => [name, from === "sentence" ? sentence(index) : "", "", index === 2 ? "worktree" : "local"]),
          `the sentence is its good at, avoid empty (${from})`,
        );
      } finally {
        opened.raw.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("'Your crew' is the Consigliere's alone; its fingerprint follows what it says, and a record from before it takes it once", () => {
  const room: Room = { id: "r", projectId: "p", environmentId: null, title: "payments", nextSequence: 1, browserEnabled: false, defaultBrowserId: null, allowedBrowserIds: null, consigliereId: "c", createdAt: "", updatedAt: "" };
  const member = (id: string, alias: string): Participant => ({ id, roomId: "r", alias, modelSelection: { instanceId: "x", model: "y" }, runtimeMode: "full-access", interactionMode: "default", bindingGeneration: 1, retiredAt: null, presetId: null, createdAt: "", updatedAt: "" });
  const c = member("c", "Fable");
  const w = member("w", "Sol");
  const [, opusSelection] = REAL[0]!;
  const opus = preset("Opus", opusSelection, { goodAt: "careful review", avoid: "quick lookups" });
  const sol = preset("Sol", REAL[5]![1]);
  const input = (crew: Preset[] | null, reader = c): StandingInput => ({ room, participant: reader, participantsById: new Map([[c.id, c], [w.id, w]]), board: { command: "rooms-board", as: "k" }, crew });

  const text = standingText(input([opus, sol]));
  assert.ok(text.includes(crewSection([opus, sol])));
  assert.ok(text.includes("== Your crew ==\nThe user's saved crew (seat one with: rooms-board seat <name>):\nOpus · claude-opus-5-5 · effort xhigh · good at: careful review · avoid: quick lookups\nSol · gpt-6.1-sol · effort max"));
  assert.ok(!standingText(input([opus, sol], w)).includes("Your crew"), "a member is not given it");
  assert.equal(standingFingerprint(input([opus, sol], w)).crew, null);
  assert.ok(standingText(input([])).includes("== Your crew ==\nThe user has no saved crew."));

  const had = standingFingerprint(input([opus, sol]));
  const changed = (crew: Preset[]) => changedStanding(had, standingFingerprint(input(crew)));
  assert.deepEqual(changed([{ ...opus, goodAt: "fast writing" }, sol]), ["crew"], "what it is good at");
  assert.deepEqual(changed([{ ...opus, avoid: "reviews" }, sol]), ["crew"], "what to avoid");
  assert.deepEqual(changed([opus, { ...sol, avoid: "long documents" }]), ["crew"], "an avoid where there was none");
  assert.deepEqual(changed([{ ...opus, modelSelection: { ...opusSelection, model: "claude-fable-5-1" } }, sol]), ["crew"], "the model");
  assert.deepEqual(changed([{ ...opus, modelSelection: { ...opusSelection, options: [{ id: "effort", value: "high" }] } }, sol]), ["crew"], "the effort");
  assert.deepEqual(changed([{ ...opus, workspaceMode: "worktree" }, sol]), ["crew"], "the worktree setting");
  assert.deepEqual(changed([opus, sol, preset("Haiku", REAL[6]![1])]), ["crew"], "a new crew member");
  assert.deepEqual(changed([{ ...opus, look: { hair: "short" }, runtimeMode: "auto" }, sol]), [], "not the look or the permission mode");
  assert.deepEqual(changed([{ ...opus, modelSelection: { ...opusSelection, options: [{ id: "effort", value: "xhigh" }, { id: "fastMode", value: true }] } }, sol]), [], "nor an option that is not the effort");
  assert.deepEqual(changedStanding(had, standingFingerprint(input(null))), [], "a crew that was not read is not a change");

  // A thread's record from before the section has no "crew" key: the Consigliere is given it once, as changed.
  const { crew: _, ...before } = had;
  assert.deepEqual(changedStanding(before, had), ["crew"]);
});
