// Agent tags in the review sources list are user data, not catalog keys: a tag
// that happens to spell a UI word must not be translated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import i18n, { t as translate } from './i18n';
import { TurnReviewBar } from './TurnReview';
import { rememberAgentReviews } from './turn-review-cache';

i18n.addResourceBundle(
  'ko',
  'translation',
  JSON.parse(readFileSync(new URL('./locales/ko.json', import.meta.url), 'utf8')),
  true,
  false
);

test('turn review shows an agent tag verbatim in every UI language', async (t) => {
  const { dom, restore } = installTestDom(null, { html: '<!doctype html><div id="root"></div>' });
  dom.window.mixdogDesktop = {};
  await i18n.changeLanguage('ko');
  const root = createRoot(dom.window.document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    await i18n.changeLanguage('en');
    restore();
  });
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '',
  ].join('\n');
  rememberAgentReviews('draft:none', [{ sessionId: 'child', agent: 'Plan', tag: null, patch }], null, [], '', '');
  await act(async () => {
    root.render(React.createElement(TurnReviewBar, { items: [], active: false, cwd: '' }));
  });
  const document = dom.window.document;
  await act(async () => document.querySelector('.turn-review-summary').click());
  const labels = [...document.querySelectorAll('.turn-review-source strong')].map((node) => node.textContent);
  // The tag spells a catalog key, so translating it would visibly change it.
  assert.notEqual(translate('Plan'), 'Plan');
  assert.deepEqual(labels, ['Plan']);
});

test('the files menu and its Delete history dialog read in Korean', async (t) => {
  const { dom, restore } = installTestDom(null, { html: '<!doctype html><div id="root"></div>' });
  const files = [{ path: 'a.ts', status: 'M', additions: 1, deletions: 0 }];
  dom.window.mixdogDesktop = {
    setTitleBarDimmed() {},
    invokeCapability: async ({ capability }) => ({
      value:
        capability === 'getSessionReviewDiff'
          ? { supported: true, authoritative: true, complete: true, patch: '', files }
          : { supported: true, authoritative: true, files: [], patch: '', agents: [], historyTurns: 12 },
    }),
  };
  await i18n.changeLanguage('ko');
  const root = createRoot(dom.window.document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    await i18n.changeLanguage('en');
    restore();
  });
  await act(async () => {
    root.render(
      React.createElement(TurnReviewBar, {
        variant: 'segment',
        // Turn activity: the turn review read carries the retained turn count.
        items: [{ kind: 'turndone', id: 'ko-done' }],
        sessionId: 'ko-files',
        active: true,
        onOpenChanges() {},
      })
    );
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const document = dom.window.document;
  await act(async () => document.querySelector('.turn-review-segment').click());
  const items = [...document.querySelectorAll('.turn-review-files-menu [role="menuitem"]')];
  // The changed files list first, then Delete history and View changes fixed below it.
  assert.deepEqual(
    items.map((item) => item.textContent),
    ['a.ts+1', '기록 삭제', '변경 사항 보기']
  );
  await act(async () => items[1].click());
  const dialog = document.querySelector('.settings-confirm-dialog');
  assert.equal(dialog.querySelector('h3').textContent, '이 세션의 변경 기록을 삭제할까요?');
  assert.equal(
    dialog.querySelector('p').textContent,
    '저장된 12개 턴의 변경 내역과 되돌리기·다시 적용이 영구 삭제됩니다. 현재 파일, 대화, Git 기록은 그대로입니다.'
  );
  assert.deepEqual(
    [...dialog.querySelectorAll('footer button')].map((button) => button.textContent),
    ['취소', '기록 삭제']
  );
});
