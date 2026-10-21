// The runtime's "latest message cannot fit" failure reaches the desktop in
// English with its sizes inline; the error notice and the transcript status
// re-speak it through the catalog sentence by sentence.
import assert from 'node:assert/strict';
import test from 'node:test';

import { errorSummary } from './ErrorNotice.tsx';
import { localizeErrorRecovery } from './error-notice-copy.ts';
import { localizedTurnFailureReason } from './transcript-failure-text.ts';
import i18n from './i18n.ts';
// @ts-expect-error Shared runtime module is plain ESM.
import { presentErrorText } from '../../../../src/runtime/shared/err-text.mjs';
// @ts-expect-error Shared runtime module is plain ESM.
import { describeError } from '../../../../src/runtime/shared/error-presentation.mjs';

const runtime =
  'The latest message cannot fit this model (LATEST_TURN_EXCEEDS_CONTEXT): it needs about 471,912 tokens, ' +
  'but the 500,000-token window leaves 357,142 for it. Its attachments alone are about 464,128 tokens. ' +
  'Shorten the message or move large pasted text into a file the model can read. ' +
  'A larger context window helps only if it holds 471,912 tokens plus room for the answer.';
const wrapped = new Error(`agent compact failed (anthropic/opus, stage=pre_send): ${runtime}`);
const english = runtime.replace(' (LATEST_TURN_EXCEEDS_CONTEXT)', '');

test('the presented reason is the fixed English sentences, and English renders them unchanged', () => {
  assert.equal(presentErrorText(wrapped), english);
  assert.equal(localizedTurnFailureReason(english), english);
  // The error notice: the sizes as its summary, cause and remedy as the next step.
  const headline =
    'The latest message cannot fit this model: it needs about 471,912 tokens, but the 500,000-token window leaves 357,142 for it.';
  assert.equal(errorSummary(wrapped), headline);
  const presented = describeError(wrapped);
  assert.equal(presented.kind, 'latest-turn-size');
  assert.equal(localizeErrorRecovery(presented), english.slice(headline.length + 1));
  assert.match(presented.recovery, /^Its attachments alone are about 464,128 tokens\./);
});

test('each sentence goes through the catalog with its sizes', async () => {
  const keys = [];
  const original = i18n.t.bind(i18n);
  i18n.t = (key, options) => {
    keys.push(key);
    return original(key, options);
  };
  try {
    localizedTurnFailureReason(english);
  } finally {
    i18n.t = original;
  }
  assert.ok(keys.includes('Its attachments alone are about {{tokens}} tokens.'), keys.join(' | '));
  assert.ok(
    keys.includes('A larger context window helps only if it holds {{needed}} tokens plus room for the answer.')
  );
  assert.equal(keys.length, 4, 'one catalog key per sentence');
});

test('an unrelated failure is left as the runtime wrote it', () => {
  assert.equal(localizedTurnFailureReason('Something odd. Then more.'), 'Something odd. Then more.');
});
