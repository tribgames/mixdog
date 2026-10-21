import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: {
    url: 'https://mixdog.test/',
  },
  expose: ['navigator'],
});
dom.window.HTMLElement.prototype.attachEvent ??= () => {};
dom.window.HTMLElement.prototype.detachEvent ??= () => {};
window.mixdogDesktop = {
  rendererDiagnostic() {},
};

const { useComposerAttachments } = await import('./use-composer-attachments.ts');
const { useComposerSubmission } = await import('./use-composer-submission.ts');
const { useComposerKeyboard } = await import('./use-composer-keyboard.ts');
const { submissionRetryKey, takeRejectedComposerSubmissionRecoveries } = await import('./composer-draft.ts');
const { sha256Bytes, sha256Hex } = await import('./sha256.ts');
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const { useComposerShareIntake } = await import('./use-composer-share-intake.ts');
const { publishSharedIntake, resetSharedIntake } = await import('./share-target-intake.ts');

function mountHarness(Component, props) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  return {
    render: (nextProps) =>
      act(async () => {
        root.render(React.createElement(Component, nextProps));
      }),
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
    initial: props,
  };
}

test('attachment hook keeps state, refs, draft tokens, and reset in sync', async () => {
  let current;
  function Harness() {
    const [draft, setDraft] = useState('[File #1]');
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const textarea = useRef(null);
    const historyNavigation = useRef({ index: -1, seed: '' });
    const transitioningRef = useRef(false);
    const dropTargetRef = useRef(null);
    current = {
      draft,
      ...useComposerAttachments({
        draftRef,
        setDraft,
        textarea,
        historyNavigation,
        transitioningRef,
        projectScope: 'C:/Project/demo',
        recoveryScope: 'session-a',
        submissionRecoveryVersion: 0,
        dropTargetRef,
      }),
    };
    return React.createElement(
      'div',
      { ref: dropTargetRef },
      React.createElement('textarea', { ref: textarea, value: draft, readOnly: true })
    );
  }
  const mounted = mountHarness(Harness, {});
  try {
    await mounted.render({});
    const attachment = {
      id: 1,
      name: 'notes.txt',
      kind: 'text',
      mimeType: 'text/plain',
      data: 'notes',
      token: '[File #1]',
      source: 'file',
    };
    await act(async () => current.replaceAttachments([attachment]));
    assert.deepEqual(
      current.attachments.map((item) => item.id),
      [1]
    );
    assert.deepEqual(
      current.attachmentsRef.current.map((item) => item.id),
      [1]
    );

    await act(async () => current.removeAttachment(attachment));
    assert.equal(current.attachments.length, 0);
    assert.equal(current.attachmentsRef.current.length, 0);
    assert.equal(current.draft, '');

    await act(async () => current.setDraggingFiles(true));
    assert.equal(current.draggingFiles, true);
    await act(async () => current.resetAttachments());
    assert.equal(current.draggingFiles, false);
    assert.equal(current.attachmentError, '');
  } finally {
    await mounted.cleanup();
  }
});

test('submission hook commits accepted text and restores interrupted text', async () => {
  let current;
  let submitted;
  function Harness() {
    const [draft, setDraft] = useState('hello');
    const [submitting, setSubmitting] = useState(false);
    const [, setSubmissionRecoveryVersion] = useState(0);
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const textarea = useRef(null);
    const attachmentsRef = useRef([]);
    const transitioningRef = useRef(false);
    const composingRef = useRef(false);
    const submittingRef = useRef(false);
    const submissionRetryRef = useRef(null);
    const mountedRef = useRef(true);
    const historyNavigation = useRef({ index: -1, seed: '' });
    current = {
      draft,
      submitting,
      ...useComposerSubmission({
        turnBusy: false,
        commandBusy: false,
        draftMode: false,
        queued: [],
        recoveryScope: 'session-submit',
        textarea,
        draftRef,
        attachmentsRef,
        pendingLoads: { current: 0 },
        transitioningRef,
        composingRef,
        submittingRef,
        submissionRetryRef,
        mountedRef,
        historyNavigation,
        setDraft,
        setSubmitting,
        setSubmissionRecoveryVersion,
        clearNotice() {},
        setAttachmentError() {},
        removeAttachments() {},
        mergeRestoredAttachments: (_attachments, text) => text,
        restoredAttachments: (_value, text) => ({ attachments: [], text }),
        executeSlash: async () => true,
        rememberPrompt() {},
        submit: async (content, options) => {
          submitted = { content, options };
          return true;
        },
        abort: async () => ({ restoreText: 'interrupted' }),
      }),
    };
    return React.createElement('textarea', { ref: textarea, value: draft, readOnly: true });
  }
  const mounted = mountHarness(Harness, {});
  try {
    await mounted.render({});
    await act(async () => {
      await current.send();
    });
    assert.equal(submitted.content, 'hello');
    assert.ok(submitted.options.id);
    assert.equal(current.draft, '');
    assert.equal(current.submitting, false);

    await act(async () => {
      await current.stop();
    });
    assert.equal(current.draft, 'interrupted');
  } finally {
    await mounted.cleanup();
  }
});

test('an ambiguous failure restored onto a colliding chip id is renumbered and resent under the same submission id', async () => {
  let current;
  const sends = [];
  let failFirst;
  // A send awaits its retry key (the chips' Web Crypto digests) before it
  // calls submit, so submit has not run when act() returns. The stub signals
  // the call, and the test waits on that.
  let firstSubmitCalled;
  const firstSubmitted = new Promise((resolve) => {
    firstSubmitCalled = resolve;
  });
  function Harness() {
    const [draft, setDraft] = useState('review this');
    const [, setSubmitting] = useState(false);
    const [submissionRecoveryVersion, setSubmissionRecoveryVersion] = useState(0);
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const textarea = useRef(null);
    const historyNavigation = useRef({ index: -1, seed: '' });
    const transitioningRef = useRef(false);
    const attachments = useComposerAttachments({
      draftRef,
      setDraft,
      textarea,
      historyNavigation,
      transitioningRef,
      projectScope: 'C:/Project/demo',
      recoveryScope: 'session-retry',
      submissionRecoveryVersion,
      dropTargetRef: useRef(null),
    });
    current = {
      draft,
      ...attachments,
      ...useComposerSubmission({
        turnBusy: false,
        commandBusy: false,
        draftMode: false,
        queued: [],
        recoveryScope: 'session-retry',
        textarea,
        draftRef,
        attachmentsRef: attachments.attachmentsRef,
        pendingLoads: { current: 0 },
        transitioningRef,
        composingRef: useRef(false),
        submittingRef: useRef(false),
        submissionRetryRef: useRef(null),
        mountedRef: useRef(true),
        historyNavigation,
        setDraft,
        setSubmitting,
        setSubmissionRecoveryVersion,
        clearNotice() {},
        setAttachmentError() {},
        removeAttachments: attachments.removeAttachments,
        mergeRestoredAttachments: attachments.mergeRestoredAttachments,
        restoredAttachments: attachments.restoredAttachments,
        executeSlash: async () => true,
        rememberPrompt() {},
        submit: (content, options) => {
          sends.push({ content, options });
          if (sends.length === 1) {
            return new Promise((_resolve, reject) => {
              failFirst = () => reject(new Error('connection interrupted'));
              firstSubmitCalled();
            });
          }
          return Promise.resolve(true);
        },
        abort: async () => ({}),
      }),
    };
    return React.createElement('textarea', { ref: textarea, value: draft, readOnly: true });
  }
  const mounted = mountHarness(Harness, {});
  const pdf = {
    id: 1,
    name: 'report.pdf',
    kind: 'pdf',
    mimeType: 'application/pdf',
    data: 'JVBERi0xLjQ=',
    token: '[PDF #1: report.pdf]',
    chipOnly: true,
  };
  try {
    await mounted.render({});
    await act(async () => current.replaceAttachments([pdf]));
    // The send goes out; it is unknown whether it arrived when it fails.
    let first;
    await act(async () => {
      first = current.send();
      await firstSubmitted;
    });
    // Meanwhile a new chip takes id 1 in the cleared composer.
    const image = { id: 1, name: 'shot.png', kind: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=', token: '' };
    await act(async () => current.replaceAttachments([image]));
    await act(async () => {
      failFirst();
      await first;
    });
    const restoredPdf = current.attachments.find((attachment) => attachment.kind === 'pdf');
    assert.ok(restoredPdf, 'the failed message came back');
    assert.notEqual(restoredPdf.id, 1, 'it was renumbered past the live chip');
    assert.equal(restoredPdf.token, `[PDF #${restoredPdf.id}: report.pdf]`);
    assert.equal(current.draft, 'review this');
    // The user drops the new chip and sends the same message again.
    await act(async () => current.removeAttachment(current.attachments.find((attachment) => attachment.id === 1)));
    await act(async () => {
      await current.send();
    });
    assert.equal(sends.length, 2);
    assert.equal(sends[1].options.id, sends[0].options.id, 'same message, same submission id');
    assert.deepEqual(
      sends[1].content,
      sends[0].content.map((part) =>
        part.type === 'text' ? { ...part, text: part.text.replace('#1', `#${restoredPdf.id}`) } : part
      )
    );
  } finally {
    await mounted.cleanup();
  }
});

test('the retry key tells apart contents a 32-bit hash confuses; same content, same key', async () => {
  // An equal-length FNV-1a 32-bit collision pair.
  const [left, right] = ['S3cCAAAA', 'wBADAAAA'];
  const fnv = (value) => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  };
  assert.equal(fnv(left), fnv(right), 'the pair really collides under FNV-1a');
  const chip = (data, id = 1) => ({
    id,
    name: 'shot.png',
    kind: 'image',
    mimeType: 'image/png',
    data,
    token: '',
  });
  const key = (data, id) => submissionRetryKey(['', 'look'], [chip(data, id)]);
  assert.notEqual(await key(left), await key(right));
  assert.equal(await key(left, 1), await key(left, 7), 'chip ids are not part of it');
});

test('a chip’s content digest is worked out once, when it enters the composer', async () => {
  const subtle = globalThis.crypto.subtle;
  const original = subtle.digest;
  let digests = 0;
  subtle.digest = function digest(...args) {
    digests += 1;
    return original.apply(this, args);
  };
  let current;
  function Harness() {
    const [draft, setDraft] = useState('');
    const draftRef = useRef(draft);
    draftRef.current = draft;
    current = useComposerAttachments({
      draftRef,
      setDraft,
      textarea: useRef(null),
      historyNavigation: useRef({ index: -1, seed: '' }),
      transitioningRef: useRef(false),
      projectScope: 'C:/Project/demo',
      recoveryScope: 'session-digest',
      submissionRecoveryVersion: 0,
      dropTargetRef: useRef(null),
    });
    return null;
  }
  const mounted = mountHarness(Harness, {});
  try {
    await mounted.render({});
    const file = {
      id: 1,
      name: 'notes.txt',
      kind: 'text',
      mimeType: 'text/plain',
      data: 'notes',
      token: '[File #1: notes.txt]',
      source: 'file',
      chipOnly: true,
    };
    await act(async () => current.replaceAttachments([file]));
    assert.equal(digests, 1);
    const [added] = current.attachmentsRef.current;
    const first = await submissionRetryKey(['', file.token], [added]);
    // Re-set, renumbered on a restore, and keyed again: no new digest.
    await act(async () => current.replaceAttachments([...current.attachmentsRef.current]));
    await act(async () => current.replaceAttachments([{ ...added, id: 4, token: '[File #4: notes.txt]' }]));
    const moved = current.attachmentsRef.current[0];
    assert.equal(await submissionRetryKey(['', moved.token], [moved]), first);
    assert.equal(digests, 1, 'one digest for the chip, however often it is copied or keyed');
    // Changed data is hashed again, once.
    await act(async () => current.replaceAttachments([{ ...moved, data: 'other notes' }]));
    assert.equal(digests, 2);
    assert.notEqual(await submissionRetryKey(['', moved.token], current.attachmentsRef.current), first);
  } finally {
    subtle.digest = original;
    await mounted.cleanup();
  }
});

/** The composer's attachment and submission hooks on one draft, sending into
 *  the conversation its props name. */
function sendingComposer(sends, initialDraft) {
  const view = { current: null };
  function Harness({ scope, identity = scope, recovery = `pane:${scope}`, session = scope }) {
    const [draft, setDraft] = useState(initialDraft);
    const [, setSubmitting] = useState(false);
    const [submissionRecoveryVersion, setSubmissionRecoveryVersion] = useState(0);
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const textarea = useRef(null);
    const historyNavigation = useRef({ index: -1, seed: '' });
    const transitioningRef = useRef(false);
    const attachments = useComposerAttachments({
      draftRef,
      setDraft,
      textarea,
      historyNavigation,
      transitioningRef,
      projectScope: 'C:/Project/demo',
      recoveryScope: recovery,
      submissionRecoveryVersion,
      dropTargetRef: useRef(null),
    });
    view.current = {
      draft,
      ...attachments,
      ...useComposerSubmission({
        turnBusy: false,
        commandBusy: false,
        draftMode: false,
        queued: [],
        recoveryScope: recovery,
        identityScope: identity,
        sessionId: session,
        textarea,
        draftRef,
        attachmentsRef: attachments.attachmentsRef,
        pendingLoads: { current: 0 },
        transitioningRef,
        composingRef: useRef(false),
        submittingRef: useRef(false),
        submissionRetryRef: useRef(null),
        mountedRef: useRef(true),
        historyNavigation,
        setDraft,
        setSubmitting,
        setSubmissionRecoveryVersion,
        clearNotice() {},
        setAttachmentError() {},
        removeAttachments: attachments.removeAttachments,
        mergeRestoredAttachments: attachments.mergeRestoredAttachments,
        restoredAttachments: attachments.restoredAttachments,
        executeSlash: async () => true,
        rememberPrompt() {},
        submit: async (content, options) => {
          sends.push({ scope, content, options });
          return true;
        },
        abort: async () => ({}),
      }),
    };
    return React.createElement('textarea', { ref: textarea, value: draft, readOnly: true });
  }
  return { view, mounted: mountHarness(Harness, {}) };
}

const notesFile = (data = 'notes body') => ({
  id: 1,
  name: 'notes.txt',
  kind: 'text',
  mimeType: 'text/plain',
  data,
  token: '[File #1: notes.txt]',
  source: 'file',
  chipOnly: true,
});

test('a session switch while a send waits for its digests sends nothing and leaves the draft as it was', async () => {
  const subtle = globalThis.crypto.subtle;
  const original = subtle.digest;
  const held = [];
  subtle.digest = function digest(...args) {
    return new Promise((resolve) => held.push(() => resolve(original.apply(this, args))));
  };
  const sends = [];
  const { view, mounted } = sendingComposer(sends, 'message for A');
  try {
    await mounted.render({ scope: 'A' });
    await act(async () => view.current.replaceAttachments([notesFile()]));
    let sending;
    await act(async () => {
      sending = view.current.send();
    });
    // The user switches to B while the digest is still being worked out.
    await mounted.render({ scope: 'B' });
    await act(async () => {
      for (const release of held) release();
      await sending;
    });
    assert.deepEqual(sends, [], 'nothing went to A or B');
    assert.equal(view.current.draft, 'message for A', 'the draft was not cleared');
    assert.deepEqual(
      view.current.attachments.map((attachment) => [attachment.id, attachment.data]),
      [[1, 'notes body']],
      'its chip was not removed'
    );
    assert.deepEqual(takeRejectedComposerSubmissionRecoveries('pane:A'), []);
    assert.deepEqual(takeRejectedComposerSubmissionRecoveries('pane:B'), []);
  } finally {
    subtle.digest = original;
    await mounted.cleanup();
  }
});

test('draft A → draft B in the same pane while a send waits for its digests sends nothing and keeps A', async () => {
  const subtle = globalThis.crypto.subtle;
  const original = subtle.digest;
  const held = [];
  subtle.digest = function digest(...args) {
    return new Promise((resolve) => held.push(() => resolve(original.apply(this, args))));
  };
  const sends = [];
  const { view, mounted } = sendingComposer(sends, 'message for draft A');
  // Two new-task drafts: no session, the same recovery scope; only the
  // composer's identity tells them apart.
  const draft = (id) => ({ scope: id, identity: `draft:${id}`, recovery: 'new-task', session: '' });
  try {
    await mounted.render(draft('a'));
    await act(async () => view.current.replaceAttachments([notesFile()]));
    let sending;
    await act(async () => {
      sending = view.current.send();
    });
    await mounted.render(draft('b'));
    await act(async () => {
      for (const release of held) release();
      await sending;
    });
    assert.deepEqual(sends, [], "A's message never goes out with B's routing");
    assert.equal(view.current.draft, 'message for draft A');
    assert.deepEqual(
      view.current.attachments.map((attachment) => [attachment.id, attachment.data]),
      [[1, 'notes body']]
    );
    assert.deepEqual(takeRejectedComposerSubmissionRecoveries('new-task'), []);
    // Unchanged conversation: the same send goes out.
    await mounted.render(draft('b'));
    await act(async () => {
      sending = view.current.send();
    });
    await act(async () => {
      for (const release of held.splice(0)) release();
      await sending;
    });
    assert.equal(sends.length, 1);
  } finally {
    subtle.digest = original;
    await mounted.cleanup();
  }
});

test('sha256Hex matches Web Crypto, and works without crypto.subtle (plain-http phone)', async () => {
  const subtle = globalThis.crypto.subtle;
  const web = async (value) =>
    Array.from(new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(value))), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('');
  assert.equal(
    hex(sha256Bytes(new TextEncoder().encode('abc'))),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
  for (const value of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), '한글 ✓'.repeat(500)]) {
    assert.equal(hex(sha256Bytes(new TextEncoder().encode(value))), await web(value), `${value.length} chars`);
  }
  Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true });
  const sends = [];
  const { view, mounted } = sendingComposer(sends, 'look');
  try {
    assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    await mounted.render({ scope: 'A' });
    await act(async () => view.current.replaceAttachments([notesFile()]));
    await act(async () => {
      await view.current.send();
    });
    assert.equal(sends.length, 1, 'the send went out');
    assert.equal(view.current.draft, '');
    assert.deepEqual(view.current.attachments, []);
  } finally {
    delete globalThis.crypto.subtle;
    await mounted.cleanup();
  }
  assert.equal(globalThis.crypto.subtle, subtle);
});

test('a failing Web Crypto digest falls back and never surfaces as an unhandled rejection', async () => {
  const subtle = globalThis.crypto.subtle;
  const original = subtle.digest;
  subtle.digest = () => Promise.reject(new Error('digest unavailable'));
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const sends = [];
  const { view, mounted } = sendingComposer(sends, 'look');
  try {
    await mounted.render({ scope: 'A' });
    // A digest is started and nobody awaits it for a while.
    await act(async () => view.current.replaceAttachments([notesFile()]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const key = await submissionRetryKey(['look'], view.current.attachmentsRef.current);
    subtle.digest = original;
    assert.equal(key, await submissionRetryKey(['look'], [notesFile()]), 'the fallback digest is the SHA-256');
    await act(async () => {
      await view.current.send();
    });
    assert.equal(sends.length, 1);
    assert.deepEqual(unhandled, []);
  } finally {
    subtle.digest = original;
    process.off('unhandledRejection', onUnhandled);
    await mounted.cleanup();
  }
});

test('submission hook refuses to send while an attachment is still loading and keeps the draft', async () => {
  let current;
  let submitted = 0;
  const errors = [];
  const pendingLoads = { current: 1 };
  function Harness() {
    const [draft, setDraft] = useState('look at this');
    const [, setSubmitting] = useState(false);
    const [, setSubmissionRecoveryVersion] = useState(0);
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const textarea = useRef(null);
    current = {
      draft,
      ...useComposerSubmission({
        turnBusy: false,
        commandBusy: false,
        draftMode: false,
        queued: [],
        recoveryScope: 'session-pending',
        textarea,
        draftRef,
        attachmentsRef: useRef([]),
        pendingLoads,
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
        setAttachmentError: (message) => errors.push(message),
        removeAttachments() {},
        mergeRestoredAttachments: (_attachments, text) => text,
        restoredAttachments: (_value, text) => ({ attachments: [], text }),
        executeSlash: async () => true,
        rememberPrompt() {},
        submit: async () => {
          submitted += 1;
          return true;
        },
        abort: async () => ({}),
      }),
    };
    return React.createElement('textarea', { ref: textarea, value: draft, readOnly: true });
  }
  const mounted = mountHarness(Harness, {});
  try {
    await mounted.render({});
    await act(async () => {
      await current.send();
    });
    assert.equal(submitted, 0);
    assert.equal(current.draft, 'look at this');
    assert.match(errors.join('\n'), /Attachments are still loading/);

    pendingLoads.current = 0;
    await act(async () => {
      await current.send();
    });
    assert.equal(submitted, 1);
    assert.equal(current.draft, '');
  } finally {
    await mounted.cleanup();
  }
});

test('keyboard hook restores history, inserts mentions, and scrolls only appended newlines', async () => {
  let current;
  let sent = 0;
  function Harness() {
    const [draft, setDraft] = useState('');
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const textarea = useRef(null);
    const historyNavigation = useRef({ index: -1, seed: '' });
    const historySeedAttachments = useRef([]);
    const attachmentsRef = useRef([]);
    const escapeClearAt = useRef(0);
    const composing = useRef(false);
    const suppressLineBreak = useRef(false);
    current = {
      draft,
      setDraft,
      textarea,
      ...useComposerKeyboard({
        draft: {
          value: draft,
          set: setDraft,
          ref: draftRef,
          textarea,
          setCaretOffset() {},
        },
        slash: {
          open: false,
          commands: [],
          index: 0,
          setIndex() {},
          setDismissed() {},
        },
        mention: {
          match: { start: 0, end: 0, query: '' },
          open: false,
          signature: '',
          results: [],
          index: 0,
          setIndex() {},
          setDismissed() {},
          setResults() {},
        },
        skillMention: {
          match: null,
          open: false,
          signature: '',
          results: [],
          index: 0,
          setIndex() {},
          setDismissed() {},
        },
        selector: {
          open: false,
          setOpen() {},
          index: 0,
          setIndex() {},
          messages: [],
          openSelector() {},
          rewindToMessage: async () => {},
        },
        history: {
          entries: [{ text: 'previous prompt' }],
          navigation: historyNavigation,
          seedAttachments: historySeedAttachments,
          attachmentsRef,
          replaceAttachments() {},
        },
        runtime: {
          turnBusy: false,
          draftMode: false,
          pendingSubmissionId: '',
          attachments: [],
          escapeClearAt,
          showNotice() {},
        },
        ime: { composing, suppressLineBreak },
        actions: {
          send: async () => {
            sent += 1;
          },
          stop: async () => {},
          clearAttachments() {},
        },
      }),
    };
    return React.createElement('textarea', {
      ref: textarea,
      value: draft,
      readOnly: true,
    });
  }
  const mounted = mountHarness(Harness, {});
  try {
    await mounted.render({});
    const textarea = current.textarea.current;
    textarea.setSelectionRange(0, 0);
    let prevented = false;
    await act(async () => {
      current.onKeyDown({
        key: 'ArrowUp',
        currentTarget: textarea,
        nativeEvent: { isComposing: false, keyCode: 38 },
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        repeat: false,
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation() {},
      });
    });
    assert.equal(prevented, true);
    assert.equal(current.draft, 'previous prompt');

    await act(async () => current.setDraft(''));
    await act(async () => current.selectMention('src/App.tsx'));
    assert.equal(current.draft, '@src/App.tsx ');
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));

    // JSDOM has no layout; provide an overflowing textarea's measured height.
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, get: () => 480 });
    for (const caret of [11, 5]) {
      await act(async () => current.setDraft('first\nlast!'));
      textarea.setSelectionRange(caret, caret);
      textarea.scrollTop = 20;
      prevented = false;
      await act(async () => {
        current.onKeyDown({
          key: 'Enter',
          currentTarget: textarea,
          nativeEvent: { isComposing: false, keyCode: 13 },
          shiftKey: false,
          ctrlKey: true,
          metaKey: false,
          altKey: false,
          repeat: false,
          preventDefault: () => {
            prevented = true;
          },
          stopPropagation() {},
        });
      });
      await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
      assert.equal(prevented, true);
      assert.equal(current.draft, caret === 11 ? 'first\nlast!\n' : 'first\n\nlast!');
      assert.equal(textarea.selectionStart, caret + 1);
      assert.equal(textarea.selectionEnd, caret + 1);
      assert.equal(textarea.scrollTop, caret === 11 ? 480 : 20);
    }

    // Plain Enter sends on desktop but keeps its native line break on phones.
    const plainEnter = () =>
      current.onKeyDown({
        key: 'Enter',
        currentTarget: textarea,
        nativeEvent: { isComposing: false, keyCode: 13 },
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        repeat: false,
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation() {},
      });
    prevented = false;
    await act(async () => plainEnter());
    assert.equal(prevented, true);
    assert.equal(sent, 1);

    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      get: () => 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile',
    });
    try {
      prevented = false;
      await act(async () => plainEnter());
      assert.equal(prevented, false);
      assert.equal(sent, 1);
    } finally {
      delete navigator.userAgent;
    }
  } finally {
    await mounted.cleanup();
  }
});

test('a shared payload lands only in the composer the user can see', async () => {
  resetSharedIntake();
  const attached = [];
  const appended = [];
  function Harness({ active }) {
    useComposerShareIntake({
      active,
      attachFiles: (files) => {
        attached.push(...files);
      },
      appendText: (text) => {
        appended.push(text);
      },
    });
    return React.createElement('div', null);
  }
  const mounted = mountHarness(Harness, { active: false });
  try {
    await mounted.render({ active: false });
    const shared = new File(['bytes'], 'screenshot.png', { type: 'image/png' });
    await act(async () => publishSharedIntake({ files: [shared], text: 'note' }));
    // A pane that is not the visible one must never swallow the share.
    assert.equal(attached.length, 0);
    assert.equal(appended.length, 0);

    // Becoming the visible pane takes the payload that was waiting.
    await mounted.render({ active: true });
    assert.deepEqual(
      attached.map((file) => file.name),
      ['screenshot.png']
    );
    assert.deepEqual(appended, ['note']);

    // One payload, one arrival: returning to this composer cannot re-attach it.
    await mounted.render({ active: false });
    await mounted.render({ active: true });
    assert.equal(attached.length, 1);
    assert.equal(appended.length, 1);
  } finally {
    await mounted.cleanup();
    resetSharedIntake();
  }
});
