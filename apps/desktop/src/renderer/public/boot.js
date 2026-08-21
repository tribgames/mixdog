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

// Surface bundle failures on remote browsers where devtools may be unavailable.
(function () {
  var errors = [];
  function overlay() {
    if (!document.body || document.getElementById('mixdog-boot-error')) return;
    var root = document.getElementById('root');
    if (root && root.childElementCount > 0) return;
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
