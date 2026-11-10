#!/usr/bin/env node
// backroom: starts the Backroom service of this package (its compiled dist/), the command a package install runs.
// A git checkout runs `npm start` instead, from its TypeScript.
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const help = `Backroom ${manifest.version}: a shared room for your T3 Code sessions.

Usage:
  backroom start      start the service (also what plain \`backroom\` does)
  backroom --version  print the version
  backroom --help     print this help

The page is at http://127.0.0.1:4400 (ROOMS_PORT changes the port); the data lives in ~/.backroom (ROOMS_DATA_DIR).
`;

const [word, ...rest] = process.argv.slice(2);
if (word === "--version" || word === "-v") {
  console.log(manifest.version);
} else if (word === "--help" || word === "-h" || word === "help") {
  process.stdout.write(help);
} else if ((word === undefined || word === "start") && rest.length === 0) {
  // node:sqlite warns that it is experimental on every start; other warnings still print.
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (warning.name !== "ExperimentalWarning") console.warn(`${warning.name}: ${warning.message}`);
  });
  await import("../dist/server/index.js");
} else {
  process.stderr.write(`backroom: unknown argument "${word === "start" ? rest[0] : word}"\n\n${help}`);
  process.exit(1);
}
