/** T3's in-text references to a turn's attachments (the iPhone app's t3-context links), as the room shows a prompt typed in T3. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { withoutT3ContextRefs } from "../web/src/t3Context.ts";

test("a t3-context reference is dropped where the image shows under the text, and named where it does not", () => {
  const prompt = "![IMG_3974.png](t3-context://v1/image/2bb8720b-15dc-40dd-8c59-5113fa30c529) So it works offline.";
  assert.equal(withoutT3ContextRefs(prompt, true), "So it works offline.");
  assert.equal(withoutT3ContextRefs(prompt, false), "[image: IMG_3974.png] So it works offline.");
  assert.equal(withoutT3ContextRefs("see [notes.md](t3-context://v1/file/abc) here", false), "see notes.md here");
  assert.equal(withoutT3ContextRefs("plain text", true), "plain text");
});
