import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { draftScopes, isDraftKey, keepDraft, keepDraftImages, readDraft, readDraftImages } from "../web/src/draftStore.ts";

// The browser's storage, as far as drafts use it.
const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
  },
});

beforeEach(() => store.clear());

test("a draft is kept per conversation as it is typed, and cleared when the text is deleted", () => {
  keepDraft("room:a", "@fable check the");
  keepDraft("room:a", "@fable check the logs");
  keepDraft("thread:t", "hello");
  assert.equal(readDraft("room:a"), "@fable check the logs");
  assert.equal(readDraft("thread:t"), "hello");
  assert.equal(readDraft("room:b"), "");
  assert.equal(readDraft(null), "");
  assert.deepEqual([...draftScopes()].sort(), ["room:a", "thread:t"]);

  // Blank text is no draft: the conversation loses its mark.
  keepDraft("room:a", "  \n");
  assert.equal(readDraft("room:a"), "");
  assert.deepEqual([...draftScopes()], ["thread:t"]);
});

test("only gaining or losing a draft is reported (the page's marks change then), not every keystroke", () => {
  assert.equal(keepDraft("room:a", "h"), true);
  assert.equal(keepDraft("room:a", "he"), false);
  assert.equal(keepDraft("room:a", "hel"), false);
  assert.equal(keepDraft("room:a", ""), true);
  assert.equal(keepDraft("room:a", ""), false);
});

test("other keys in storage are not drafts", () => {
  store.set("backroom.selection", "{}");
  keepDraft("room:a", "x");
  assert.deepEqual([...draftScopes()], ["room:a"]);
});

test("a draft's images are kept with it by reference, and a draft of images alone is still a draft", () => {
  const shot = { id: "att-1", name: "shot.png", sizeBytes: 2048 };
  assert.equal(keepDraftImages("room:a", [shot]), true, "the room gains a draft");
  assert.deepEqual(readDraftImages("room:a"), [shot]);
  assert.deepEqual([...draftScopes()], ["room:a"], "images alone mark the conversation");
  keepDraft("room:a", "@fable look at this");
  assert.deepEqual([...draftScopes()], ["room:a"], "text and images are one draft");
  assert.equal(keepDraftImages("room:a", [shot, { id: "att-2", name: "b.png", sizeBytes: 1 }]), false, "more images: still the same draft");
  assert.equal(readDraftImages("room:a").length, 2);

  // Only the reference is stored: never the picture.
  assert.ok((store.get("backroom.draftimages.room:a") ?? "").length < 200);
  keepDraftImages("thread:t", [{ id: "k", name: "x.png", sizeBytes: 3, dataUrl: "data:image/png;base64,AAAA" } as never]);
  assert.ok(!(store.get("backroom.draftimages.thread:t") ?? "").includes("data:"));

  // Removing them all ends that part of the draft; the text keeps the mark.
  assert.equal(keepDraftImages("room:a", []), true);
  assert.deepEqual(readDraftImages("room:a"), []);
  assert.deepEqual([...draftScopes()].sort(), ["room:a", "thread:t"]);
  keepDraft("room:a", "");
  assert.deepEqual([...draftScopes()], ["thread:t"]);
  assert.ok(isDraftKey("backroom.draftimages.thread:t") && isDraftKey("backroom.draft.room:a") && !isDraftKey("backroom.drafts"));
});

test("damaged image lists read as none or skip the bad entries", () => {
  store.set("backroom.draftimages.room:a", "not json");
  assert.deepEqual(readDraftImages("room:a"), []);
  store.set("backroom.draftimages.room:a", JSON.stringify([{ id: "ok", name: "a.png", sizeBytes: 1 }, { id: 3 }, null]));
  assert.deepEqual(readDraftImages("room:a"), [{ id: "ok", name: "a.png", sizeBytes: 1 }]);
  assert.deepEqual(readDraftImages(null), []);
});
