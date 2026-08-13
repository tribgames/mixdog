// First-paint theme: resolve the stored preference before any CSS evaluates.
try {
  var mixdogThemePref = localStorage.getItem('mixdog.desktop-theme-preference');
  var mixdogLight = mixdogThemePref === 'white'
    || (mixdogThemePref !== 'dark'
      && window.matchMedia
      && window.matchMedia('(prefers-color-scheme: light)').matches);
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
      + 'background:#151518;color:#e9e9e9;font:400 13px/19px monospace;white-space:pre-wrap;';
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
