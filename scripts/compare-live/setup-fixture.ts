/**
 * Builds the fixture repository the jobs clone, from the template committed here (scripts/compare-live/fixture):
 * COMPARE_ROOT/fixture with one commit, made with a fixed author and date, tagged fixture-v1. Run again, it checks that
 * the tag still holds exactly the template's files and changes nothing.
 *
 *   node scripts/compare-live/setup-fixture.ts
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { FIXTURE_REPO, FIXTURE_TAG } from "./campaign.ts";

const TEMPLATE = join(import.meta.dirname, "fixture");
const git = (cwd: string, args: string[], env: Record<string, string> = {}) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } }).trim();

const IDENTITY = {
  GIT_AUTHOR_NAME: "tally",
  GIT_AUTHOR_EMAIL: "tally@example.invalid",
  GIT_AUTHOR_DATE: "2026-10-01T09:00:00Z",
  GIT_COMMITTER_NAME: "tally",
  GIT_COMMITTER_EMAIL: "tally@example.invalid",
  GIT_COMMITTER_DATE: "2026-10-01T09:00:00Z",
};

function templateFiles(dir = TEMPLATE): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => (statSync(join(dir, name)).isDirectory() ? templateFiles(join(dir, name)) : [relative(TEMPLATE, join(dir, name))]));
}

/** The blob ids of the template's files, as git would store them. */
const templateBlobs = (): Map<string, string> => new Map(templateFiles().map((file) => [file, git(TEMPLATE, ["hash-object", file])]));

export function fixtureMatchesTemplate(): { ok: boolean; differences: string[] } {
  const listed = new Map(
    git(FIXTURE_REPO, ["ls-tree", "-r", FIXTURE_TAG])
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [meta, path] = line.split("\t") as [string, string];
        return [path, meta.split(" ")[2] as string];
      }),
  );
  const wanted = templateBlobs();
  const differences = [...new Set([...listed.keys(), ...wanted.keys()])].filter((path) => listed.get(path) !== wanted.get(path));
  return { ok: differences.length === 0, differences };
}

if (import.meta.main) {
  if (!existsSync(join(FIXTURE_REPO, ".git"))) {
    mkdirSync(FIXTURE_REPO, { recursive: true });
    cpSync(TEMPLATE, FIXTURE_REPO, { recursive: true });
    git(FIXTURE_REPO, ["init", "--quiet", "--initial-branch=main"]);
    git(FIXTURE_REPO, ["add", "--all"]);
    git(FIXTURE_REPO, ["commit", "--quiet", "-m", "tally"], IDENTITY);
    git(FIXTURE_REPO, ["tag", FIXTURE_TAG]);
  }
  const check = fixtureMatchesTemplate();
  if (!check.ok) {
    console.error(`${FIXTURE_REPO} at ${FIXTURE_TAG} differs from the template: ${check.differences.join(", ")}`);
    process.exit(1);
  }
  console.log(`${FIXTURE_REPO} at ${FIXTURE_TAG} = ${git(FIXTURE_REPO, ["rev-parse", `${FIXTURE_TAG}^{commit}`])}, matching the template (${templateFiles().length} files)`);
}
