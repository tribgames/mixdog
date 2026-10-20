// A first message with attachments and no words titles its session (tab
// strip, sidebar, window title) by the first attachment — a file by its name,
// an image or video by its localized kind — never by a raw `[Image]` /
// `[File]` / `[PDF #n: …]` placeholder. Words, when there are any, title it.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, { jsdom: { url: 'https://mixdog.test/' } });
after(restore);

const [{ buildSubmissionContent }, { promptTitle }, { displaySessionTitle, sessionDisplayTitle }, i18n] =
  await Promise.all([
    import('./use-composer-submission.ts'),
    import('../shared/session-title.mjs'),
    import('./session-display-title.ts'),
    import('./i18n.ts'),
  ]);

const PNG = Buffer.from('png bytes').toString('base64');
const image = (id, name = 'Pasted image') => ({ id, name, kind: 'image', mimeType: 'image/png', data: PNG, token: '' });
const chip = (id, kind, name, mimeType, token) => ({
  id,
  name,
  kind,
  mimeType,
  data: Buffer.from(`${name} bytes`).toString('base64'),
  token,
  chipOnly: true,
});
const pdf = (id, name = 'report.pdf') => chip(id, 'pdf', name, 'application/pdf', `[PDF #${id}: ${name}]`);
const office = (id, name = 'budget.xlsx') =>
  chip(id, 'office', name, 'application/vnd.ms-excel', `[File #${id}: ${name}]`);
const textFile = (id, name = 'main.ts') => ({
  ...chip(id, 'text', name, 'text/plain', `[File #${id}: ${name}]`),
  data: 'export const answer = 42;\n',
  source: 'file',
});

// [kind, draft, attachments, English title, Korean title]
const CASES = [
  ['pasted image', '', [image(1)], 'Image', '이미지'],
  ['image file', '', [image(1, 'photo.jpg')], 'Image', '이미지'],
  ['three pasted images', '', [image(1), image(2), image(3)], 'Image', '이미지'],
  ['PDF', '', [pdf(1)], 'report.pdf', 'report.pdf'],
  ['office document', '', [office(1)], 'budget.xlsx', 'budget.xlsx'],
  ['text / code file', '', [textFile(1)], 'main.ts', 'main.ts'],
  ['several files', '', [office(1), pdf(2)], 'budget.xlsx', 'budget.xlsx'],
  ['images and a file', '', [image(1), pdf(2)], 'report.pdf', 'report.pdf'],
  ['image plus text', 'what is this?', [image(1)], 'what is this?', 'what is this?'],
  ['files plus text', 'review these', [pdf(1), textFile(2)], 'review these', 'review these'],
];

/** The title a new task gets from its first message, and how each surface
 *  shows it: the tab (`use-app-submit-routing`), and the sidebar / tab strip /
 *  window title from the catalog row (titled by it, or by its preview). */
function surfaces(draft, attachments) {
  const built = buildSubmissionContent(draft, attachments);
  const displayText = built.expandedText.trim();
  const title = promptTitle(built.content, displayText) || 'New task';
  return {
    title,
    shown: [
      displaySessionTitle(title),
      sessionDisplayTitle({ title }, 'Untitled session'),
      sessionDisplayTitle({ preview: title }, 'Untitled session'),
      ...(displayText ? [sessionDisplayTitle({ preview: displayText }, 'Untitled session')] : []),
    ],
  };
}

const PLACEHOLDER = /\[(?:Image|Video|File|PDF|Pasted text)\b[^\]]*\]/;

for (const [kind, draft, attachments, english, korean] of CASES) {
  test(`session title for a first message with ${kind}`, async (t) => {
    t.after(async () => {
      i18n.setUiLanguagePreference('en');
      await i18n.initUiLanguage();
    });
    for (const [language, expected] of [
      ['en', english],
      ['ko', korean],
    ]) {
      i18n.setUiLanguagePreference(language);
      await i18n.initUiLanguage();
      const { shown } = surfaces(draft, attachments);
      for (const value of shown) {
        assert.equal(value, expected, `${language}: ${JSON.stringify(shown)}`);
        assert.doesNotMatch(value, PLACEHOLDER);
      }
    }
  });
}

test('after a restart a session tab titled [Image] reads as the localized kind in the tab strip', async (t) => {
  const { root } = installTestDom(t, {
    jsdom: { url: 'http://localhost/' },
    rootId: 'root',
    expose: ['Event', 'CustomEvent'],
  });
  window.mixdogDesktop = { invokeCapability: async () => ({ value: [] }) };
  window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  i18n.setUiLanguagePreference('ko');
  await i18n.initUiLanguage();
  t.after(async () => {
    i18n.setUiLanguagePreference('en');
    await i18n.initUiLanguage();
  });
  const [{ useAppStartupRestore }, { useAppPaneChrome }] = await Promise.all([
    import('./use-app-startup-restore.ts'),
    import('./use-app-pane-chrome.tsx'),
  ]);
  window.localStorage.setItem('restore-session', 's-image');
  const sessions = [{ id: 's-image', title: '[Image]', preview: '[Image]' }];
  const registered = [];
  const restoreProps = {
    restoredFromStorage: false,
    startupFocusedPaneSelection: null,
    startupNavigationSelection: null,
    projectCatalogReady: true,
    snapshotReady: true,
    selectionRef: { current: { kind: 'new' } },
    viewedSessionRef: { current: '' },
    unreadViewedSessionRef: { current: '' },
    setSelection() {},
    setStartupSettled() {},
    activateSelection: (selection, title) => registered.push({ selection, title }),
    openSessionRef: { current: async () => {} },
    lastNewTaskPrefs: { current: null },
    effectiveDraftProjectPath: (path) => path,
    preferredDraftProjectPath: '',
    setNewTaskDeferred() {},
    resetNewTaskDraft() {},
    lastSessionStorageKey: 'restore-session',
    lastProjectStorageKey: 'restore-project',
    restorePending: false,
  };
  // The stored session restored from the catalog row known at startup.
  function Restore() {
    useAppStartupRestore({ ...restoreProps, sessions, snapshot: { sessionId: 's-image' } });
    return null;
  }
  await act(async () => root.render(React.createElement(Restore)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  await act(async () => root.render(null));
  assert.deepEqual(
    registered.map((entry) => [entry.selection.id, entry.title]),
    [['s-image', '이미지']]
  );
  // A tab persisted with the raw placeholder (or registered before this fix)
  // is shown the same way; any other title is shown as it is.
  const tabs = [
    { key: 'session:s-image', title: '[Image]', selection: { kind: 'session', id: 's-image' } },
    { key: 'session:s-text', title: 'Fix the release', selection: { kind: 'session', id: 's-text' } },
  ];
  let titleFor = null;
  function Strip() {
    titleFor = useAppPaneChrome({ tabs, sessions }).stripTitleFor;
    return null;
  }
  await act(async () => root.render(React.createElement(Strip)));
  assert.equal(titleFor(tabs[0].key, tabs[0].selection), '이미지');
  assert.equal(titleFor(tabs[1].key, tabs[1].selection), 'Fix the release');
});

test('an image-only title stays the provisional placeholder underneath; text titles are untouched', () => {
  assert.equal(surfaces('', [image(1)]).title, '[Image]', 'a later worded title can still replace it');
  assert.equal(displaySessionTitle('[Image: artistic direction]'), '[Image: artistic direction]');
  assert.equal(displaySessionTitle('Fix the login bug'), 'Fix the login bug');
  assert.equal(displaySessionTitle('[Video]'), 'Video');
  assert.equal(displaySessionTitle('[File]'), 'File');
});
