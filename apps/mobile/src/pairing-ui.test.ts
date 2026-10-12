import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
  PREVIEW_STATES,
  previewFromLocation,
  renderPairing,
  STRINGS,
  stateForPreview,
  trackKeyboardInset,
  viewFor,
  type Hooks,
} from './pairing-ui.ts';

const BANNED = /desktop|데스크톱|relay|릴레이|pairing|페어링|main PC|메인 PC|unpair/iu;
const noHooks: Hooks = {
  onAction() {},
  onCodeInput() {},
};

function paint(state: (typeof PREVIEW_STATES)[number], codeValue = '') {
  const dom = new JSDOM('<!doctype html><div id="screen"></div>');
  const root = dom.window.document.getElementById('screen') as HTMLElement;
  const s = STRINGS.ko;
  const screenState = stateForPreview(state, s);
  renderPairing(
    root,
    { view: viewFor(screenState, s), state: screenState, strings: s, codeValue },
    noHooks
  );
  return root;
}

test('every preview state renders the real logo, a title, a subtitle slot and at least one action', () => {
  for (const state of PREVIEW_STATES) {
    const root = paint(state);
    const visual = root.querySelector('.mxp-vis');
    assert.ok(visual, `${state}: visual slot`);
    assert.equal(root.querySelector('.mxp-ring, svg'), null, 'nothing decorative under the subtitle or in buttons');
    assert.equal(visual.querySelector('img.mxp-logo')?.getAttribute('src'), './mixdog-logo-titanium.svg', state);
    assert.equal(visual.querySelector('.mxp-ring'), null, `${state}: no ring`);
    assert.equal(Boolean(root.querySelector('.mxp-extra .mxp-wait .mxp-spinner')), /^waiting/u.test(state), `${state}: waiting row only while waiting`);
    assert.ok(root.querySelector('.mxp-title')?.textContent, `${state}: title`);
    assert.ok(root.querySelector('.mxp-sub'), `${state}: subtitle`);
    assert.ok(root.querySelectorAll('.mxp-actions button').length >= 1, `${state}: actions`);
    assert.equal(root.querySelector('.mxp-card'), null, 'no floating card');
  }
});

test('start: v4 copy, QR primary + keypad secondary, text-only buttons, no saved-PC list or link', () => {
  const empty = paint('start-empty');
  assert.equal(empty.querySelector('.mxp-title')?.textContent, 'PC에 연결');
  assert.equal(empty.querySelector('.mxp-sub')?.textContent, 'PC의 Mixdog에서 설정 > 연결 > 휴대폰으로 이동하세요.');
  const buttons = [...empty.querySelectorAll<HTMLButtonElement>('.mxp-actions button')];
  assert.deepEqual(
    buttons.map((b) => [b.textContent, b.classList.contains('sec'), Boolean(b.querySelector('svg'))]),
    [
      ['QR 코드 스캔', false, false],
      ['코드로 연결', true, false],
    ]
  );
  assert.equal(empty.querySelector('.mxp-link, .mxp-pc, .mxp-section, .mxp-back'), null);
  assert.ok(!PREVIEW_STATES.some((state) => /pcs/u.test(state)), 'no saved-PC previews');
});

test('every step renders one fixed block: logo 48px slot, title, subtitle, 80px middle slot, same DOM order', () => {
  for (const state of PREVIEW_STATES) {
    const root = paint(state);
    const block = root.querySelector('.mxp-main > .mxp-block');
    assert.ok(block, state);
    assert.deepEqual(
      [...block.children].map((child) => child.className.split(' ')[0]),
      ['mxp-vis', 'mxp-title', 'mxp-sub', 'mxp-extra'],
      state
    );
  }
});

test('code step: six digit boxes over one input, error under them, 연결 primary with 취소 text button below', () => {
  const root = paint('code-error');
  assert.equal(root.querySelector('.mxp-title')?.textContent, '코드로 연결');
  assert.equal(root.querySelector('.mxp-sub')?.textContent, 'PC에 표시된 6자리 코드를 입력하세요.');
  assert.equal(root.querySelector('.mxp-back'), null, 'cancel is the bottom button');
  assert.equal(root.querySelectorAll('.mxp-otp > .mxp-digit').length, 6);
  assert.equal(root.querySelectorAll('input').length, 1, 'one real input');
  const input = root.querySelector('input.mxp-code') as HTMLInputElement;
  assert.equal(input.autocomplete, 'one-time-code');
  assert.equal(input.inputMode, 'numeric');
  assert.equal(root.querySelector('.mxp-error')?.textContent, '코드가 올바르지 않거나 만료되었습니다.');
  const [connect, cancel] = [...root.querySelectorAll<HTMLButtonElement>('.mxp-actions button')];
  assert.deepEqual([connect.textContent, connect.classList.contains('sec'), connect.disabled], ['연결', false, true]);
  assert.deepEqual([cancel.textContent, cancel.classList.contains('sec')], ['취소', true]);
  assert.equal(root.querySelector('.mxp-row'), null);
  const filled = paint('code', '482917');
  assert.equal(filled.querySelector<HTMLButtonElement>('[data-action="connect"]')?.disabled, false);
  assert.deepEqual([...filled.querySelectorAll('.mxp-digit')].map((box) => box.textContent), ['4', '8', '2', '9', '1', '7']);
  assert.match(paint('code-ratelimited').querySelector('.mxp-error')?.textContent ?? '', /42초/);
});

test('waiting and result steps follow the v4 copy with one natural primary action', () => {
  const titleAndActions = (state: (typeof PREVIEW_STATES)[number]) => {
    const root = paint(state);
    return [
      root.querySelector('.mxp-title')?.textContent,
      root.querySelector('.mxp-sub')?.textContent,
      [...root.querySelectorAll('.mxp-actions button')].map((b) => b.textContent),
    ];
  };
  assert.deepEqual(titleAndActions('waiting'), ['PC에서 허용하세요', 'Home PC에 표시된 요청에서 허용을 누르세요.', ['취소']]);
  assert.equal(paint('waiting').querySelector('.mxp-sub b')?.textContent, 'Home PC', 'PC name is bold');
  assert.equal(paint('waiting').querySelector('.mxp-wait')?.textContent, '기다리는 중…');
  assert.equal(paint('waiting-offline').querySelector('.mxp-wait')?.textContent, '기다리는 중…');
  assert.equal(viewFor({ step: 'waiting' }, STRINGS.ko).sub, 'PC에 표시된 요청에서 허용을 누르세요.', 'no name: fallback copy');
  assert.equal(viewFor({ step: 'waiting', pc: 'Home PC' }, STRINGS.en).sub, 'On Home PC, press Allow on the request.');
  assert.deepEqual(titleAndActions('revoked'), [
    '연결이 해제되었습니다',
    'PC에서 이 기기의 연결을 해제했습니다.',
    ['다시 연결', '취소'],
  ]);
  assert.deepEqual(titleAndActions('declined')[1], 'PC에서 요청을 거절했습니다.');
  assert.deepEqual(titleAndActions('network-error')[0], '연결하지 못했습니다');
  assert.deepEqual(titleAndActions('scan-unavailable')[2], ['코드로 연결', '취소']);
  assert.deepEqual(titleAndActions('outdated')[2], ['QR 코드 스캔', '취소']);
  assert.equal(paint('declined').querySelector('.mxp-mark, .mxp-ring'), null, 'state is carried by the text only');
});

test('the preview switch needs the debug flag', () => {
  const storage = (value: string | null) => ({ getItem: () => value });
  assert.equal(previewFromLocation('?mxPairingPreview=waiting', storage('1')), 'waiting');
  assert.equal(previewFromLocation('?mxPairingPreview=waiting', storage(null)), null);
  assert.equal(previewFromLocation('?mxPairingPreview=nope', storage('1')), null);
  assert.equal(previewFromLocation('?mxPairingPreview=waiting', null), null);
});

test('app copy has no developer wording and the shell page is a single full-screen mount', () => {
  for (const strings of [STRINGS.ko, STRINGS.en]) for (const text of Object.values(strings)) assert.doesNotMatch(text, BANNED, text);
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.equal((html.match(/<main/g) || []).length, 0);
  assert.match(html, /<div id="screen" class="mxp-screen"><\/div>/);
  assert.deepEqual(Object.keys(STRINGS.ko).sort(), Object.keys(STRINGS.en).sort());
});


test('code step: one redemption at a time — input and button wait with a pending label', () => {
  const dom = new JSDOM('<!doctype html><div id="screen"></div>');
  const root = dom.window.document.getElementById('screen') as HTMLElement;
  const s = STRINGS.ko;
  const state = { ...stateForPreview('code', s), busy: true };
  renderPairing(root, { view: viewFor(state, s), state, strings: s, codeValue: '482917' }, noHooks);
  assert.equal((root.querySelector('input') as HTMLInputElement).disabled, true);
  const connect = root.querySelector('[data-action="connect"]') as HTMLButtonElement;
  assert.deepEqual([connect.disabled, connect.textContent], [true, '연결 중…']);
  assert.ok(root.classList.contains('mxp-code-step'));
  assert.equal(paint('start-empty').classList.contains('mxp-code-step'), false);
});

test('code step on a phone: the form group is bottom-anchored and follows the visual viewport', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /@media \(max-width:599px\)\{\.mxp-code-step \.mxp-col\{[^}]*flex-direction:column/);
  assert.match(html, /\.mxp-code-step \.mxp-extra\{[^}]*margin-top:auto/);
  assert.match(html, /\.mxp-code-step \.mxp-sub\{height:auto/);
  const listeners: Record<string, () => void> = {};
  const viewport = {
    height: 500,
    offsetTop: 0,
    addEventListener: (name: string, fn: () => void) => (listeners[name] = fn),
    removeEventListener() {},
  };
  const root = new JSDOM('<div id="r"></div>').window.document.getElementById('r') as HTMLElement;
  trackKeyboardInset(root, { innerHeight: 800, visualViewport: viewport } as unknown as Window);
  assert.equal(root.style.getPropertyValue('--mxp-kb'), '300px');
  viewport.height = 800;
  listeners.resize();
  assert.equal(root.style.getPropertyValue('--mxp-kb'), '0px');
});

test('codes unavailable names the connection server, not a PC update', () => {
  assert.match(STRINGS.ko.outdatedSub, /연결 서버에서는 아직 코드를 쓸 수 없습니다\. QR 코드를 사용하세요\./);
  assert.doesNotMatch(STRINGS.ko.outdatedSub + STRINGS.en.outdatedSub, /업데이트|update/iu);
});
