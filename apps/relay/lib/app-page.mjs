// `/app?d=<deviceId>`: the target of the desktop's Phone pairing QR. It tries
// to open the Mixdog app at `mixdog://pair?link=<this relay>/d/<deviceId>/`
// (the app's linkFromAppUrl/connectFrom handle it); if the page is still
// visible shortly after, the app is missing and the visitor is sent to the
// installers. The page grants nothing and links to no web client: access is
// still approved on the PC.
import { isRoutingId } from './ids.mjs';

const APP_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'";

const TESTFLIGHT_URL = 'https://testflight.apple.com/join/UNPBM2hU';
const ANDROID_URL = 'https://github.com/tribgames/mixdog/releases/tag/mobile-v0.1.11';

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="dark" />
<title>Mixdog</title>
<style>
html,body{margin:0;background:#0e0e0e}
body{min-height:100vh;min-height:100dvh;display:flex;justify-content:center;align-items:center;padding:env(safe-area-inset-top) 20px env(safe-area-inset-bottom);box-sizing:border-box;color:#e9e9e9;font-family:system-ui,-apple-system,"Segoe UI","Noto Sans KR","Apple SD Gothic Neo","Malgun Gothic",sans-serif;font-size:15px;line-height:22px}
main{width:100%;max-width:340px;text-align:center}
[hidden]{display:none!important}
img{width:48px;height:48px;display:block;margin:0 auto}
h1{margin:20px 0 8px;font-size:22px;line-height:30px;font-weight:700}
p{margin:0;color:#a8a8a8}
.opts{display:flex;flex-direction:column;gap:18px;margin-top:24px}
.opt{display:flex;flex-direction:column;gap:6px}
.btn{display:block;width:100%;box-sizing:border-box;padding:12px 16px;border:0;border-radius:12px;background:#e9e9e9;color:#0e0e0e;font:inherit;font-weight:600;text-align:center;text-decoration:none;cursor:pointer}
.btn.alt{background:rgba(255,255,255,.1);color:#e9e9e9}
.fine{font-size:12px;line-height:17px;color:#7a7a80}
#open{margin-top:24px}
</style>
</head>
<body>
<main>
<img src="/mixdog-logo-titanium.svg" alt="" draggable="false" />
<h1 id="heading">Mixdog</h1>
<p id="note"></p>
<section id="install" hidden>
<div class="opts" id="opts">
<div class="opt" id="ios"><a class="btn" id="iosBtn" href="${TESTFLIGHT_URL}" rel="noopener">iPhone</a><p class="fine" id="iosNote"></p></div>
<div class="opt" id="android"><a class="btn" id="androidBtn" href="${ANDROID_URL}" rel="noopener">Android</a><p class="fine" id="androidNote"></p></div>
</div>
<button class="btn alt" id="open" type="button"></button>
</section>
</main>
<script>
(function () {
  var ko = (navigator.language || '').toLowerCase().indexOf('ko') === 0;
  var T = ko
    ? { opening: 'Mixdog 앱을 여는 중…', title: 'Mixdog 앱이 필요합니다', ios: 'iPhone용 받기', iosNote: 'TestFlight(Apple 공식 베타 앱)를 통해 설치됩니다.', android: 'Android용 받기', androidNote: '설치할 때 ‘출처를 알 수 없는 앱’ 허용이 필요할 수 있습니다.', open: 'Mixdog 열기' }
    : { opening: 'Opening the Mixdog app…', title: 'Mixdog app required', ios: 'Get it for iPhone', iosNote: 'Installs through TestFlight (Apple’s official beta app).', android: 'Get it for Android', androidNote: 'You may need to allow installs from unknown sources.', open: 'Open Mixdog' };
  document.documentElement.lang = ko ? 'ko' : 'en';
  var $ = function (id) { return document.getElementById(id); };
  $('note').textContent = T.opening;
  $('iosBtn').textContent = T.ios;
  $('iosNote').textContent = T.iosNote;
  $('androidBtn').textContent = T.android;
  $('androidNote').textContent = T.androidNote;
  $('open').textContent = T.open;
  var ua = navigator.userAgent;
  var ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
  var android = /Android/i.test(ua);
  if (ios) $('android').hidden = true;
  else if (android) { $('ios').hidden = true; }
  var id = new URLSearchParams(location.search).get('d') || '';
  var link = 'mixdog://pair?link=' + encodeURIComponent(location.origin + '/d/' + encodeURIComponent(id) + '/');
  var left = false;
  var gone = function () { left = true; };
  document.addEventListener('visibilitychange', function () { if (document.hidden) gone(); });
  window.addEventListener('pagehide', gone);
  var timer = null;
  var attempt = function () {
    left = false;
    clearTimeout(timer);
    location.href = link;
    timer = setTimeout(function () {
      if (left || document.hidden) return;
      $('heading').textContent = T.title;
      $('note').hidden = true;
      $('install').hidden = false;
    }, 1500);
  };
  $('open').addEventListener('click', attempt);
  attempt();
})();
</script>
</body>
</html>`;

export function sendAppPage(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end();
    return;
  }
  const id = new URL(request.url || '', 'http://relay.invalid').searchParams.getAll('d');
  if (id.length !== 1 || !isRoutingId(id[0])) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('Bad request');
    return;
  }
  response
    .writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': APP_PAGE_CSP,
      'X-Content-Type-Options': 'nosniff',
    })
    .end(request.method === 'HEAD' ? undefined : PAGE);
}
