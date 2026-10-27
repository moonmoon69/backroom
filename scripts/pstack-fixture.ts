/**
 * A local stand-in for cursor/plugins, for the tests and the rehearsal (ROOMS_PSTACK_REPO), so neither reaches the
 * network: a bare repository on main whose tree has pstack's shape as Poteto mode reads it (src/app/poteto.ts):
 * pstack/plugin.json with its version, poteto-mode and a few skills in pstack/skills and in the Claude Code copy under
 * harness/pstack/claude-code/skills, pstack's Claude Code adapter note, and folders outside the sparse paths that a
 * clone must leave out. `commit` adds a commit to it, as upstream would.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PstackFixture {
  /** The bare repository: what ROOMS_PSTACK_REPO names. */
  bare: string;
  /** The checkout commits are made in and pushed from. */
  work: string;
  /** Writes the files (a version too, when given), commits them with the subject and pushes; answers the commit. */
  commit(subject: string, options?: { version?: string; files?: Record<string, string> }): string;
}

/** The skills the fixture holds, in both trees. */
export const FIXTURE_SKILLS = ["how", "poteto-mode", "tdd"];

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

const pluginJson = (version: string) => `${JSON.stringify({ name: "pstack", version, author: { name: "Lauren Tan" }, license: "MIT" }, null, 2)}\n`;

/** A fixture under `dir` (made; it must not hold one already) at pstack `version`. */
export function makePstackFixture(dir: string, version = "0.15.0"): PstackFixture {
  const work = join(dir, "plugins");
  const bare = join(dir, "plugins.git");
  mkdirSync(work, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  const files: Record<string, string> = {
    "README.md": "# plugins (fixture)\n",
    "pstack/plugin.json": pluginJson(version),
    "pstack/LICENSE": "MIT License (fixture)\n",
    "pstack/docs/harness/claude-code.md": "# pstack in Claude Code (fixture)\n",
    "pstack/skills/assets/readme.md": "a folder with no SKILL.md: no skill\n",
    "harness/pstack/claude-code/plugin.json": pluginJson(version),
    "harness/other/README.md": "outside the sparse paths\n",
    "other-plugin/README.md": "outside the sparse paths\n",
  };
  for (const name of FIXTURE_SKILLS) {
    files[`pstack/skills/${name}/SKILL.md`] = `---\nname: ${name}\n---\n\n# ${name} (fixture)\n`;
    files[`harness/pstack/claude-code/skills/${name}/SKILL.md`] = `---\nname: ${name}\n---\n\n# ${name} (fixture, Claude Code)\n`;
  }
  write(work, files);
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "pstack: first commit");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  git(work, "push", "-q", bare, "main");
  return {
    bare,
    work,
    commit(subject, options = {}) {
      write(work, { ...(options.version ? { "pstack/plugin.json": pluginJson(options.version), "harness/pstack/claude-code/plugin.json": pluginJson(options.version) } : {}), ...options.files });
      git(work, "add", ".");
      git(work, "commit", "-q", "--allow-empty", "-m", subject);
      git(work, "push", "-q", bare, "main");
      return git(work, "rev-parse", "HEAD");
    },
  };
}
