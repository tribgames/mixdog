// `/app`: the target of the desktop's Phone QR. A static install page: the
// store/APK button for the visitor's platform and a line on how to pair. It
// takes no parameters and grants nothing; pairing is the 6-digit code typed in
// the app, approved on the PC. No link to any web client.
import { readFileSync } from 'node:fs';

const APP_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'";

const TESTFLIGHT_URL = 'https://testflight.apple.com/join/UNPBM2hU';
// Written beside server.mjs by deploy/deploy-release.sh: the newest Android
// release Deploy verified as published with a downloadable APK.
const MOBILE_RELEASE_CONFIG = new URL('../mobile-release.json', import.meta.url);
// Without a deployed link (local runs, or a release that recorded none) the
// releases list still reaches every published APK.
export const ANDROID_FALLBACK_URL = 'https://github.com/tribgames/mixdog/releases';
const ANDROID_URL_RE =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases(?:\/tag\/mobile-v\d+\.\d+\.\d+)?$/;

export function readAndroidUrl(file = MOBILE_RELEASE_CONFIG) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn(`[relay] cannot read ${file}: ${error.message}`);
    return ANDROID_FALLBACK_URL;
  }
  try {
    const { androidUrl } = JSON.parse(text);
    if (typeof androidUrl === 'string' && ANDROID_URL_RE.test(androidUrl)) return androidUrl;
  } catch {
    /* reported below */
  }
  console.warn(`[relay] ignoring malformed ${file}; /app links the releases list`);
  return ANDROID_FALLBACK_URL;
}

export const renderAppPage = (androidUrl) => `<!doctype html>
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
.opts{display:flex;flex-direction:column;gap:18px;margin:24px 0}
.opt{display:flex;flex-direction:column;gap:6px}
.btn{display:block;width:100%;box-sizing:border-box;padding:12px 16px;border-radius:12px;background:#e9e9e9;color:#0e0e0e;font-weight:600;text-align:center;text-decoration:none}
.fine{font-size:12px;line-height:17px;color:#7a7a80}
</style>
</head>
<body>
<main>
<img src="/mixdog-logo-titanium.svg" alt="" draggable="false" />
<h1 id="heading">Install Mixdog</h1>
<div class="opts">
<div class="opt" id="ios"><a class="btn" id="iosBtn" href="${TESTFLIGHT_URL}" rel="noopener">Get it for iPhone</a><p class="fine" id="iosNote">Installs through TestFlight (Apple’s official beta app).</p></div>
<div class="opt" id="android"><a class="btn" id="androidBtn" href="${androidUrl}" rel="noopener">Get it for Android</a><p class="fine" id="androidNote">You may need to allow installs from unknown sources.</p></div>
</div>
<p id="after">After installing, open the app and tap Connect with a code.</p>
</main>
<script>
(function () {
  var ko = (navigator.language || '').toLowerCase().indexOf('ko') === 0;
  var T = ko
    ? { title: 'Mixdog 설치', ios: 'iPhone용 받기', iosNote: 'TestFlight(Apple 공식 베타 앱)를 통해 설치됩니다.', android: 'Android용 받기', androidNote: '설치할 때 ‘출처를 알 수 없는 앱’ 허용이 필요할 수 있습니다.', after: '설치한 뒤 앱을 열고 ‘코드로 연결’을 누르세요.' }
    : { title: 'Install Mixdog', ios: 'Get it for iPhone', iosNote: 'Installs through TestFlight (Apple’s official beta app).', android: 'Get it for Android', androidNote: 'You may need to allow installs from unknown sources.', after: 'After installing, open the app and tap Connect with a code.' };
  document.documentElement.lang = ko ? 'ko' : 'en';
  var $ = function (id) { return document.getElementById(id); };
  $('heading').textContent = T.title;
  $('iosBtn').textContent = T.ios;
  $('iosNote').textContent = T.iosNote;
  $('androidBtn').textContent = T.android;
  $('androidNote').textContent = T.androidNote;
  $('after').textContent = T.after;
  var ua = navigator.userAgent;
  var ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
  if (ios) $('android').hidden = true;
  else if (/Android/i.test(ua)) $('ios').hidden = true;
})();
</script>
</body>
</html>`;

const PAGE = renderAppPage(readAndroidUrl());

export function sendAppPage(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end();
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
