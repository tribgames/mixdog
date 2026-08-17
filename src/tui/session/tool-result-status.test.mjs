import assert from 'node:assert/strict';
import test from 'node:test';

import {
  failureDetailText,
  shellCommandExitCode,
  toolCallOutcome,
} from './tool-result-status.mjs';

// Outcome taxonomy contract (user report: "Exit 0" rendered as if failed):
// - exit 0            → plain success ("Ok" bucket, success tone)
// - non-zero exit     → neutral "Exit N" state (warning tone, never red)
// - envelope isError  → real call failure ("Failed", red)

test('exit 0 is a plain success, never the Exit bucket', () => {
  const rawText = '[exit code: 0]\nall good';
  assert.equal(shellCommandExitCode(rawText), 0);
  assert.deepEqual(toolCallOutcome({ isError: false }, rawText), {
    isCallError: false,
    isExitError: false,
    exitCode: 0,
  });
});

test('a recognized exit 0 wins over a provider error envelope', () => {
  const outcome = toolCallOutcome({ isError: true }, '[exit code: 0]\nnoise on stderr');
  assert.equal(outcome.isCallError, false);
  assert.equal(outcome.isExitError, false);
});

test('non-zero exit is the neutral Exit state, not a call error', () => {
  assert.deepEqual(toolCallOutcome({ isError: true }, '[exit code: 2]\nboom'), {
    isCallError: false,
    isExitError: true,
    exitCode: 2,
  });
});

test('timeout/signal results never classify as a plain command exit', () => {
  assert.equal(shellCommandExitCode('[timeout: 5000ms signal: SIGKILL]\n[exit code: 1]'), null);
  const outcome = toolCallOutcome({ isError: true }, '[signal: SIGTERM]\nkilled');
  assert.equal(outcome.isCallError, true);
  assert.equal(outcome.isExitError, false);
});

test('provider envelope error without an exit header is a call failure', () => {
  const outcome = toolCallOutcome({ isError: true }, 'Error: transport failed');
  assert.equal(outcome.isCallError, true);
  assert.equal(outcome.isExitError, false);
});

test('failure detail keeps Ok / Failed / Exit buckets distinct', () => {
  assert.equal(failureDetailText({ succeeded: 1, realErrors: 1, exitErrors: 1, exitCode: 3 }), '1 Ok · 1 Failed · 1 Exit');
  assert.equal(failureDetailText({ succeeded: 0, realErrors: 0, exitErrors: 1, exitCode: 3 }), 'Exit 3');
  // Exit 0 no longer feeds exitErrors, so an all-success group is pure Ok.
  assert.equal(failureDetailText({ succeeded: 2, realErrors: 0, exitErrors: 0 }), '2 Ok');
});
