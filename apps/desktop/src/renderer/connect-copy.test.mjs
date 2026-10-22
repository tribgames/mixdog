import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { sendConnectPage } from '../../../relay/lib/connect-page.mjs';
import { installTestDom } from './test-support/test-dom.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const BANNED = /desktop|데스크톱|relay|릴레이|pairing|페어링|main PC|메인 PC|unpair/iu;

const connectHtml = () => {
  let body = '';
  sendConnectPage({ method: 'GET' }, { writeHead: () => ({ end: (html) => (body = html) }) });
  return body;
};

// The shared component: the same rule text in the app picker, the web pairing layer and /connect.
const canonicalRules = () => {
  const html = read('../../../mobile/src/index.html');
  const start = html.indexOf('.mxp-screen{');
  const end = html.indexOf('</style>');
  return html.slice(start, end).trim();
};

test('all three connecting-side surfaces carry the identical layout CSS', () => {
  const css = canonicalRules();
  assert.ok(css.includes('.mxp-col{width:calc(100% - 40px);max-width:340px;'));
  assert.ok(css.includes('.mxp-actions{width:100%;margin-top:24px;display:grid;gap:8px;align-content:start}'));
  assert.ok(connectHtml().includes(css), '/connect');
  assert.ok(read('./remote-pairing-screen.ts').includes(css), 'web pairing layer');
  assert.doesNotMatch(css, /border-radius:22px/, 'no floating card');
  // The layer is exactly the viewport and never grows with its content.
  assert.match(
    css,
    /\.mxp-screen\{[^}]*position:fixed;inset:0;height:100vh;height:100dvh;max-height:100dvh;[^}]*overflow:hidden/
  );
  assert.match(
    css,
    /\.mxp-col\{[^}]*max-width:340px[^}]*overflow:auto[^}]*45dvh/,
    'column scrolls only on a truly short viewport'
  );
  // One 340px column at the optical center (~45%): logo 48 + 20 + title 30 + 8 + description 45 + 24 + middle 80, actions flowing 24px below.
  assert.match(css, /\.mxp-vis\{[^}]*width:48px;height:48px/);
  assert.match(css, /\.mxp-title\{[^}]*height:30px;margin-top:20px;[^}]*font-size:22px;[^}]*font-weight:700/);
  assert.match(css, /\.mxp-sub\{[^}]*height:45px;margin-top:8px;[^}]*word-break:keep-all;[^}]*text-wrap:balance/);
  assert.match(css, /\.mxp-extra\{[^}]*height:80px;margin-top:24px/);
  assert.match(css, /--mxp-btn-h:48px/);
  assert.match(css, /\.mxp-btn\{[^}]*min-height:var\(--mxp-btn-h\)/);
  assert.match(css, /\.mxp-digit\{[^}]*max-width:44px;height:52px[^}]*border-radius:10px/);
  assert.match(css, /prefers-reduced-motion:reduce\)\{\.mxp-spinner\{animation:none/);
  assert.match(css, /\.mxp-btn\{[^}]*font-family:inherit;[^}]*font-weight:700/);
  assert.match(css, /Pretendard Variable[^;]*Apple SD Gothic Neo/);
  assert.match(css, /--mxp-band:#181818/);
  assert.doesNotMatch(css, /mxp-ring|mxp-mark|mxp-chev|mxp-btn svg/, 'no decorative icon rules');
});

test('/connect: full-screen column, v4 copy, one centered primary button, footnote', () => {
  const html = connectHtml();
  assert.equal((html.match(/<button/g) || []).length, 1);
  // Error sits right under the input; the footnote is under the button.
  assert.ok(html.indexOf('id="code"') < html.indexOf('id="status"'));
  assert.ok(html.indexOf('id="go"') < html.indexOf('id="fine"'));
  assert.match(html, /<footer class="mxp-actions"><button[^>]*id="go"[^>]*><\/button><p class="mxp-fine" id="fine">/);
  assert.match(html, /<div class="mxp-screen mxp-code-step">/);
  assert.match(html, /heading: 'PC에 연결'/);
  assert.match(html, /note: 'PC의 Mixdog에서 설정 > 연결 > 웹으로 이동해 코드를 확인하세요\.'/);
  assert.match(html, /fine: 'iPhone에서는 아직 알림을 받을 수 없습니다\.'/);
  assert.match(html, /<img class="mxp-logo" src="data:image\/svg\+xml,%3Csvg/);
  const copy = html.slice(html.indexOf('var T = ko'), html.indexOf('document.documentElement.lang'));
  assert.doesNotMatch(copy, BANNED);
});

for (const [state, expected] of [
  ['start-empty', ''],
  ['code', ''],
  ['code-error', '코드가 올바르지 않거나 만료되었습니다.'],
  ['code-ratelimited', '시도가 너무 많습니다. 42초 뒤에 다시 시도하세요.'],
  ['network-error', '연결하지 못했습니다. 인터넷 연결을 확인하세요.'],
]) {
  test(`/connect preview "${state}" renders without network, only with the debug flag`, () => {
    const render = (flag) => {
      const dom = new JSDOM(connectHtml(), {
        url: `https://relay.example/connect?mxPairingPreview=${state}`,
        runScripts: 'dangerously',
        beforeParse(window) {
          Object.defineProperty(window.navigator, 'language', { value: 'ko-KR' });
          if (flag) window.localStorage.setItem('mixdog.debug.pairingPreview', '1');
          window.fetch = () => assert.fail('preview must not use the network');
        },
      });
      return dom.window.document;
    };
    const document = render(true);
    assert.equal(document.getElementById('heading').textContent, 'PC에 연결');
    assert.equal(document.getElementById('go').textContent, '연결');
    assert.equal(document.getElementById('status').textContent, expected);
    assert.equal(render(false).getElementById('status').textContent, '');
  });
}

test('web pairing layer: every preview state paints logo, title, subtitle region and actions', async (t) => {
  const { createRemotePairingScreen, PAIRING_PREVIEW_STATES } = await import('./remote-pairing-screen.ts');
  const expectations = {
    waiting: ['Allow it on your PC', ['cancel']],
    'waiting-offline': ['Waiting for your PC', ['cancel']],
    declined: ['Request declined', ['ask', 'back']],
    expired: ['Request expired', ['ask', 'back']],
    revoked: ['You were disconnected', ['ask', 'back']],
    'network-error': ['Connection failed', ['ask', 'back']],
  };
  for (const state of PAIRING_PREVIEW_STATES) {
    const { document, window } = installTestDom(t, {
      jsdom: { url: `https://relay.example/d/abc/?mxPairingPreview=${state}` },
      expose: ['localStorage', 'location', 'navigator'],
    });
    window.localStorage.setItem('mixdog.debug.pairingPreview', '1');
    createRemotePairingScreen({
      deviceId: 'abc',
      claimStorageKey: 'claim',
      serverBase: () => 'https://relay.example',
      clientId: () => 'client',
      acceptApproval: () => false,
      verifyConnection: () => Promise.resolve(),
    })('', true);
    await new Promise((done) => setTimeout(done, 20));
    const layer = document.getElementById('mixdog-remote-pairing');
    assert.ok(layer, state);
    const visual = layer.querySelector('.mxp-vis');
    assert.ok(visual, `${state}: visual slot`);
    assert.equal(
      visual.querySelector('img.mxp-logo').getAttribute('src'),
      '/mixdog-logo-titanium.svg',
      `${state}: logo in every step`
    );
    assert.equal(visual.querySelector('.mxp-ring'), null, `${state}: no ring`);
    assert.equal(
      Boolean(layer.querySelector('.mxp-extra .mxp-wait .mxp-spinner')),
      /^waiting/u.test(state),
      `${state}: waiting row only while waiting`
    );
    if (state === 'waiting') assert.equal(layer.querySelector('.mxp-sub b').textContent, 'Home PC');
    assert.equal(layer.querySelector('.mxp-mark, svg'), null, `${state}: no decorative icons`);
    assert.ok(layer.querySelector('.mxp-title').textContent, `${state}: title`);
    assert.ok(layer.querySelector('.mxp-sub'), `${state}: subtitle slot`);
    assert.ok(layer.querySelector('.mxp-col'), `${state}: one column, no card`);
    const roles = [...layer.querySelectorAll('.mxp-actions button')].map((b) => b.dataset.role);
    const [title, actions] = expectations[state];
    assert.equal(layer.querySelector('.mxp-title').textContent, title);
    assert.deepEqual(roles, actions, state);
    assert.equal(layer.querySelector('.mxp-step'), null, `${state}: no install steps`);
    t.after(() => document.getElementById('mixdog-remote-pairing')?.remove());
  }
});

test('web pairing layer ignores the preview switch without the debug flag', async (t) => {
  const { pairingPreviewState } = await import('./remote-pairing-screen.ts');
  installTestDom(t, {
    jsdom: { url: 'https://relay.example/d/abc/?mxPairingPreview=waiting' },
    expose: ['localStorage', 'location'],
  });
  assert.equal(pairingPreviewState(), null);
});

test('web pairing layer copy has no developer wording and the revoked screen shows its reason once', () => {
  const source = read('./remote-pairing-screen.ts');
  for (const [, text] of source.matchAll(/earlyUiT\(\s*'([^']+)'/gu)) assert.doesNotMatch(text, BANNED, text);
  assert.doesNotMatch(source, /Mixdog needs a one-time approval/u);
  assert.match(
    read('./remote-shim-socket.ts'),
    /resetApprovalAndAsk\(earlyUiT\('Your PC disconnected this device\.'\)\)/
  );
  const ended = /const endedView[\s\S]*?\n {6}\};/u.exec(source)[0];
  assert.equal((ended.match(/message/g) || []).length, 1, 'the reason appears once');
});

test('/connect: auto-submit, Enter and the button start ONE redemption and the form waits', async () => {
  let calls = 0;
  const dom = new JSDOM(connectHtml(), {
    url: 'https://relay.example/connect',
    runScripts: 'dangerously',
    beforeParse(window) {
      Object.defineProperty(window.navigator, 'language', { value: 'ko-KR' });
      window.fetch = () => {
        calls += 1;
        return new Promise(() => undefined);
      };
    },
  });
  const { document } = dom.window;
  const input = document.getElementById('code');
  input.value = '123456';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(calls, 1, 'the sixth digit submits');
  assert.equal(input.disabled, true);
  assert.equal(document.getElementById('go').disabled, true);
  assert.equal(document.getElementById('go').textContent, '연결 중…');
  document.getElementById('go').click();
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter' }));
  assert.equal(calls, 1, 'no second redemption while one is in flight');
  assert.match(connectHtml(), /signal: abort\.signal/, 'the request is bounded');
});

test('phone code step: the form is one bottom-anchored group above the keyboard; other steps keep the centered column', () => {
  const css = read('./remote-pairing-screen.ts');
  assert.match(css, /--mxp-kb,0px/);
  const phone = /@media \(max-width:599px\)\{\.mxp-code-step[^@]*\}\}/u.exec(css)?.[0] ?? '';
  assert.ok(phone, 'phone rule scoped to the code step');
  assert.match(phone, /\.mxp-code-step \.mxp-extra\{[^}]*margin-top:auto/);
  assert.match(phone, /\.mxp-code-step \.mxp-sub\{height:auto/);
  assert.match(phone, /\.mxp-code-step \.mxp-main,\.mxp-code-step \.mxp-block\{display:contents\}/);
  assert.ok(connectHtml().includes(phone), '/connect carries the same rule');
  assert.match(connectHtml(), /class="mxp-screen mxp-code-step"/);
  assert.match(connectHtml(), /visualViewport/);
});

test('web layer: a cancel is final and the load-failure page and redeem errors are localized', () => {
  const windows = read('../main/remote-host-windows.ts');
  assert.doesNotMatch(windows, /Could not reach \$\{/);
  assert.match(windows, /nativeT\('Could not reach \{\{name\}\}/);
  assert.doesNotMatch(read('../main/remote-hosts.ts'), /main PC/);
});
