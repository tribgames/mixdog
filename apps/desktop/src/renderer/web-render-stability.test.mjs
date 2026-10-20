import assert from 'node:assert/strict';
import test from 'node:test';

import {
  composerDraftAfterScopeChange,
  rejectComposerSubmissionRecovery,
  resolveComposerSubmissionRecovery,
  retainComposerSubmissionRecovery,
  composerScopeHasContent,
  stashComposerAttachments,
  stashComposerDraft,
  stashComposerTags,
  stashedComposerDraft,
  takeRejectedComposerSubmissionRecoveries,
  takeStashedComposerAttachments,
  takeStashedComposerTags,
} from './composer-draft.ts';
import { isRemoteBrowserRenderer } from './remote-ui-projection.ts';

test('focused web composer keeps the native value across a scope snapshot', () => {
  assert.equal(
    composerDraftAfterScopeChange({
      currentDraft: '입력',
      liveDomDraft: '입력 중',
      freshDraft: false,
      typingLive: true,
    }),
    '입력 중'
  );
});

test('inactive composer still clears a draft when its scope changes', () => {
  assert.equal(
    composerDraftAfterScopeChange({
      currentDraft: 'old session',
      liveDomDraft: 'old session',
      freshDraft: false,
      typingLive: false,
    }),
    ''
  );
});

test('a fresh New Task pane opens clean even while the user is typing', () => {
  assert.equal(
    composerDraftAfterScopeChange({
      currentDraft: '이전 작업 입력',
      liveDomDraft: '이전 작업 입력 중',
      freshDraft: true,
      typingLive: true,
    }),
    ''
  );
});

test('returning to a tab hands back the text typed there before leaving', () => {
  stashComposerDraft('draft:task-1', '쓰다 만 문장');
  assert.equal(
    composerDraftAfterScopeChange({
      currentDraft: '다른 탭 입력',
      liveDomDraft: '다른 탭 입력',
      freshDraft: true,
      typingLive: false,
      stashedDraft: stashedComposerDraft('draft:task-1'),
    }),
    '쓰다 만 문장'
  );
  // Whitespace-only text drops the entry, so a cleared tab reopens clean.
  stashComposerDraft('draft:task-1', '  ');
  assert.equal(stashedComposerDraft('draft:task-1'), '');
  assert.equal(
    composerDraftAfterScopeChange({
      currentDraft: '다른 탭 입력',
      liveDomDraft: '다른 탭 입력',
      freshDraft: true,
      typingLive: false,
      stashedDraft: stashedComposerDraft('draft:task-1'),
    }),
    ''
  );
});

test('returning to a tab hands back the attachments parked there before sending', () => {
  const chip = { id: 3, kind: 'image', name: 'shot.png', mimeType: 'image/png', data: 'AAAA', token: '[Image #3]' };
  assert.equal(composerScopeHasContent('session-a'), false);
  stashComposerAttachments('session-a', [chip]);
  // A tab holding only chips is not an untouched one.
  assert.equal(composerScopeHasContent('session-a'), true);
  assert.deepEqual(takeStashedComposerAttachments('session-b'), []);
  assert.deepEqual(takeStashedComposerAttachments('session-a'), [chip]);
  // Handed back once: the live composer owns them again.
  assert.deepEqual(takeStashedComposerAttachments('session-a'), []);
  // Leaving with no chips drops the entry.
  stashComposerAttachments('session-a', [chip]);
  stashComposerAttachments('session-a', []);
  assert.deepEqual(takeStashedComposerAttachments('session-a'), []);
});

test('returning to an agent room hands back the members tagged there before sending', () => {
  stashComposerTags('room-a', ['agent-1', 'agent-2']);
  assert.deepEqual(takeStashedComposerTags('room-b'), []);
  assert.deepEqual(takeStashedComposerTags('room-a'), ['agent-1', 'agent-2']);
  assert.deepEqual(takeStashedComposerTags('room-a'), []);
  stashComposerTags('room-a', ['agent-1']);
  stashComposerTags('room-a', []);
  assert.deepEqual(takeStashedComposerTags('room-a'), []);
});

test('a rejected web submission survives a composer remount until its pane restores it', () => {
  retainComposerSubmissionRecovery({
    id: 'rejected-submit',
    scope: 'pane-a',
    text: '사라지면 안 되는 입력',
    attachments: [],
  });
  assert.deepEqual(takeRejectedComposerSubmissionRecoveries('pane-a'), []);
  rejectComposerSubmissionRecovery('rejected-submit');
  assert.deepEqual(takeRejectedComposerSubmissionRecoveries('pane-a'), [
    {
      id: 'rejected-submit',
      scope: 'pane-a',
      text: '사라지면 안 되는 입력',
      attachments: [],
    },
  ]);
  assert.deepEqual(takeRejectedComposerSubmissionRecoveries('pane-a'), []);
});

test('an accepted web submission discards its recovery copy', () => {
  retainComposerSubmissionRecovery({
    id: 'accepted-submit',
    scope: 'pane-b',
    text: '전송 완료',
    attachments: [],
  });
  resolveComposerSubmissionRecovery('accepted-submit');
  rejectComposerSubmissionRecovery('accepted-submit');
  assert.deepEqual(takeRejectedComposerSubmissionRecoveries('pane-b'), []);
});

test('browser and Electron renderers select distinct transcript update paths', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Mozilla/5.0 Mobile Safari' },
    });
    assert.equal(isRemoteBrowserRenderer(), true);
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Mozilla/5.0 Electron/40.8.4' },
    });
    assert.equal(isRemoteBrowserRenderer(), false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete globalThis.navigator;
  }
});
