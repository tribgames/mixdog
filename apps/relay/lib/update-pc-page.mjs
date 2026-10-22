// "Update your PC": answered instead of the legacy renderer to the Mixdog phone
// app (user agent `MixdogApp/`). The legacy renderer predates the app, so it
// would show a dead install guide and never ask the PC for approval. Static
// and self-contained like /connect and /app; it grants nothing. Browsers and
// home-screen web apps never get it: very old PCs only work through legacy.
import { LOGO_SRC, PAGE_BASE_CSS, PAIRING_CSS } from './connect-page.mjs';

// Keep in sync with NATIVE_APP_USER_AGENT_TOKEN (apps/desktop/src/shared/native-app.ts).
const NATIVE_APP_USER_AGENT_TOKEN = 'MixdogApp/';

const UPDATE_PC_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export const isNativeAppRequest = (request) =>
  String(request.headers['user-agent'] || '').includes(NATIVE_APP_USER_AGENT_TOKEN);

/** `current` is the PC's reported app version ('' = never reported); `min` the
 *  oldest version the relay still has a renderer for. */
export const renderUpdatePcPage = ({ current = '', min = '' } = {}) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="dark" />
<title>Mixdog</title>
<style>
${PAGE_BASE_CSS}
${PAIRING_CSS}
</style>
</head>
<body>
<div class="mxp-screen mxp-code-step">
<div class="mxp-col">
<main class="mxp-main">
<div class="mxp-block">
<div class="mxp-vis"><img class="mxp-logo" src="${LOGO_SRC}" alt="" draggable="false" /></div><h1 class="mxp-title" id="heading">Update Mixdog on your PC</h1><p class="mxp-sub" id="note">Mixdog on your PC is out of date. Update it to the latest version on your PC.</p>
</div>
</main>
<footer class="mxp-actions">
<button class="mxp-btn" id="retry" type="button">Try again</button>
<button class="mxp-btn sec" id="pick" type="button" hidden>Choose another PC</button>
<p class="mxp-fine" id="fine" data-current="${escapeHtml(current)}" data-min="${escapeHtml(min)}"></p>
</footer>
</div>
</div>
<script>
(function () {
  var ko = (navigator.language || '').toLowerCase().indexOf('ko') === 0;
  var T = ko
    ? { title: 'PC 업데이트 필요', note: 'PC의 Mixdog이 오래된 버전입니다. PC에서 최신 버전으로 업데이트하세요.', retry: '다시 시도', pick: '다른 PC 선택', pc: 'PC 버전 ', unknown: 'PC 버전 알 수 없음', min: ' 이상이 필요합니다' }
    : { title: 'Update Mixdog on your PC', note: 'Mixdog on your PC is out of date. Update it to the latest version on your PC.', retry: 'Try again', pick: 'Choose another PC', pc: 'PC version ', unknown: 'PC version unknown', min: ' or later required' };
  document.documentElement.lang = ko ? 'ko' : 'en';
  var $ = function (id) { return document.getElementById(id); };
  $('heading').textContent = T.title;
  $('note').textContent = T.note;
  $('retry').textContent = T.retry;
  $('pick').textContent = T.pick;
  var fine = $('fine');
  var current = fine.getAttribute('data-current');
  var min = fine.getAttribute('data-min');
  fine.textContent = (current ? T.pc + current : T.unknown) + (min ? ' · ' + min + T.min : '');
  $('retry').addEventListener('click', function () { location.reload(); });
  var native = window.mixdogNative;
  var host = window.MixdogNativeHost;
  var openPicker = null;
  if (native && typeof native.call === 'function') {
    openPicker = function () { return native.call('openHostPicker'); };
  } else if (host && typeof host.postMessage === 'function') {
    openPicker = function () { host.postMessage(JSON.stringify({ id: 1, method: 'openHostPicker', args: {} })); };
  }
  if (openPicker) {
    $('pick').hidden = false;
    $('pick').addEventListener('click', function () {
      try { Promise.resolve(openPicker()).catch(function () {}); } catch (e) { /* bridge refused */ }
    });
  }
})();
</script>
</body>
</html>`;

export function sendUpdatePcPage(request, response, details) {
  response
    .writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': UPDATE_PC_PAGE_CSP,
      'X-Content-Type-Options': 'nosniff',
    })
    .end(request.method === 'HEAD' ? undefined : renderUpdatePcPage(details));
}
