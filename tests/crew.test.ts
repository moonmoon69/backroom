/**
 * Each saved crew member's one-sentence description, and the crew as the Consigliere reads it (src/app/crew.ts): the
 * effort level per harness, the listing line, the commands that save the sentence, the migration that adds it, and the
 * "Your crew" standing section with its fingerprint (src/briefing/assemble.ts).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crewLine, crewListing, selectionEffort } from "../src/app/crew.ts";
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
  id: `id-${name}`, name, modelSelection, runtimeMode: "full-access", workspaceMode: "local", look: {}, description: "", createdAt: "", updatedAt: "", ...extra,
});

test("the effort level is the effort (Claude), reasoning (Cursor) or reasoningEffort (Codex) option, else none", () => {
  assert.deepEqual(
    REAL.map(([name, selection]) => [name, selectionEffort(selection)]),
    [["Opus", "xhigh"], ["Fable", "xhigh"], ["Grok", "xhigh"], ["Gemini", null], ["Astra", "xhigh"], ["Sol", "max"], ["Haiku", "max"], ["OpusWorker", "high"]],
  );
  assert.equal(selectionEffort({ instanceId: "claudeAgent", model: "m", options: [{ id: "fastMode", value: true }, { id: "contextWindow", value: "1m" }] }), null, "other options are not an effort");
  assert.equal(selectionEffort({ instanceId: "claudeAgent", model: "m", options: [{ id: "effort", value: { level: "high" } }] }), null, "nor a value that is not text");
  assert.equal(selectionEffort({ instanceId: "claudeAgent", model: "m", options: [{ id: "effort", value: "  " }] }), null);
});

test("a crew line is name · model · effort · worktree note · sentence, leaving out what is not there", () => {
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
    crewLine(preset("Opus", opus, { workspaceMode: "worktree", description: "Careful reviewer for risky changes." })),
    "Opus · claude-opus-5-5 · effort xhigh · works in its own worktree · Careful reviewer for risky changes.",
  );
  assert.equal(crewLine(preset("Opus", opus, { description: "   " })), "Opus · claude-opus-5-5 · effort xhigh", "a blank sentence leaves no trailing ·");
  assert.deepEqual(crewListing([]), ["The user has no saved crew."]);
});

test("the description is saved on one line within the cap; an update that omits it keeps it, an empty one clears it", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, []);
  t.after(() => stack.close());
  const [, opus] = REAL[0]!;
  const plain = (await stack.run({ type: "preset.create", name: "plain", modelSelection: opus })) as { presetId: string };
  assert.equal(stack.repos.getPreset(plain.presetId)?.description, "", "empty by default");

  const saved = (await stack.run({ type: "preset.create", name: "opus", modelSelection: opus, description: "  Careful reviewer\nfor risky\t changes.  " })) as { presetId: string };
  const description = () => stack.repos.getPreset(saved.presetId)?.description;
  assert.equal(description(), "Careful reviewer for risky changes.", "folded to one line on the server");
  await assert.rejects(stack.run({ type: "preset.create", name: "long", modelSelection: opus, description: "x".repeat(PRESET_DESCRIPTION_MAX + 1) }), /300/);
  await assert.rejects(stack.run({ type: "preset.update", presetId: saved.presetId, description: "x".repeat(PRESET_DESCRIPTION_MAX + 1) }), /300/);
  assert.equal(WEB_PRESET_DESCRIPTION_MAX, PRESET_DESCRIPTION_MAX, "the page's field has the server's cap");

  await stack.run({ type: "preset.update", presetId: saved.presetId, name: "opus-high", runtimeMode: "auto", workspaceMode: "worktree", look: { hair: "short" } });
  assert.equal(description(), "Careful reviewer for risky changes.", "a name, mode or look change keeps it");
  await stack.run({ type: "preset.update", presetId: saved.presetId, modelSelection: REAL[1]![1] });
  assert.equal(description(), "Careful reviewer for risky changes.", "so does a model change");
  await stack.run({ type: "preset.update", presetId: saved.presetId, description: "Fast\r\nwriter." });
  assert.equal(description(), "Fast writer.");
  await stack.run({ type: "preset.update", presetId: saved.presetId, description: "" });
  assert.equal(description(), "", "an empty one clears it");
});

test("the migration gives the crew members saved before it an empty description, and changes nothing else", () => {
  const dir = mkdtempSync(join(tmpdir(), "backroom-crew-migration-"));
  try {
    const path = join(dir, "rooms.sqlite");
    // A database at the version before: every migration applied up to the description's (later ones apply again on open).
    const old = new Database(path);
    const id = MIGRATIONS.findIndex((sql) => sql.includes("ALTER TABLE presets ADD COLUMN description")) + 1;
    assert.ok(id > 0, "the description's migration is in the list");
    old.raw.exec(`ALTER TABLE presets DROP COLUMN description; DELETE FROM migrations WHERE id >= ${id};`);
    const insert = old.raw.prepare(
      "INSERT INTO presets (id, name, name_key, model_selection_json, runtime_mode, workspace_mode, look_json, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 'full-access', ?, ?, ?, 't', 't')",
    );
    REAL.forEach(([name, selection], index) => insert.run(`id-${name}`, name, name.toLowerCase(), JSON.stringify(selection), index === 2 ? "worktree" : "local", index === 0 ? '{"hair":"short"}' : null, index + 1));
    const before = old.raw.prepare("SELECT * FROM presets ORDER BY sort_order").all().map((row) => ({ ...row }));
    old.raw.close();

    const opened = new Database(path);
    try {
      const after = opened.raw.prepare("SELECT * FROM presets ORDER BY sort_order").all() as Array<Record<string, unknown>>;
      assert.deepEqual(after.map(({ description: _, ...rest }) => rest), before, "every other column as it was");
      assert.deepEqual(after.map((row) => row.description), REAL.map(() => ""));
      const presets = new Repos(opened).listPresets();
      assert.deepEqual(presets.map((p) => [p.name, p.description, p.workspaceMode]), REAL.map(([name], index) => [name, "", index === 2 ? "worktree" : "local"]));
    } finally {
      opened.raw.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("'Your crew' is the Consigliere's alone; its fingerprint follows what it says, and a record from before it takes it once", () => {
  const room: Room = { id: "r", projectId: "p", environmentId: null, title: "payments", nextSequence: 1, browserEnabled: false, defaultBrowserId: null, allowedBrowserIds: null, consigliereId: "c", createdAt: "", updatedAt: "" };
  const member = (id: string, alias: string): Participant => ({ id, roomId: "r", alias, modelSelection: { instanceId: "x", model: "y" }, runtimeMode: "full-access", interactionMode: "default", bindingGeneration: 1, retiredAt: null, presetId: null, createdAt: "", updatedAt: "" });
  const c = member("c", "Fable");
  const w = member("w", "Sol");
  const [, opusSelection] = REAL[0]!;
  const opus = preset("Opus", opusSelection, { description: "Careful reviewer." });
  const sol = preset("Sol", REAL[5]![1]);
  const input = (crew: Preset[] | null, reader = c): StandingInput => ({ room, participant: reader, participantsById: new Map([[c.id, c], [w.id, w]]), board: { command: "rooms-board", as: "k" }, crew });

  const text = standingText(input([opus, sol]));
  assert.ok(text.includes(crewSection([opus, sol])));
  assert.ok(text.includes("== Your crew ==\nThe user's saved crew (seat one with: rooms-board seat <name>):\nOpus · claude-opus-5-5 · effort xhigh · Careful reviewer.\nSol · gpt-6.1-sol · effort max"));
  assert.ok(!standingText(input([opus, sol], w)).includes("Your crew"), "a member is not given it");
  assert.equal(standingFingerprint(input([opus, sol], w)).crew, null);
  assert.ok(standingText(input([])).includes("== Your crew ==\nThe user has no saved crew."));

  const had = standingFingerprint(input([opus, sol]));
  const changed = (crew: Preset[]) => changedStanding(had, standingFingerprint(input(crew)));
  assert.deepEqual(changed([{ ...opus, description: "Fast writer." }, sol]), ["crew"], "the sentence");
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
