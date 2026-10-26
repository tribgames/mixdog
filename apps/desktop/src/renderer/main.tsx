// Renderer entry. Its only job is ORDER: the UI language has to be in place
// before any app module evaluates, because module-level strings pass through
// t() at import time. Everything the app actually does lives in ./bootstrap,
// which is imported once the catalog is ready.
//
// The split is what lets the eleven language catalogs stop riding the
// first-paint bundle: only the resolved language is fetched, and English
// fetches nothing at all.
import './process-shim';
import { nativeAppInfo } from '../shared/native-app';
import { installShellUpdateState, recoverShellBootstrap } from './shell-update-state';
import { preloadMarkdownBody } from './markdown-body-loader';
import { installKeyboardFlick, installTouchGestures } from './touch-gestures';
// Browser-served remote sessions install a WebSocket-backed DesktopApi before
// any module reads window.mixdogDesktop; inside Electron the preload bridge
// already exists and this is a no-op.
const remoteBrowser = typeof navigator !== 'undefined' && !/Electron/i.test(navigator.userAgent);
if (remoteBrowser) installShellUpdateState();
// Start the remote transport immediately. On the installed web app, mobile
// detection, language code and first-screen CSS overlap this fetch instead of
// forming four relay round trips in a row.
const remoteShimReady = import('./remote-shim');
let launchApplication = true;
if (remoteBrowser) {
  const { isInstalledMobileWebAppSurface, isMobileDeviceSurface } = await import('./mobile-surface');
  // A phone/tablet browser tab remains the lightweight installation page and
  // needs the worker to become installable. An app that runs (installed
  // device app or a second PC's remote window) needs it for push and the
  // encrypted media lane. A plain desktop browser tab does not.
  if (
    (isMobileDeviceSurface() || isInstalledMobileWebAppSurface()) &&
    window.isSecureContext &&
    'serviceWorker' in navigator
  ) {
    const registerWorker = (): void => {
      void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        // Installation remains available from browsers that do not need a worker.
      });
    };
    // The await above can outlast the page load on a fast launch; a listener
    // added after `load` never fires, and the worker never registered.
    if (document.readyState === 'complete') registerWorker();
    else window.addEventListener('load', registerWorker, { once: true });
  }
  launchApplication = isInstalledMobileWebAppSurface();
}

if (launchApplication) {
  installTouchGestures();
  installKeyboardFlick(window);
  // Inside the phone apps a stray `<a download>` is dropped by the WebView:
  // route it to the native save bridge instead.
  if (nativeAppInfo()) void import('./native-download-hook').then((hook) => hook.installNativeDownloadHook(document));
  // Start the settled transcript renderer after its HTML hint has queued the
  // shell-critical chunks first. The separate streaming parser Worker and
  // secondary dialogs remain lazy, so an existing Markdown conversation is
  // complete at reveal without letting those later surfaces take a boot slot.
  if (remoteBrowser) void preloadMarkdownBody().catch(() => undefined);
  const languageReady = import('./i18n').then((module) => module.initUiLanguage());
  // Web-only early CSS fetch: bootstrap still imports this module and remains
  // the readiness owner. The Electron path keeps its existing load order.
  if (remoteBrowser) {
    void import('./font-faces-styles').catch(() => undefined);
    void import('./bootstrap-styles').catch(() => undefined);
  }
  try {
    await Promise.all([remoteShimReady, languageReady]);
    // The restored session's transcript read starts here, next to the app
    // bundle's load instead of behind its evaluation, first commit and
    // catalog check. The language is in place, as the order above requires.
    if (!remoteBrowser) {
      void import('./boot-session-read').then((module) => module.startRestoredSessionReads()).catch(() => undefined);
    }
    await import('./bootstrap');
  } catch (error) {
    if (remoteBrowser) recoverShellBootstrap();
    throw error;
  }
} else {
  // The lightweight installation page is rendered by remote-shim itself.
  await remoteShimReady;
}
