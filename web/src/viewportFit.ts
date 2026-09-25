/**
 * Keep the app inside the visible area while the on-screen keyboard is open.
 *
 * iOS Safari does not shrink the layout viewport for the keyboard (it ignores interactive-widget=resizes-content);
 * instead it scrolls the whole page up to reveal the focused field, and that offset sticks around after the
 * composer clears, leaving the header off-screen and a gap under the composer. Here the app's height follows
 * the visual viewport whenever it is markedly shorter than the window, and the page scroll is pinned at zero,
 * so the composer sits directly above the keyboard without Safari having to scroll anything.
 *
 * Browsers that do resize the layout (Android Chrome with the viewport meta above) never trip the threshold,
 * and pinch zoom is left alone because the visual viewport shrinks then too.
 */
const KEYBOARD_MIN_PX = 80;

export function installViewportFit(): void {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const root = document.documentElement;
  let frame = 0;

  const apply = () => {
    frame = 0;
    const zoomed = Math.abs(viewport.scale - 1) > 0.01;
    const keyboard = !zoomed && window.innerHeight - viewport.height > KEYBOARD_MIN_PX;
    if (keyboard) {
      root.style.setProperty("--app-height", `${Math.round(viewport.height)}px`);
      root.classList.add("keyboard-open");
    } else {
      root.style.removeProperty("--app-height");
      root.classList.remove("keyboard-open");
    }
    if (!zoomed && (window.scrollY !== 0 || viewport.offsetTop !== 0)) window.scrollTo(0, 0);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(apply);
  };

  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);
  // Safari scrolls the page on focus before it fires any viewport event; catch up right after.
  document.addEventListener("focusin", () => setTimeout(schedule, 50));
  document.addEventListener("focusout", () => setTimeout(schedule, 50));
  apply();
}
