/**
 * The comparison's reads of T3 itself, the same for both sides: its HTTP API (thread shells and details, versions),
 * its state database (read-only), and the harness transcripts on this machine. At a job's close the runner copies
 * what measure.ts and rawsum.mjs read into the job's evidence folder, so the job can be measured again later.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readStoredAuth } from "../../src/adapter/auth.ts";
import { HttpT3Adapter } from "../../src/adapter/http.ts";
import { readT3RuntimeOrigin } from "../../src/config.ts";

export const T3_USERDATA = process.env.T3_USERDATA_DIR ?? join(homedir(), ".t3", "userdata");
export const STATE_DB = join(T3_USERDATA, "statev2.sqlite");
export const RATES = join(T3_USERDATA, "usage-model-rates.json");
export const CLAUDE_PROJECTS = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");

/** T3 over HTTP with the credential an instance was given (its data/t3-auth.json); no shell cache, every read is fresh. */
export function liveT3(instanceDataDir: string): HttpT3Adapter {
  const auth = readStoredAuth(instanceDataDir);
  if (!auth) throw new Error(`no T3 credential in ${instanceDataDir}/t3-auth.json`);
  return new HttpT3Adapter({ baseUrl: readT3RuntimeOrigin(T3_USERDATA) ?? auth.baseUrl, accessToken: auth.accessToken, userDataDir: T3_USERDATA, shellCacheMs: 0 });
}

/** The folder Claude Code keeps a working directory's transcripts in: the path with every non-alphanumeric as "-". */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Copy the transcripts of every session started in `cwd` (the session files and their folders, subagents included)
 * to `<into>/<project dir name>/`, the layout ~/.claude/projects has, so tokens.ts and rawsum.mjs read the copy
 * as they read the original. Claude Code prunes old transcripts; the copy keeps the job measurable.
 */
export function copyTranscripts(cwd: string, into: string, projectsDir = CLAUDE_PROJECTS): string[] {
  const name = claudeProjectDirName(cwd);
  const source = join(projectsDir, name);
  if (!existsSync(source)) return [];
  const target = join(into, name);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  cpSync(source, target, { recursive: true });
  return readdirSync(target);
}

/** Tables copied for a job's threads: enough for rawsum.mjs (sessions), the sqlite3 turn check, and a recount. */
const SUBSET_TABLES = [
  "orchestration_v2_projection_threads",
  "orchestration_v2_projection_runs",
  "orchestration_v2_projection_provider_threads",
  "orchestration_v2_projection_messages",
  "orchestration_v2_projection_subagents",
  "orchestration_v2_projection_runtime_requests",
];

/** A small sqlite file with T3's rows for the given threads, the same tables and columns as statev2.sqlite. */
export function exportStateSubset(threadIds: string[], outPath: string, stateDb = STATE_DB): Record<string, number> {
  rmSync(outPath, { force: true });
  const source = new DatabaseSync(stateDb, { readOnly: true });
  const target = new DatabaseSync(outPath);
  const counts: Record<string, number> = {};
  try {
    const marks = threadIds.map(() => "?").join(", ");
    for (const table of SUBSET_TABLES) {
      const schema = source.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql?: string } | undefined;
      if (!schema?.sql) continue;
      target.exec(schema.sql);
      const rows = source.prepare(`SELECT * FROM ${table} WHERE thread_id IN (${marks})`).all(...threadIds) as Array<Record<string, string | number | null>>;
      counts[table] = rows.length;
      const first = rows[0];
      if (!first) continue;
      const columns = Object.keys(first);
      const insert = target.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
      target.exec("BEGIN");
      for (const row of rows) insert.run(...columns.map((c) => row[c] ?? null));
      target.exec("COMMIT");
    }
  } finally {
    source.close();
    target.close();
  }
  return counts;
}
