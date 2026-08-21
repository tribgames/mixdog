import test from 'node:test';
import assert from 'node:assert/strict';
import { isLiveSpinnerMetaVisible } from './live-spinner-visibility.mjs';

const visible = (overrides = {}) => isLiveSpinnerMetaVisible({
  inputBoxHidden: false,
  slashPaletteOpen: false,
  liveSpinner: { active: true },
  liveSpinnerIsCommand: false,
  latestTranscriptItem: null,
  streamingTail: null,
  transcriptViewActive: false,
  ...overrides,
});

test('visible assistant streaming text replaces the agent spinner', () => {
  assert.equal(visible({
    streamingTail: {
      kind: 'assistant',
      streaming: true,
      text: 'Checking the command path.\n',
    },
  }), false);
});

test('empty or hidden assistant streams do not suppress spinner feedback', () => {
  const streamingTail = { kind: 'assistant', streaming: true, text: '' };
  assert.equal(visible({ streamingTail }), true);
  assert.equal(visible({
    streamingTail: { ...streamingTail, text: 'Visible only in the live window.\n' },
    transcriptViewActive: true,
  }), true);
});

test('command status remains visible when an assistant tail is present', () => {
  assert.equal(visible({
    liveSpinnerIsCommand: true,
    streamingTail: {
      kind: 'assistant',
      streaming: true,
      text: 'Stale assistant tail.\n',
    },
  }), true);
});
