/**
 * The threads the overview and its shelf list are the loose ones (src/server/engineView.ts isLoose): no room seats them,
 * T3 has not deleted them, and no agent made them as a subagent of its own (the parent member shows those as
 * "subagents running").
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isLoose } from "../src/server/engineView.ts";

test("a thread whose lineage says subagent is not loose, nor one a room seats or T3 deleted; a fork is a thread of its own", () => {
  const thread = (relationshipToParent: "fork" | "subagent" | null, deletedAt: string | null = null) => ({ id: "t", deletedAt, lineage: { parentThreadId: relationshipToParent ? "parent" : null, relationshipToParent, rootThreadId: "root" } });
  const none = new Set<string>();
  assert.equal(isLoose(thread("subagent"), none), false);
  assert.equal(isLoose(thread("fork"), none), true, "a fork is a thread of its own");
  assert.equal(isLoose(thread(null), none), true);
  assert.equal(isLoose(thread(null), new Set(["t"])), false, "seated in a room");
  assert.equal(isLoose(thread(null, "2026-11-02T00:00:00.000Z"), none), false, "deleted in T3");
});
