import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ANDROID_FALLBACK_URL, readAndroidUrl, renderAppPage } from './app-page.mjs';

const RELEASE_URL = 'https://github.com/tribgames/mixdog/releases/tag/mobile-v0.1.13';

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
    /<a class="btn" id="androidBtn" href="https:\/\/github\.com\/tribgames\/mixdog\/releases\/tag\/mobile-v0\.1\.13"/
  );
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
      JSON.stringify({ androidUrl: 'https://github.com/tribgames/mixdog/releases/tag/v1.2.3' }),
    ]) {
      withConfig(contents, (file) => assert.equal(readAndroidUrl(file), ANDROID_FALLBACK_URL, contents));
    }
  } finally {
    console.warn = warn;
  }
});
