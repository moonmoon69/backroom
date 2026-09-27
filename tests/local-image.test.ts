/** GET /api/local-file (and its older name /api/local-image): media agents reference from replies, and nothing else. */
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
  writeFileSync(join(dir, "demo.mp4"), Buffer.from("0123456789abcdef"));
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

test("GET /api/local-file serves a video in byte ranges, so it seeks and plays on every browser", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const config = loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-local-file", ROOMS_PORT: "0" });
  const app = createHttpApp(stack, config, "/nonexistent/dist");
  const dir = fixture();
  const url = `/api/local-file?path=${encodeURIComponent(join(dir, "demo.mp4"))}`;

  const whole = await app.request(url);
  assert.deepEqual([whole.status, whole.headers.get("content-type"), whole.headers.get("accept-ranges"), whole.headers.get("content-length")], [200, "video/mp4", "bytes", "16"]);
  assert.equal(await whole.text(), "0123456789abcdef");

  const part = await app.request(url, { headers: { range: "bytes=4-7" } });
  assert.deepEqual([part.status, part.headers.get("content-range"), part.headers.get("content-length")], [206, "bytes 4-7/16", "4"]);
  assert.equal(await part.text(), "4567");
  const tail = await app.request(url, { headers: { range: "bytes=12-" } });
  assert.deepEqual([tail.status, await tail.text()], [206, "cdef"]);
  const last = await app.request(url, { headers: { range: "bytes=-3" } });
  assert.deepEqual([last.status, last.headers.get("content-range"), await last.text()], [206, "bytes 13-15/16", "def"]);
  assert.equal((await app.request(url, { headers: { range: "bytes=20-" } })).status, 416);
  const head = await app.request(url, { method: "HEAD" });
  assert.deepEqual([head.status, head.headers.get("content-length")], [200, "16"]);
});
