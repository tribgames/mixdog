import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';

import { startRelay } from '../server.mjs';
import { MAX_FEEDBACK_BODY_BYTES } from './feedback.mjs';
import {
  FEEDBACK_ATTACHMENT_MAX_BYTES,
  normalizeFeedbackAttachments,
} from './feedback-attachments.mjs';

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function image(type = 'png', size = 64, fill = 7) {
  const head = {
    png: PNG_HEAD,
    jpeg: [0xff, 0xd8, 0xff, 0xe0],
    webp: [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')],
  }[type];
  const bytes = Buffer.alloc(size, fill);
  Buffer.from(head).copy(bytes);
  return bytes;
}
const attach = (name = 'shot.png', type = 'png', size, fill) => ({
  name,
  mimeType: `image/${type}`,
  data: image(type, size, fill).toString('base64'),
});

const dirs = [];
function tempData() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-feedback-'));
  dirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// Manual clock + timer so retries are driven by the test, not wall time.
function fakeClock() {
  const clock = { t: 1_000_000, timers: new Map(), seq: 0 };
  clock.now = () => clock.t;
  clock.setTimer = (fn, ms) => {
    const handle = ++clock.seq;
    clock.timers.set(handle, { fn, at: clock.t + ms });
    return handle;
  };
  clock.clearTimer = (handle) => clock.timers.delete(handle);
  clock.advance = async (ms) => {
    clock.t += ms;
    for (const [handle, timer] of [...clock.timers]) {
      if (timer.at <= clock.t) {
        clock.timers.delete(handle);
        timer.fn();
      }
    }
    await settle();
  };
  return clock;
}
// Lets already-queued microtasks/immediates run; use waitFor for real I/O.
async function settle() {
  for (let i = 0; i < 20; i++) await tick();
}

// Polls (sync or async) `cond` until truthy; bounded so a failure never hangs.
async function waitFor(cond, what = 'condition', timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sentAt = (dir, id) => {
  try {
    return JSON.parse(readFileSync(join(dir, 'feedback', `${id}.json`), 'utf8')).sentAt;
  } catch {
    return 0;
  }
};

// Every relay booted by a test is closed afterwards, even if an assertion threw.
const opened = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((relay) => relay.close()));
});

// A POST whose body never finishes; `done` settles with the early response.
function stalled(url, headers) {
  const req = httpRequest(url, { method: 'POST', headers: { 'Content-Length': 1000, ...headers } });
  const done = new Promise((resolve, reject) => {
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
  done.catch(() => {});
  req.write('{');
  return { req, done };
}

async function boot(dataDir, { sender, clock = fakeClock(), options = {}, env = {} } = {}) {
  const relay = await startRelay({
    port: 0,
    dataDir,
    feedbackSender: sender,
    feedbackEnv: env,
    feedbackOptions: { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...options },
  });
  opened.push(relay);
  const url = `http://127.0.0.1:${relay.port}/feedback`;
  const post = (body, init = {}) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      ...init,
    });
  return { relay, url, post, clock };
}
const valid = (extra = {}) => ({ id: randomUUID(), kind: 'bug', message: '  it broke  ', ...extra });

test('accepts, persists before replying, and mails immediately once', async () => {
  const dataDir = tempData();
  const sent = [];
  const { relay, post } = await boot(dataDir, { sender: async (m) => sent.push(m) });
  const body = valid({ replyTo: 'User@Example.com' });
  const res = await post(body);
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { id: body.id, status: 'accepted' });
  const files = readdirSync(join(dataDir, 'feedback')).filter((f) => !f.endsWith('.tmp'));
  assert.deepEqual(files, [`${body.id}.json`]);
  const stored = JSON.parse(readFileSync(join(dataDir, 'feedback', files[0]), 'utf8'));
  assert.equal(stored.id, body.id);
  await waitFor(() => sent.length === 1, 'mail sent');
  assert.equal(sent[0].to, 'support@tribgames.com');
  assert.equal(sent[0].text, 'it broke');
  assert.equal(sent[0].replyTo, 'User@Example.com');
  assert.ok(!JSON.stringify(stored).includes('127.0.0.1'));
  await waitFor(() => sentAt(dataDir, body.id), 'sentAt');
  const after = JSON.parse(readFileSync(join(dataDir, 'feedback', files[0]), 'utf8'));
  assert.ok(after.sentAt);
  assert.equal(after.payload, undefined);
  await relay.close();
});

test('same id and payload is idempotent, different payload conflicts', async () => {
  const sent = [];
  const { relay, post } = await boot(tempData(), { sender: async (m) => sent.push(m) });
  const body = valid();
  assert.equal((await post(body)).status, 202);
  await waitFor(() => sent.length === 1, 'first mail');
  assert.equal((await post({ ...body, message: 'it broke' })).status, 202);
  const concurrent = valid();
  const both = await Promise.all([post(concurrent), post(concurrent)]);
  assert.deepEqual(both.map((r) => r.status), [202, 202]);
  assert.equal((await post({ ...body, message: 'other' })).status, 409);
  assert.equal((await post({ ...body, kind: 'other' })).status, 409);
  await waitFor(() => sent.length === 2, 'two mails');
  await settle();
  assert.equal(sent.length, 2);
  await relay.close();
});

test('validation, method, size and rate limits', async () => {
  const { relay, post, url } = await boot(tempData(), {
    sender: async () => {},
    options: { ipLimit: 13, globalLimit: 1000 },
  });
  for (const bad of [
    'not json',
    '[]',
    valid({ id: 'nope' }),
    valid({ kind: 'x' }),
    valid({ message: '   ' }),
    valid({ message: 'a'.repeat(8001) }),
    valid({ replyTo: 'not-an-email' }),
    valid({ replyTo: `${'a'.repeat(250)}@b.co` }),
    valid({ replyTo: 5 }),
    valid({ replyTo: null }),
  ]) {
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal((await post(valid({ message: 'a'.repeat(8000) }))).status, 202);
  assert.equal((await fetch(url)).status, 405);
  assert.equal((await fetch(url, { method: 'PUT', body: '{}' })).status, 405);
  const oversized = await new Promise((resolve, reject) => {
    const req = httpRequest(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': MAX_FEEDBACK_BODY_BYTES + 1 },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write('x');
  });
  assert.equal(oversized, 413);
  assert.equal((await post(valid())).status, 202);
  assert.equal((await post(valid())).status, 429);
  await relay.close();
});

test('global rate limit applies across clients', async () => {
  const { relay, post } = await boot(tempData(), {
    sender: async () => {},
    options: { ipLimit: 100, globalLimit: 2 },
  });
  assert.equal((await post(valid())).status, 202);
  assert.equal((await post(valid())).status, 202);
  assert.equal((await post(valid())).status, 429);
  await relay.close();
});

test('failed sends retry with bounded backoff and survive restart', async () => {
  const dataDir = tempData();
  const clock = fakeClock();
  let calls = 0;
  const failing = async () => {
    calls++;
    throw new Error('smtp down');
  };
  const options = { baseDelayMs: 1000, maxDelayMs: 4000 };
  let app = await boot(dataDir, { sender: failing, clock, options });
  const body = valid();
  assert.equal((await app.post(body)).status, 202);
  const retryArmed = (n) => waitFor(() => calls === n && clock.timers.size === 1, `retry armed after attempt ${n}`);
  await retryArmed(1);
  await clock.advance(999);
  assert.equal(calls, 1);
  await clock.advance(1); // +1000
  await retryArmed(2);
  await clock.advance(1999);
  assert.equal(calls, 2);
  await clock.advance(1); // +2000
  await retryArmed(3);
  await clock.advance(4000); // capped at 4000
  await retryArmed(4);
  await app.relay.close();
  const closedCalls = calls;
  await clock.advance(100_000);
  assert.equal(calls, closedCalls);

  const sent = [];
  app = await boot(dataDir, { sender: async (m) => sent.push(m), clock, options });
  await waitFor(() => sent.length === 1, 'due record sent after restart');
  assert.equal(sent[0].text, 'it broke');
  assert.equal((await app.post(body)).status, 202, 'still idempotent after restart');
  await settle();
  assert.equal(sent.length, 1);
  await app.relay.close();
});

test('never overlaps sends for one record and close waits for in-flight work', async (t) => {
  const clock = fakeClock();
  let active = 0;
  let peak = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  let closed = false;
  const sender = async () => {
    active++;
    peak = Math.max(peak, active);
    await gate;
    active--;
  };
  let closing;
  try {
    const { relay, post } = await boot(tempData(), { sender, clock });
    assert.equal((await post(valid())).status, 202);
    await waitFor(() => active === 1, 'send in flight');
    clock.timers.forEach((timer) => timer.fn());
    await settle();
    assert.equal(peak, 1);
    closing = relay.close().then(() => (closed = true));
    await settle();
    assert.equal(closed, false);
  } finally {
    release(); // never leave afterEach's close() waiting on the gate
  }
  await closing;
  assert.equal(closed, true);
  assert.equal(clock.timers.size, 0);
});

test('capacity limits answer 503 and prune only delivered records', async () => {
  const dataDir = tempData();
  const { relay, post } = await boot(dataDir, {
    sender: async () => {
      throw new Error('down');
    },
    options: { maxPending: 2, maxRecords: 5 },
  });
  assert.equal((await post(valid())).status, 202);
  assert.equal((await post(valid())).status, 202);
  const res = await post(valid());
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'feedback_busy' });
  await waitFor(() => readdirSync(join(dataDir, 'feedback')).length === 2, 'two stored records');
  await relay.close();

  const okDir = tempData();
  const ok = await boot(okDir, { sender: async () => {}, options: { maxRecords: 2 } });
  for (let i = 0; i < 4; i++) {
    const body = valid();
    assert.equal((await ok.post(body)).status, 202);
    await waitFor(() => sentAt(okDir, body.id), 'delivery');
  }
  await ok.relay.close();
});

test('unconfigured mail answers 503 and stores nothing; env enables it', async () => {
  const dataDir = tempData();
  const { relay, post } = await boot(dataDir, {});
  const res = await post(valid());
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'feedback_unavailable' });
  assert.deepEqual(readdirSync(join(dataDir, 'feedback')), []);
  assert.equal((await post('bad')).status, 503, 'unconfigured answers before parsing the body');
  await relay.close();

  const partial = await boot(tempData(), { env: { SMTP_USER: 'admin@tribgames.com' } });
  assert.equal((await partial.post(valid())).status, 503);
  await partial.relay.close();

  const configured = await boot(tempData(), { env: { SMTP_USER: 'admin@tribgames.com', SMTP_PASSWORD: 'pw' } });
  await configured.relay.close(); // real transport builds lazily; nothing is sent
});

test('blank replyTo is treated as absent', async () => {
  const sent = [];
  const { relay, post } = await boot(tempData(), { sender: async (m) => sent.push(m) });
  assert.equal((await post(valid({ replyTo: '   ' }))).status, 202);
  await waitFor(() => sent.length === 1, 'mail sent');
  assert.equal(sent[0].replyTo, undefined);
  await relay.close();
});

test('a record still persisting is not scheduled or sent, and close waits for its write', async (t) => {
  const dataDir = tempData();
  const clock = fakeClock();
  const sent = [];
  let gateId = null;
  let openGate;
  let gateHit = false;
  const gate = new Promise((r) => (openGate = r));
  // Runs before afterEach's close(), which would otherwise wait on the gate.
  t.after(() => openGate());
  const fs = {
    writeFile: async (path, ...rest) => {
      if (gateId && path.includes(gateId)) {
        gateHit = true;
        await gate;
      }
      return (await import('node:fs/promises')).writeFile(path, ...rest);
    },
  };
  const first = valid();
  const second = valid();
  const { relay, post } = await boot(dataDir, {
    sender: async (m) => {
      sent.push(m.subject);
      if (m.subject.includes(first.id)) throw new Error('down');
    },
    clock,
    options: { fs, baseDelayMs: 1000 },
  });
  assert.equal((await post(first)).status, 202); // fails once, retry armed
  await waitFor(() => sent.length === 1, 'first send attempt');
  gateId = second.id;
  const pending = post(second);
  await waitFor(() => gateHit, 'second write started');
  await clock.advance(1000); // retry of `first` fires while `second` is mid-write
  assert.ok(!sent.some((s) => s.includes(second.id)), 'not sent before durable');
  let closed = false;
  const closing = relay.close().then(() => (closed = true));
  await settle();
  assert.equal(closed, false, 'close waits for the pending write');
  openGate();
  await closing;
  assert.equal((await pending).status, 202);
  assert.ok(!sent.some((s) => s.includes(second.id)), 'closed service sends nothing more');
  assert.ok(readdirSync(join(dataDir, 'feedback')).includes(`${second.id}.json`));
});

test('capacity prune waits for unlink and a failed unlink answers 503 without forgetting the record', async () => {
  const dataDir = tempData();
  let failUnlink = true;
  const fs = {
    unlink: async (path) => {
      if (failUnlink) throw Object.assign(new Error('nope'), { code: 'EACCES' });
      return (await import('node:fs/promises')).unlink(path);
    },
  };
  const { relay, post } = await boot(dataDir, { sender: async () => {}, options: { maxRecords: 1, fs } });
  const a = valid();
  assert.equal((await post(a)).status, 202);
  await waitFor(() => sentAt(dataDir, a.id), 'delivery of a');
  const res = await post(valid());
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'feedback_unavailable' });
  assert.equal(readdirSync(join(dataDir, 'feedback')).length, 1);
  assert.equal((await post(a)).status, 202, 'record still known');
  failUnlink = false;
  assert.equal((await post(valid())).status, 202);
  await waitFor(() => !readdirSync(join(dataDir, 'feedback')).includes(`${a.id}.json`), 'a pruned');
  await relay.close();
});

test('corrupt stored records fail closed with a generic diagnostic', async () => {
  const dataDir = tempData();
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(dataDir, 'feedback'));
  const id = randomUUID();
  const secret = 'SECRET-PAYLOAD-TEXT';
  writeFileSync(join(dataDir, 'feedback', `${id}.json`), `{"id":"${id}","payload":"${secret}"`);
  const other = randomUUID();
  writeFileSync(join(dataDir, 'feedback', `${other}.json`), JSON.stringify({ id: randomUUID(), hash: 'x' }));
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  let app;
  try {
    app = await boot(dataDir, { sender: async () => {} });
  } finally {
    console.error = original;
  }
  assert.ok(logged.length >= 2);
  assert.ok(!logged.join('\n').includes(secret));
  assert.equal((await app.post(valid())).status, 503);
  assert.equal((await app.post({ id, kind: 'bug', message: 'x' })).status, 503, 'no ack on unverified id');
  await app.relay.close();
});

test('failed initial persistence answers 503 and leaves nothing acknowledged', async () => {
  const dataDir = tempData();
  const fs = {
    rename: async () => {
      throw Object.assign(new Error('disk'), { code: 'ENOSPC' });
    },
  };
  const sent = [];
  const { relay, post } = await boot(dataDir, { sender: async (m) => sent.push(m), options: { fs } });
  const body = valid();
  assert.equal((await post(body)).status, 503);
  assert.equal((await post(body)).status, 503, 'retry is not mistaken for a duplicate');
  await settle();
  assert.equal(sent.length, 0);
  await relay.close();
});

test('storage unavailable answers 503 without crashing the relay', async () => {
  const dataDir = tempData();
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dataDir, 'feedback'), 'a file where the directory should be');
  const { relay, post } = await boot(dataDir, { sender: async () => {} });
  assert.equal((await post(valid())).status, 503);
  await relay.close();
});

test('attachment validator rejects malformed, unsafe and oversized input and drops unknown fields', () => {
  const ok = attach();
  assert.deepEqual(normalizeFeedbackAttachments(undefined), []);
  assert.deepEqual(normalizeFeedbackAttachments([]), []);
  assert.deepEqual(normalizeFeedbackAttachments([{ ...ok, path: '/etc/passwd', url: 'http://x', headers: {} }]), [ok]);
  for (const t of ['png', 'jpeg', 'webp']) assert.equal(normalizeFeedbackAttachments([attach(`a.${t}`, t)]).length, 1);
  const bad = [
    null, 'x', {}, [null], [[]], [{}], [{ ...ok, name: undefined }], [{ ...ok, data: 5 }],
    [{ ...ok, mimeType: 'image/gif' }], [{ ...ok, mimeType: 'image/svg+xml' }],
    [{ ...ok, name: '' }], [{ ...ok, name: '../x.png' }], [{ ...ok, name: 'a/b.png' }],
    [{ ...ok, name: 'a\\b.png' }], [{ ...ok, name: 'a\r\nBcc: x.png' }], [{ ...ok, name: '.hidden.png' }],
    [{ ...ok, name: ' x.png' }], [{ ...ok, name: `${'a'.repeat(100)}.png` }], [{ ...ok, name: 'C:x.png' }],
    [{ ...ok, data: `data:image/png;base64,${ok.data}` }], [{ ...ok, data: `${ok.data}\n` }],
    [{ ...ok, data: ok.data.slice(1) }], [{ ...ok, data: `${ok.data.slice(0, -1)}*` }],
    [{ ...ok, data: '' }], [{ ...ok, data: Buffer.from('not an image at all').toString('base64') }],
    [{ ...ok, mimeType: 'image/jpeg' }], [{ ...ok, mimeType: 'image/webp' }],
    [{ ...ok, data: image('png', 4).toString('base64') }],
    [attach(), attach(), attach(), attach()],
    [attach('big.png', 'png', FEEDBACK_ATTACHMENT_MAX_BYTES + 1)],
    [{ ...ok, data: image('png', 14, 0).toString('base64').replace(/=*$/, '') }],
  ];
  for (const value of bad) assert.throws(() => normalizeFeedbackAttachments(value), TypeError, JSON.stringify(value)?.slice(0, 70));
  // non-canonical trailing bits are not strict base64
  const odd = Buffer.from([...PNG_HEAD, 1, 2, 3, 4, 5]).toString('base64');
  assert.equal(normalizeFeedbackAttachments([{ ...ok, data: odd }]).length, 1);
  assert.throws(() => normalizeFeedbackAttachments([{ ...ok, data: `${odd.slice(0, -2)}${'B'}=` }]));
  const max = attach('max.png', 'png', FEEDBACK_ATTACHMENT_MAX_BYTES);
  assert.equal(normalizeFeedbackAttachments([max, max, max]).length, 3);
});

test('attachments are persisted before acceptance, mailed as MIME attachments, then removed', async () => {
  const dataDir = tempData();
  const sent = [];
  let stored;
  const body = valid({ attachments: [attach('a.png', 'png', 100, 1), attach('b.jpg', 'jpeg', 5000, 2)] });
  const { relay, post } = await boot(dataDir, {
    sender: async (m) => {
      stored = JSON.parse(readFileSync(join(dataDir, 'feedback', `${body.id}.json`), 'utf8'));
      sent.push(m);
    },
  });
  assert.equal((await post(body)).status, 202);
  await waitFor(() => sent.length === 1, 'mail sent');
  assert.deepEqual(stored.payload.attachments, body.attachments);
  assert.equal(sent[0].attachments.length, 2);
  assert.deepEqual(sent[0].attachments.map((a) => [a.filename, a.contentType]), [['a.png', 'image/png'], ['b.jpg', 'image/jpeg']]);
  assert.ok(sent[0].attachments[1].content.equals(image('jpeg', 5000, 2)));
  await waitFor(() => sentAt(dataDir, body.id), 'sentAt');
  const after = JSON.parse(readFileSync(join(dataDir, 'feedback', `${body.id}.json`), 'utf8'));
  assert.equal(after.payload, undefined);
  assert.ok(!JSON.stringify(after).includes(body.attachments[0].data));
  await relay.close();
});

test('attachment-free payloads keep their legacy hash and mail shape', async () => {
  const dataDir = tempData();
  const sent = [];
  const { relay, post } = await boot(dataDir, { sender: async (m) => sent.push(m) });
  const body = valid({ attachments: [] });
  assert.equal((await post(body)).status, 202);
  await waitFor(() => sent.length === 1, 'mail sent');
  const { createHash } = await import('node:crypto');
  const stored = JSON.parse(readFileSync(join(dataDir, 'feedback', `${body.id}.json`), 'utf8'));
  assert.equal(stored.hash, createHash('sha256').update(JSON.stringify(['bug', 'it broke', ''])).digest('hex'));
  assert.equal('attachments' in sent[0], false);
  await relay.close();
});

test('attachment content takes part in idempotency and conflicts', async () => {
  const sent = [];
  const { relay, post } = await boot(tempData(), { sender: async (m) => sent.push(m) });
  const a = attach('a.png', 'png', 100, 1);
  const body = valid({ attachments: [a] });
  assert.equal((await post(body)).status, 202);
  await waitFor(() => sent.length === 1, 'mail sent');
  assert.equal((await post(body)).status, 202);
  assert.equal((await post({ ...body, attachments: [attach('a.png', 'png', 100, 2)] })).status, 409);
  assert.equal((await post({ ...body, attachments: [{ ...a, name: 'z.png' }] })).status, 409);
  assert.equal((await post({ ...body, attachments: [] })).status, 409);
  assert.equal((await post({ ...body, attachments: undefined })).status, 409);
  await settle();
  assert.equal(sent.length, 1);
  await relay.close();
});

test('invalid attachments answer 400 and store nothing', async () => {
  const dataDir = tempData();
  const { relay, post } = await boot(dataDir, { sender: async () => {}, options: { ipLimit: 100 } });
  for (const attachments of [
    'x', [{ name: 'a.png', mimeType: 'image/png', data: 'AAAA' }],
    [{ ...attach(), name: '../a.png' }], [attach(), attach(), attach(), attach()],
    [attach('big.png', 'png', FEEDBACK_ATTACHMENT_MAX_BYTES + 1)], null,
  ]) {
    assert.equal((await post(valid({ attachments }))).status, 400);
  }
  assert.deepEqual(readdirSync(join(dataDir, 'feedback')), []);
  const max = attach('max.png', 'png', FEEDBACK_ATTACHMENT_MAX_BYTES);
  const full = valid({ attachments: [max, max, max] });
  assert.ok(Buffer.byteLength(JSON.stringify(full)) <= MAX_FEEDBACK_BODY_BYTES);
  assert.equal((await post(full)).status, 202);
  await relay.close();
});

test('attachment mail retries across restart with identical bytes', async () => {
  const dataDir = tempData();
  const clock = fakeClock();
  const body = valid({ attachments: [attach('a.webp', 'webp', 3000, 9)] });
  let attempts = 0;
  let app = await boot(dataDir, { sender: async () => { attempts++; throw new Error('down'); }, clock });
  assert.equal((await app.post(body)).status, 202);
  await waitFor(() => attempts === 1, 'failed attempt');
  await app.relay.close();
  const sent = [];
  app = await boot(dataDir, { sender: async (m) => sent.push(m), clock });
  await clock.advance(60 * 60_000);
  await waitFor(() => sent.length === 1, 'retry after restart');
  assert.ok(sent[0].attachments[0].content.equals(image('webp', 3000, 9)));
  assert.equal(sent[0].attachments[0].contentType, 'image/webp');
  await app.relay.close();
  app = await boot(dataDir, { sender: async (m) => sent.push(m), clock });
  assert.equal((await app.post(body)).status, 202);
  await settle();
  assert.equal(sent.length, 1);
  await app.relay.close();
});

test('legacy records without attachments still load and send; corrupt attachments fail closed', async () => {
  const dataDir = tempData();
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(dataDir, 'feedback'));
  const legacy = randomUUID();
  const record = (id, payload) => JSON.stringify({
    id, hash: 'h', payload, createdAt: 1, attempts: 0, nextAttemptAt: 0, sentAt: 0,
  });
  writeFileSync(join(dataDir, 'feedback', `${legacy}.json`), record(legacy, { kind: 'bug', message: 'old', replyTo: '' }));
  const sent = [];
  const original = console.error;
  console.error = () => {};
  let app;
  try {
    app = await boot(dataDir, { sender: async (m) => sent.push(m) });
  } finally {
    console.error = original;
  }
  await waitFor(() => sent.length === 1, 'legacy mail sent');
  assert.equal(sent[0].text, 'old');
  assert.equal('attachments' in sent[0], false);
  await app.relay.close();

  const dir2 = tempData();
  mkdirSync(join(dir2, 'feedback'));
  const corrupt = randomUUID();
  writeFileSync(join(dir2, 'feedback', `${corrupt}.json`), record(corrupt, {
    kind: 'bug', message: 'x', replyTo: '', attachments: [{ name: '../x', mimeType: 'image/png', data: 'AAAA' }],
  }));
  console.error = () => {};
  const sent2 = [];
  try {
    app = await boot(dir2, { sender: async (m) => sent2.push(m) });
  } finally {
    console.error = original;
  }
  await settle();
  assert.equal(sent2.length, 0);
  assert.equal((await app.post(valid())).status, 503);
  await app.relay.close();
});

test('pending attachment storage is bounded and freed after delivery', async () => {
  let fail = true;
  const { relay, post, clock } = await boot(tempData(), {
    sender: async () => { if (fail) throw new Error('down'); },
    options: { maxPendingAttachmentBytes: 10_000 },
  });
  const big = () => valid({ attachments: [attach('a.png', 'png', 6000, Math.floor(Math.random() * 200))] });
  assert.equal((await post(big())).status, 202);
  const res = await post(big());
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'feedback_busy' });
  assert.equal((await post(valid())).status, 202, 'attachment-free feedback is unaffected');
  fail = false;
  await clock.advance(30_000);
  let status;
  await waitFor(async () => (status = (await post(big())).status) === 202, 'delivered attachments release queue capacity');
  await relay.close();
});

test('feedback body reads are capped; extra requests get 503 without being read', async (t) => {
  const dataDir = tempData();
  const { url, post } = await boot(dataDir, {
    sender: async () => {},
    options: { ipLimit: 1000, globalLimit: 1000 },
  });
  const json = { 'Content-Type': 'application/json' };
  const held = [stalled(url, json), stalled(url, json), stalled(url, json)];
  t.after(() => held.forEach(({ req }) => req.destroy()));
  let busy;
  await waitFor(async () => {
    busy = await post('bad'); // 400 until all three slots are occupied
    return busy.status === 503;
  }, 'read cap reached');
  assert.deepEqual(await busy.json(), { error: 'feedback_busy' });
  held.forEach(({ req }) => req.destroy());
  await waitFor(async () => (await post(valid())).status === 202, 'slots released');
});

test('unconfigured mail answers 503 before the body is read', async (t) => {
  const { url } = await boot(tempData(), {});
  const { req, done } = stalled(url, { 'Content-Type': 'application/json' });
  t.after(() => req.destroy());
  const res = await done; // the request body is still unfinished
  assert.equal(res.status, 503);
  assert.deepEqual(JSON.parse(res.body), { error: 'feedback_unavailable' });
});

test('feedback POST requires an application/json content type', async () => {
  const dataDir = tempData();
  const sent = [];
  const { post } = await boot(dataDir, { sender: async (m) => sent.push(m), options: { ipLimit: 1000 } });
  const text = JSON.stringify(valid());
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/jsonp']) {
    const res = await post(text, { headers: { 'Content-Type': type } });
    assert.equal(res.status, 415, type);
    assert.deepEqual(await res.json(), { error: 'unsupported_media_type' });
  }
  assert.equal((await post(text, { headers: {} })).status, 415, 'fetch defaults string bodies to text/plain');
  assert.deepEqual(readdirSync(join(dataDir, 'feedback')), []);
  assert.equal((await post(text, { headers: { 'Content-Type': 'Application/JSON; charset=utf-8' } })).status, 202);
});
