import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const pane = await readFile(new URL('./BrowserPane.lazy.tsx', import.meta.url), 'utf8');
const styles = await readFile(
  new URL('./desktop/32-browser-pane.css', import.meta.url),
  'utf8',
);
const persistentSurfaces = await readFile(
  new URL('./use-app-persistent-pane-surfaces.tsx', import.meta.url),
  'utf8',
);

test('browser importer defaults to every supported item and only selected items show progress', () => {
  assert.match(
    pane,
    /setImportItems\(\{\s*passwords: source\?\.supports\.passwords === true,\s*cookies: source\?\.supports\.cookies === true,\s*history: source\?\.supports\.history === true,/,
  );
  assert.match(
    pane,
    /const showProgress = \(importBusy \|\| importFinished\) && selected/,
  );
  assert.match(pane, /className="browser-import-skipped">제외</);
  assert.match(pane, /브라우저 데이터를 가져왔습니다/);
  assert.match(pane, /progress\?\.count\?\.toLocaleString\(\) \|\| "0"/);
  assert.doesNotMatch(pane, /가져오기를 시작하면 Google Chrome을 안전하게 종료합니다/);
  assert.doesNotMatch(pane, /Windows App-Bound Encryption으로 보호된 비밀번호/);
});

test('browser importer stays a centered popup in a narrow pane', () => {
  assert.match(styles, /container-type:\s*inline-size/);
  assert.match(styles, /\.browser-import-dialog\s*\{[\s\S]*?box-sizing:\s*border-box/);
  assert.match(
    styles,
    /\.browser-import-backdrop\s*\{[\s\S]*?align-items:\s*center[\s\S]*?padding:\s*12px/,
  );
  assert.match(
    styles,
    /\.browser-import-dialog\s*\{[\s\S]*?max-width:\s*440px[\s\S]*?max-height:\s*calc\(100% - 24px\)[\s\S]*?flex:\s*none/,
  );
  assert.match(
    styles,
    /\.browser-import-source\s*\{[\s\S]*?flex-direction:\s*column/,
  );
  assert.match(styles, /@container \(min-width:\s*1200px\)/);
  assert.match(
    styles,
    /@container \(min-width:\s*1200px\)[\s\S]*?\.browser-import-dialog\s*\{[\s\S]*?max-width:\s*440px/,
  );
});

test('stored credential UX exposes only masked suggestions and keeps the guest sandbox intact', () => {
  assert.match(pane, /browserCredentialSuggestions\(\)/);
  assert.match(pane, /browserCredentialFill\(credentialId\)/);
  assert.match(pane, /저장된 계정으로 채우기/);
  assert.match(pane, /credential\.label/);
  assert.doesNotMatch(pane, /credential\.password|credential\.username/);
  assert.match(styles, /\.browser-pane-credential-menu\s*\{/);
  assert.match(styles, /\.browser-pane-webview\.is-credential-open/);
});

test('browser guests stay mounted, repaint after parking, and follow the focused pane', () => {
  assert.doesNotMatch(styles, /display:\s*none\s*;/);
  assert.match(
    styles,
    /\.browser-pane\[data-surface-active="false"\] \.browser-pane-webview/,
  );
  assert.match(styles, /width:\s*1px[\s\S]*?height:\s*1px/);
  assert.match(pane, /getWebContentsId\(\)/);
  assert.match(pane, /browserSetActiveGuest/);
  assert.match(persistentSurfaces, /foreground=\{utilityActive && descriptor\.focused\}/);
});

test('browser pane exposes deterministic load and renderer recovery', () => {
  assert.match(pane, /did-fail-load/);
  assert.match(pane, /render-process-gone/);
  assert.match(pane, /unresponsive/);
  assert.match(pane, /다시 불러오기/);
  assert.match(styles, /\.browser-pane-failure\s*\{/);
  assert.match(styles, /\.browser-pane-webview\.is-failed/);
});
