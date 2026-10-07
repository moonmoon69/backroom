/**
 * The device pixel ratio as a CSS variable (--dpr) on the page, kept current when the browser zooms or the window moves
 * to another screen. pixel.css sizes pixel art from it, so every cell of a sprite or icon covers the same whole number
 * of device pixels: at a ratio of 1.8 (a Mac at 90% zoom) a 32px sprite would have 3.6 per cell, and some rows of a
 * face would come out a device pixel wider than others.
 */
export function installDevicePixels(): void {
  const update = () => {
    const ratio = window.devicePixelRatio || 1;
    document.documentElement.style.setProperty("--dpr", String(ratio));
    // A query for the ratio just set: it changes (once) when the ratio does.
    window.matchMedia(`(resolution: ${ratio}dppx)`).addEventListener("change", update, { once: true });
  };
  update();
  // Zooming also resizes the page; some browsers tell that sooner than they tell the resolution.
  window.addEventListener("resize", () => {
    if (document.documentElement.style.getPropertyValue("--dpr") !== String(window.devicePixelRatio || 1)) {
      document.documentElement.style.setProperty("--dpr", String(window.devicePixelRatio || 1));
    }
  });
}
