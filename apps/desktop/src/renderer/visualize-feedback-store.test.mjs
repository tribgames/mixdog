import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { remoteVisualizeState } from '../shared/visualize.ts';
import { installTestDom } from './test-support/test-dom.mjs';
import { useComposerSubmission, withFeedbackText } from './use-composer-submission.ts';
import {
  addVisualizePin,
  clearVisualizeChoices,
  consumeVisualizeFeedback,
  MAX_VISUALIZE_CHOICE_GROUPS,
  MAX_VISUALIZE_PINS,
  removeVisualizePin,
  resetVisualizeFeedback,
  setVisualizeChoice,
  setVisualizePinImage,
  visualizeChoicesChip,
  visualizeFeedbackFor,
  visualizeFeedbackPrompt,
  visualizePaneChoices,
  visualizePaneFile,
  visualizePaneMarkers,
  visualizePinChip,
  visualizePinsFull,
} from './visualize-feedback-store.ts';

const { dom } = installTestDom(null, {
  html: '<html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['sessionStorage', 'navigator'],
});
window.mixdogDesktop = { rendererDiagnostic() {} };
dom.window.HTMLElement.prototype.attachEvent ??= () => {};
dom.window.HTMLElement.prototype.detachEvent ??= () => {};

const elementPin = (overrides = {}) => ({
  tabId: 'v1',
  tabLabel: 'Mockup',
  pane: 0,
  paneKind: 'html',
  file: 'design/mockups/a/index.html',
  note: 'Make this bigger',
  label: 'button.rename',
  element: {
    selector: 'main > button.rename',
    html: '<button class="rename">Rename</button>',
    styles: { display: 'inline-flex', 'font-size': '14px' },
    box: { x: 120, y: 40, width: 80, height: 28 },
  },
  ...overrides,
});

const choice = (overrides = {}) => ({
  tabId: 'v2',
  tabLabel: 'Options',
  pane: 0,
  file: 'design/options.html',
  group: 'layout',
  choice: 'b',
  label: 'Two columns',
  ...overrides,
});

test('pins number in session order, and the pages and chips renumber together', () => {
  resetVisualizeFeedback();
  const first = addVisualizePin('s1', elementPin());
  const region = addVisualizePin(
    's1',
    elementPin({
      pane: 1,
      paneKind: 'pdf',
      label: 'report.pdf region',
      element: undefined,
      region: { view: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } },
    })
  );
  const third = addVisualizePin('s1', elementPin({ label: 'h1', element: { ...elementPin().element, selector: 'h1' } }));
  addVisualizePin('s2', elementPin());

  assert.deepEqual(visualizePaneMarkers(visualizeFeedbackFor('s1'), 'v1', 0), {
    markers: [
      { n: 1, selector: 'main > button.rename' },
      { n: 3, selector: 'h1' },
    ],
    regions: [],
    next: 4,
  });
  assert.deepEqual(
    visualizePaneMarkers(visualizeFeedbackFor('s1'), 'v1', 1).regions.map(({ n, pin }) => [n, pin.id]),
    [[2, region.id]]
  );
  assert.equal(visualizePinChip(first, 1), '📌 1 · button.rename');

  removeVisualizePin('s1', first.id);
  const after = visualizeFeedbackFor('s1');
  assert.deepEqual(visualizePaneMarkers(after, 'v1', 0).markers, [{ n: 2, selector: 'h1' }]);
  assert.equal(visualizePaneMarkers(after, 'v1', 0).next, 3);
  assert.deepEqual(
    after.pins.map((pin, index) => visualizePinChip(pin, index + 1)),
    ['📌 1 · report.pdf region', '📌 2 · h1']
  );
  assert.equal(visualizeFeedbackFor('s2').pins.length, 1, 'sessions keep their own pins');

  // A crop for a pin already gone is dropped.
  setVisualizePinImage('s1', first.id, { data: 'AAAA', mimeType: 'image/png', width: 1, height: 1 });
  assert.equal(
    visualizeFeedbackFor('s1').pins.some((pin) => pin.image),
    false
  );
  setVisualizePinImage('s1', third.id, { data: 'AAAA', mimeType: 'image/png', width: 1, height: 1 });
  assert.equal(visualizeFeedbackFor('s1').pins[1].image.data, 'AAAA');
});

test('choices queue one pick per tab, pane and group', () => {
  resetVisualizeFeedback();
  setVisualizeChoice('s1', choice({ choice: 'a', label: 'One column' }), true);
  setVisualizeChoice('s1', choice(), true);
  setVisualizeChoice('s1', choice({ group: 'theme', choice: 'dark', label: 'Dark' }), true);
  setVisualizeChoice('s1', choice({ pane: 1 }), true);
  let queued = visualizeFeedbackFor('s1').choices;
  assert.deepEqual(
    queued.map((entry) => [entry.pane, entry.group, entry.choice]),
    [
      [0, 'layout', 'b'],
      [0, 'theme', 'dark'],
      [1, 'layout', 'b'],
    ]
  );
  assert.deepEqual(visualizePaneChoices(visualizeFeedbackFor('s1'), 'v2', 0), [
    { group: 'layout', choice: 'b' },
    { group: 'theme', choice: 'dark' },
  ]);
  assert.equal(visualizeChoicesChip(queued.slice(0, 2)), '☑ layout: Two columns, theme: Dark');

  setVisualizeChoice('s1', choice(), false);
  queued = visualizeFeedbackFor('s1').choices;
  assert.deepEqual(
    queued.map((entry) => [entry.pane, entry.group]),
    [
      [0, 'theme'],
      [1, 'layout'],
    ]
  );
  clearVisualizeChoices('s1');
  assert.deepEqual(visualizeFeedbackFor('s1'), { pins: [], choices: [], tweaks: [] });
});

test('the message carries every pin field, the crops as numbered images, and the choices', () => {
  resetVisualizeFeedback();
  const pin = addVisualizePin('s1', elementPin({ note: 'Bigger\nand bolder' }));
  setVisualizePinImage('s1', pin.id, { data: 'PNGDATA', mimeType: 'image/png', width: 80, height: 28 });
  addVisualizePin(
    's1',
    elementPin({
      pane: 1,
      paneKind: 'image',
      file: 'shots/home.png',
      label: 'home.png region',
      note: 'Crop tighter',
      element: undefined,
      region: { view: { x: 0.1, y: 0.25, width: 0.5, height: 0.125 }, image: { x: 40, y: 50, width: 200, height: 25 } },
    })
  );
  setVisualizeChoice('s1', choice(), true);
  const prompt = visualizeFeedbackPrompt(visualizeFeedbackFor('s1'), 7);
  assert.equal(
    prompt.text,
    [
      '<visualize_feedback>',
      'The user left this feedback in the visualize panel. Pins are numbered; the image labelled "visualize pin N" is the crop of pin N.',
      'pin 1 · button.rename',
      '  note: Bigger\n    and bolder',
      '  tab: v1 "Mockup" · pane 1 (html) · file: design/mockups/a/index.html',
      '  selector: main > button.rename',
      '  html: <button class="rename">Rename</button>',
      '  styles: display: inline-flex; font-size: 14px',
      '  box: x 120, y 40, 80×28 (CSS px, page coordinates)',
      '  crop: image "visualize pin 1"',
      'pin 2 · home.png region',
      '  note: Crop tighter',
      '  tab: v1 "Mockup" · pane 2 (image) · file: shots/home.png',
      "  region: x 10%, y 25%, 50%×12.5% of the pane's visible view",
      '  image area: x 40, y 50, 200×25 (image px)',
      '  crop: none',
      'choices:',
      '  - tab: v2 "Options" · file: design/options.html · group: "layout" → choice: "b" ("Two columns")',
      '</visualize_feedback>',
    ].join('\n')
  );
  assert.deepEqual(prompt.images, [
    {
      id: 7,
      name: 'visualize-pin-1.png',
      kind: 'image',
      mimeType: 'image/png',
      data: 'PNGDATA',
      token: '',
      metadataText: '[Image: visualize pin 1 · button.rename, 80x28]',
    },
  ]);
  assert.equal(
    prompt.display,
    '📌 1 · button.rename — Bigger and bolder\n📌 2 · home.png region — Crop tighter\n☑ layout: Two columns'
  );
  assert.equal(withFeedbackText('Hi', 'Hi', 'F'), 'Hi\n\nF');
  assert.deepEqual(
    withFeedbackText([{ type: 'text', text: 'Hi' }, { type: 'image', data: 'x', mimeType: 'image/png' }], 'Hi', 'F'),
    [
      { type: 'text', text: 'Hi' },
      { type: 'text', text: 'F' },
      { type: 'image', data: 'x', mimeType: 'image/png' },
    ]
  );
});

test('a session holds at most 20 pins and 20 choice groups', () => {
  resetVisualizeFeedback();
  for (let i = 0; i < MAX_VISUALIZE_PINS; i += 1) assert.ok(addVisualizePin('s1', elementPin()));
  assert.equal(visualizePinsFull('s1'), true);
  assert.equal(addVisualizePin('s1', elementPin()), null, 'the 21st pin is refused');
  assert.equal(visualizeFeedbackFor('s1').pins.length, MAX_VISUALIZE_PINS);
  assert.ok(addVisualizePin('s2', elementPin()), 'other sessions are unaffected');
  removeVisualizePin('s1', visualizeFeedbackFor('s1').pins[0].id);
  assert.ok(addVisualizePin('s1', elementPin()), 'room again after a removal');

  for (let i = 0; i < MAX_VISUALIZE_CHOICE_GROUPS; i += 1) {
    assert.equal(setVisualizeChoice('s1', choice({ group: `g${i}` }), true), true);
  }
  assert.equal(setVisualizeChoice('s1', choice({ group: 'one-too-many' }), true), false);
  assert.equal(visualizeFeedbackFor('s1').choices.length, MAX_VISUALIZE_CHOICE_GROUPS);
  // A full session still takes a new pick in a group it already holds, and unpicks.
  assert.equal(setVisualizeChoice('s1', choice({ group: 'g3', choice: 'c' }), true), true);
  assert.equal(visualizeFeedbackFor('s1').choices.find((entry) => entry.group === 'g3').choice, 'c');
  assert.equal(setVisualizeChoice('s1', choice({ group: 'g0' }), false), true);
  assert.equal(visualizeFeedbackFor('s1').choices.length, MAX_VISUALIZE_CHOICE_GROUPS - 1);
  resetVisualizeFeedback();
});

test('a sent message consumes exactly what it carried', () => {
  resetVisualizeFeedback();
  addVisualizePin('s1', elementPin());
  setVisualizeChoice('s1', choice(), true);
  const sent = visualizeFeedbackFor('s1');
  const later = addVisualizePin('s1', elementPin({ note: 'later' }));
  setVisualizeChoice('s1', choice({ choice: 'c', label: 'Three' }), true);
  consumeVisualizeFeedback('s1', sent);
  const left = visualizeFeedbackFor('s1');
  assert.deepEqual(
    left.pins.map((pin) => pin.id),
    [later.id]
  );
  assert.deepEqual(
    left.choices.map((entry) => entry.choice),
    ['c']
  );
});

test('a remote client names files path-free in the feedback it sends', () => {
  resetVisualizeFeedback();
  const cwd = process.platform === 'win32' ? 'C:\\Users\\me\\proj' : '/home/me/proj';
  const absolute = process.platform === 'win32' ? `${cwd}\\site\\index.html` : `${cwd}/site/index.html`;
  const state = remoteVisualizeState({
    sessionId: 's1',
    active: 'v1',
    tabs: [
      {
        id: 'v1',
        label: absolute,
        remoteLabel: 'site/index.html',
        revision: 0,
        cwd,
        panes: [{ kind: 'html', label: 'index.html', target: absolute, path: absolute, remoteTarget: 'site/index.html' }],
      },
    ],
  });
  const [tab] = state.tabs;
  const [pane] = tab.panes;
  assert.equal(pane.file, undefined);
  assert.equal(visualizePaneFile(pane), 'site/index.html');
  assert.equal(visualizePaneFile({ ...pane, version: 2 }), 'site/index.html (kept version v2, read-only)');
  assert.equal(visualizePaneFile({ kind: 'html', label: 'a', target: absolute, url: '', file: 'site/index.html' }), 'site/index.html');
  addVisualizePin('s1', elementPin({ tabId: tab.id, tabLabel: tab.label, file: visualizePaneFile(pane) }));
  setVisualizeChoice('s1', choice({ tabId: tab.id, tabLabel: tab.label, file: visualizePaneFile(pane) }), true);
  const { text, display } = visualizeFeedbackPrompt(visualizeFeedbackFor('s1'), 1);
  for (const sent of [text, display]) assert.equal(sent.includes(cwd), false);
  assert.match(text, /file: site\/index\.html/);
});

test('a failed storage write forgets the stored queue instead of resurrecting it', async () => {
  resetVisualizeFeedback();
  const storage = dom.window.Storage.prototype;
  const setItem = storage.setItem;
  const reload = (tag) => import(`./visualize-feedback-store.ts?reload=${Date.now()}-${tag}`);
  try {
    // The first write lands; every later one fails (full or broken storage).
    let writes = 0;
    storage.setItem = function (key, value) {
      writes += 1;
      if (writes > 1) throw new dom.window.DOMException('full', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
    const pin = addVisualizePin('s1', elementPin());
    assert.equal((await reload('stored')).visualizeFeedbackFor('s1').pins.length, 1, 'the first write landed');
    setVisualizeChoice('s2', choice(), true);
    removeVisualizePin('s1', pin.id);
    assert.equal(sessionStorage.getItem('mixdog:visualize-feedback:v1'), null);
    const afterRemove = await reload('removed');
    assert.equal(afterRemove.visualizeFeedbackFor('s1').pins.length, 0, 'a removed pin never comes back');
    assert.equal(afterRemove.visualizeFeedbackFor('s2').choices.length, 0, 'nor anything else');

    // Sending one session's feedback while another still holds some.
    writes = 0;
    addVisualizePin('s1', elementPin({ note: 'Sent' }));
    setVisualizePinImage('s1', visualizeFeedbackFor('s1').pins[0].id, {
      data: 'PNGDATA',
      mimeType: 'image/png',
      width: 1,
      height: 1,
    });
    consumeVisualizeFeedback('s1', visualizeFeedbackFor('s1'));
    assert.equal(visualizeFeedbackFor('s2').choices.length, 1, 'the document keeps its live queue');
    const afterSend = await reload('sent');
    assert.equal(afterSend.visualizeFeedbackFor('s1').pins.length, 0, 'sent feedback never comes back');
    assert.equal(afterSend.visualizeFeedbackFor('s2').choices.length, 0);
    assert.equal(sessionStorage.getItem('mixdog:visualize-feedback:v1'), null);
  } finally {
    storage.setItem = setItem;
    resetVisualizeFeedback();
  }
});

test('queued feedback survives a renderer reload, crops dropped only when storage is full', async () => {
  resetVisualizeFeedback();
  const first = addVisualizePin('s1', elementPin());
  setVisualizePinImage('s1', first.id, { data: 'PNGDATA', mimeType: 'image/png', width: 80, height: 28 });
  setVisualizeChoice('s1', choice(), true);
  addVisualizePin('s2', elementPin({ note: 'Other session' }));
  // A reload: the module starts over from this window's storage.
  const reloaded = await import(`./visualize-feedback-store.ts?reload=${Date.now()}`);
  assert.deepEqual(reloaded.visualizeFeedbackFor('s1'), visualizeFeedbackFor('s1'));
  assert.equal(reloaded.visualizeFeedbackFor('s2').pins[0].note, 'Other session');
  const next = reloaded.addVisualizePin('s1', elementPin({ note: 'After reload' }));
  assert.equal(
    reloaded.visualizeFeedbackFor('s1').pins.some((pin) => pin !== next && pin.id === next.id),
    false,
    'new pins never reuse a restored id'
  );

  // Over the quota: the notes and picks are kept, the crops let go.
  const storage = dom.window.Storage.prototype;
  const setItem = storage.setItem;
  storage.setItem = function (key, value) {
    if (value.includes('PNGDATA')) throw new dom.window.DOMException('full', 'QuotaExceededError');
    return setItem.call(this, key, value);
  };
  try {
    setVisualizeChoice('s1', choice({ choice: 'a', label: 'One column' }), true);
  } finally {
    storage.setItem = setItem;
  }
  const again = await import(`./visualize-feedback-store.ts?reload=${Date.now()}-2`);
  const restored = again.visualizeFeedbackFor('s1');
  assert.equal(restored.pins[0].note, 'Make this bigger');
  assert.equal(restored.pins[0].image, undefined);
  assert.equal(restored.choices[0].choice, 'a');

  // Sent or cleared feedback is gone after a reload too.
  consumeVisualizeFeedback('s1', visualizeFeedbackFor('s1'));
  consumeVisualizeFeedback('s2', visualizeFeedbackFor('s2'));
  const empty = await import(`./visualize-feedback-store.ts?reload=${Date.now()}-3`);
  assert.equal(empty.visualizeFeedbackFor('s1').pins.length, 0);
  assert.equal(sessionStorage.getItem('mixdog:visualize-feedback:v1'), null);
  resetVisualizeFeedback();
});

test('queued feedback alone is sendable, rides with the message and clears only once accepted', async () => {
  resetVisualizeFeedback();
  const pin = addVisualizePin('s1', elementPin());
  setVisualizePinImage('s1', pin.id, { data: 'PNGDATA', mimeType: 'image/png', width: 80, height: 28 });
  setVisualizeChoice('s1', choice(), true);
  let current;
  let accept = false;
  const submissions = [];
  const errors = [];
  /** Overrides the session's answer (a transport failure). */
  let submit;
  function Harness() {
    const [draft, setDraft] = useState('');
    const [, setSubmitting] = useState(false);
    const [, setSubmissionRecoveryVersion] = useState(0);
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const textarea = useRef(null);
    current = {
      setDraft,
      ...useComposerSubmission({
        turnBusy: false,
        commandBusy: false,
        recoveryScope: 'feedback-test',
        textarea,
        draftRef,
        attachmentsRef: useRef([]),
        transitioningRef: useRef(false),
        composingRef: useRef(false),
        submittingRef: useRef(false),
        submissionRetryRef: useRef(null),
        mountedRef: useRef(true),
        historyNavigation: useRef({ index: -1, seed: '' }),
        setDraft,
        setSubmitting,
        setSubmissionRecoveryVersion,
        clearNotice() {},
        setAttachmentError: (message) => {
          if (message) errors.push(message);
        },
        removeAttachments() {},
        mergeRestoredAttachments: (_attachments, text) => text,
        restoredAttachments: (_value, text) => ({ attachments: [], text }),
        executeSlash: async () => true,
        rememberPrompt() {},
        submit: async (content, options) => {
          if (submit) return submit();
          submissions.push({ content, options });
          return accept;
        },
        abort: async () => ({}),
        sessionId: 's1',
      }),
    };
    return React.createElement('textarea', { ref: textarea, value: draft, readOnly: true });
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => current.send());
    assert.equal(submissions.length, 1, 'no text, but the pins make it sendable');
    const [first] = submissions;
    assert.equal(first.content[0].type, 'text');
    assert.match(first.content[0].text, /^<visualize_feedback>\n.*\npin 1 · button\.rename\n/);
    assert.match(first.content[0].text, /choice: "b"/);
    assert.deepEqual(first.content.slice(1), [
      { type: 'text', text: '[Image: visualize pin 1 · button.rename, 80x28]' },
      { type: 'image', data: 'PNGDATA', mimeType: 'image/png' },
    ]);
    assert.equal(first.options.displayText, '📌 1 · button.rename — Make this bigger\n☑ layout: Two columns');
    assert.equal(Object.keys(first.options.pastedImages).length, 1);
    assert.equal(visualizeFeedbackFor('s1').pins.length, 1, 'a refused send keeps the pins');
    assert.equal(visualizeFeedbackFor('s1').choices.length, 1);
    assert.deepEqual(errors, ['The message was not sent. It has been kept for retry.'], 'and says so');

    // A send that throws keeps them too, and shows the failure.
    await act(async () => current.setDraft('Looks close'));
    submit = async () => {
      throw new Error('session transport closed');
    };
    await act(async () => current.send());
    assert.equal(errors.at(-1), 'session transport closed');
    assert.equal(visualizeFeedbackFor('s1').pins.length, 1);
    assert.equal(visualizeFeedbackFor('s1').choices.length, 1);
    submit = undefined;

    accept = true;
    await act(async () => current.setDraft('Looks close'));
    await act(async () => current.send());
    const second = submissions[1];
    assert.equal(second.content[0].text, 'Looks close');
    assert.match(second.content[1].text, /^<visualize_feedback>/);
    assert.equal(second.options.displayText.split('\n')[0], 'Looks close');
    assert.deepEqual(visualizeFeedbackFor('s1'), { pins: [], choices: [], tweaks: [] }, 'sent feedback clears');

    // Slash commands never carry feedback.
    addVisualizePin('s1', elementPin());
    await act(async () => current.setDraft('/help'));
    await act(async () => current.send());
    assert.equal(submissions.length, 2);
    assert.equal(visualizeFeedbackFor('s1').pins.length, 1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    resetVisualizeFeedback();
  }
});
