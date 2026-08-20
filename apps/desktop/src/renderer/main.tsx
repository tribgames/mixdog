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
import "./remote-shim";
import { initUiLanguage } from "./i18n";

await initUiLanguage();
await import("./bootstrap");
