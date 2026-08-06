import "./process-shim";
// Browser-served remote sessions (phone via the remote bridge) install a
// WebSocket-backed DesktopApi before any module reads window.mixdogDesktop;
// inside Electron the preload bridge already exists and this is a no-op.
import "./remote-shim";
// UI language resolves synchronously here, BEFORE any App module evaluates:
// module-level English strings pass through t() at import time.
import "./i18n";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DesktopErrorBoundary, installGlobalRendererDiagnostics } from "./RendererRecovery";
import "@fontsource-variable/inter";
// Grok-web feel: Geist leads the Latin stack (Universal Sans's closest open
// stand-in); Inter stays as fallback and Pretendard owns Hangul.
import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
// Hangul coverage: Inter has no Korean glyphs, so without a bundled Korean
// face the UI fell back to Malgun Gothic. Pretendard Variable is the modern
// Inter-metric-compatible Korean companion face.
// Dynamic subset (not the single 2MB variable file): the face ships as ~93
// unicode-range slices, so a browser/phone downloads only the Hangul blocks it
// actually paints instead of the whole family on every cold load.
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
// Monaco is lazy JS, but its structural CSS must be present before any editor
// DOM mounts. Keeping this in the lazy chunk exposed raw textarea/token DOM for
// a frame before Vite injected the stylesheet.
import "monaco-editor/min/vs/editor/editor.main.css";
import "./ui/tokens.css";
import "./styles.css";
import "./desktop.css";
// Split-pane workspace + bottom panel chrome (components import no css).
import "./pane-layout.css";
import "./webview-zoom";
// Phone/tablet only: visual-viewport pinning + app-like touch behavior.
import "./mobile-shell";
import { markBootStage } from "./boot-metrics";
import { scheduleFontWarmup } from "./font-warmup";
import { preloadMarkdownBody } from "./TranscriptView";
import { defaultSessionLaneStore } from "./session-lane-store";
import { readStoredPaneLayout } from "./pane-workspace-state";
import { paneActiveSelection, paneLeaves } from "./pane-layout";

markBootStage("renderer-entry");
if (import.meta.env?.DEV) performance.mark("mixdog:startup:renderer-entry");
const removeGlobalRendererDiagnostics = installGlobalRendererDiagnostics();
window.addEventListener("beforeunload", removeGlobalRendererDiagnostics, { once: true });
const syncMotionVisibility = () => {
  document.documentElement.dataset.mixdogMotion =
    document.visibilityState === "visible" ? "running" : "paused";
};
syncMotionVisibility();
document.addEventListener("visibilitychange", syncMotionVisibility);
window.addEventListener("beforeunload", () => {
  document.removeEventListener("visibilitychange", syncMotionVisibility);
}, { once: true });

// Listen before React mounts. Persisted pane session ids are not registered
// here: usePaneWorkspace first authorizes them against the durable catalog.
defaultSessionLaneStore.start();
try {
  const restored = readStoredPaneLayout(window.localStorage);
  const visibleSessionIds = restored
    ? [...new Set(paneLeaves(restored.layout).flatMap((leaf) => {
      const active = paneActiveSelection(leaf);
      return active?.kind === "session" ? [active.id] : [];
    }))]
    : [];
  if (visibleSessionIds.length > 0) {
    void preloadMarkdownBody().catch(() => undefined);
  }
} catch {
  // Corrupt/unavailable layout storage falls back to App's normal empty boot.
}

// Kick the webfont fetches BEFORE the first layout: lazily-triggered loads
// made the first paint render fallback glyphs and then swap (user: the
// composer hint "pops" right after entry). Local assets resolve in a few ms,
// so starting them here lands the real faces by first paint.
let criticalFontsReady: Promise<unknown> = Promise.resolve();
try {
  criticalFontsReady = Promise.allSettled([
    // Pretendard's dynamic subset splits Hangul away from its Latin face.
    // Supplying Korean text starts a Hangul range before React's first layout.
    document.fonts.load('400 15px "Pretendard Variable"', "한글"),
    document.fonts.load('500 13px "Geist Variable"'),
    // Restored editor/terminal panes render code at boot: without the mono
    // face in the reveal gate, Monaco painted fallback glyphs and visibly
    // re-flowed when JetBrains Mono landed (user: 부트 시 스크립트가 크게 튐).
    document.fonts.load('400 13px "JetBrains Mono Variable"'),
  ]);
} catch { /* font swap stays a cosmetic fallback */ }

const reactCommitted = new Promise<void>((resolve) => {
  window.addEventListener("mixdog:react-committed", () => resolve(), { once: true });
});
createRoot(document.getElementById("root")!).render(
  <DesktopErrorBoundary>
    <App />
  </DesktopErrorBoundary>,
);
markBootStage("react-render-requested");

// Hidden windows throttle requestAnimationFrame, so using a double-rAF as the
// main-process handshake created a circular wait with ready-to-show. App emits
// this after the complete initial tree's layout effects have committed.
void reactCommitted.then(() => {
  // The explicit probe above cannot predict every Hangul range used by the
  // restored task. After React has committed, FontFaceSet.ready covers the exact
  // subsets requested by the launch DOM before the hidden window is revealed.
  let renderedFontsReady: Promise<unknown> = Promise.resolve();
  try {
    renderedFontsReady = document.fonts.ready;
  } catch { /* font readiness remains a cosmetic launch guard */ }
  // Every face declares font-display:swap, so a reveal that beats the font
  // parse paints fallback glyphs and then REFLOWS the whole window when
  // Pretendard (~2MB variable) lands — the user-visible "폰트 튐" + hitch at
  // entry. Hold the reveal for the critical faces, capped so a broken font
  // fetch can never stall the launch.
  const fontsSettled = Promise.race([
    Promise.allSettled([criticalFontsReady, renderedFontsReady]),
    new Promise((resolve) => window.setTimeout(resolve, 300)),
  ]);
  void fontsSettled.then(() => {
    markBootStage("fonts-settled");
    window.mixdogDesktop?.rendererReady?.();
    // With the launch faces settled and the window revealed, warm the rest of
    // the local font inventory so later-created UI text never lazy-loads.
    scheduleFontWarmup();
  });
});

if ((window as { __mixdogStartupSettled?: boolean }).__mixdogStartupSettled) {
  markBootStage("startup-restored");
} else {
  window.addEventListener(
    "mixdog:startup-settled",
    () => markBootStage("startup-restored"),
    { once: true },
  );
}
