import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['sessionStorage', 'navigator'],
});

const { applyPromptRestore, useComposerPromptRestore } = await import('./use-composer-prompt-restore.ts');
const {
  appliedPromptRestores,
  forgetComposerScope,
  nextComposerSubmissionId,
  takeRejectedComposerSubmissionRecoveries,
  wasSubmittedHere,
} = await import('./composer-draft.ts');
const { restoreAlreadyApplied, useComposerSubmission } = await import('./use-composer-submission.ts');

// A Stop's reply and the session state's `promptRestore` carry one id for one hand-back: whichever reaches the composer
// second inserts nothing.

test('a reply after the notification inserts nothing; a notification after the reply is skipped', () => {
  const submission = nextComposerSubmissionId();
  const id = `restore-7777-${submission}`;
  const reply = { restoreText: 'draft', restoreId: id, restoredSubmissionIds: [submission] };
  const notification = { id, ids: [submission], text: 'draft', device: 'desktop-1', at: 7777 };

  const notifiedFirst = new Map();
  assert.equal(applyPromptRestore(notification, '', 's1', notifiedFirst), 'draft');
  assert.equal(restoreAlreadyApplied(reply, 's1', notifiedFirst), true, 'the reply recognises the applied id');

  const repliedFirst = new Map();
  assert.equal(restoreAlreadyApplied(reply, 's1', repliedFirst), false, 'the reply inserts the text');
  assert.equal(applyPromptRestore(notification, '', 's1', repliedFirst), null, 'the later notification is skipped');
});

test('a reply without an id, or for submissions this composer never sent, is applied as before', () => {
  const submission = nextComposerSubmissionId();
  const applied = new Map();
  assert.equal(
    restoreAlreadyApplied({ restoreText: 'draft', restoredSubmissionIds: [submission] }, 's1', applied),
    false
  );
  assert.equal(
    restoreAlreadyApplied(
      { restoreText: 'draft', restoreId: 'restore-1-other', restoredSubmissionIds: ['other'] },
      's1',
      applied
    ),
    false
  );
  assert.equal(
    restoreAlreadyApplied(
      { restoreText: 'draft', restoreId: 'restore-1-other', restoredSubmissionIds: ['other'] },
      's1',
      applied
    ),
    false
  );
});

test('an applied offer still held in its session state is not inserted again after many other restores and a revisit', () => {
  const heldSubmission = nextComposerSubmissionId();
  const held = {
    id: `restore-1-${heldSubmission}`,
    ids: [heldSubmission],
    text: 'held prompt',
    device: 'desktop-1',
    at: 1,
  };
  assert.equal(applyPromptRestore(held, '', 's-held'), 'held prompt');
  // 200 other restores, all of one submission minted here, so the held submission stays this device's own.
  const otherSubmission = nextComposerSubmissionId();
  for (let index = 0; index < 200; index += 1) {
    const session = `s-other-${index}`;
    const other = {
      id: `restore-${index}-${otherSubmission}`,
      ids: [otherSubmission],
      text: 'other',
      device: 'desktop-1',
      at: index,
    };
    assert.equal(applyPromptRestore(other, '', session), 'other');
  }
  assert.ok(wasSubmittedHere(heldSubmission), 'ownership alone would apply it again');
  // The held session is shown again: its state still offers the same hand-back (settlement does not clear it).
  assert.equal(applyPromptRestore(held, 'typed since', 's-held'), null, 'one insertion');
  forgetComposerScope('s-held');
  assert.equal(appliedPromptRestores.has('s-held'), false, 'deleting the session drops what it applied');
  for (let index = 0; index < 200; index += 1) forgetComposerScope(`s-other-${index}`);
});

test('the state offer and the Stop replies of one session are remembered separately', () => {
  const restoreOf = (at) => {
    const submission = nextComposerSubmissionId();
    const id = `restore-${at}-${submission}`;
    return {
      offer: { id, ids: [submission], text: `prompt ${at}`, device: 'desktop-1', at },
      reply: { restoreText: `prompt ${at}`, restoreId: id, restoredSubmissionIds: [submission] },
    };
  };
  // R1 by notification, then R2 by reply: the state still offers R1 on a revisit.
  const r1 = restoreOf(1);
  const r2 = restoreOf(2);
  assert.equal(applyPromptRestore(r1.offer, '', 's-a'), 'prompt 1');
  assert.equal(restoreAlreadyApplied(r2.reply, 's-a'), false, 'R2 is inserted by its reply');
  assert.equal(applyPromptRestore(r1.offer, '', 's-a'), null, 'revisit: R1 not inserted again');

  // Reply R2, then the state shows R2, then reply R3: the state still offers R2 on a revisit.
  const s2 = restoreOf(2);
  const s3 = restoreOf(3);
  assert.equal(restoreAlreadyApplied(s2.reply, 's-b'), false, 'R2 is inserted by its reply');
  assert.equal(applyPromptRestore(s2.offer, '', 's-b'), null, 'the state offer of R2 is the reply already applied');
  assert.equal(restoreAlreadyApplied(s3.reply, 's-b'), false, 'R3 is inserted by its reply');
  assert.equal(applyPromptRestore(s2.offer, '', 's-b'), null, 'revisit: R2 not inserted again');
  assert.equal(restoreAlreadyApplied(s3.reply, 's-b'), true, 'a repeated reply R3 inserts nothing');
  forgetComposerScope('s-a');
  forgetComposerScope('s-b');
});

test('a Stop of a submission whose input read is pending puts the prompt back once, by its hand-back only', async () => {
  const scope = 'stopped-start';
  let current;
  let submitted = '';
  let versions = 0;
  const errors = [];
  function Harness() {
    const [draft, setDraft] = useState('my prompt');
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const textarea = useRef(null);
    const [promptRestore, setPromptRestore] = useState(null);
    useComposerPromptRestore({ promptRestore, sessionId: 's1', setDraft, draftRef, textarea });
    current = {
      draft,
      setPromptRestore,
      ...useComposerSubmission({
        turnBusy: false,
        commandBusy: false,
        recoveryScope: scope,
        textarea,
        draftRef,
        attachmentsRef: useRef([]),
        pendingLoads: { current: 0 },
        transitioningRef: useRef(false),
        composingRef: useRef(false),
        submittingRef: useRef(false),
        submissionRetryRef: useRef(null),
        mountedRef: useRef(true),
        historyNavigation: useRef({ index: -1, seed: '' }),
        setDraft,
        setSubmitting() {},
        setSubmissionRecoveryVersion: () => {
          versions += 1;
        },
        clearNotice() {},
        setAttachmentError: (message) => {
          if (message) errors.push(message);
        },
        removeAttachments() {},
        mergeRestoredAttachments: (_attachments, text) => text,
        restoredAttachments: (_value, text) => ({ attachments: [], text }),
        executeSlash: async () => false,
        rememberPrompt() {},
        // The core published the Stop's hand-back for this device, then refused the start with the typed stop outcome.
        submit: async (_content, options) => {
          submitted = options.id;
          setPromptRestore({
            id: `restore-5-${submitted}`,
            ids: [submitted],
            text: 'my prompt',
            device: 'desktop-1',
            at: 5,
          });
          throw Object.assign(new Error('The turn was stopped before it started.'), { code: 'ETURNSTOPPED' });
        },
        abort: async () => ({}),
        sessionId: 's1',
      }),
    };
    return null;
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => current.send());
    assert.ok(submitted, 'the prompt was submitted');
    assert.equal(current.draft, 'my prompt', 'the hand-back put the prompt back once');
    assert.deepEqual(takeRejectedComposerSubmissionRecoveries(scope), [], 'the failed-submission recovery did not run');
    assert.equal(versions, 0);
    assert.deepEqual(errors, [], 'a stop is not a failed send');
  } finally {
    await act(async () => root.unmount());
    forgetComposerScope('s1');
  }
});
