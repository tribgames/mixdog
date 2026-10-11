// `/connect`: the public browser entry for pairing v2. Self-contained (no app
// bundle, no data): the visitor types the 6-digit code shown on the PC,
// the relay resolves it to a device route plus a one-time ticket, and the
// browser continues at `/d/<deviceId>/#pair=<ticket>` where the web app asks
// the PC for permission. The page itself grants nothing. Same full-screen
// column as the phone app's picker and the web pairing layer.
const CONNECT_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'";

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="dark" />
<title>Mixdog</title>
<style>
html,body{margin:0;background:#0e0e0e}
.mxp-screen{position:fixed;inset:0;height:100vh;height:100dvh;max-height:100dvh;box-sizing:border-box;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr);justify-items:center;padding:env(safe-area-inset-top) env(safe-area-inset-right) calc(env(safe-area-inset-bottom) + var(--mxp-kb,0px)) env(safe-area-inset-left);background:#0e0e0e;color:#e9e9e9;font-family:system-ui,-apple-system,"Segoe UI","Noto Sans KR","Apple SD Gothic Neo","Malgun Gothic",sans-serif;font-size:15px;line-height:22px;font-weight:400}.mxp-screen *{box-sizing:border-box;margin:0}.mxp-screen [hidden]{display:none!important}.mxp-col{width:calc(100% - 40px);max-width:340px;height:100%;min-height:0;overflow:auto;padding:max(16px,calc(45vh - 190px)) 0 16px;padding-top:max(16px,calc(45dvh - 190px))}.mxp-main{text-align:center}.mxp-block{width:100%;display:flex;flex-direction:column;align-items:center}.mxp-vis{flex:none;width:48px;height:48px}.mxp-logo{display:block;width:48px;height:48px}.mxp-title{flex:none;width:100%;height:30px;margin-top:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:22px;line-height:30px;font-weight:700}.mxp-sub{flex:none;width:100%;height:45px;margin-top:8px;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;color:#a8a8a8;font-size:15px;line-height:22.5px;word-break:keep-all;overflow-wrap:normal;text-wrap:balance}.mxp-extra{flex:none;width:100%;height:80px;margin-top:24px;display:flex;flex-direction:column;align-items:center;gap:8px}.mxp-block.steps .mxp-extra{height:auto;gap:12px}.mxp-actions{width:100%;margin-top:24px;display:grid;gap:8px;align-content:start}.mxp-actions .mxp-fine{text-align:center}.mxp-btn{width:100%;min-height:48px;padding:0 16px;display:flex;align-items:center;justify-content:center;border:0;border-radius:12px;background:#e9e9e9;color:#111114;font-family:inherit;font-size:15px;line-height:20px;font-weight:700;cursor:pointer}.mxp-btn.sec{min-height:44px;background:transparent;color:#a8a8a8}.mxp-btn:disabled{opacity:.45;cursor:default}.mxp-otp{position:relative;flex:none;width:100%;height:52px;display:flex;justify-content:center;gap:8px}.mxp-digit{flex:1 1 0;min-width:0;max-width:44px;height:52px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,.2);border-radius:10px;font:700 22px/1 ui-monospace,Consolas,monospace}.mxp-digit:nth-child(3){margin-right:8px}.mxp-digit.on{border-color:#e9e9e9;box-shadow:0 0 0 1px #e9e9e9}.mxp-code{position:absolute;inset:0;width:100%;height:100%;padding:0;border:0;opacity:0;background:transparent;color:transparent;caret-color:transparent;font-size:16px}.mxp-error{min-height:20px;color:#ff8b8f;font-size:13px;line-height:20px}@media (max-width:599px){.mxp-code-step .mxp-col{display:flex;flex-direction:column;align-items:center;padding-top:max(24px,7dvh)}.mxp-code-step .mxp-main,.mxp-code-step .mxp-block{display:contents}.mxp-code-step .mxp-title{height:auto;min-height:30px;white-space:normal}.mxp-code-step .mxp-sub{height:auto;display:block;overflow:visible}.mxp-code-step .mxp-extra{height:auto;margin-top:auto;padding-top:24px}.mxp-code-step .mxp-actions{margin-top:16px}}.mxp-wait{display:flex;align-items:center;justify-content:center;gap:8px;color:#a8a8a8;font-size:14px;line-height:20px}.mxp-spinner{flex:none;width:16px;height:16px;border:2px solid rgba(255,255,255,.18);border-top-color:#a8a8a8;border-radius:50%;animation:mxp-spin 1.1s linear infinite}@keyframes mxp-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.mxp-spinner{animation:none;border:0;width:6px;height:6px;margin:5px;background:#a8a8a8}}.mxp-fine{color:#7a7a80;font-size:12px;line-height:17px}.mxp-step{width:100%;padding:10px 14px;border-radius:12px;background:rgba(255,255,255,.06);font-size:14px;line-height:20px;text-align:left}.mxp-step b{margin-right:10px;color:#8a8a92}
</style>
</head>
<body>
<div class="mxp-screen mxp-code-step">
<div class="mxp-col">
<main class="mxp-main">
<div class="mxp-block">
<div class="mxp-vis"><img class="mxp-logo" src="/mixdog-logo-titanium.svg" alt="" draggable="false" /></div><h1 class="mxp-title" id="heading"></h1><p class="mxp-sub" id="note"></p>
<div class="mxp-extra">
<div class="mxp-otp" id="otp"><span class="mxp-digit"></span><span class="mxp-digit"></span><span class="mxp-digit"></span><span class="mxp-digit"></span><span class="mxp-digit"></span><span class="mxp-digit"></span><input class="mxp-code" id="code" inputmode="numeric" autocomplete="one-time-code" aria-labelledby="heading" /></div>
<p class="mxp-error" id="status" role="alert"></p>
</div>
</div>
</main>
<footer class="mxp-actions"><button class="mxp-btn" id="go" type="button" disabled></button><p class="mxp-fine" id="fine"></p></footer>
</div>
</div>
<script>
(function () {
  var ko = (navigator.language || '').toLowerCase().indexOf('ko') === 0;
  var T = ko
    ? { heading: 'PC에 연결', note: 'PC의 Mixdog에서 설정 > 연결 > 웹으로 이동해 코드를 확인하세요.', go: '연결', busy: '연결 중…', fine: 'iPhone에서는 아직 알림을 받을 수 없습니다.', bad: '코드가 올바르지 않거나 만료되었습니다.', wait: function (s) { return '시도가 너무 많습니다. ' + s + '초 뒤에 다시 시도하세요.'; }, net: '연결하지 못했습니다. 인터넷 연결을 확인하세요.' }
    : { heading: 'Connect to PC', note: 'On your PC, go to Mixdog Settings > Connection > Web to get the code.', go: 'Connect', busy: 'Connecting…', fine: 'Notifications aren’t available on iPhone yet.', bad: 'The code is wrong or has expired.', wait: function (s) { return 'Too many attempts. Try again in ' + s + ' seconds.'; }, net: 'Could not connect. Check your internet connection.' };
  document.documentElement.lang = ko ? 'ko' : 'en';
  var $ = function (id) { return document.getElementById(id); };
  $('heading').textContent = T.heading;
  $('note').textContent = T.note;
  $('go').textContent = T.go;
  var ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
  $('fine').textContent = ios ? T.fine : '';
  var input = $('code');
  var digits = function () { return input.value.replace(/\\D/g, '').slice(0, 6); };
  var boxes = document.querySelectorAll('#otp .mxp-digit');
  var last = 0;
  var submit = null;
  var paint = function () {
    var d = digits();
    for (var i = 0; i < 6; i++) {
      boxes[i].textContent = d.charAt(i);
      boxes[i].className = 'mxp-digit' + (document.activeElement === input && i === Math.min(d.length, 5) ? ' on' : '');
    }
  };
  input.addEventListener('input', function () {
    var d = digits();
    input.value = d;
    paint();
    $('go').disabled = d.length !== 6;
    var filled = d.length === 6 && last < 6;
    last = d.length;
    if (filled && submit) submit();
  });
  input.addEventListener('focus', paint);
  input.addEventListener('blur', paint);
  var say = function (text) { $('status').textContent = text; };
  // Screenshot switch: ?mxPairingPreview=<state> renders a state with no
  // network, only when localStorage mixdog.debug.pairingPreview is "1".
  var preview = null;
  try {
    if (localStorage.getItem('mixdog.debug.pairingPreview') === '1') {
      preview = new URLSearchParams(location.search).get('mxPairingPreview');
    }
  } catch (e) { /* storage unavailable */ }
  if (preview === 'code-error') say(T.bad);
  else if (preview === 'code-ratelimited') say(T.wait(42));
  else if (preview === 'network-error') say(T.net);
  if (preview) return;
  // One redemption at a time: auto-submit, Enter and the button share this flag.
  var busy = false;
  var settle = function () {
    busy = false;
    input.disabled = false;
    $('go').textContent = T.go;
    $('go').disabled = digits().length !== 6;
    input.focus();
    paint();
  };
  submit = function () {
    var d = digits();
    if (d.length !== 6 || busy) return;
    busy = true;
    input.disabled = true;
    $('go').disabled = true;
    $('go').textContent = T.busy;
    say('');
    var abort = new AbortController();
    var timer = setTimeout(function () { abort.abort(); }, 10000);
    fetch('/pair-code/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: d }), signal: abort.signal })
      .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
      .then(function (r) {
        if (r.status === 200 && r.body.deviceId && r.body.ticket) {
          location.href = '/d/' + encodeURIComponent(r.body.deviceId) + '/#pair=' + encodeURIComponent(r.body.ticket) + (r.body.name ? '&host=' + encodeURIComponent(r.body.name) : '');
          return;
        }
        say(r.status === 429 ? T.wait(r.body.retryAfter || 60) : T.bad);
        settle();
      })
      .catch(function () { say(T.net); settle(); })
      .then(function () { clearTimeout(timer); });
  };
  $('go').addEventListener('click', submit);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  input.focus();
  paint();
  var vv = window.visualViewport;
  if (vv) {
    var inset = function () { document.querySelector('.mxp-screen').style.setProperty('--mxp-kb', Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) + 'px'); };
    vv.addEventListener('resize', inset);
    vv.addEventListener('scroll', inset);
    inset();
  }
})();
</script>
</body>
</html>`;

export function sendConnectPage(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end();
    return;
  }
  response
    .writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CONNECT_PAGE_CSP,
      'X-Content-Type-Options': 'nosniff',
    })
    .end(request.method === 'HEAD' ? undefined : PAGE);
}
