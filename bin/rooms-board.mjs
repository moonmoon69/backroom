#!/usr/bin/env node
/**
 * rooms-board: read a room's board and seat the user's saved crew, from any shell. A thin client, like rooms-browser:
 * it finds the service through browser-api.json (URL and token, written by the service at every start), posts the
 * command line, and prints the answer. Parsing, rules and help live in the service (src/app/board.ts).
 *
 *   rooms-board help
 *
 * The connection file is found through --api <file>, ROOMS_BROWSER_API, or ../data/browser-api.json next to this
 * script. --as <key> (or ROOMS_BROWSER_AS) names the member: the key its briefing gives it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const take = (flag) => {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const [, value] = argv.splice(index, 2);
  return value;
};

const apiFile = take("--api") ?? process.env.ROOMS_BROWSER_API ?? join(dirname(fileURLToPath(import.meta.url)), "..", "data", "browser-api.json");
const as = take("--as") ?? process.env.ROOMS_BROWSER_AS ?? null;

let api;
try {
  api = JSON.parse(readFileSync(apiFile, "utf8"));
} catch {
  console.error(`rooms-board: cannot read ${apiFile}. Is Backroom running?`);
  process.exit(2);
}

let response;
try {
  response = await fetch(`${api.url}/api/board-tools`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${api.token}` },
    body: JSON.stringify({ argv, as }),
  });
} catch (error) {
  console.error(`rooms-board: cannot reach Backroom at ${api.url} (${error.message}).`);
  process.exit(2);
}
const body = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
if (!response.ok) {
  console.error(body.message ?? body.error ?? `HTTP ${response.status}`);
  process.exit(1);
}
console.log(body.text);
