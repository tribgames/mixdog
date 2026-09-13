import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { readJsonRequestBody } from './http-request-body.mjs';
import { readBody } from '../memory/lib/http-wire.mjs';

function request(headers = {}) {
  const req = new PassThrough();
  req.headers = headers;
  return req;
}

function budget() {
  let bytes = 0;
  const releases = [];
  return {
    reserve: (size) => { bytes += size; return true; },
    release: (size) => { bytes -= size; releases.push(size); },
    bytes: () => bytes,
    releases,
  };
}

test('JSON body reservations are released once on successful parsing', async () => {
  const req = request();
  const tracking = budget();
  const body = readJsonRequestBody(req, { maxBytes: 100, ...tracking });
  req.write('{"ok":');
  assert.ok(tracking.bytes() > 0);
  req.end('true}');
  assert.deepEqual(await body, { ok: true });
  assert.equal(tracking.bytes(), 0);
  assert.deepEqual(tracking.releases, [11]);
});

test('invalid JSON preserves the 400 error and releases its reserved bytes', async () => {
  const req = request();
  const tracking = budget();
  const body = readJsonRequestBody(req, { maxBytes: 100, ...tracking });
  req.end('{');
  await assert.rejects(body, (error) => error.statusCode === 400 && /^invalid JSON body:/.test(error.message));
  assert.equal(tracking.bytes(), 0);
});

test('stream errors retain their identity while releasing body reservations', async () => {
  const req = request();
  const tracking = budget();
  const failure = new Error('socket failed');
  const rejected = assert.rejects(readJsonRequestBody(req, { maxBytes: 100, ...tracking }), (error) => error === failure);
  req.write('{"partial":');
  req.destroy(failure);
  await rejected;
  assert.equal(tracking.bytes(), 0);
});

test('premature close settles the body promise and releases its process-wide budget', async () => {
  const req = request();
  const tracking = budget();
  const rejected = assert.rejects(
    readJsonRequestBody(req, { maxBytes: 100, ...tracking }),
    { code: 'ERR_STREAM_PREMATURE_CLOSE' },
  );
  req.write('{"partial":');
  req.destroy();
  await rejected;
  assert.equal(tracking.bytes(), 0);
  assert.equal(tracking.releases.length, 1);
});

test('a request already destroyed is rejected instead of waiting for an event that passed', async () => {
  const req = request();
  req.destroy();
  await assert.rejects(readJsonRequestBody(req, { maxBytes: 100 }), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
});

test('an already-destroyed request preserves and observes its pending stream error', async () => {
  const req = request();
  const failure = new Error('destroyed before body reader attachment');
  req.destroy(failure);
  await assert.rejects(readJsonRequestBody(req, { maxBytes: 100 }), (error) => error === failure);
  await setImmediate();
});

test('session-style declared overflow retains its message and closes the request', async () => {
  const req = request({ 'content-length': '101' });
  await assert.rejects(readJsonRequestBody(req, {
    maxBytes: 100,
    tooLargeMessage: 'request body too large',
    destroyOnLimit: true,
  }), (error) => error.statusCode === 413 && error.message === 'request body too large');
  assert.equal(req.destroyed, true);
});

test('streamed overflow releases only previously reserved chunks', async () => {
  const req = request();
  const tracking = budget();
  const rejected = assert.rejects(readJsonRequestBody(req, {
    maxBytes: 4, destroyOnLimit: true, ...tracking,
  }), (error) => error.statusCode === 413);
  req.write('123');
  req.write('45');
  await rejected;
  assert.deepEqual(tracking.releases, [3]);
  assert.equal(tracking.bytes(), 0);
});

test('process-wide admission failure releases earlier chunks and reports 503', async () => {
  const req = request();
  const tracking = budget();
  const rejected = assert.rejects(readJsonRequestBody(req, {
    maxBytes: 100,
    destroyOnLimit: true,
    release: tracking.release,
    reserve: (size) => tracking.bytes() === 0 && tracking.reserve(size),
  }), (error) => error.statusCode === 503 && error.message === 'daemon request memory budget is busy');
  req.write('123');
  req.write('45');
  await rejected;
  assert.equal(tracking.bytes(), 0);
  assert.deepEqual(tracking.releases, [3]);
});

test('memory body limits retain draining behavior and the byte-limit error', async () => {
  const req = request({ 'content-length': '9' });
  const rejected = assert.rejects(readBody(req, { maxBytes: 8 }), (error) =>
    error.statusCode === 413 && error.message === 'request body exceeds the 8 byte limit');
  assert.equal(req.destroyed, false);
  req.end('123456789');
  await rejected;
});

test('empty and UTF-8 bodies preserve parsing and byte accounting', async () => {
  const empty = request();
  const parsedEmpty = readBody(empty);
  empty.end(' \n ');
  assert.deepEqual(await parsedEmpty, {});
  const req = request();
  const tracking = budget();
  const payload = JSON.stringify({ value: '가' });
  const body = readJsonRequestBody(req, { maxBytes: Buffer.byteLength(payload), ...tracking });
  req.end(payload);
  assert.deepEqual(await body, { value: '가' });
  assert.deepEqual(tracking.releases, [Buffer.byteLength(payload)]);
});
