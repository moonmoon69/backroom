#!/usr/bin/env node
// The accuracy check's own token sum for one T3 thread, sharing no code with tokens.ts or measure.ts: the thread's
// Claude sessions from T3's state database (sqlite3 CLI), then the raw transcripts (the session's file and everything
// under its folder, subagents included). A message is written once per content block under one id; it counts once,
// with the largest output of its copies (a subagent's copies grow while it streams), at the time of its first copy,
// and is kept if that time is in [from, to] (ISO, both optional, inclusive). Prints {input, cacheRead, cacheWrite,
// output, messages} as JSON.
//   node rawsum.mjs <statev2.sqlite> <claude projects dir> <threadId> [fromIso] [toIso]
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const [db, projects, thread, from, to] = process.argv.slice(2);
if (!db || !projects || !/^[A-Za-z0-9:%._-]+$/.test(thread ?? "")) throw new Error("usage: rawsum.mjs <statev2.sqlite> <claude projects dir> <threadId> [fromIso] [toIso]");
const sql = `select json_extract(payload_json, '$.nativeThreadRef.nativeId') from orchestration_v2_projection_provider_threads where thread_id = '${thread}' and driver = 'claudeAgent'`;
const sessions = execFileSync("sqlite3", ["-readonly", db, sql], { encoding: "utf8" }).split("\n").filter(Boolean);
const files = [];
const walk = (dir) => readdirSync(dir).sort().forEach((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : name.endsWith(".jsonl") && files.push(join(dir, name))));
for (const project of readdirSync(projects).sort()) for (const session of sessions) {
  if (existsSync(join(projects, project, `${session}.jsonl`))) files.push(join(projects, project, `${session}.jsonl`));
  if (existsSync(join(projects, project, session))) walk(join(projects, project, session));
}
const byId = new Map();
for (const file of files) for (const line of readFileSync(file, "utf8").split("\n")) {
  let row;
  try { row = JSON.parse(line); } catch { continue; }
  const message = row?.message;
  if (!message?.usage || typeof message.id !== "string" || typeof message.model !== "string") continue;
  const at = Date.parse(row.timestamp);
  const seen = byId.get(message.id);
  if (seen) { seen.at = Math.min(seen.at, at); seen.usage = (message.usage.output_tokens ?? 0) > (seen.usage.output_tokens ?? 0) ? message.usage : seen.usage; }
  else byId.set(message.id, { at, usage: message.usage });
}
const [low, high] = [from ? Date.parse(from) : -Infinity, to ? Date.parse(to) : Infinity];
const sum = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, messages: 0 };
for (const { at, usage } of byId.values()) {
  if (!(at >= low && at <= high)) continue;
  sum.input += usage.input_tokens ?? 0;
  sum.cacheRead += usage.cache_read_input_tokens ?? 0;
  sum.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  sum.output += usage.output_tokens ?? 0;
  sum.messages += 1;
}
console.log(JSON.stringify(sum));
