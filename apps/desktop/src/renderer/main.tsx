import "./process-shim";
// Browser-served remote sessions (phone via the remote bridge) install a
// WebSocket-backed DesktopApi before any module reads window.mixdogDesktop;
// inside Electron the preload bridge already exists and this is a no-op.
import "./remote-shim";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fontsource-variable/inter";
// Grok-web feel: Geist leads the Latin stack (Universal Sans's closest open
// stand-in); Inter stays as fallback and Pretendard owns Hangul.
import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
// Hangul coverage: Inter has no Korean glyphs, so without a bundled Korean
// face the UI fell back to Malgun Gothic. Pretendard Variable is the modern
// Inter-metric-compatible Korean companion face.
import "pretendard/dist/web/variable/pretendardvariable.css";
import "./styles.css";
import "./opencode-v2.css";
import "./webview-zoom";
// Phone/tablet only: visual-viewport pinning + app-like touch behavior.
import "./mobile-shell";

if (import.meta.env?.DEV) performance.mark("mixdog:startup:renderer-entry");

// Kick the webfont fetches BEFORE the first layout: lazily-triggered loads
// made the first paint render fallback glyphs and then swap (user: the
// composer hint "pops" right after entry). Local assets resolve in a few ms,
// so starting them here lands the real faces by first paint.
try {
  void document.fonts.load('400 15px "Pretendard Variable"');
  void document.fonts.load('500 13px "Geist Variable"');
  void document.fonts.load('400 13px "JetBrains Mono Variable"');
} catch { /* font swap stays a cosmetic fallback */ }

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Tell main the first commit is painted: the window used to show on the
// renderer's FIRST paint (empty band), so the tab strip popped in a frame
// later (user-reported launch jolt). Double rAF = post-commit, post-paint.
// The reveal ALSO waits for the last-project restore decision (capped) so the
// welcome block and tabs never jump after the window is visible.
requestAnimationFrame(() => requestAnimationFrame(() => {
  const signal = () => window.mixdogDesktop?.rendererReady?.();
  if ((window as { __mixdogStartupSettled?: boolean }).__mixdogStartupSettled) {
    signal();
    return;
  }
  const timer = window.setTimeout(signal, 900);
  window.addEventListener("mixdog:startup-settled", () => {
    window.clearTimeout(timer);
    requestAnimationFrame(() => requestAnimationFrame(signal));
  }, { once: true });
}));
