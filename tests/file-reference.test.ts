/** Inline code that names a file becomes a chip that opens its preview: what counts, and the lines it points at. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { headingAnchor, linkTarget, parseFileReference } from "../web/src/components/markdownFiles.ts";

test("a path with a line, a line and column, or a range of lines", () => {
  assert.deepEqual(parseFileReference("src/parser.ts:42"), { raw: "src/parser.ts:42", path: "src/parser.ts", basename: "parser.ts", extension: "ts", line: 42 });
  assert.deepEqual(parseFileReference("src/parser.ts:42:7"), { raw: "src/parser.ts:42:7", path: "src/parser.ts", basename: "parser.ts", extension: "ts", line: 42, column: 7 });
  const range = parseFileReference("src/server/http.ts:869-891");
  assert.deepEqual([range?.path, range?.line, range?.endLine], ["src/server/http.ts", 869, 891]);
  assert.equal(parseFileReference("README.md")?.path, "README.md");
});

test("code that is not a file stays code", () => {
  assert.equal(parseFileReference("npm test -- discounts"), null);
  assert.equal(parseFileReference("document.title"), null);
  assert.equal(parseFileReference("https://example.com/a.ts"), null);
});

test("links in a document: its own headings, files beside it or in the project, the web", () => {
  assert.equal(headingAnchor("Try it without T3 (demo mode)"), "try-it-without-t3-demo-mode");
  assert.equal(headingAnchor("1. Get a pairing link"), "1-get-a-pairing-link");
  assert.equal(headingAnchor("Projects, and threads without a room"), "projects-and-threads-without-a-room");
  assert.deepEqual(linkTarget("#how-it-works"), { kind: "anchor", anchor: "how-it-works" });
  assert.deepEqual(linkTarget("docs/plan.md"), { kind: "file", path: "docs/plan.md" });
  assert.deepEqual(linkTarget("src/parser.ts#L10-L20"), { kind: "file", path: "src/parser.ts", line: 10, endLine: 20 });
  assert.deepEqual(linkTarget("file:///tmp/check%20run.log#L3"), { kind: "file", path: "/tmp/check run.log", line: 3 });
  assert.deepEqual(linkTarget("https://github.com/pingdotgg/t3code"), { kind: "web" });
  assert.deepEqual(linkTarget("mailto:someone@example.com"), { kind: "web" });
});
