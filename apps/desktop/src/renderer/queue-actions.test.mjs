import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

import {
  hasSendablePromptContent,
  isComposerNewlineChord,
  shouldBlockPromptSubmit,
  shouldInterruptPrompt,
  shouldNavigatePromptHistory,
  shouldStopComposerGeneration,
} from './renderer-logic.mjs';
import { paneActiveSessionIds } from './pane-layout.ts';
import { classifyPromptEscape } from '../../../../src/tui/components/prompt-input/escape-policy.mjs';
import {
  mergeQueuedRestoreDraft,
  paletteOwnsPromptVerticalArrow,
  queuedRestorePrefix,
  queuedRestoreProjection,
  replaceQueuedRestorePrefix,
} from '../../../../src/tui/components/prompt-input/restore-policy.mjs';

function installDom() {
  const { restore } = installTestDom(null, { jsdom: { url: 'http://localhost/' }, expose: ['navigator'] });
  return {
    root: createRoot(document.getElementById('root')),
    close: restore,
  };
}

test('queued follow-up Escape behavior keeps queue priority and handoff', () => {
  assert.equal(
    classifyPromptEscape({
      interruptActive: true,
      hasSelection: true,
      hasQueuedMessages: true,
      value: '',
    }).action,
    'interrupt',
    'an active turn wins even when draft text is selected'
  );
  assert.equal(
    classifyPromptEscape({
      interruptActive: false,
      hasSelection: true,
      hasQueuedMessages: true,
      value: 'selected draft',
    }).action,
    'collapse-selection',
    'idle selection keeps its existing first-Escape behavior'
  );
  assert.equal(
    classifyPromptEscape({
      interruptActive: false,
      hasQueuedMessages: true,
      value: 'current draft',
    }).action,
    'restore-queue'
  );
  assert.deepEqual(
    mergeQueuedRestoreDraft('queued follow-up', {
      value: 'current draft',
      cursor: 7,
      selectionAnchor: null,
    }),
    {
      value: 'queued follow-up\ncurrent draft',
      cursor: 24,
      selectionAnchor: null,
    }
  );

  assert.equal(
    shouldInterruptPrompt({
      turnBusy: false,
      pendingSubmissionId: 'submitted-before-busy-paint',
    }),
    true,
    'an accepted prompt interrupts before the busy snapshot paints'
  );
  assert.equal(
    shouldInterruptPrompt({
      turnBusy: false,
      pendingSubmissionId: 'draft-submit',
      draftMode: true,
    }),
    false,
    'New task materialization keeps its separate submit ownership'
  );
});

test('existing-session Enter does not wait for the previous host acknowledgement', () => {
  // A draft's follow-up joins the session its first submit is minting, so it
  // is queued rather than dropped; useAppSubmitRouting owns the single mint.
  assert.equal(shouldBlockPromptSubmit({ submitting: true, slashCommand: false }), false);
  assert.equal(shouldBlockPromptSubmit({ submitting: true, slashCommand: true }), true);
});

test('an image-only composer submit remains sendable during an active turn', () => {
  const image = { token: '', kind: 'image' };
  assert.equal(hasSendablePromptContent({ text: '', attachments: [image] }), true);
  assert.equal(
    shouldStopComposerGeneration({
      turnBusy: true,
      text: '',
      attachments: [image],
    }),
    false,
    'the send control must not turn into Stop while an image is queued'
  );
  assert.equal(
    shouldStopComposerGeneration({
      turnBusy: true,
      text: '',
      attachments: [],
    }),
    true
  );
});

test('prompt arrows enter history only from an empty draft', () => {
  assert.equal(
    shouldNavigatePromptHistory({
      key: 'ArrowUp',
      value: 'current draft',
      selectionStart: 0,
    }),
    false,
    'an existing draft keeps native cursor navigation'
  );
  assert.equal(
    shouldNavigatePromptHistory({
      key: 'ArrowUp',
      value: '',
      selectionStart: 0,
    }),
    true,
    'an empty draft may enter prompt history'
  );
  assert.equal(
    shouldNavigatePromptHistory({
      key: 'ArrowUp',
      value: 'current draft',
      selectionStart: 0,
      allowNonEmpty: true,
    }),
    true,
    'queued restore may reclaim above a non-empty first-line draft'
  );
  assert.equal(
    shouldNavigatePromptHistory({
      key: 'ArrowUp',
      value: 'history entry',
      selectionStart: 0,
      historyActive: true,
    }),
    true,
    'active history navigation may continue backward'
  );
  assert.equal(
    shouldNavigatePromptHistory({
      key: 'ArrowDown',
      value: 'history entry',
      selectionStart: 13,
      historyActive: true,
    }),
    true,
    'active history navigation may continue toward the seed'
  );
});

test('queue parity helpers preserve order, rollback exact prefixes, and guard meta entries', () => {
  assert.deepEqual(
    queuedRestoreProjection([
      { id: 'one', displayText: 'first' },
      { id: 'two', text: 'second' },
    ]),
    {
      count: 2,
      ids: ['one', 'two'],
      text: 'first\nsecond',
    }
  );
  const optimisticPrefix = queuedRestorePrefix('queued', 'draft');
  assert.equal(optimisticPrefix, 'queued\n');
  assert.deepEqual(
    replaceQueuedRestorePrefix(optimisticPrefix, 'confirmed\n', {
      value: 'queued\ndraft plus',
      cursor: 17,
      selectionAnchor: null,
    }),
    {
      value: 'confirmed\ndraft plus',
      cursor: 20,
      selectionAnchor: null,
      replaced: true,
    }
  );
  assert.equal(paletteOwnsPromptVerticalArrow(1), false);
  assert.equal(paletteOwnsPromptVerticalArrow(2), true);
});

test('PANE active sessions follow focused pane order', () => {
  const session = (id) => ({ kind: 'session', id });
  const leaves = [
    {
      type: 'leaf',
      id: 'left',
      tabs: [session('left-inactive'), session('left-active')],
      activeKey: 'session:left-active',
    },
    {
      type: 'leaf',
      id: 'right',
      tabs: [
        session('right-active'),
        { kind: 'file', project: 'C:/Project/mixdog', rel: 'README.md' },
        session('left-inactive'),
      ],
      activeKey: 'session:right-active',
    },
  ];

  assert.deepEqual(paneActiveSessionIds(leaves, 'right'), ['right-active', 'left-active']);
});

test('COMPOSER Shift+Enter breaks the line even right after a shifted character', () => {
  // Shift held from typing '?' (Shift+/) is still a newline chord on Enter.
  assert.equal(isComposerNewlineChord({ key: 'Enter', shiftKey: true }), true);
  assert.equal(isComposerNewlineChord({ key: 'Enter', ctrlKey: true }), true);
  assert.equal(isComposerNewlineChord({ key: 'Enter', altKey: true }), true);
  assert.equal(isComposerNewlineChord({ key: 'Enter', metaKey: true }), true);
  assert.equal(isComposerNewlineChord({ key: 'Enter' }), false);
  assert.equal(isComposerNewlineChord({ key: 'a', shiftKey: true }), false);
});