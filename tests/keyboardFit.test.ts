/** The phone keyboard's fit (web/src/keyboardFit.ts): when the app shrinks to the visible area, and how the page scrolls after. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fitFor, scrollFor, type ViewportSample } from "../web/src/keyboardFit.ts";

// An iPhone 15 Pro Max in the installed app, 430 × 932, the composer's textarea near the bottom of the page.
const composer = { tag: "textarea", top: 860, bottom: 900 };
const sample = (over: Partial<ViewportSample> = {}): ViewportSample => ({
  innerHeight: 932,
  viewportHeight: 932,
  offsetTop: 0,
  scale: 1,
  scrollY: 0,
  field: null,
  ...over,
});

test("the screenshot's state fits: the field has focus under the keyboard while the window shrank with the viewport", () => {
  // User's post 264: header at the top, no zoom, the keyboard and AutoFill bar covering everything below 529 px,
  // and no gap between innerHeight and the visual viewport for the old rule to see.
  const hidden = sample({ innerHeight: 529, viewportHeight: 529, field: composer });
  assert.deepEqual(fitFor(hidden, false), { keyboard: true, appHeight: 529 });
  // A small gap (the AutoFill bar alone) is not enough on its own, but the hidden field is.
  assert.deepEqual(fitFor(sample({ innerHeight: 573, viewportHeight: 529, field: composer }), false), { keyboard: true, appHeight: 529 });
});

test("a page at rest with no field focused is left alone", () => {
  assert.deepEqual(fitFor(sample(), false), { keyboard: false, appHeight: null });
  assert.equal(scrollFor(sample(), false, true), "none");
  // A visible focused field with no gap (Android Chrome resizing the layout, a hardware keyboard) is no keyboard either.
  assert.deepEqual(fitFor(sample({ innerHeight: 529, viewportHeight: 529, field: { tag: "textarea", top: 480, bottom: 520 } }), false), { keyboard: false, appHeight: null });
});

test("pinch zoom is left alone, whatever the gap or the field", () => {
  const zoomed = sample({ viewportHeight: 300, offsetTop: 200, scale: 1.8, scrollY: 40, field: composer });
  assert.deepEqual(fitFor(zoomed, true), { keyboard: false, appHeight: null });
  assert.equal(scrollFor(zoomed, false, true), "none");
});

test("a gap between the window and the visual viewport fits as before, field or not", () => {
  assert.deepEqual(fitFor(sample({ viewportHeight: 529 }), false), { keyboard: true, appHeight: 529 });
  assert.deepEqual(fitFor(sample({ viewportHeight: 529, field: { tag: "input", top: 100, bottom: 130 } }), false), { keyboard: true, appHeight: 529 });
  assert.deepEqual(fitFor(sample({ viewportHeight: 860 }), false), { keyboard: false, appHeight: null });
});

test("the fit stays while the field keeps focus, so bringing the field into view does not undo itself", () => {
  // After the fit, the composer sits above the keyboard and the window is no taller than the viewport.
  const fitted = sample({ innerHeight: 529, viewportHeight: 529, field: { tag: "textarea", top: 480, bottom: 520 } });
  assert.deepEqual(fitFor(fitted, true), { keyboard: true, appHeight: 529 });
  // The keyboard closes and focus leaves: the app goes back to the full height.
  assert.deepEqual(fitFor(sample(), true), { keyboard: false, appHeight: null });
});

test("the app height never exceeds the visible area, and sub-pixel rounding is not a hidden field", () => {
  assert.deepEqual(fitFor(sample({ viewportHeight: 529.6 }), false), { keyboard: true, appHeight: 529 });
  assert.deepEqual(fitFor(sample({ innerHeight: 529, viewportHeight: 529, field: { tag: "textarea", top: 489.5, bottom: 529.5 } }), false), { keyboard: false, appHeight: null });
});

test("a field taller than the visible area is not hidden: its caret, not its edge, is what shows", () => {
  const tall = { tag: "textarea", top: 60, bottom: 900 };
  assert.deepEqual(fitFor(sample({ innerHeight: 529, viewportHeight: 529, field: tall }), false), { keyboard: false, appHeight: null });
  assert.equal(scrollFor(sample({ viewportHeight: 529, scrollY: 120, field: tall }), true, true), "pin");
});

test("after the fit the page is pinned at the top when the field shows there", () => {
  // Safari scrolled the page 300 px to reveal the composer; with the fit the composer shows at the top.
  assert.equal(scrollFor(sample({ viewportHeight: 529, scrollY: 300, field: { tag: "textarea", top: 180, bottom: 220 } }), true, false), "pin");
  assert.equal(scrollFor(sample({ viewportHeight: 529, offsetTop: 300, field: { tag: "textarea", top: 480, bottom: 520 } }), true, false), "pin");
  // The keyboard closed with the page still scrolled: back to the top.
  assert.equal(scrollFor(sample({ scrollY: 300 }), false, false), "pin");
});

test("a field the fit leaves hidden is brought into view, and the pin does not take it away again", () => {
  // The fit applied, but the field is still under the keyboard at the top of the page.
  const stillHidden = sample({ innerHeight: 529, viewportHeight: 529, field: composer });
  assert.equal(scrollFor(stillHidden, true, true), "reveal");
  // Once scrolled into view, it would be hidden at the top again: the pin waits.
  const scrolledIn = sample({ innerHeight: 529, viewportHeight: 529, scrollY: 380, field: { tag: "textarea", top: 480, bottom: 520 } });
  assert.equal(scrollFor(scrolledIn, true, true), "none");
  // The poll never reveals, so a reader scrolling a panel past its focused field is not pulled back.
  assert.equal(scrollFor(stillHidden, true, false), "none");
});
