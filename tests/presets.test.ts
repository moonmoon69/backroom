import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestStack } from "./helpers.ts";

const sol = { instanceId: "codex", model: "gpt-6-sol", options: [{ id: "reasoningEffort", value: "high" }] };

test("a preset keeps a participant's settings and seats them in a room on a new thread", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, []);
  t.after(() => stack.close());
  const role = (await stack.run({ type: "role.create", name: "reviewer", rules: "Review twice." })) as { roleId: string };
  const saved = (await stack.run({ type: "preset.create", name: "sol", modelSelection: sol, runtimeMode: "auto", roleId: role.roleId })) as { presetId: string };
  assert.deepEqual(
    stack.repos.listPresets().map((p) => [p.name, p.modelSelection, p.runtimeMode, p.roleId, p.workspaceMode]),
    [["sol", sol, "auto", role.roleId, "local"]],
  );

  const first = (await stack.run({ type: "participant.fromPreset", roomId: stack.roomId, presetId: saved.presetId })) as { participantId: string; threadId: string };
  const second = (await stack.run({ type: "participant.fromPreset", roomId: stack.roomId, presetId: saved.presetId })) as { participantId: string; threadId: string };
  const named = (await stack.run({ type: "participant.fromPreset", roomId: stack.roomId, presetId: saved.presetId, alias: "checker" })) as { participantId: string };
  const seated = stack.repos.listParticipants(stack.roomId);
  assert.deepEqual(seated.map((p) => p.alias).sort(), ["checker", "sol", "sol2"], "the name, then numbered, or the alias asked for");
  assert.notEqual(first.threadId, second.threadId, "each seat is a thread of its own");
  for (const participant of seated) {
    assert.deepEqual(participant.modelSelection, sol);
    assert.equal(participant.runtimeMode, "auto");
    assert.equal(participant.roleId, role.roleId);
  }
  assert.ok(named.participantId);
  const thread = await stack.fake.getThreadShell(first.threadId);
  assert.deepEqual(thread?.modelSelection, sol);
  assert.equal(thread?.runtimeMode, "auto");
});

test("presets are renamed, changed and deleted; names are unique and a deleted role leaves the preset without one", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, []);
  t.after(() => stack.close());
  const role = (await stack.run({ type: "role.create", name: "reviewer", rules: "Review twice." })) as { roleId: string };
  const a = (await stack.run({ type: "preset.create", name: "sol", modelSelection: sol, roleId: role.roleId })) as { presetId: string };
  await stack.run({ type: "preset.create", name: "fable", modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5-1" }, workspaceMode: "worktree" });
  assert.deepEqual(stack.repos.listPresets().map((p) => p.name), ["sol", "fable"], "in the order they were made");

  await assert.rejects(stack.run({ type: "preset.create", name: "SOL", modelSelection: sol }), /already exists/);
  await assert.rejects(stack.run({ type: "preset.update", presetId: a.presetId, name: "fable" }), /already exists/);
  await assert.rejects(stack.run({ type: "preset.create", name: "all", modelSelection: sol }), /reserved/);

  await stack.run({ type: "preset.update", presetId: a.presetId, name: "sol-high", runtimeMode: "approval-required" });
  const updated = stack.repos.getPreset(a.presetId);
  assert.equal(updated?.name, "sol-high");
  assert.equal(updated?.runtimeMode, "approval-required");
  assert.deepEqual(updated?.modelSelection, sol, "what was not sent stays");
  assert.deepEqual(stack.repos.listPresets().map((p) => p.name), ["sol-high", "fable"], "an update keeps its place");

  await stack.run({ type: "role.delete", roleId: role.roleId });
  assert.equal(stack.repos.getPreset(a.presetId)?.roleId, null);
  const seated = (await stack.run({ type: "participant.fromPreset", roomId: stack.roomId, presetId: a.presetId })) as { participantId: string };
  assert.equal(stack.repos.getParticipant(seated.participantId)?.roleId, null);

  await stack.run({ type: "preset.delete", presetId: a.presetId });
  assert.deepEqual(stack.repos.listPresets().map((p) => p.name), ["fable"]);
  await assert.rejects(stack.run({ type: "preset.delete", presetId: a.presetId }), /does not exist/);
  await assert.rejects(stack.run({ type: "participant.fromPreset", roomId: stack.roomId, presetId: a.presetId }), /does not exist/);
});

test("a preset that works in a new worktree gets one from the project's default branch", async (t) => {
  const stack = await createTestStack({ autoCompleteMs: null }, []);
  t.after(() => stack.close());
  const saved = (await stack.run({ type: "preset.create", name: "fable", modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5-1" }, workspaceMode: "worktree" })) as { presetId: string };
  const seated = (await stack.run({ type: "participant.fromPreset", roomId: stack.roomId, presetId: saved.presetId })) as { threadId: string };
  const thread = await stack.fake.getThreadShell(seated.threadId);
  assert.ok(thread?.worktreePath, "the thread works in a worktree");
  assert.notEqual(thread?.branch, "main");
});
