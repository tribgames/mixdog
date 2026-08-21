import "./process-shim";
// Browser-served remote sessions install a
// WebSocket-backed DesktopApi before any module reads window.mixdogDesktop;
// inside Electron the preload bridge already exists and this is a no-op.
import "./remote-shim";
// UI language resolves synchronously here, BEFORE any App module evaluates:
// module-level English strings pass through t() at import time.
import "./i18n";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { RemoteClaimPrompt } from "./RemoteClaimPrompt";
import { DesktopErrorBoundary, installGlobalRendererDiagnostics } from "./RendererRecovery";
import "@fontsource-variable/jetbrains-mono";
// Pretendard owns both Latin and Hangul across the shell. Geist/Inter used to
// be bundled as fallbacks even though no rendered stack selected them, adding
// font-face CSS and making the launch gate fetch an unused Geist face.
// Dynamic subset (not the single 2MB variable file): the face ships as ~93
// unicode-range slices, so a browser/phone downloads only the Hangul blocks it
// actually paints instead of the whole family on every cold load.
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
// Monaco's structural CSS is NOT imported here. The esm build the editor chunk
// uses pulls in the same rules, and Vite resolves a lazy chunk's stylesheet
// before its component renders, so editor DOM still never paints unstyled.
// Importing min/vs/editor/editor.main.css as well put a SECOND ~200KB copy of
// those rules into the first-paint stylesheet, which every phone downloaded
// before it could show a single message.
// Codicon FONT (B안): chrome-level glyphs render through the text
// rasterizer on their native 16px grid — crisp on device pixels where the
// scaled 24-grid lucide SVG strokes went fractional and soft. Loaded BEFORE
// desktop.css so our sizing overrides win the equal-specificity cascade.
import "@vscode/codicons/dist/codicon.css";
import "./ui/tokens.css";
import "./styles.css";
import "./desktop.css";
// Split-pane workspace + bottom panel chrome (components import no css).
import "./pane-layout.css";
// Mobile PWA runtime invariants load last: they own the visual-viewport frame,
// page scroll lock, and iOS input scale floor over every desktop layer.
import "./mobile-web-runtime.css";
import "./webview-zoom";
import { installShellViewport } from "./shell-viewport";
import { installFocusModality } from "./focus-modality";
import { installMobileSurfaceMarker } from "./mobile-surface";
import { installMotionVisibility } from "./motion-visibility";
import { installScrollbarMetrics } from "./scrollbar-metrics";
import { markBootStage } from "./boot-metrics";
import { scheduleFontWarmup } from "./font-warmup";
import { preloadMarkdownBody } from "./TranscriptView";
import { defaultSessionLaneStore } from "./session-lane-store";
import { installAutoDomI18n } from "./auto-dom-i18n";

markBootStage("renderer-entry");
if (import.meta.env?.DEV) performance.mark("mixdog:startup:renderer-entry");
const removeGlobalRendererDiagnostics = installGlobalRendererDiagnostics();
window.addEventListener("beforeunload", removeGlobalRendererDiagnostics, { once: true });
const removeAutoDomI18n = installAutoDomI18n();
window.addEventListener("beforeunload", removeAutoDomI18n, { once: true });
const removeShellViewport = installShellViewport();
window.addEventListener("beforeunload", removeShellViewport, { once: true });
// Focus rings are keyboard chrome: the root records whether the last
// interaction came from a pointer, and 02-base.css hides button focus frames
// while it did (user: 동작 끝났는데 선택 프레임이 남는다).
const removeFocusModality = installFocusModality();
window.addEventListener("beforeunload", removeFocusModality, { once: true });
// Measured scrollbar reserve BEFORE the first paint: every gutter-paying
// layout (session rail, transcript column, settings/studio padding, SCM dock)
// reads --mx-scrollbar-gutter, which is 0 where scrollbars are overlays.
const removeScrollbarMetrics = installScrollbarMetrics();
window.addEventListener("beforeunload", removeScrollbarMetrics, { once: true });
// Phone marker BEFORE the first React render (user: 첫 진입 레이아웃 시프트):
// the Chrome-toolbar/drawer/popup CSS keys on the root attribute, so it must
// exist before the desktop grammar can paint even once.
const removeMobileSurfaceMarker = installMobileSurfaceMarker();
window.addEventListener("beforeunload", removeMobileSurfaceMarker, { once: true });
const removeMotionVisibility = installMotionVisibility();
window.addEventListener("beforeunload", removeMotionVisibility, { once: true });

// Listen before React mounts. Persisted pane session ids are not registered
// here: usePaneWorkspace first authorizes them against the durable catalog.
defaultSessionLaneStore.start();
void preloadMarkdownBody().catch(() => undefined);

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
    <RemoteClaimPrompt />
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
