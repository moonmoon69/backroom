/** Threads an agent made as subagents of its own are left out of the sidebar's lists (web/src/types.ts isSubagentThread). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isSubagentThread } from "../web/src/types.ts";

test("a thread whose lineage says subagent is left out of the sidebar's lists, active or settled", () => {
  const lineage = (relationshipToParent: "fork" | "subagent" | null) => ({ lineage: { parentThreadId: relationshipToParent ? "parent" : null, relationshipToParent, rootThreadId: "root" } });
  assert.equal(isSubagentThread(lineage("subagent")), true);
  assert.equal(isSubagentThread(lineage("fork")), false, "a fork is a thread of its own");
  assert.equal(isSubagentThread(lineage(null)), false);
  assert.equal(isSubagentThread({}), false, "a thread read without its lineage is listed");
});
