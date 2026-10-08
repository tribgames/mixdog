import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startRelay } from '../../../relay/server.mjs';
import { DESKTOP_IPC } from '../shared/contract.ts';
import {
  FEEDBACK_ATTACHMENT_MAX_BYTES,
  FEEDBACK_ATTACHMENT_MAX_COUNT,
  FEEDBACK_ATTACHMENT_MAX_TOTAL_BYTES,
  normalizeDesktopFeedback,
  normalizeFeedbackAttachments,
} from '../shared/contract-feedback.ts';
import { submitFeedback } from './feedback-client.ts';
import { registerDesktopIpc } from './ipc.ts';
import { createRemoteMethods } from './remote-methods.ts';

const feedback = {
  id: '457e173a-0ec2-4405-afb7-98b15ea9bf74',
  kind: 'bug',
  message: '  한글 피드백\n두 번째 줄  ',
  replyTo: ' person@example.com ',
};
const normalized = { ...feedback, message: '한글 피드백\n두 번째 줄', replyTo: 'person@example.com' };

test('feedback validation permits only typed feedback fields on the wire', () => {
  assert.deepEqual(normalizeDesktopFeedback({ ...feedback, to: 'other@example.com', logs: 'private' }), normalized);
  assert.deepEqual(normalizeDesktopFeedback({ ...feedback, replyTo: ' ' }), {
    id: feedback.id, kind: feedback.kind, message: normalized.message,
  });
  for (const value of [
    null, [], {}, { ...feedback, id: '../secret' }, { ...feedback, kind: 'mail' },
    { ...feedback, kind: { toString: () => 'bug' } },
    { ...feedback, message: ' ' }, { ...feedback, message: 'x'.repeat(8001) },
    { ...feedback, replyTo: 3 }, { ...feedback, replyTo: 'not-an-email' },
    { ...feedback, replyTo: null }, { ...feedback, replyTo: 'a,b@example.com' },
    { ...feedback, replyTo: 'person@example.com\r\nBcc: victim@example.com' },
    { ...feedback, replyTo: `${'x'.repeat(250)}@example.com` },
  ]) {
    assert.throws(() => normalizeDesktopFeedback(value), TypeError);
  }
  assert.equal(normalizeDesktopFeedback({ ...feedback, message: 'x'.repeat(8000) }).message.length, 8000);
  assert.equal(normalizeDesktopFeedback({ ...feedback, replyTo: ' User@Example.com ' }).replyTo, 'User@Example.com');
});

test('feedback client posts normalized fields only to the configured HTTPS relay', async () => {
  const result = await submitFeedback({ ...feedback, password: 'do-not-send', url: 'http://other.test' }, {
    env: { MIXDOG_RELAY_URL: 'wss://relay.example.com/old?token=private#fragment' },
    request: async (url, options) => {
      assert.equal(String(url), 'https://relay.example.com/feedback');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.ok(options.signal instanceof AbortSignal);
      assert.deepEqual(JSON.parse(options.body), normalized);
      return Response.json({ id: feedback.id, status: 'accepted', internal: 'not-exposed' }, { status: 202 });
    },
  });
  assert.deepEqual(result, { id: feedback.id, status: 'accepted' });
});

test('disabled or insecure relay and invalid input cannot make outbound requests', async () => {
  const request = () => { assert.fail('must not send'); };
  for (const endpoint of ['off', '0', 'false', 'ws://external.test', 'wss://user:password@external.test']) {
    await assert.rejects(submitFeedback(feedback, { env: { MIXDOG_RELAY_URL: endpoint }, request }));
  }
  await assert.rejects(submitFeedback({ ...feedback, message: '' }, { request }));
});

test('feedback client reports safe failures and never mistakes a failure for acceptance', async () => {
  const env = { MIXDOG_RELAY_URL: 'wss://relay.example.com' };
  for (const status of [400, 409, 413, 429, 500, 503, 200, 302]) {
    await assert.rejects(submitFeedback(feedback, {
      env, request: async () => new Response('smtp-secret', { status }),
    }), (error) => !error.message.includes('smtp-secret') &&
      (status === 429 ? /Too many/.test(error.message) : /unavailable/.test(error.message)));
  }
  for (const body of ['not json', 'null', '{}', JSON.stringify({ id: 'wrong', status: 'accepted' }),
    JSON.stringify({ id: feedback.id, status: 'sent' })]) {
    await assert.rejects(submitFeedback(feedback, {
      env, request: async () => new Response(body, { status: 202 }),
    }), /receipt is invalid/);
  }
  await assert.rejects(submitFeedback(feedback, {
    env, request: async () => { throw new Error('private network detail'); },
  }), { message: 'Unable to submit feedback. Please try again.' });
});

test('desktop sender-guarded IPC and paired remote method reach the same feedback endpoint', async (t) => {
  const received = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push({ path: request.url, method: request.method, body: JSON.parse(body) });
    response.writeHead(202, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: feedback.id, status: 'accepted' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const previous = process.env.MIXDOG_RELAY_URL;
  process.env.MIXDOG_RELAY_URL = `ws://127.0.0.1:${server.address().port}`;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_RELAY_URL;
    else process.env.MIXDOG_RELAY_URL = previous;
  });
  const handlers = new Map();
  const mainFrame = {};
  const webContents = { mainFrame, isDestroyed: () => false, send() {} };
  const host = {
    subscribe: () => () => {},
    subscribeSessionStates: () => () => {},
    listProjects: async () => [],
    invokeDesktopOperation: async () => { throw new Error('feedback must not enter the agent runtime'); },
  };
  const dispose = registerDesktopIpc({ webContents, isDestroyed: () => false }, host, {
    app: { quit() {} },
    ipcMain: {
      handle: (channel, listener) => handlers.set(channel, listener),
      removeHandler: (channel) => handlers.delete(channel),
      on() {}, removeListener() {},
    },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openPath: async () => '', openExternal: async () => {} },
  });
  t.after(dispose);
  const invoke = handlers.get(DESKTOP_IPC.submitFeedback);
  assert.equal(typeof invoke, 'function');
  await assert.rejects(async () => invoke({ sender: {}, senderFrame: {} }, feedback));
  assert.equal(received.length, 0);
  const receipt = { id: feedback.id, status: 'accepted' };
  assert.deepEqual(await invoke({ sender: webContents, senderFrame: mainFrame }, feedback), receipt);
  assert.deepEqual(await createRemoteMethods({ host }).submitFeedback([feedback]), receipt);
  assert.deepEqual(received, Array.from({ length: 2 }, () => ({
    path: '/feedback', method: 'POST', body: normalized,
  })));
});

test('feedback client and relay persist the message before one email handoff, including a repeated request', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-feedback-e2e-'));
  const mails = [];
  let storedBeforeMail;
  const relay = await startRelay({
    port: 0,
    dataDir,
    feedbackSender: async (mail) => {
      storedBeforeMail = JSON.parse(await readFile(join(dataDir, 'feedback', `${feedback.id}.json`), 'utf8'));
      mails.push(mail);
    },
  });
  t.after(async () => {
    await relay.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const env = { MIXDOG_RELAY_URL: `ws://127.0.0.1:${relay.port}` };
  assert.deepEqual(await submitFeedback(feedback, { env }), { id: feedback.id, status: 'accepted' });
  assert.deepEqual(await submitFeedback(feedback, { env }), { id: feedback.id, status: 'accepted' });
  await relay.close();
  assert.equal(storedBeforeMail.payload.message, normalized.message);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].text, normalized.message);
  assert.equal(mails[0].replyTo, normalized.replyTo);
  assert.equal(mails[0].to, 'support@tribgames.com');
});

const shot = (name, type, fill) => {
  const head = type === 'png' ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] : [0xff, 0xd8, 0xff, 0xe0];
  const bytes = Buffer.alloc(FEEDBACK_ATTACHMENT_MAX_BYTES, fill);
  Buffer.from(head).copy(bytes);
  return { name, mimeType: `image/${type}`, data: bytes.toString('base64'), bytes };
};

test('attachment validation is shared and strips unknown fields', () => {
  const a = shot('a.png', 'png', 3);
  const { bytes, ...wire } = a;
  assert.equal(FEEDBACK_ATTACHMENT_MAX_COUNT, 3);
  assert.equal(FEEDBACK_ATTACHMENT_MAX_TOTAL_BYTES, 6291456);
  assert.deepEqual(normalizeFeedbackAttachments(undefined), []);
  assert.deepEqual(normalizeFeedbackAttachments([{ ...wire, path: 'C:/secret.png' }]), [wire]);
  assert.deepEqual(normalizeDesktopFeedback({ ...feedback, attachments: [] }), normalized);
  assert.deepEqual(normalizeDesktopFeedback({ ...feedback, attachments: [wire] }).attachments, [wire]);
  for (const attachments of [
    {}, [wire, wire, wire, wire], [{ ...wire, name: '../a.png' }], [{ ...wire, data: `data:image/png;base64,${wire.data}` }],
    [{ ...wire, mimeType: 'image/gif' }], [{ ...wire, data: Buffer.alloc(2_097_153, 1).toString('base64') }],
  ]) {
    assert.throws(() => normalizeDesktopFeedback({ ...feedback, attachments }), TypeError);
  }
});

test('invalid attachments never reach the network', async () => {
  const request = () => { assert.fail('must not send'); };
  await assert.rejects(submitFeedback({ ...feedback, attachments: [{ name: 'x.png', mimeType: 'image/png', data: 'AAAA' }] }, {
    env: { MIXDOG_RELAY_URL: 'wss://relay.example.com' }, request,
  }), TypeError);
});

test('three maximum-size images reach the relay mail byte-for-byte', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-feedback-att-'));
  const mails = [];
  const relay = await startRelay({ port: 0, dataDir, feedbackSender: async (mail) => { mails.push(mail); } });
  t.after(async () => {
    await relay.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const shots = [shot('one.png', 'png', 1), shot('two.jpg', 'jpeg', 2), shot('three.png', 'png', 3)];
  const attachments = shots.map(({ bytes, ...wire }) => wire);
  const env = { MIXDOG_RELAY_URL: `ws://127.0.0.1:${relay.port}` };
  const input = { ...feedback, attachments };
  assert.deepEqual(await submitFeedback(input, { env }), { id: feedback.id, status: 'accepted' });
  await relay.close();
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].attachments.map((a) => [a.filename, a.contentType]),
    shots.map((s) => [s.name, s.mimeType]));
  mails[0].attachments.forEach((a, i) => assert.ok(a.content.equals(shots[i].bytes)));
  // the full request must also fit the relay's frame ceiling used by paired remote routes
  assert.ok(Buffer.byteLength(JSON.stringify(normalizeDesktopFeedback(input))) < 64 * 1024 * 1024);
});
