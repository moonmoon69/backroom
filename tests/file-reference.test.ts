/** Inline code that names a file becomes a chip that opens its preview: what counts, and the lines it points at. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { headingAnchor, imageSource, isDataImage, isImageLink, linkTarget, mediaKind, parseFileReference } from "../web/src/components/markdownFiles.ts";

test("a path with a line, a line and column, or a range of lines", () => {
  assert.deepEqual(parseFileReference("src/parser.ts:42"), { raw: "src/parser.ts:42", path: "src/parser.ts", basename: "parser.ts", extension: "ts", line: 42 });
  assert.deepEqual(parseFileReference("src/parser.ts:42:7"), { raw: "src/parser.ts:42:7", path: "src/parser.ts", basename: "parser.ts", extension: "ts", line: 42, column: 7 });
  const range = parseFileReference("src/server/http.ts:869-891");
  assert.deepEqual([range?.path, range?.line, range?.endLine], ["src/server/http.ts", 869, 891]);
  assert.equal(parseFileReference("README.md")?.path, "README.md");
});

test("image display URLs preserve app and web routes while resolving document paths", () => {
  const base = "/tmp/document";
  assert.equal(imageSource("./pictures/shot.png", base), "/api/local-file?path=%2Ftmp%2Fdocument%2Fpictures%2Fshot.png");
  assert.equal(imageSource("/tmp/shot.png", base), "/api/local-file?path=%2Ftmp%2Fshot.png");
  assert.equal(imageSource("file:///tmp/check%20run.png", base), "/api/local-file?path=%2Ftmp%2Fcheck%20run.png");
  for (const src of ["/api/local-file?path=%2Ftmp%2Fshot.png", "/api/attachments/abc", "/assets/shot.png", "https://example.com/shot.png?x=1", "//example.com/shot.png", "data:image/png;base64,AAAA"]) {
    assert.equal(imageSource(src, base), src);
    assert.equal(isImageLink(src), true);
    assert.deepEqual(linkTarget(src), { kind: "web" });
  }
});

test("image links distinguish players, documents and supported data images", () => {
  for (const src of ["./shot.png", "file:///tmp/shot.jpg", "/tmp/shot.svg", "https://example.com/shot.AVIF#view"]) assert.equal(isImageLink(src), true);
  for (const src of ["https://example.com", "docs/plan.md", "/api/local-file?path=%2Ftmp%2Fclip.mp4", "data:text/html,<h1>x</h1>"]) assert.equal(isImageLink(src), false);
  assert.equal(mediaKind("/api/local-file?path=%2Ftmp%2Fclip.mp4"), "video");
  assert.equal(mediaKind("/api/local-file?path=%2Ftmp%2Fsound.wav"), "audio");
  assert.equal(isDataImage("data:image/svg+xml,%3Csvg%3E%3C/svg%3E"), true);
  assert.equal(isDataImage("data:text/html,<script>"), false);
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
