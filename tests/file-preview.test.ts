/** GET /api/file-preview: a file a reply names, wherever the service can read it, never a secret. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createHttpApp } from "../src/server/http.ts";
import { MAX_PREVIEW_BYTES, previewFile } from "../src/server/filePreview.ts";
import { createTestStack } from "./helpers.ts";

function project() {
  const root = mkdtempSync(join(tmpdir(), "rooms-preview-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "src", "parser.ts"), "export const parse = (s: string) => s.trim();\n");
  writeFileSync(join(root, "docs", "plan.md"), "# Plan\n\n- read `src/parser.ts`\n");
  writeFileSync(join(root, ".env"), "TOKEN=secret");
  writeFileSync(join(root, ".env.example"), "TOKEN=");
  writeFileSync(join(root, "tool.bin"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 1]));
  writeFileSync(join(root, "shot.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  writeFileSync(join(root, "big.log"), "x".repeat(MAX_PREVIEW_BYTES + 10));
  return root;
}

test("a relative path is found in the reply's folder first, then in each project; text comes back whole", () => {
  const root = project();
  const worktree = mkdtempSync(join(tmpdir(), "rooms-preview-wt-"));
  mkdirSync(join(worktree, "src"));
  writeFileSync(join(worktree, "src", "parser.ts"), "// the branch's version\n");
  const fromBase = previewFile("src/parser.ts", { base: worktree, folders: [root, worktree] });
  assert.equal(fromBase.ok && fromBase.kind === "text" && fromBase.content, "// the branch's version\n");
  const fromRoots = previewFile("docs/plan.md", { base: worktree, folders: [root, worktree] });
  assert.equal(fromRoots.ok && fromRoots.kind === "text" && fromRoots.content.startsWith("# Plan"), true);
  assert.deepEqual(previewFile("src/missing.ts", { folders: [root] }), { ok: false, status: 404, reason: "no such file" });
  assert.equal((previewFile("src", { folders: [root] }) as { status: number }).status, 400, "a folder");
});

test("a file outside the projects is previewed, by its path or through a link; a secret is refused wherever it is", () => {
  const root = project();
  const outside = mkdtempSync(join(tmpdir(), "rooms-preview-outside-"));
  writeFileSync(join(outside, "notes.md"), "private");
  symlinkSync(join(outside, "notes.md"), join(root, "link.md"));
  const byPath = previewFile(join(outside, "notes.md"), { folders: [root] });
  assert.equal(byPath.ok && byPath.kind === "text" && byPath.content, "private");
  const byLink = previewFile("link.md", { folders: [root] });
  assert.equal(byLink.ok && byLink.path, join(outside, "notes.md"), "the link is followed");
  writeFileSync(join(outside, "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----");
  symlinkSync(join(outside, "id_ed25519"), join(root, "harmless.txt"));
  assert.equal((previewFile("harmless.txt", { folders: [root] }) as { status: number }).status, 403, "a link to a key is refused as the key is");
  assert.equal((previewFile(".env", { folders: [root] }) as { status: number }).status, 403);
  assert.equal(previewFile(".env.example", { folders: [root] }).ok, true, "an example has no secrets");
  assert.equal((previewFile("~/.ssh/id_ed25519", { folders: [root] }) as { status: number }).status >= 403, true);
});

test("a project folder that is a link elsewhere: its files are previewed by their path in the project and by a relative path", () => {
  const root = project();
  const elsewhere = mkdtempSync(join(tmpdir(), "rooms-preview-docs-"));
  mkdirSync(join(elsewhere, "plans"));
  writeFileSync(join(elsewhere, "plans", "canvas-home.md"), "# Canvas home\n");
  symlinkSync(elsewhere, join(root, "linked-docs"));
  const absolute = previewFile(join(root, "linked-docs", "plans", "canvas-home.md"), { folders: [root] });
  assert.equal(absolute.ok && absolute.kind === "text" && absolute.content, "# Canvas home\n");
  assert.equal(absolute.ok && absolute.path, join(elsewhere, "plans", "canvas-home.md"), "the resolved path is shown");
  const relative = previewFile("linked-docs/plans/canvas-home.md", { base: root, folders: [root] });
  assert.equal(relative.ok && relative.kind === "text" && relative.content, "# Canvas home\n");
});

test("binaries are named, not shown; media goes to the media route; long text is cut and says so", () => {
  const root = project();
  assert.equal((previewFile("tool.bin", { folders: [root] }) as { kind: string }).kind, "binary");
  const image = previewFile("shot.png", { folders: [root] });
  assert.equal(image.ok && image.kind === "image" && image.url, `/api/local-file?path=${encodeURIComponent(join(root, "shot.png"))}`);
  const big = previewFile("big.log", { folders: [root] });
  assert.equal(big.ok && big.kind === "text" && big.truncated && big.content.length, MAX_PREVIEW_BYTES);
});

test("HTML keeps the text contract, original source and resolved extension; incomplete HTML is flagged", () => {
  const root = project();
  const source = '<!doctype html><html><button id="choice">Choose</button><script>choice.onclick=()=>choice.textContent="Chosen";</script></html>\n';
  for (const name of ["overview.html", "overview.HTM"]) {
    writeFileSync(join(root, name), source);
    const preview = previewFile(name, { folders: [root] });
    assert.ok(preview.ok && preview.kind === "text");
    assert.equal(preview.path, join(root, name));
    assert.equal(preview.content, source);
    assert.equal(preview.truncated, false);
  }
  symlinkSync(join(root, "overview.html"), join(root, "alias.txt"));
  const alias = previewFile("alias.txt", { folders: [root] });
  assert.ok(alias.ok && alias.kind === "text");
  assert.equal(alias.path, join(root, "overview.html"), "the frontend classifies the resolved HTML, not the alias");
  const incomplete = source + " ".repeat(MAX_PREVIEW_BYTES);
  writeFileSync(join(root, "large.html"), incomplete);
  const large = previewFile("large.html", { folders: [root] });
  assert.ok(large.ok && large.kind === "text");
  assert.equal(large.truncated, true);
  assert.equal(large.content, incomplete.slice(0, MAX_PREVIEW_BYTES));
  assert.equal(large.size, Buffer.byteLength(incomplete));
});

test("the route finds a relative path in T3's project folders, reads an absolute one anywhere, and says why it refuses", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const root = project();
  stack.fake.projects.push({ id: "project_real", title: "real", workspaceRoot: root, defaultModelSelection: null });
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-preview", ROOMS_PORT: "0" }), "/nonexistent/dist");
  const read = (query: string) => app.request(`/api/file-preview?${query}`);
  const ok = await read(`path=${encodeURIComponent("src/parser.ts")}`);
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { kind: string }).kind, "text");
  // Outside the home and temp folders, which the route once refused.
  const outside = mkdtempSync("/var/tmp/rooms-preview-anywhere-");
  writeFileSync(join(outside, "notes.md"), "elsewhere");
  const anywhere = await read(`path=${encodeURIComponent(join(outside, "notes.md"))}`);
  assert.equal(anywhere.status, 200);
  assert.equal(((await anywhere.json()) as { content: string }).content, "elsewhere");
  const missing = await read(`path=${encodeURIComponent(join(outside, "gone.md"))}`);
  assert.equal(missing.status, 404);
  // A picture there, by its path and through a project folder that is a link to it: the preview's media URL serves it.
  writeFileSync(join(outside, "pixel.png"), Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
  symlinkSync(outside, join(root, "linked"));
  for (const path of [join(outside, "pixel.png"), join(root, "linked", "pixel.png")]) {
    const preview = await read(`path=${encodeURIComponent(path)}`);
    assert.equal(preview.status, 200, path);
    const body = (await preview.json()) as { kind: string; url: string };
    assert.equal(body.kind, "image", path);
    const media = await app.request(body.url);
    assert.equal(media.status, 200, `the preview's media URL serves ${path}`);
    assert.equal(media.headers.get("content-type"), "image/png");
  }
  const secret = await read("path=.env");
  assert.equal(secret.status, 403);
  assert.match(((await secret.json()) as { message: string }).message, /keys or tokens/);
});

test("a file named without its folder is found by name, shallowest first, never inside node_modules", () => {
  const root = project();
  mkdirSync(join(root, "node_modules", "lib"), { recursive: true });
  writeFileSync(join(root, "node_modules", "lib", "Crew.tsx"), "// not this one");
  mkdirSync(join(root, "web", "src", "components"), { recursive: true });
  writeFileSync(join(root, "web", "src", "components", "Crew.tsx"), "export function Crew() {}\n");
  const found = previewFile("Crew.tsx", { base: root, folders: [root] });
  assert.equal(found.ok && found.path, join(root, "web", "src", "components", "Crew.tsx"));
  assert.equal((previewFile("Nowhere.tsx", { base: root, folders: [root] }) as { status: number }).status, 404);
});
