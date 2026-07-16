import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSessionRuntime,
  linkParentSignalToSession,
  markSessionCancelled,
  markSessionError,
} from '../src/runtime/agent/orchestrator/session/manager.mjs';
import {
  _clearSessionRuntime,
  _sweepTerminalSessionRuntimes,
} from '../src/runtime/agent/orchestrator/session/manager/runtime-liveness.mjs';

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

test('an already/early-aborted parent signal is retained and re-cascades onto a swapped controller', () => {
  const sessionId = `parent-abort-early-${Date.now()}`;
  const parent = new AbortController();
  parent.abort(new Error('canceled before dispatch'));
  linkParentSignalToSession(sessionId, parent.signal);
  const runtime = getSessionRuntime(sessionId);
  // The controller present at link time was aborted up front...
  assert.equal(runtime.controller.signal.aborted, true);
  // ...and the parent signal is RETAINED (listener null: nothing left to fire)
  // so askSession's fresh-controller swap can detect + re-cascade the early abort.
  assert.ok(runtime.parentAbortLink?.signal === parent.signal);
  assert.equal(runtime.parentAbortLink.listener, null);
  // Simulate askSession swapping in a fresh (non-aborted) controller, then
  // re-linking the retained parent signal: the early abort must re-cascade so
  // provider computation actually aborts instead of running detached.
  const linked = runtime.parentAbortLink.signal;
  runtime.controller = null;
  linkParentSignalToSession(sessionId, linked);
  assert.equal(runtime.controller.signal.aborted, true,
    'early parent abort re-cascaded onto the freshly swapped controller');
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

test('terminal runtime sweep drains the full backlog but preserves in-flight controllers', () => {
  const prefix = `terminal-retention-${Date.now()}`;
  const terminalIds = Array.from({ length: 40 }, (_, i) => `${prefix}-${i}`);
  for (const id of terminalIds) {
    linkParentSignalToSession(id, new AbortController().signal);
    markSessionError(id, 'finished');
    getSessionRuntime(id).controller = null;
  }
  const activeId = `${prefix}-active`;
  linkParentSignalToSession(activeId, new AbortController().signal);
  markSessionError(activeId, 'provider still unwinding');

  const cleaned = _sweepTerminalSessionRuntimes();

  assert.ok(cleaned >= terminalIds.length, 'one pass drains every settled terminal entry');
  for (const id of terminalIds) assert.equal(getSessionRuntime(id), null);
  assert.ok(getSessionRuntime(activeId)?.controller, 'active in-flight controller is retained');
  _clearSessionRuntime(activeId);
});

