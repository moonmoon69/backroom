/** Inline code that names a file becomes a chip that opens its preview: what counts, and the lines it points at. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { headingAnchor, imageSource, isDataImage, isImageLink, linkTarget, localizeHtmlMedia, mediaKind, parseFileReference } from "../web/src/components/markdownFiles.ts";

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

test("a previewed HTML document's local media is served by the service, looked for next to the document", () => {
  const base = "/tmp/prism-design";
  const served = (path: string) => `/api/local-file?path=${encodeURIComponent(path)}`;
  const untouched = [
    `<img src="https://example.com/x.png?a=1&amp;b=2"><img src="data:image/png;base64,AAAA"><img src="/api/attachments/abc"><img src="" alt="none">`,
    `<a href="opus/index.html">a link</a><script src="app.js"></script><link rel="stylesheet" href="style.css"><div data-src="x.png"></div>`,
  ];
  const html = [
    `<img src="opus/shots/desk-1440x900.png" alt="Opus, desk">`,
    `<img src='./opus2/shots/phone.png'><IMG SRC=opus3/shots/hand.png>`,
    `<picture><source srcset="shots/a.png 1x, /tmp/shots/b.png 2x" type="image/png"><img src="shots/a.png"></picture>`,
    `<video poster="clips/poster.jpg" src="file:///tmp/clips/demo.mp4" controls></video><audio src="sounds/ping.wav"></audio>`,
    ...untouched,
  ].join("\n");
  assert.equal(
    localizeHtmlMedia(html, base),
    [
      `<img src="${served("/tmp/prism-design/opus/shots/desk-1440x900.png")}" alt="Opus, desk">`,
      `<img src="${served("/tmp/prism-design/opus2/shots/phone.png")}"><IMG SRC="${served("/tmp/prism-design/opus3/shots/hand.png")}">`,
      `<picture><source srcset="${served("/tmp/prism-design/shots/a.png")} 1x, ${served("/tmp/shots/b.png")} 2x" type="image/png"><img src="${served("/tmp/prism-design/shots/a.png")}"></picture>`,
      `<video poster="${served("/tmp/prism-design/clips/poster.jpg")}" src="${served("/tmp/clips/demo.mp4")}" controls></video><audio src="${served("/tmp/prism-design/sounds/ping.wav")}"></audio>`,
      ...untouched,
    ].join("\n"),
  );
  // A document with nothing local to map is returned as it was.
  assert.equal(localizeHtmlMedia(untouched.join("\n"), base), untouched.join("\n"));
});

test("the HTML media mapping reads the document as a browser does (Sol's review #23)", () => {
  const base = "/tmp/prism-design";
  const served = (path: string) => `/api/local-file?path=${encodeURIComponent(`${base}/${path}`)}`;
  // Text in a script, a style, a textarea or a comment is not markup.
  for (const raw of [
    `<script>const markup = "<img src=plain.png>"; document.body.textContent = "ran";</script>`,
    `<style>/* <img src="x.png"> */ .a { background: url(plain.png) }</style>`,
    `<textarea><img src="x.png"></textarea>`,
    `<!-- <img src="x.png"> -->`,
    `<div style="background-image:url(plain.png)">test</div>`,
  ]) {
    assert.equal(localizeHtmlMedia(raw, base), raw);
  }
  // Attributes are read one at a time: a quoted value may hold `>` or something that looks like another attribute.
  assert.equal(localizeHtmlMedia(`<img alt="a > b" src="plain.png">`, base), `<img alt="a > b" src="${served("plain.png")}">`);
  assert.equal(localizeHtmlMedia(`<img alt="hello src='note.png'" src="plain.png">`, base), `<img alt="hello src='note.png'" src="${served("plain.png")}">`);
  assert.equal(localizeHtmlMedia(`<img title='say "hi" > there' src=plain.png />`, base), `<img title='say "hi" > there' src="${served("plain.png")}" />`);
  // An entity in a path names the file it decodes to.
  assert.equal(localizeHtmlMedia(`<img src="a&amp;b.png">`, base), `<img src="${served("a&b.png")}">`);
  assert.equal(localizeHtmlMedia(`<img src="caf&#233;&#x20;shot.png">`, base), `<img src="${served("café shot.png")}">`);
  // srcset candidates as a browser reads them: a comma needs no space after it, a data URL's commas are its own.
  assert.equal(localizeHtmlMedia(`<img srcset="small.png 1w,large.png 9000w">`, base), `<img srcset="${served("small.png")} 1w, ${served("large.png")} 9000w">`);
  const data = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  assert.equal(localizeHtmlMedia(`<img srcset="${data} 1x, plain.png 2x">`, base), `<img srcset="${data} 1x, ${served("plain.png")} 2x">`);
  assert.equal(localizeHtmlMedia(`<img srcset="a.png, b.png 2x">`, base), `<img srcset="${served("a.png")}, ${served("b.png")} 2x">`);
  const web = `<img srcset="https://x.org/a.png 1x,https://x.org/b.png 2x">`;
  assert.equal(localizeHtmlMedia(web, base), web);
  // The document around a mapped element is kept byte for byte, an unclosed tag included.
  assert.equal(localizeHtmlMedia(`<p>a</p>\n<img src="plain.png" alt="x"\n<p>b</p>`, base), `<p>a</p>\n<img src="${served("plain.png")}" alt="x"\n<p>b</p>`);
});

test("the HTML media mapping reads the document as the HTML tokenizer does (Sol's review #39)", () => {
  const base = "/tmp/prism-design";
  const served = (path: string) => `/api/local-file?path=${encodeURIComponent(`${base}/${path}`)}`;
  // A raw-text element's content starts after its whole start tag, whatever its attributes hold; noscript is raw text too.
  for (const raw of [
    `<script data-note="</script>">const markup = "<img src=plain.png>";</script>`,
    `<noscript><img src="plain.png"></noscript>`,
    `<svg><![CDATA[ <img src="plain.png"> ]]></svg>`,
    `<plaintext><img src="plain.png">`,
  ]) {
    assert.equal(localizeHtmlMedia(raw, base), raw);
  }
  // An end tag counts only when its name is followed by whitespace, a slash or >.
  assert.equal(localizeHtmlMedia(`<script>"</scripts>"</script><img src="plain.png">`, base), `<script>"</scripts>"</script><img src="${served("plain.png")}">`);
  // Character references as the tokenizer decodes them: every named one, numeric ones with or without the semicolon,
  // the C1 range as Windows-1252, and a replacement character where a browser puts one (nothing throws).
  assert.equal(localizeHtmlMedia(`<img src="caf&eacute;.png">`, base), `<img src="${served("café.png")}">`);
  assert.equal(localizeHtmlMedia(`<img src="&#128;.png">`, base), `<img src="${served("€.png")}">`);
  assert.equal(localizeHtmlMedia(`<img src="a&#38b.png">`, base), `<img src="${served("a&b.png")}">`);
  for (const invalid of ["&#x110000;", "&#xD800;", "&#0;"]) assert.equal(localizeHtmlMedia(`<img src="${invalid}.png">`, base), `<img src="${served("�.png")}">`);
  // An unknown name, or a name without its semicolon, stays as written.
  assert.equal(localizeHtmlMedia(`<img src="x&nosuch;y&amp.png">`, base), `<img src="${served("x&nosuch;y&amp.png")}">`);
  // Whitespace is HTML's: a no-break space belongs to a file's name, in srcset and in a bare value.
  assert.equal(localizeHtmlMedia(`<img srcset="a b.png 1x">`, base), `<img srcset="${served("a b.png")} 1x">`);
  assert.equal(localizeHtmlMedia(`<img src=a b.png>`, base), `<img src="${served("a b.png")}">`);
  // A bare value runs to whitespace or >, a stray quote included, as a browser reads it.
  assert.equal(localizeHtmlMedia(`<img src=a"b.png alt=x>`, base), `<img src="${served('a"b.png')}" alt=x>`);
});
