/** GET /api/local-image: serves agent screenshots referenced from replies, and nothing else. */
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createHttpApp } from "../src/server/http.ts";
import { resolveLocalImage } from "../src/server/localImage.ts";
import { createTestStack } from "./helpers.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rooms-local-image-"));
  writeFileSync(join(dir, "shot.png"), PNG);
  writeFileSync(join(dir, "notes.txt"), "secret");
  writeFileSync(join(dir, "fake.png.txt"), "secret");
  return dir;
}

test("resolveLocalImage only accepts image files inside the allowed roots", () => {
  const dir = fixture();
  const outside = mkdtempSync(join(tmpdir(), "rooms-outside-"));
  writeFileSync(join(outside, "leak.png"), PNG);
  symlinkSync(join(outside, "leak.png"), join(dir, "link.png"));

  const ok = resolveLocalImage(join(dir, "shot.png"), [dir]);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.mimeType, "image/png");

  assert.equal(resolveLocalImage(`file://${join(dir, "shot.png")}`, [dir]).ok, true, "file:// URLs are accepted");
  assert.equal(resolveLocalImage("shot.png", [dir]).ok, false, "relative paths are rejected");
  assert.equal(resolveLocalImage(join(dir, "notes.txt"), [dir]).ok, false, "non-images are rejected");
  assert.equal(resolveLocalImage(join(dir, "fake.png.txt"), [dir]).ok, false, "the real extension counts");
  assert.equal(resolveLocalImage(join(dir, "missing.png"), [dir]).ok, false, "missing files are rejected");
  assert.equal(resolveLocalImage(join(dir, "..", "..", "etc", "passwd.png"), [dir]).ok, false, "traversal is rejected");
  const viaLink = resolveLocalImage(join(dir, "link.png"), [dir]);
  assert.equal(viaLink.ok, false, "symlinks pointing outside the roots are rejected");
  assert.equal(resolveLocalImage(join(dir, "shot.png"), [outside]).ok, false, "files outside every root are rejected");
});

test("GET /api/local-image streams the image with its mime type and refuses everything else", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const config = loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-local-image", ROOMS_PORT: "0" });
  const app = createHttpApp(stack, config, "/nonexistent/dist");
  const dir = fixture();

  const served = await app.request(`/api/local-image?path=${encodeURIComponent(join(dir, "shot.png"))}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);

  assert.equal((await app.request(`/api/local-image?path=${encodeURIComponent(join(dir, "notes.txt"))}`)).status, 403);
  assert.equal((await app.request(`/api/local-image?path=${encodeURIComponent(join(dir, "missing.png"))}`)).status, 404);
  assert.equal((await app.request("/api/local-image?path=relative.png")).status, 400);
  assert.equal((await app.request("/api/local-image")).status, 400);
});
