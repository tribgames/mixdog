import assert from 'node:assert/strict';
import test from 'node:test';
import {
  errorFrameError,
  responseFailedError,
  responseIncompleteError,
  serverErrorEventError,
} from './openai-ws-terminal.mjs';
import { classifyError, isRetryableWireErrorEvent } from './retry-classifier.mjs';

// Observed live (2026-09-20): the Codex backend answered a status-less
// `{"type":"error","error":{...}}` frame with "Our servers are currently
// overloaded" and the turn failed outright with zero retries because the
// error carried no wire-error marker.
test('status-less server error event default-retries like response.failed', () => {
  const event = {
    type: 'error',
    error: { type: 'server_error', message: 'Our servers are currently overloaded. Please try again later.' },
  };
  const err = serverErrorEventError(event.error, event);
  assert.equal(err.message, 'Our servers are currently overloaded. Please try again later.');
  assert.equal(err.httpStatus, undefined, 'no status is synthesized from text');
  assert.equal(err.providerErrorCode, 'server_error');
  assert.equal(err.responseFailed, event);
  assert.equal(classifyError(err), 'transient');
  assert.equal(isRetryableWireErrorEvent(err), true);
});

test('fatal typed code on a server error event stays terminal', () => {
  const event = { type: 'error', error: { type: 'usage_limit_reached', message: 'The usage limit has been reached' } };
  const err = serverErrorEventError(event.error, event);
  assert.equal(classifyError(err), 'permanent');
  assert.equal(isRetryableWireErrorEvent(err), false);
});

test('typed status on a server error event outranks the default-retry marker', () => {
  const refused = serverErrorEventError(
    { type: 'invalid_request_error', message: 'bad input' },
    { type: 'error', status: 400, error: { type: 'invalid_request_error', message: 'bad input' } }
  );
  assert.equal(refused.httpStatus, 400);
  assert.equal(classifyError(refused), 'permanent');

  const overloaded = serverErrorEventError(
    { type: 'server_error', message: 'overloaded' },
    { type: 'error', status: 503, error: { type: 'server_error', message: 'overloaded' } }
  );
  assert.equal(overloaded.httpStatus, 503);
  assert.equal(classifyError(overloaded), 'transient');
});

test('websocket connection limit keeps its typed transient verdict and payload', () => {
  const error = {
    type: 'invalid_request_error',
    code: 'websocket_connection_limit_reached',
    message: 'Responses websocket connection limit reached (60 minutes).',
  };
  const err = serverErrorEventError(error, { type: 'error', status: 400, error });
  assert.equal(err.payload, error);
  assert.equal(err.providerErrorCode, 'websocket_connection_limit_reached');
  assert.equal(classifyError(err), 'transient');
});

test('nested error.headers are copied to err.headers and the typed code is kept', () => {
  const error = {
    type: 'usage_limit_reached',
    code: 'Usage_Limit_Reached',
    message: 'limit',
    resets_at: 1893456000,
    headers: { 'retry-after': '7' },
  };
  const event = { type: 'response.failed', response: { error } };
  const failed = responseFailedError(event, { label: 'WS', fallbackMessage: 'x' });
  assert.equal(failed.code, 'usage_limit_reached');
  assert.equal(failed.headers, error.headers);
  assert.equal(failed.retryAfterMs, 7000);
  assert.equal(failed.resetAt, 1893456000 * 1000);

  const frame = errorFrameError({ type: 'error', status: 429, error }, 'WS error');
  assert.equal(frame.code, 'usage_limit_reached');
  assert.equal(frame.status, 429);
  assert.equal(frame.httpStatus, 429);
  assert.equal(frame.headers, error.headers);

  const server = serverErrorEventError(error, { type: 'error', error });
  assert.equal(server.code, 'usage_limit_reached');
  assert.equal(server.headers, error.headers);
  assert.equal(server.retryAfterMs, 7000);
});

test('top-level event headers are preserved on a status-bearing error frame', () => {
  const headers = { 'retry-after-ms': '1500' };
  const err = errorFrameError({ type: 'error', status: 429, headers, error: { code: 'rate_limit_exceeded' } }, 'WS');
  assert.equal(err.headers, headers);
  assert.equal(err.retryAfterMs, 1500);
});

test('response.incomplete content_filter is a typed policy error', () => {
  const event = { type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' } } };
  const err = responseIncompleteError(event, 'content_filter', 'WS');
  assert.equal(err.code, 'content_filter');
  assert.equal(err.providerErrorCode, 'content_filter');
  assert.equal(err.incompleteReason, 'content_filter');
  assert.notEqual(classifyError(err), 'transient', 'a policy refusal is never default-retried');
  assert.equal(responseIncompleteError(event, 'other', 'WS').code, undefined);
});
