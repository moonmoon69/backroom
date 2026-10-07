import assert from "node:assert/strict";
import { test } from "node:test";
import { LINK_SEATS_TO_PRESETS } from "../src/db/database.ts";
import { defaultPart, LOOK_PARTS, lookCount, resolveLook, seatLook, shuffledLook } from "../src/domain/look.ts";
import { createTestStack } from "./helpers.ts";

const claude = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
const codex = { instanceId: "codex", model: "gpt-6-sol" };

test("a look's default is stable for an id, names every part, and differs between crew members", () => {
  const a = resolveLook("preset-a", null);
  assert.deepEqual(resolveLook("preset-a", undefined), a, "the same id, the same look, every time");
  assert.deepEqual(Object.keys(a).sort(), LOOK_PARTS.map((p) => p.key).sort());
  for (const part of LOOK_PARTS) assert.ok(part.options.some((o) => o.key === a[part.key]), `${part.key} is one of its options`);
  // Hat band and tie start as the harness's colour; dark sunglasses are an ordinary choice, never a default.
  assert.equal(a.band, "auto");
  assert.equal(a.neckwearColour, "auto");
  assert.ok(LOOK_PARTS.find((p) => p.key === "glasses")!.options.some((o) => o.key === "shades"));
  assert.equal(LOOK_PARTS.find((p) => p.key === "glasses")!.fixed, true, "glasses default to none");
  const looks = new Set(["opus", "fable", "astra", "gemini", "grok", "sol"].map((id) => JSON.stringify(resolveLook(id, null))));
  assert.equal(looks.size, 6, "six crew members, six looks");
});

test("a stored look keeps its parts; a missing part or an unknown name falls back to that part's default alone", () => {
  const stored = { hat: "tophat", fur: "grey", glasses: "monocle" };
  const look = resolveLook("preset-b", stored);
  assert.equal(look.hat, "tophat");
  assert.equal(look.fur, "grey");
  assert.equal(look.glasses, "monocle");
  assert.equal(look.hatColour, defaultPart(LOOK_PARTS.find((p) => p.key === "hatColour")!, "preset-b"), "a part not stored takes its default");
  const odd = resolveLook("preset-b", { ...stored, hat: "crown", sparkle: "yes" });
  assert.equal(odd.hat, resolveLook("preset-b", null).hat, "an option this version does not know falls back");
  assert.equal(odd.fur, "grey", "and the other parts are untouched");
  assert.ok(!("sparkle" in odd), "a part this version does not know is not drawn");
  // A part added later must not change a look: each part's default depends on the id and that part's name only.
  assert.equal(resolveLook("preset-b", null).fur, resolveLook("preset-b", { hat: "cap" }).fur);
});

test("shuffling keeps the harness's colour on band and tie; the parts make many thousands of looks", () => {
  let n = 0;
  const random = () => ((n = (n * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 20; i += 1) {
    const look = shuffledLook(random);
    assert.equal(look.band, "auto");
    assert.equal(look.neckwearColour, "auto");
  }
  assert.ok(lookCount() > 100_000);
});

test("a crew member's look is stored with it; without one it has its default; an edit without a look keeps it", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, []);
  t.after(() => stack.close());
  const plain = (await stack.run({ type: "preset.create", name: "sol", modelSelection: codex })) as { presetId: string };
  assert.deepEqual(stack.repos.getPreset(plain.presetId)?.look, resolveLook(plain.presetId, null));

  const chosen = { hat: "boater", hatColour: "straw", fur: "pale", neckwear: "bowtie", neckwearColour: "red" };
  const styled = (await stack.run({ type: "preset.create", name: "opus", modelSelection: claude, look: chosen })) as { presetId: string };
  const look = stack.repos.getPreset(styled.presetId)!.look;
  for (const [part, value] of Object.entries(chosen)) assert.equal(look[part], value);
  assert.equal(look.outfit, resolveLook(styled.presetId, null).outfit, "parts not chosen keep their defaults");

  await stack.run({ type: "preset.update", presetId: styled.presetId, runtimeMode: "auto" });
  assert.equal(stack.repos.getPreset(styled.presetId)!.look.hat, "boater", "an edit that sends no look keeps it");
  await stack.run({ type: "preset.update", presetId: styled.presetId, look: { ...chosen, hat: "tophat" } });
  assert.equal(stack.repos.getPreset(styled.presetId)!.look.hat, "tophat");
});

test("every seat of a crew member knows its preset; a member added by hand is matched by name and harness", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, []);
  t.after(() => stack.close());
  const opus = (await stack.run({ type: "preset.create", name: "opus", modelSelection: claude })) as { presetId: string };
  const first = (await stack.run({ type: "participant.fromPreset", roomId: stack.roomId, presetId: opus.presetId })) as { participantId: string };
  const second = (await stack.run({ type: "participant.fromPreset", roomId: stack.roomId, presetId: opus.presetId })) as { participantId: string };
  assert.equal(stack.repos.getParticipant(first.participantId)?.presetId, opus.presetId);
  assert.equal(stack.repos.getParticipant(second.participantId)?.presetId, opus.presetId, "opus2 is the same crew member");

  const byHand = (await stack.run({ type: "participant.create", roomId: stack.roomId, alias: "Opus3", modelSelection: claude, thread: { mode: "create" } })) as { participantId: string };
  assert.equal(stack.repos.getParticipant(byHand.participantId)?.presetId, opus.presetId, "named like the crew member, on its harness");
  const otherHarness = (await stack.run({ type: "participant.create", roomId: stack.roomId, alias: "opus4", modelSelection: codex, thread: { mode: "create" } })) as { participantId: string };
  assert.equal(stack.repos.getParticipant(otherHarness.participantId)?.presetId, null, "the same name on another harness is someone else");
});

test("members seated before seats knew their preset are linked where name and harness match, and only there", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, []);
  t.after(() => stack.close());
  const sol = (await stack.run({ type: "preset.create", name: "sol", modelSelection: codex })) as { presetId: string };
  const seat = (alias: string, modelSelection: typeof codex) => stack.run({ type: "participant.create", roomId: stack.roomId, alias, modelSelection, thread: { mode: "create" } }) as Promise<{ participantId: string }>;
  const sol2 = await seat("Sol2", codex);
  const solClaude = await seat("sol3", claude);
  const kit = await seat("kit", codex);
  // As they were before the link existed.
  stack.db.raw.exec("UPDATE participants SET preset_id = NULL");
  stack.db.raw.exec(LINK_SEATS_TO_PRESETS);
  assert.equal(stack.repos.getParticipant(sol2.participantId)?.presetId, sol.presetId);
  assert.equal(stack.repos.getParticipant(solClaude.participantId)?.presetId, null);
  assert.equal(stack.repos.getParticipant(kit.participantId)?.presetId, null);
});

test("one crew member, one drawing: every seat of it, in every room and view, wears its look; a seat of no crew member its own", () => {
  const presets = [
    { id: "preset-fable", look: { hat: "tophat", hatColour: "grey", fur: "pale", neckwear: "tie", glasses: "shades" } },
    { id: "preset-opus", look: null },
  ];
  // Fable seated in two rooms (as Consigliere in one), and drawn on the Overview, in the room, on the board, in a
  // composer chip and on the crew tile: each place passes its own seat id as the seed; the look is the preset's.
  const places = ["seat-in-vault", "seat-in-foundation", "preset-fable"].map((seed) => seatLook(presets, "preset-fable", seed));
  for (const look of places) assert.deepEqual(look, places[0]);
  assert.equal(places[0]!.hat, "tophat");
  assert.equal(places[0]!.glasses, "shades", "sunglasses are worn because the look has them, not because of a role");
  // A crew member without a stored look wears its preset's default in every seat, the same as the editor shows.
  const opus = ["seat-a", "seat-b", "preset-opus"].map((seed) => seatLook(presets, "preset-opus", seed));
  for (const look of opus) assert.deepEqual(look, resolveLook("preset-opus", null));
  // Before the crew list has loaded the stored look is unknown; the default it falls back to is the preset's, never the seat's.
  assert.deepEqual(seatLook([], "preset-opus", "seat-a"), resolveLook("preset-opus", null));
  // A member seated by hand that matches no crew member keeps a look of its own.
  assert.deepEqual(seatLook(presets, null, "seat-x"), resolveLook("seat-x", null));
  assert.deepEqual(seatLook(presets, null, "seat-x", "Vera"), resolveLook("seat-x", null));
  // One added by hand under a crew member's name ("opus", "Opus2") is that crew member to the eye.
  const named = [...presets.map((p) => ({ ...p, name: p.id === "preset-fable" ? "Fable" : "Opus" }))];
  assert.deepEqual(seatLook(named, null, "seat-y", "opus"), resolveLook("preset-opus", null));
  assert.deepEqual(seatLook(named, null, "seat-z", "Fable2"), seatLook(named, "preset-fable", "anything"));
  // A seat linked to a crew member is never re-matched by its name.
  assert.deepEqual(seatLook(named, "preset-opus", "seat-y", "Fable"), resolveLook("preset-opus", null));
});
