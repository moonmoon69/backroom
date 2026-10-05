/** GET /api/file-preview: a file a reply names, read only inside the projects, their worktrees and the temp folder. */
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
  const fromBase = previewFile("src/parser.ts", { base: worktree, roots: [root, worktree] });
  assert.equal(fromBase.ok && fromBase.kind === "text" && fromBase.content, "// the branch's version\n");
  const fromRoots = previewFile("docs/plan.md", { base: worktree, roots: [root, worktree] });
  assert.equal(fromRoots.ok && fromRoots.kind === "text" && fromRoots.content.startsWith("# Plan"), true);
  assert.deepEqual(previewFile("src/missing.ts", { roots: [root] }), { ok: false, status: 404, reason: "no such file" });
  assert.equal((previewFile("src", { roots: [root] }) as { status: number }).status, 400, "a folder");
});

test("outside the allowed folders, through a symlink, or a secret: refused", () => {
  const root = project();
  const outside = mkdtempSync(join(tmpdir(), "rooms-preview-outside-"));
  writeFileSync(join(outside, "notes.md"), "private");
  symlinkSync(join(outside, "notes.md"), join(root, "link.md"));
  assert.equal((previewFile(join(outside, "notes.md"), { roots: [root] }) as { status: number }).status, 403);
  assert.equal((previewFile("link.md", { roots: [root] }) as { status: number }).status, 403);
  assert.equal((previewFile(".env", { roots: [root] }) as { status: number }).status, 403);
  assert.equal(previewFile(".env.example", { roots: [root] }).ok, true, "an example has no secrets");
  assert.equal((previewFile("~/.ssh/id_ed25519", { roots: [root] }) as { status: number }).status >= 403, true);
});

test("binaries are named, not shown; media goes to the media route; long text is cut and says so", () => {
  const root = project();
  assert.equal((previewFile("tool.bin", { roots: [root] }) as { kind: string }).kind, "binary");
  const image = previewFile("shot.png", { roots: [root] });
  assert.equal(image.ok && image.kind === "image" && image.url, `/api/local-file?path=${encodeURIComponent(join(root, "shot.png"))}`);
  const big = previewFile("big.log", { roots: [root] });
  assert.equal(big.ok && big.kind === "text" && big.truncated && big.content.length, MAX_PREVIEW_BYTES);
});

test("the route reads from T3's project folders and says why it refuses", async (t) => {
  const stack = await createTestStack();
  t.after(() => stack.close());
  const root = project();
  stack.fake.projects.push({ id: "project_real", title: "real", workspaceRoot: root, defaultModelSelection: null });
  const app = createHttpApp(stack, loadConfig({ ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: "/tmp/rooms-test-preview", ROOMS_PORT: "0" }), "/nonexistent/dist");
  const read = (query: string) => app.request(`/api/file-preview?${query}`);
  const ok = await read(`path=${encodeURIComponent("src/parser.ts")}`);
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { kind: string }).kind, "text");
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
  const found = previewFile("Crew.tsx", { base: root, roots: [root] });
  assert.equal(found.ok && found.path, join(root, "web", "src", "components", "Crew.tsx"));
  assert.equal((previewFile("Nowhere.tsx", { base: root, roots: [root] }) as { status: number }).status, 404);
});
