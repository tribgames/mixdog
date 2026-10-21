// The language helpers and the small recovery catalog are prepended by i18n:sync.
// Resolve outside the installed-app branch: browser tabs and Electron need the
// same preference when the main application bundle cannot boot.
var mixdogStoredLanguage;
try {
  mixdogStoredLanguage = localStorage.getItem(UI_LANGUAGE_STORAGE_KEY);
} catch (error) {}
var mixdogUiLanguage = selectUiLanguage(
  mixdogStoredLanguage,
  navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]
);
document.documentElement.lang = mixdogUiLanguage;
function bootT(key) {
  return (BOOT_UI_CATALOGS[mixdogUiLanguage] || {})[key] || key;
}

// Every browser lays out at device-width in native CSS pixels: phones, tablets
// and PC browsers alike (a fixed desktop width cannot shrink onto a portrait
// tablet). The phone LAYOUT marker comes from the classifier mobile-surface.ts
// also uses (shared/surface-class.ts, prepended above), so the first paint
// already has the layout the mounted app keeps.
var mixdogSurface = null;
if (!/Electron/i.test(navigator.userAgent)) {
  mixdogSurface = readSurfaceProbe(navigator, window);
  var mixdogViewport = document.querySelector('meta[name="viewport"]');
  if (mixdogViewport) {
    mixdogViewport.setAttribute(
      'content',
      'width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content'
    );
  }
  var mixdogLayoutWidth = Number(window.innerWidth) || Number(document.documentElement.clientWidth) || 0;
  if (usesPhoneLayout(mixdogSurface, mixdogLayoutWidth)) {
    document.documentElement.dataset.mixdogMobileTabs = '';
    if (isIosDevice(mixdogSurface)) document.documentElement.dataset.mixdogIosWeb = '';
  }
}

// First-paint theme: resolve the stored preference before any CSS evaluates.
// Pin the dark default before reading storage: the document also accepts light,
// so Android can otherwise show light system chrome until the app mounts.
document.documentElement.style.colorScheme = 'dark';
try {
  var mixdogThemePref = localStorage.getItem('mixdog.desktop-theme-preference');
  var mixdogLight =
    mixdogThemePref === 'white' ||
    (mixdogThemePref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  // Match App's default: only an explicit System choice follows the OS.
  // Fresh profiles and the retired Gray preference both start dark.
  if (mixdogLight) {
    document.documentElement.dataset.mixdogTheme = 'light';
    document.documentElement.style.colorScheme = 'light';
  }
} catch (error) {
  /* default dark */
}

// First-paint skin and user theme. The bundle paints both only after it has
// run, so the first frame was the default theme (and a skin's picture arrived
// before its plates). skin-boot-snapshot.ts records what the bundle set on
// <html> (attributes, --mx-skin-* values, the user theme's style sheet text);
// replaying it here, before anything paints, makes the bundle's later paint a
// no-op. mixdogBootSig (this build's chunk list) and mixdogThemeInputs (what the
// appearance above is resolved from) tell a record made for another build or
// another appearance apart: such a record is ignored, never half-applied.
var mixdogBootSig = '';
try {
  var mixdogSigHost = document.getElementById('mixdog-first-screen');
  var mixdogSigLinks =
    mixdogSigHost && mixdogSigHost.content ? mixdogSigHost.content.querySelectorAll('link[rel="modulepreload"]') : [];
  var mixdogSigHash = 0;
  for (var mixdogSigIndex = 0; mixdogSigIndex < mixdogSigLinks.length; mixdogSigIndex += 1) {
    var mixdogSigHref = mixdogSigLinks[mixdogSigIndex].getAttribute('href') || '';
    for (var mixdogSigChar = 0; mixdogSigChar < mixdogSigHref.length; mixdogSigChar += 1) {
      mixdogSigHash = (mixdogSigHash * 31 + mixdogSigHref.charCodeAt(mixdogSigChar)) | 0;
    }
  }
  if (mixdogSigLinks.length) mixdogBootSig = String(mixdogSigHash);
} catch (error) {
  /* an unreadable hint list is a build nothing is recorded for */
}
window.mixdogBootSig = mixdogBootSig;
window.mixdogThemeInputs = function () {
  var preference = '';
  var userTheme = '';
  var systemLight = false;
  try {
    preference = localStorage.getItem('mixdog.desktop-theme-preference') || '';
    userTheme = localStorage.getItem('mixdog.desktop.user-theme.v1') || '';
    systemLight = Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  } catch (error) {
    /* unreadable storage resolves like a fresh profile */
  }
  return preference + '|' + (systemLight ? '1' : '0') + '|' + userTheme;
};
var mixdogSkinned = false;
var mixdogUserThemed = false;
try {
  var mixdogBootRaw = localStorage.getItem('mixdog.desktop.skin-boot.v1');
  var mixdogBoot = mixdogBootRaw ? JSON.parse(mixdogBootRaw) : null;
  var mixdogBootSkin = mixdogBoot && mixdogBoot.skin;
  var mixdogBootTheme = mixdogBoot && mixdogBoot.userTheme;
  var mixdogBootPicture = '';
  var mixdogBootValid =
    Boolean(mixdogBoot) &&
    mixdogBoot.v === 1 &&
    mixdogBoot.sig === mixdogBootSig &&
    mixdogBoot.inputs === window.mixdogThemeInputs() &&
    Boolean(mixdogBootSkin || mixdogBootTheme);
  if (mixdogBootValid && mixdogBootSkin) {
    var mixdogBootAttributes = mixdogBootSkin.attributes;
    var mixdogBootVars = mixdogBootSkin.vars;
    var mixdogBootImage = mixdogBootSkin.image;
    mixdogBootValid =
      Boolean(mixdogBootAttributes) &&
      typeof mixdogBootAttributes['data-mixdog-skin'] === 'string' &&
      Boolean(mixdogBootVars) &&
      Object.keys(mixdogBootAttributes).every(function (name) {
        return /^data-mixdog-skin(-plate|-photo)?$/.test(name) && typeof mixdogBootAttributes[name] === 'string';
      }) &&
      Object.keys(mixdogBootVars).every(function (name) {
        return /^--mx-skin-[a-z0-9-]+$/.test(name) && typeof mixdogBootVars[name] === 'string';
      });
    if (mixdogBootValid && mixdogBootImage) {
      if (typeof mixdogBootImage.url === 'string') {
        mixdogBootValid = /^url\("[^"\\]*"\)$/.test(mixdogBootImage.url);
        mixdogBootPicture = mixdogBootImage.url;
      } else {
        // A custom picture stays under its own key (a data URL too large to copy).
        var mixdogBootCustom =
          mixdogBootImage.custom === 'mixdog.desktop.skin-custom-image.v1'
            ? localStorage.getItem(mixdogBootImage.custom)
            : null;
        mixdogBootValid = Boolean(mixdogBootCustom);
        mixdogBootPicture = 'url("' + mixdogBootCustom + '")';
      }
    }
  }
  if (mixdogBootValid && mixdogBootTheme) {
    mixdogBootValid =
      typeof mixdogBootTheme.id === 'string' && typeof mixdogBootTheme.css === 'string' && mixdogBootTheme.id !== '';
  }
  if (mixdogBootValid) {
    var mixdogBootRoot = document.documentElement;
    // The appearance the recorded values were computed for (a single-appearance
    // user theme can differ from the stored preference).
    if (mixdogBoot.themeId === 'basic' || mixdogBoot.themeId === 'light') {
      mixdogLight = mixdogBoot.themeId === 'light';
      mixdogBootRoot.dataset.mixdogTheme = mixdogBoot.themeId;
      mixdogBootRoot.style.colorScheme = mixdogLight ? 'light' : 'dark';
    }
    if (mixdogBootSkin) {
      for (var mixdogBootName in mixdogBootAttributes) {
        mixdogBootRoot.setAttribute(mixdogBootName, mixdogBootAttributes[mixdogBootName]);
      }
      for (var mixdogBootVar in mixdogBootVars) {
        mixdogBootRoot.style.setProperty(mixdogBootVar, mixdogBootVars[mixdogBootVar]);
      }
      if (mixdogBootPicture) {
        mixdogBootRoot.style.setProperty('--mx-skin-image', mixdogBootPicture);
        // Fetch and decode the picture now, not when the bundle's CSS first asks for it.
        var mixdogPictureImage = new Image();
        mixdogPictureImage.src = mixdogBootPicture.slice(5, -2);
        if (mixdogPictureImage.decode) mixdogPictureImage.decode().catch(function () {});
        window.mixdogBootPictureImage = mixdogPictureImage;
      }
      // The picture needs its plates in the SAME frame: until the app mounts
      // (#root is empty) the frame and veil plates are drawn over it here. The
      // boot cover (19-studio.css) wears the identical wash once it exists.
      var mixdogWashSheet = document.createElement('style');
      mixdogWashSheet.id = 'mixdog-boot-skin';
      mixdogWashSheet.textContent =
        'html[data-mixdog-skin] body::after{content:"";position:fixed;z-index:-1;inset:0;pointer-events:none;opacity:0;' +
        'background:linear-gradient(var(--mx-skin-veil),var(--mx-skin-veil)),var(--mx-skin-frame)}' +
        'html[data-mixdog-skin] body:has(> #root:empty)::after{opacity:1}';
      document.head.appendChild(mixdogWashSheet);
      mixdogSkinned = true;
    }
    if (mixdogBootTheme) {
      mixdogBootRoot.dataset.mixdogUserTheme = mixdogBootTheme.id;
      var mixdogThemeSheet = document.createElement('style');
      mixdogThemeSheet.id = 'mixdog-user-theme';
      mixdogThemeSheet.textContent = mixdogBootTheme.css;
      document.head.appendChild(mixdogThemeSheet);
      mixdogUserThemed = true;
    }
  }
} catch (error) {
  /* a corrupt record paints nothing here; the bundle paints the skin later */
}

// Desktop-only hints (the Seti file-icon font) are kept out of the parsed head
// so a phone never fetches them ahead of its relay transport; Electron
// promotes them here, at the point in the parse where the markup used to.
if (/Electron/i.test(navigator.userAgent)) {
  var mixdogDesktopHintHost = document.getElementById('mixdog-first-screen');
  var mixdogDesktopHints =
    mixdogDesktopHintHost && mixdogDesktopHintHost.content
      ? mixdogDesktopHintHost.content.querySelectorAll('link[data-mixdog-surface="desktop"]')
      : [];
  for (var mixdogDesktopIndex = 0; mixdogDesktopIndex < mixdogDesktopHints.length; mixdogDesktopIndex += 1) {
    document.head.appendChild(document.importNode(mixdogDesktopHints[mixdogDesktopIndex], true));
  }
}

// The installed web app has no equivalent of the desktop's hidden window:
// rendererReady is a no-op over the relay, so the browser painted every step of
// the launch in sequence — unstyled document, first React frame in fallback
// glyphs, then the restored layout landing on top (user: 웹앱 처음 들어갈 때
// 화면이 툭툭 튄다). Hold #root behind the window band until the renderer
// reports a settled first frame, and move the build's first-screen hints into
// the head so the stylesheet, React and the app bundle are fetched together
// instead of one relay round trip at a time (user: 늦게 생성되기도 하고).
// A browser tab that connected directly (mark set by mobile-surface.ts) runs
// the same app, so it gets the same gate; a tab that only shows the old-host
// install guide pays for neither.
var mixdogInstalledApp = false;
try {
  mixdogInstalledApp =
    mixdogSurface !== null &&
    isTouchDevice(mixdogSurface) &&
    Boolean(
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true
    );
} catch (error) {
  /* an unreadable display mode is treated as a browser tab */
}
try {
  if (!mixdogInstalledApp) mixdogInstalledApp = localStorage.getItem('mixdog.directBrowser') === '1';
} catch (error) {
  /* storage this origin cannot read holds no direct-connect mark */
}
if (mixdogInstalledApp) {
  var mixdogHintHost = document.getElementById('mixdog-first-screen');
  var mixdogHints = mixdogHintHost && mixdogHintHost.content ? mixdogHintHost.content.querySelectorAll('link') : [];
  // Locale chunks stay inert in the template; only this device's catalog
  // joins the first network fan-out.
  for (var mixdogHintIndex = 0; mixdogHintIndex < mixdogHints.length; mixdogHintIndex += 1) {
    var mixdogHint = mixdogHints[mixdogHintIndex];
    var mixdogHintLocale = mixdogHint.getAttribute('data-mixdog-locale');
    if (mixdogHintLocale && mixdogHintLocale !== mixdogUiLanguage) continue;
    if (mixdogHint.hasAttribute('data-mixdog-surface')) continue;
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
  // A recorded skin or user theme already painted above: the gate then holds
  // the window in THEIR colours (the skin's picture under its frame and veil
  // plates, never bare; the user theme's band), not the built-in ones.
  var mixdogGateBand = mixdogLight ? '#f7f7f7' : '#181818';
  mixdogGate.textContent =
    'html[data-mixdog-booting]{background:' +
    (mixdogSkinned
      ? 'var(--mx-skin-tint,' + mixdogGateBand + ')'
      : mixdogUserThemed
        ? 'var(--mx-window-band,' + mixdogGateBand + ')'
        : mixdogGateBand) +
    '}' +
    (mixdogSkinned
      ? // The boot wash (above) stays through the gate and fades out with the
        // reveal, in step with #root fading in.
        'html[data-mixdog-skin] body::after{transition:opacity 160ms ease-out}' +
        'html[data-mixdog-booting][data-mixdog-skin] body::after{opacity:1}'
      : '') +
    'html[data-mixdog-booting] #root{opacity:0}' +
    '#root{transition:opacity 160ms ease-out}';
  document.documentElement.dataset.mixdogBooting = '';
  document.head.appendChild(mixdogGate);
  var mixdogGateTimer = 0;
  window.mixdogRevealApp = () => {
    if (mixdogGateTimer) {
      clearTimeout(mixdogGateTimer);
      mixdogGateTimer = 0;
    }
    if (!document.documentElement.hasAttribute('data-mixdog-booting')) return;
    document.documentElement.removeAttribute('data-mixdog-booting');
    // Drop the gate once the fade has run: nothing below it needs a permanent
    // transition on #root.
    setTimeout(() => {
      if (mixdogGate.parentNode) mixdogGate.parentNode.removeChild(mixdogGate);
    }, 400);
  };
  // A bundle that never boots must not leave a blank band on screen.
  mixdogGateTimer = setTimeout(() => {
    window.mixdogRevealApp();
  }, 30000);
}

// Surface bundle failures on remote browsers where devtools may be unavailable.
(() => {
  var errors = [];
  var settled = false;
  var deadlineReached = false;
  var previousFocus = null;
  function clearOverlay() {
    var layer = document.getElementById('mixdog-boot-error');
    if (layer) {
      var restoreFocus = layer.contains(document.activeElement);
      layer.remove();
      if (restoreFocus && previousFocus && previousFocus.isConnected) previousFocus.focus();
    }
  }
  function hasStarted() {
    var root = document.getElementById('root');
    return Boolean(root && root.childElementCount > 0);
  }
  var observer = new MutationObserver(() => {
    if (hasStarted()) {
      settled = true;
      clearOverlay();
      observer.disconnect();
    } else if (document.getElementById('mixdog-remote-pairing')) {
      clearOverlay();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  function overlay() {
    if (!deadlineReached || !document.body || settled || hasStarted()) return;
    // A browser tab never mounts the app: remote-shim draws the install guide
    // (or the approval wait) beside #root, so an empty root there is the
    // expected state, not a bundle that failed. Painting the failure overlay
    // over that guide after the timer is what the user saw as "No error
    // captured" a few seconds after the guide appeared.
    if (document.getElementById('mixdog-remote-pairing')) {
      clearOverlay();
      return;
    }
    // The boot gate hides #root, so a failure message must not sit behind a
    // reveal that will never arrive.
    if (window.mixdogRevealApp) window.mixdogRevealApp();
    var div = document.getElementById('mixdog-boot-error');
    if (!div) {
      div = document.createElement('div');
      div.id = 'mixdog-boot-error';
      div.style.cssText =
        'position:fixed;inset:0;z-index:99999;padding:24px;overflow:auto;' +
        'display:grid;place-items:center;background:rgba(0,0,0,.45);' +
        'color:#e9e9e9;font:400 14px/22px system-ui,sans-serif;';
      var card = document.createElement('div');
      card.setAttribute('role', 'alertdialog');
      card.setAttribute('aria-modal', 'true');
      card.setAttribute('aria-labelledby', 'mixdog-boot-title');
      card.setAttribute('aria-describedby', 'mixdog-boot-description');
      card.style.cssText =
        'box-sizing:border-box;width:100%;max-width:400px;' +
        'padding:24px;border:1px solid #444;border-radius:16px;background:#202024;';
      var title = document.createElement('h2');
      title.id = 'mixdog-boot-title';
      title.style.cssText = 'margin:0 0 12px;font-size:18px;';
      title.textContent = bootT('Connection is taking longer than expected');
      var description = document.createElement('p');
      description.id = 'mixdog-boot-description';
      description.textContent = bootT('The app could not start within 30 seconds. You can keep waiting or try again.');
      var details = document.createElement('details');
      details.hidden = true;
      var summary = document.createElement('summary');
      summary.textContent = bootT('Error details');
      var errorText = document.createElement('pre');
      errorText.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;';
      details.appendChild(summary);
      details.appendChild(errorText);
      var retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = bootT('Try again');
      retry.style.cssText =
        'width:100%;margin-top:16px;padding:12px;border:0;border-radius:8px;' +
        'background:#e9e9e9;color:#171719;font:inherit;cursor:pointer;';
      retry.addEventListener('click', () => {
        window.location.reload();
      });
      card.appendChild(title);
      card.appendChild(description);
      card.appendChild(details);
      card.appendChild(retry);
      // Keep keyboard focus inside the modal while recovery remains pending.
      card.addEventListener('keydown', (event) => {
        if (event.key !== 'Tab') return;
        if (details.hidden) {
          event.preventDefault();
          retry.focus();
        } else if (event.shiftKey && document.activeElement === summary) {
          event.preventDefault();
          retry.focus();
        } else if (!event.shiftKey && document.activeElement === retry) {
          event.preventDefault();
          summary.focus();
        }
      });
      div.appendChild(card);
      previousFocus = document.activeElement;
      document.body.appendChild(div);
      retry.focus();
    }
    var detailPanel = div.querySelector('details');
    detailPanel.hidden = errors.length === 0;
    div.querySelector('pre').textContent = errors.join('\n\n');
  }
  window.addEventListener(
    'error',
    (event) => {
      var target = event.target;
      // Only a shell chunk (script or stylesheet) failing says the boot broke.
      // A media thumbnail that cannot load (Studio's mixdog-media assets) is
      // the page's own business: counting each one as a "missing chunk"
      // reloaded the window once per image, forever (user: 무한으로 깜빡).
      if (target && target !== window && target.tagName !== 'SCRIPT' && target.tagName !== 'LINK') return;
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
            caches.delete('mixdog-shell-v1').then(() => {
              location.reload();
            });
            return;
          }
        } catch (recoveryError) {
          /* fall through to the overlay */
        }
      } else {
        errors.push(
          String(event.message || event.type) + ' @ ' + String(event.filename || '') + ':' + String(event.lineno || 0)
        );
      }
      setTimeout(overlay, 400);
    },
    true
  );
  window.addEventListener('unhandledrejection', (event) => {
    var reason = event.reason;
    errors.push('unhandledrejection: ' + String((reason && (reason.stack || reason.message)) || reason));
    setTimeout(overlay, 400);
  });
  setTimeout(() => {
    deadlineReached = true;
    overlay();
  }, 30000);
})();
