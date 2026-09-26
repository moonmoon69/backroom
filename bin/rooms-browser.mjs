#!/usr/bin/env node
/**
 * rooms-browser: drive the shared Chrome browsers of a T3 Rooms service from any shell. A thin client: it finds the
 * service through browser-api.json (URL and token, written by the service at every start), posts the command line,
 * and prints the answer. Parsing, rules and help live in the service (src/browser/tools.ts).
 *
 *   rooms-browser help
 *
 * The connection file is found through --api <file>, ROOMS_BROWSER_API, or ../data/browser-api.json next to this
 * script. --as <key> (or ROOMS_BROWSER_AS) names the agent; --force acts on a tab that is not yours.
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
const has = (flag) => {
  const index = argv.indexOf(flag);
  if (index < 0) return false;
  argv.splice(index, 1);
  return true;
};

const apiFile = take("--api") ?? process.env.ROOMS_BROWSER_API ?? join(dirname(fileURLToPath(import.meta.url)), "..", "data", "browser-api.json");
const as = take("--as") ?? process.env.ROOMS_BROWSER_AS ?? null;
const force = has("--force");

let api;
try {
  api = JSON.parse(readFileSync(apiFile, "utf8"));
} catch {
  console.error(`rooms-browser: cannot read ${apiFile}. Is the T3 Rooms service running, with browsers available?`);
  process.exit(2);
}

let response;
try {
  response = await fetch(`${api.url}/api/browser-tools`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${api.token}` },
    body: JSON.stringify({ argv, as, force }),
  });
} catch (error) {
  console.error(`rooms-browser: cannot reach the T3 Rooms service at ${api.url} (${error.message}).`);
  process.exit(2);
}
const body = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
if (!response.ok) {
  console.error(body.message ?? body.error ?? `HTTP ${response.status}`);
  process.exit(1);
}
console.log(body.text);
