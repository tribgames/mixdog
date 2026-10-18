import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ANDROID_FALLBACK_URL,
  createAppPageHandler,
  createLatestHandler,
  readAndroidUrl,
  renderAppPage,
} from './app-page.mjs';

function latest(androidUrl, method = 'GET') {
  const result = {};
  const response = {
    writeHead(status, head) {
      Object.assign(result, { status, head });
      return this;
    },
    end(body) {
      result.body = body;
    },
  };
  createLatestHandler(androidUrl)({ method, headers: {} }, response);
  return result;
}

test('/app/latest.json reports the version and APK of the deployed release', () => {
  const ok = latest(RELEASE_URL);
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { version: '0.1.13', url: RELEASE_URL });
  assert.equal(ok.head['Cache-Control'], 'no-store');
  assert.equal(ok.head['X-Content-Type-Options'], 'nosniff');
  assert.match(ok.head['Content-Type'], /^application\/json/);
  assert.equal(latest(RELEASE_URL, 'HEAD').body, undefined);
  assert.equal(latest(RELEASE_URL, 'POST').status, 405);
});

test('/app/latest.json is 404 when only the releases page is known', () => {
  const missing = latest(ANDROID_FALLBACK_URL);
  assert.equal(missing.status, 404);
  assert.equal(missing.head['Cache-Control'], 'no-store');
});

const RELEASE_URL = 'https://github.com/tribgames/mixdog/releases/download/mobile-v0.1.13/Mixdog-0.1.13.apk';

function withConfig(contents, check) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-app-page-'));
  try {
    const file = join(dir, 'mobile-release.json');
    if (contents !== undefined) writeFileSync(file, contents);
    check(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('/app links the Android release recorded at deploy time', () => {
  withConfig(JSON.stringify({ androidUrl: RELEASE_URL }), (file) => {
    assert.equal(readAndroidUrl(file), RELEASE_URL);
  });
  withConfig(JSON.stringify({ androidUrl: ANDROID_FALLBACK_URL }), (file) => {
    assert.equal(readAndroidUrl(file), ANDROID_FALLBACK_URL);
  });
  assert.match(
    renderAppPage(RELEASE_URL),
    /<a class="mxp-btn" id="androidBtn" href="https:\/\/github\.com\/tribgames\/mixdog\/releases\/download\/mobile-v0\.1\.13\/Mixdog-0\.1\.13\.apk"/
  );
});

function send(androidUrl, headers, method = 'GET') {
  const result = {};
  const response = {
    writeHead(status, head) {
      Object.assign(result, { status, head });
      return this;
    },
    end(body) {
      result.body = body;
    },
  };
  createAppPageHandler(androidUrl)({ method, headers }, response);
  return result;
}

test('/app sends an Android phone straight to the APK and others to the install page', () => {
  const android = send(RELEASE_URL, { 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' });
  assert.equal(android.status, 302);
  assert.equal(android.head.Location, RELEASE_URL);
  const iphone = send(RELEASE_URL, { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' });
  assert.equal(iphone.status, 200);
  assert.match(iphone.body, /Get it for iPhone/);
  // Without a known APK, Android sees the page whose button opens the releases list.
  assert.equal(send(ANDROID_FALLBACK_URL, { 'user-agent': 'Android' }).status, 200);
});

test('/app falls back to the releases list without a usable deployed link', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    withConfig(undefined, (file) => assert.equal(readAndroidUrl(file), ANDROID_FALLBACK_URL));
    for (const contents of [
      '{not json',
      '{}',
      JSON.stringify({ androidUrl: 42 }),
      JSON.stringify({ androidUrl: 'javascript:alert(1)' }),
      JSON.stringify({ androidUrl: 'https://evil.example/releases/tag/mobile-v1.0.0' }),
      JSON.stringify({ androidUrl: `${RELEASE_URL}"><script>` }),
      JSON.stringify({ androidUrl: 'https://github.com/tribgames/mixdog/releases/tag/mobile-v0.1.13' }),
      JSON.stringify({ androidUrl: 'https://github.com/other/repo/releases/download/mobile-v0.1.13/a.apk' }),
      JSON.stringify({ androidUrl: 'https://github.com/tribgames/mixdog/releases/download/v1.2.3/a.apk' }),
      JSON.stringify({ androidUrl: 'https://github.com/tribgames/mixdog/releases/download/mobile-v0.1.13/a.zip' }),
      JSON.stringify({ androidUrl: 'https://github.com/tribgames/mixdog/releases/tag/v1.2.3' }),
    ]) {
      withConfig(contents, (file) => assert.equal(readAndroidUrl(file), ANDROID_FALLBACK_URL, contents));
    }
  } finally {
    console.warn = warn;
  }
});
