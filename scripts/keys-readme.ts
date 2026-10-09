/**
 * README.md's Keyboard tables drawn again from the key table (web/src/keyOrder.ts, KEYS): `node scripts/keys-readme.ts`.
 * Everything from the section's first table ("**Everywhere**") to the next section is replaced; the prose above it is
 * kept. tests/keys.test.ts fails while README.md and KEYS differ.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { keysMarkdown } from "../web/src/keyOrder.ts";

const file = new URL("../README.md", import.meta.url);
const readme = readFileSync(file, "utf8");
const section = readme.indexOf("## Keyboard\n");
const start = readme.indexOf("**Everywhere**\n", section);
const end = readme.indexOf("## The pixel look");
if (section < 0 || start < 0 || end < start) throw new Error("README.md has no Keyboard section with its tables before ## The pixel look");
writeFileSync(file, `${readme.slice(0, start)}${keysMarkdown()}\n\n${readme.slice(end)}`);
console.log("README.md: the Keyboard tables are drawn from KEYS");
