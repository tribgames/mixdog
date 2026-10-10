import assert from 'node:assert/strict';
import test from 'node:test';

import { failMediaPending, forwardMediaFrame, handleMediaRequest } from './relay-media-proxy.mjs';
import { recordingResponse } from './test-recording-response.mjs';

test('malformed media paths answer 400 without consulting the store', () => {
  const response = recordingResponse();
  const { recorded } = response;
  handleMediaRequest({}, new Map(), { allow: () => true }, { method: 'GET', url: '/media/%', headers: {} }, response);
  assert.equal(recorded[0].status, 400);
  assert.equal(recorded[0].body, 'Bad request.');
  handleMediaRequest(
    {},
    new Map(),
    { allow: () => true },
    { method: 'POST', url: '/media/abc', headers: {} },
    response
  );
  assert.equal(recorded[1].status, 405);
});

const SID = 'A'.repeat(43);

function liveDesktop({ mediaLane }) {
  const sent = [];
  const entry = {
    socket: { OPEN: 1, readyState: 1, send: (text) => sent.push(JSON.parse(text)) },
    media: new Map(),
    mediaLane,
  };
  const store = { deviceIdForClientToken: (token) => (token === 'tok' ? 'dev' : null) };
  return { entry, sent, store, desktops: new Map([['dev', entry]]) };
}

function mediaGet(url, headers = {}) {
  const listeners = new Map();
  const response = {
    chunks: [],
    head: null,
    ended: false,
    writableLength: 0,
    writeHead(status, outHeaders) {
      this.head = { status, headers: outHeaders };
      return this;
    },
    write(chunk) {
      this.chunks.push(Buffer.from(chunk));
      return true;
    },
    end() {
      this.ended = true;
    },
    on: (event, listener) => listeners.set(event, listener),
    once: (event, listener) => listeners.set(event, listener),
  };
  return { request: { method: 'GET', url, headers }, response };
}

test('encrypted media bytes reach the phone exactly as the desktop sent them', () => {
  const { entry, sent, store, desktops } = liveDesktop({ mediaLane: true });
  const { request, response } = mediaGet(
    `/media/0123456789abcdef?variant=display&sid=${SID}&enc=e2ee1&token=tok`,
    { range: 'bytes=65536-131071' }
  );
  handleMediaRequest(store, desktops, { allow: () => true }, request, response);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'media-request');
  assert.equal(sent[0].sid, SID);
  assert.equal(sent[0].enc, 'e2ee1');
  assert.equal(sent[0].range, 'bytes=65536-131071');
  const [id] = [...entry.media.keys()];
  // Arbitrary bytes stand in for AES-GCM output: nothing may alter them.
  const ciphertext = Buffer.from(Array.from({ length: 600 }, (_, index) => (index * 37 + 11) & 0xff));
  forwardMediaFrame(entry, { type: 'media-head', id, status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
  forwardMediaFrame(entry, { type: 'media-chunk', id, data: ciphertext.subarray(0, 100).toString('base64') });
  forwardMediaFrame(entry, { type: 'media-chunk', id, data: ciphertext.subarray(100).toString('base64') });
  forwardMediaFrame(entry, { type: 'media-end', id });
  assert.equal(response.head.status, 200);
  assert.equal(response.head.headers['Content-Type'], 'application/octet-stream');
  assert.deepEqual(Buffer.concat(response.chunks), ciphertext);
  assert.equal(response.ended, true);
});

test('a plaintext-era request is forwarded without the scheme marker so the desktop can refuse it', () => {
  const { sent, store, desktops } = liveDesktop({ mediaLane: true });
  const { request, response } = mediaGet('/media/0123456789abcdef?variant=thumb&token=tok');
  handleMediaRequest(store, desktops, { allow: () => true }, request, response);
  assert.equal(sent[0].sid, '');
  assert.equal(sent[0].enc, '');
  const bad = mediaGet('/media/0123456789abcdef?enc=%20%20&token=tok');
  handleMediaRequest(store, desktops, { allow: () => true }, bad.request, bad.response);
  assert.equal(bad.response.head.status, 400);
});

test('a malformed session label is refused before the desktop is asked', () => {
  const { sent, store, desktops } = liveDesktop({ mediaLane: true });
  const { request, response } = mediaGet('/media/0123456789abcdef?sid=short&token=tok');
  handleMediaRequest(store, desktops, { allow: () => true }, request, response);
  assert.equal(response.head.status, 400);
  assert.equal(sent.length, 0);
});

test('an older desktop that announced media:false is answered 503 without a request', () => {
  const { sent, store, desktops } = liveDesktop({ mediaLane: false });
  const { request, response } = mediaGet(`/media/0123456789abcdef?sid=${SID}&token=tok`);
  handleMediaRequest(store, desktops, { allow: () => true }, request, response);
  assert.equal(response.head.status, 503);
  assert.equal(sent.length, 0);
});

test('a vanished desktop closes half-written media responses', () => {
  const recorded = [];
  const response = {
    writeHead(status) {
      recorded.push(status);
    },
    end() {
      recorded.push('end');
    },
  };
  const timer = setTimeout(() => {}, 60_000);
  timer.unref?.();
  const entry = { media: new Map([['id', { response, timer, head: false }]]) };
  failMediaPending(entry);
  assert.equal(entry.media.size, 0);
  assert.deepEqual(recorded, [503, 'end']);
});
