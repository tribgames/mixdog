import './process-shim';
import { nativeAppInfo } from '../shared/native-app';
import { installShellUpdateState, recoverShellBootstrap } from './shell-update-state';
import { preloadMarkdownBody } from './markdown-body-loader';
import { installKeyboardFlick, installTouchGestures } from './touch-gestures';
// Browser-served remote sessions install a WebSocket-backed DesktopApi before
// any module reads window.mixdogDesktop; inside Electron the window composes it
// from the preload's host half and its own core port (core-direct/install).
const remoteBrowser = typeof navigator !== 'undefined' && !/Electron/i.test(navigator.userAgent);
if (remoteBrowser) installShellUpdateState();
// Start the remote transport immediately. On the installed web app, mobile
// detection, language code and first-screen CSS overlap this fetch instead of
// forming four relay round trips in a row.
const remoteShimReady = remoteBrowser ? import('./remote-shim') : undefined;
let launchApplication = true;
if (remoteBrowser) {
  const { isInstalledMobileWebAppSurface, isMobileDeviceSurface } = await import('./mobile-surface');
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
    // window.mixdogDesktop: the preload's host half plus the core methods over this window's own core port. A dynamic import:
    // install.ts pulls in renderer modules that must not evaluate before the language is in place nor ride the first paint.
    if (!remoteBrowser) await import('./core-direct/install').then((module) => module.installDirectDesktopApi());
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
