// Renderer entry. Its only job is ORDER: the UI language has to be in place
// before any app module evaluates, because module-level strings pass through
// t() at import time. Everything the app actually does lives in ./bootstrap,
// which is imported once the catalog is ready.
//
// The split is what lets the eleven language catalogs stop riding the
// first-paint bundle: only the resolved language is fetched, and English
// fetches nothing at all.
import "./process-shim";
import { preloadMarkdownBody } from "./markdown-body-loader";
// Browser-served remote sessions install a WebSocket-backed DesktopApi before
// any module reads window.mixdogDesktop; inside Electron the preload bridge
// already exists and this is a no-op.
const remoteBrowser = typeof navigator !== "undefined" && !/Electron/i.test(navigator.userAgent);
// Start the remote transport immediately. On the installed web app, mobile
// detection, language code and first-screen CSS overlap this fetch instead of
// forming four relay round trips in a row.
const remoteShimReady = import("./remote-shim");
let launchApplication = true;
if (remoteBrowser) {
  const {
    isInstalledMobileWebAppSurface,
    isMobileRemoteSurface,
  } = await import("./mobile-surface");
  // A mobile browser tab remains the lightweight installation page. It still
  // needs the worker to become installable; desktop browsers do not.
  if (isMobileRemoteSurface() && window.isSecureContext && "serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        // Installation remains available from browsers that do not need a worker.
      });
    }, { once: true });
  }
  launchApplication = isInstalledMobileWebAppSurface();
}

if (launchApplication) {
  // Start the settled transcript renderer after its HTML hint has queued the
  // shell-critical chunks first. The separate streaming parser Worker and
  // secondary dialogs remain lazy, so an existing Markdown conversation is
  // complete at reveal without letting those later surfaces take a boot slot.
  if (remoteBrowser) void preloadMarkdownBody().catch(() => undefined);
  const languageReady = import("./i18n")
    .then((module) => module.initUiLanguage());
  // Web-only early CSS fetch: bootstrap still imports this module and remains
  // the readiness owner. The Electron path keeps its existing load order.
  if (remoteBrowser) void import("./bootstrap-styles").catch(() => undefined);
  await Promise.all([remoteShimReady, languageReady]);
  await import("./bootstrap");
} else {
  // The lightweight installation page is rendered by remote-shim itself.
  await remoteShimReady;
}
