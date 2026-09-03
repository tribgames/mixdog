// Remote phones (iOS and Android Chrome/PWA) keep device-width so the first
// paint uses native CSS pixels. Desktop browsers still project 1040px.
if (!/Electron/i.test(navigator.userAgent)) {
  var mixdogViewport = document.querySelector('meta[name="viewport"]');
  var mixdogIos = /iPad|iPhone|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
  var mixdogPhone = mixdogIos
    || (/Android/i.test(navigator.userAgent) && /Mobile/i.test(navigator.userAgent))
    || ((navigator.maxTouchPoints || 0) > 0
      && Math.min(screen.width, screen.height) < 768);
  if (mixdogPhone) {
    if (mixdogViewport) {
      mixdogViewport.setAttribute(
        'content',
        'width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content',
      );
    }
    document.documentElement.dataset.mixdogMobileTabs = '';
    document.documentElement.style.setProperty('--mx-device-scale', '1');
    if (mixdogIos) document.documentElement.dataset.mixdogIosWeb = '';
  } else if (mixdogViewport) {
    mixdogViewport.setAttribute(
      'content',
      'width=1040, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content',
    );
    document.documentElement.dataset.mixdogProjection = 'desktop';
  }
}

// First-paint theme: resolve the stored preference before any CSS evaluates.
try {
  var mixdogThemePref = localStorage.getItem('mixdog.desktop-theme-preference');
  var mixdogLight = mixdogThemePref === 'white'
    || (mixdogThemePref !== 'dark'
      && mixdogThemePref !== 'gray'
      && window.matchMedia
      && window.matchMedia('(prefers-color-scheme: light)').matches);
  // A legacy stored 'gray' preference boots dark (Gray collapsed into Dark).
  if (mixdogLight) {
    document.documentElement.dataset.mixdogTheme = 'light';
    document.documentElement.style.colorScheme = 'light';
  }
} catch (error) { /* default dark */ }

// The installed web app has no equivalent of the desktop's hidden window:
// rendererReady is a no-op over the relay, so the browser painted every step of
// the launch in sequence — unstyled document, first React frame in fallback
// glyphs, then the restored layout landing on top (user: 웹앱 처음 들어갈 때
// 화면이 툭툭 튄다). Hold #root behind the window band until the renderer
// reports a settled first frame, and move the build's first-screen hints into
// the head so the stylesheet, React and the app bundle are fetched together
// instead of one relay round trip at a time (user: 늦게 생성되기도 하고).
// A browser TAB only ever renders the install guide, so it pays for neither.
var mixdogInstalledApp = false;
try {
  mixdogInstalledApp = mixdogPhone === true
    && Boolean((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || navigator.standalone === true);
} catch (error) { /* an unreadable display mode is treated as a browser tab */ }
if (mixdogInstalledApp) {
  var mixdogHintHost = document.getElementById('mixdog-first-screen');
  var mixdogHints = mixdogHintHost && mixdogHintHost.content
    ? mixdogHintHost.content.querySelectorAll('link')
    : [];
  // Resolve the same supported locale grammar as i18n.ts before its bundle
  // runs. Locale chunks stay inert in the template; only this phone's catalog
  // joins the first network fan-out.
  var mixdogUiLanguage = 'en';
  try {
    var mixdogStoredLanguage = localStorage.getItem('mixdog.desktop.ui-language.v1');
    var mixdogLanguageValue = mixdogStoredLanguage && mixdogStoredLanguage !== 'system'
      ? mixdogStoredLanguage
      : navigator.language;
    var mixdogLanguageLower = String(mixdogLanguageValue || 'en').toLowerCase();
    var mixdogLanguageBase = mixdogLanguageLower.split(/[-_]/)[0];
    var mixdogSimpleLanguages = ['de', 'es', 'fr', 'it', 'ja', 'ko', 'ru', 'vi'];
    if (mixdogLanguageBase === 'zh') {
      mixdogUiLanguage = /hant|tw|hk|mo/.test(mixdogLanguageLower) ? 'zh-TW' : 'zh-CN';
    } else if (mixdogLanguageBase === 'pt') {
      mixdogUiLanguage = 'pt-BR';
    } else if (mixdogSimpleLanguages.indexOf(mixdogLanguageBase) >= 0) {
      mixdogUiLanguage = mixdogLanguageBase;
    }
  } catch (error) { /* English needs no catalog and remains the safe fallback. */ }
  for (var mixdogHintIndex = 0; mixdogHintIndex < mixdogHints.length; mixdogHintIndex += 1) {
    var mixdogHint = mixdogHints[mixdogHintIndex];
    var mixdogHintLocale = mixdogHint.getAttribute('data-mixdog-locale');
    if (mixdogHintLocale && mixdogHintLocale !== mixdogUiLanguage) continue;
    var mixdogLink = document.createElement('link');
    mixdogLink.rel = mixdogHint.getAttribute('rel');
    if (mixdogHint.hasAttribute('crossorigin')) mixdogLink.crossOrigin = 'anonymous';
    if (mixdogHint.hasAttribute('fetchpriority')) {
      mixdogLink.setAttribute('fetchpriority', mixdogHint.getAttribute('fetchpriority'));
    }
    // Resolved against the DOCUMENT: a template's contents carry no base of
    // their own, and the bundle's module-preload helper skips a dependency only
    // when an existing link's href ATTRIBUTE equals the absolute URL it
    // resolved — a relative one here would load every chunk twice.
    mixdogLink.href = new URL(mixdogHint.getAttribute('href'), document.baseURI).href;
    document.head.appendChild(mixdogLink);
  }
  var mixdogGate = document.createElement('style');
  mixdogGate.id = 'mixdog-boot-gate';
  // --mx-window-band of each theme (desktop/01-tokens.css) — the gate paints
  // the color the settled app keeps, so releasing it never changes the backdrop.
  mixdogGate.textContent = 'html[data-mixdog-booting]{background:'
    + (mixdogLight ? '#f0f0f0' : '#151518') + '}'
    + 'html[data-mixdog-booting] #root{opacity:0}'
    + '#root{transition:opacity 160ms ease-out}';
  document.documentElement.dataset.mixdogBooting = '';
  document.head.appendChild(mixdogGate);
  var mixdogGateTimer = 0;
  window.mixdogRevealApp = function () {
    if (mixdogGateTimer) {
      clearTimeout(mixdogGateTimer);
      mixdogGateTimer = 0;
    }
    if (!document.documentElement.hasAttribute('data-mixdog-booting')) return;
    document.documentElement.removeAttribute('data-mixdog-booting');
    // Drop the gate once the fade has run: nothing below it needs a permanent
    // transition on #root.
    setTimeout(function () {
      if (mixdogGate.parentNode) mixdogGate.parentNode.removeChild(mixdogGate);
    }, 400);
  };
  // A bundle that never boots must not leave a blank band on screen.
  mixdogGateTimer = setTimeout(function () { window.mixdogRevealApp(); }, 8000);
}

// Surface bundle failures on remote browsers where devtools may be unavailable.
(function () {
  var errors = [];
  function overlay() {
    if (!document.body || document.getElementById('mixdog-boot-error')) return;
    var root = document.getElementById('root');
    if (root && root.childElementCount > 0) return;
    // A browser tab never mounts the app: remote-shim draws the install guide
    // (or the approval wait) beside #root, so an empty root there is the
    // expected state, not a bundle that failed. Painting the failure overlay
    // over that guide after the timer is what the user saw as "No error
    // captured" a few seconds after the guide appeared.
    if (document.getElementById('mixdog-remote-pairing')) return;
    // The boot gate hides #root, so a failure message must not sit behind a
    // reveal that will never arrive.
    if (window.mixdogRevealApp) window.mixdogRevealApp();
    var div = document.createElement('div');
    div.id = 'mixdog-boot-error';
    div.style.cssText = 'position:fixed;inset:0;z-index:99999;padding:24px;overflow:auto;'
      + 'background:#111114;color:#e9e9e9;font:400 13px/19px monospace;white-space:pre-wrap;';
    div.textContent = 'Mixdog failed to start.\n\n'
      + (errors.join('\n\n') || 'No error captured - the app bundle may not have loaded.');
    document.body.appendChild(div);
  }
  window.addEventListener('error', function (event) {
    var target = event.target;
    if (target && target !== window && (target.src || target.href)) {
      errors.push('failed to load: ' + (target.src || target.href));
      // The worker answers this document from its last copy, so a launch that
      // follows a deploy can name chunks that deploy removed. Drop the cached
      // shell and reload ONCE per missing chunk — the network copy names live
      // chunks. The record is keyed by the URL that failed, not by the tab:
      // Safari keeps a tab's sessionStorage for weeks, and a tab-wide flag
      // from one earlier recovery skipped every later deploy straight to this
      // overlay (user: qr로 연동하려고하니 저게뜸). A genuinely broken build
      // fails on the SAME url twice and still stops here.
      try {
        var failedUrl = String(target.src || target.href);
        if (sessionStorage.getItem('mixdog.shell-recovered') !== failedUrl && window.caches) {
          sessionStorage.setItem('mixdog.shell-recovered', failedUrl);
          caches.delete('mixdog-shell-v1').then(function () { location.reload(); });
          return;
        }
      } catch (recoveryError) { /* fall through to the overlay */ }
    } else {
      errors.push(String(event.message || event.type)
        + ' @ ' + String(event.filename || '') + ':' + String(event.lineno || 0));
    }
    setTimeout(overlay, 400);
  }, true);
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    errors.push('unhandledrejection: ' + String((reason && (reason.stack || reason.message)) || reason));
  });
  setTimeout(overlay, 7000);
})();
