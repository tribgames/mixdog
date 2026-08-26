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
import "./bootstrap-styles";
import "./webview-zoom";
import { installShellViewport } from "./shell-viewport";
import { installFocusModality } from "./focus-modality";
import { installMobileSurfaceMarker } from "./mobile-surface";
import { installMotionVisibility } from "./motion-visibility";
import { installScrollbarMetrics } from "./scrollbar-metrics";
import { markBootStage } from "./boot-metrics";
import { scheduleFontWarmup } from "./font-warmup";
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

// Kick the webfont fetches BEFORE the first layout: lazily-triggered loads
// made the first paint render fallback glyphs and then swap (user: the
// composer hint "pops" right after entry). Local assets resolve in a few ms,
// so starting them here lands the real faces by first paint.
const nativeDesktop = Boolean(window.mixdogDesktop?.bootContext?.bootId);
let criticalFontsReady: Promise<unknown> = Promise.resolve();
try {
  criticalFontsReady = Promise.allSettled([
    // Pretendard's dynamic subset splits Hangul away from its Latin face.
    // Supplying Korean text starts a Hangul range before React's first layout.
    document.fonts.load('400 15px "Pretendard Variable"', "한글"),
    // Only Electron can restore an editor/terminal before the first visible
    // frame. A phone loads the mono face with that deferred surface instead of
    // spending one more cold relay request before its shell appears.
    ...(nativeDesktop
      ? [document.fonts.load('400 13px "JetBrains Mono Variable"')]
      : []),
  ]);
} catch { /* font swap stays a cosmetic fallback */ }

// The desktop keeps its window hidden until rendererReady, so its launch
// sequence is never visible. Over the relay that call is a no-op and the
// installed web app showed every step of it (user: 웹앱 처음 들어갈 때 화면이
// 툭툭 튄다). boot.js gates #root behind the window band; release it once the
// first frame is as settled as it is going to get.
// Session/layout restore is a relay round trip on the installed web app, so
// the reveal waits for it instead of letting the restored layout land on an
// already visible frame. A slow desktop leg can never hold the app behind the
// gate. The budget starts HERE rather than inside the reveal call: the font
// race below covers the same launch, and running the two in series charged
// every boot the sum of both waits (user: 최초 부트가 느리다).
const startupRevealBudget = Promise.race([
  new Promise<void>((resolve) => {
    if ((window as { __mixdogStartupSettled?: boolean }).__mixdogStartupSettled) {
      resolve();
      return;
    }
    window.addEventListener("mixdog:startup-settled", () => resolve(), { once: true });
  }),
  new Promise((resolve) => { window.setTimeout(resolve, 800); }),
]);

function revealInstalledWebApp(): void {
  const reveal = (window as typeof window & { mixdogRevealApp?: () => void }).mixdogRevealApp;
  if (typeof reveal !== "function") return;
  void startupRevealBudget.then(() => {
    window.requestAnimationFrame(() => reveal());
  });
}

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
  const fontRevealBudgetMs = nativeDesktop ? 300 : 150;
  const fontsSettled = Promise.race([
    Promise.allSettled([criticalFontsReady, renderedFontsReady]),
    new Promise((resolve) => window.setTimeout(resolve, fontRevealBudgetMs)),
  ]);
  void fontsSettled.then(() => {
    markBootStage("fonts-settled");
    window.mixdogDesktop?.rendererReady?.();
    revealInstalledWebApp();
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
