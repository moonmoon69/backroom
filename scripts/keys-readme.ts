/**
 * README.md's Keyboard list and tables drawn again from the key table (web/src/keyOrder.ts, FOUR_KEYS and KEYS):
 * `node scripts/keys-readme.ts`. The list of the four keys opens the section; everything from the section's first table
 * ("**Everywhere**") to the next section is replaced; the prose between them is kept. tests/keys.test.ts fails while
 * README.md and the table differ.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fourKeysMarkdown, keysMarkdown } from "../web/src/keyOrder.ts";

const file = new URL("../README.md", import.meta.url);
const readme = readFileSync(file, "utf8");
const heading = "## Keyboard\n\n";
const section = readme.indexOf(heading);
// The four keys: the list right under the heading (none yet: it goes there).
const listStart = section + heading.length;
const listEnd = readme.startsWith("- `", listStart) ? readme.indexOf("\n\n", listStart) + 2 : listStart;
const start = readme.indexOf("**Everywhere**\n", section);
const end = readme.indexOf("## The pixel look");
if (section < 0 || start < 0 || end < start) throw new Error("README.md has no Keyboard section with its tables before ## The pixel look");
writeFileSync(file, `${readme.slice(0, listStart)}${fourKeysMarkdown()}\n\n${readme.slice(listEnd, start)}${keysMarkdown()}\n\n${readme.slice(end)}`);
console.log("README.md: the Keyboard list and tables are drawn from FOUR_KEYS and KEYS");
