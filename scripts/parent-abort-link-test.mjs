import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSessionRuntime,
  linkParentSignalToSession,
  markSessionCancelled,
  markSessionError,
} from '../src/runtime/agent/orchestrator/session/manager.mjs';

test('markSessionError drops parent AbortSignal listener but keeps runtime entry', () => {
  const sessionId = `parent-abort-error-${Date.now()}`;
  const parent = new AbortController();
  linkParentSignalToSession(sessionId, parent.signal);
  const runtime = getSessionRuntime(sessionId);
  assert.ok(runtime?.parentAbortLink?.signal === parent.signal);
  assert.equal(typeof runtime.parentAbortLink.listener, 'function');

  markSessionError(sessionId, 'boom');

  assert.equal(getSessionRuntime(sessionId)?.parentAbortLink, null);
  assert.equal(getSessionRuntime(sessionId)?.stage, 'error');
  let childAborted = false;
  runtime.controller.signal.addEventListener('abort', () => { childAborted = true; }, { once: true });
  parent.abort();
  assert.equal(childAborted, false);
});

test('markSessionCancelled drops parent AbortSignal listener but keeps runtime entry', () => {
  const sessionId = `parent-abort-cancel-${Date.now()}`;
  const parent = new AbortController();
  linkParentSignalToSession(sessionId, parent.signal);
  const runtime = getSessionRuntime(sessionId);
  assert.ok(runtime?.parentAbortLink);

  markSessionCancelled(sessionId);

  assert.equal(getSessionRuntime(sessionId)?.parentAbortLink, null);
  assert.equal(getSessionRuntime(sessionId)?.stage, 'done');
  let childAborted = false;
  runtime.controller.signal.addEventListener('abort', () => { childAborted = true; }, { once: true });
  parent.abort();
  assert.equal(childAborted, false);
});

