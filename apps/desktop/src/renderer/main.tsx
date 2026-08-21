// Renderer entry. Its only job is ORDER: the UI language has to be in place
// before any app module evaluates, because module-level strings pass through
// t() at import time. Everything the app actually does lives in ./bootstrap,
// which is imported once the catalog is ready.
//
// The split is what lets the eleven language catalogs stop riding the
// first-paint bundle: only the resolved language is fetched, and English
// fetches nothing at all.
import "./process-shim";
// Browser-served remote sessions install a WebSocket-backed DesktopApi before
// any module reads window.mixdogDesktop; inside Electron the preload bridge
// already exists and this is a no-op.
await import("./remote-shim");

const remoteBrowser = typeof navigator !== "undefined" && !/Electron/i.test(navigator.userAgent);
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
  const { initUiLanguage } = await import("./i18n");
  await initUiLanguage();
  await import("./bootstrap");
}
