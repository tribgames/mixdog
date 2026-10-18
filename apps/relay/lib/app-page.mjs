// `/app`: the target of the desktop's Phone QR. A static install page: the
// store/APK button for the visitor's platform and a line on how to pair. It
// takes no parameters and grants nothing; pairing is the 6-digit code typed in
// the app, approved on the PC. No link to any web client.
import { readFileSync } from 'node:fs';
import { LOGO_SRC, PAGE_BASE_CSS, PAIRING_CSS } from './connect-page.mjs';

const APP_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

const TESTFLIGHT_URL = 'https://testflight.apple.com/join/UNPBM2hU';
// Written beside server.mjs by deploy/deploy-release.sh: the newest Android
// release Deploy verified as published with a downloadable APK.
const MOBILE_RELEASE_CONFIG = new URL('../mobile-release.json', import.meta.url);
// Without a deployed link (local runs, or a release that recorded none) the
// releases list still reaches every published APK.
export const ANDROID_FALLBACK_URL = 'https://github.com/tribgames/mixdog/releases';
// The recorded link is the APK itself: this repo's mobile-v* release asset.
const ANDROID_APK_RE =
  /^https:\/\/github\.com\/tribgames\/mixdog\/releases\/download\/mobile-v\d+\.\d+\.\d+\/[A-Za-z0-9_.-]+\.apk$/;
const isAndroidApkUrl = (value) => typeof value === 'string' && ANDROID_APK_RE.test(value);

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
    if (androidUrl === ANDROID_FALLBACK_URL || isAndroidApkUrl(androidUrl)) return androidUrl;
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
${PAGE_BASE_CSS}
${PAIRING_CSS}
.mxp-actions{gap:20px}
</style>
</head>
<body>
<div class="mxp-screen">
<div class="mxp-col">
<main class="mxp-main">
<div class="mxp-block">
<div class="mxp-vis"><img class="mxp-logo" src="${LOGO_SRC}" alt="" draggable="false" /></div><h1 class="mxp-title" id="heading">Install Mixdog</h1><p class="mxp-sub" id="after">After installing, open the app and tap Connect with a code.</p>
</div>
</main>
<footer class="mxp-actions">
<div class="mxp-opt" id="ios"><a class="mxp-btn" id="iosBtn" href="${TESTFLIGHT_URL}" rel="noopener">Get it for iPhone</a><p class="mxp-fine" id="iosNote">Installs through TestFlight (Apple’s official beta app).</p></div>
<div class="mxp-opt" id="android"><a class="mxp-btn" id="androidBtn" href="${androidUrl}" rel="noopener">Get it for Android</a><p class="mxp-fine" id="androidNote">You may need to allow installs from unknown sources.</p></div>
</footer>
</div>
</div>
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

export function createAppPageHandler(androidUrl) {
  const page = renderAppPage(androidUrl);
  return (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    // The QR targets this page for every phone: an Android phone is sent
    // straight to the APK, anything else gets the install page.
    if (isAndroidApkUrl(androidUrl) && /Android/i.test(request.headers['user-agent'] || '')) {
      response.writeHead(302, { Location: androidUrl, 'Cache-Control': 'no-store' }).end();
      return;
    }
    response
      .writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': APP_PAGE_CSP,
        'X-Content-Type-Options': 'nosniff',
      })
      .end(request.method === 'HEAD' ? undefined : page);
  };
}

export const sendAppPage = createAppPageHandler(readAndroidUrl());

// Public read-only hint for the Android updater: the newest published version
// and its APK, so the app only asks GitHub when this is newer than itself.
export function createLatestHandler(androidUrl) {
  const version = androidUrl.match(/\/mobile-v(\d+\.\d+\.\d+)\//)?.[1];
  const body = isAndroidApkUrl(androidUrl) && version ? JSON.stringify({ version, url: androidUrl }) : null;
  return (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    if (body === null) {
      // 404 = "no APK known here": the client must treat the relay as
      // unavailable and use its rate-limited GitHub fallback, not assume up to date.
      response.writeHead(404, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end();
      return;
    }
    response
      .writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      .end(request.method === 'HEAD' ? undefined : body);
  };
}

export const sendLatestRelease = createLatestHandler(readAndroidUrl());
