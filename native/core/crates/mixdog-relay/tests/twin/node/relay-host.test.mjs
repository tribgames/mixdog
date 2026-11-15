import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFeedbackSender, createNativePushFake, createWebPushFetch } from './fakes.mjs';
import { findTreeRoot, removeInstall, resolvePackages } from './relay-host.mjs';

const HOST = join(dirname(fileURLToPath(import.meta.url)), 'relay-host.mjs');
const LISTENING = /^\[relay\] http listening on :(\d+) \(renderer: none\)$/u;

function startHost(config) {
  const child = spawn(process.execPath, [HOST, JSON.stringify(config)], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  const waiters = [];
  let pending = '';
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {
      lines.push(pending.slice(0, at).replace(/\r$/u, ''));
      pending = pending.slice(at + 1);
    }
    for (const waiter of waiters.splice(0)) waiter();
  });
  const exited = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)));
  const line = async (predicate) => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const found = lines.find(predicate);
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`no matching line in ${JSON.stringify(lines)}`);
      await new Promise((resolveWait) => {
        waiters.push(resolveWait);
        setTimeout(resolveWait, 200);
      });
    }
  };
  return { child, lines, line, exited };
}

test('the host prints versions then the CLI listening line, serves /healthz, and closes when stdin ends', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'relay-host-test-'));
  const host = startHost({ dataDir: join(scratch, 'data'), installBase: scratch, mobileRelease: { android: 'x' } });
  try {
    const versions = await host.line((l) => l.startsWith('[twin] '));
    const parsed = JSON.parse(versions.slice('[twin] '.length));
    assert.deepEqual(Object.keys(parsed.versions).sort(), ['nodemailer', 'source', 'ws']);
    assert.equal(parsed.versions.ws, resolvePackages(findTreeRoot()).versions.ws);
    const listening = await host.line((l) => LISTENING.test(l));
    const port = Number(LISTENING.exec(listening)[1]);
    assert.ok(port > 0);
    assert.ok(host.lines.indexOf(versions) < host.lines.indexOf(listening));
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(response.status, 200);
    host.child.stdin.end();
    assert.equal(await host.exited, 0);
  } finally {
    host.child.kill();
    await host.exited;
    // A host killed before its own clean-up leaves its install, link included.
    for (const entry of readdirSync(scratch)) {
      if (entry.startsWith('relay-twin-')) removeInstall(join(scratch, entry));
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('an unknown knob is refused', async () => {
  const host = startHost({ dataDir: 'x', porrt: 1 });
  assert.equal(await host.exited, 1);
});

test('the fakes record every call and answer the script', async () => {
  const captured = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  let results;
  try {
    const send = createFeedbackSender({ answers: [{ throw: 'down', code: 'ECONNECTION' }, {}] });
    const mail = { from: 'a', to: 'b', attachments: [{ filename: 'f', content: Buffer.from('abc') }] };
    const first = await send(mail).catch((error) => error.code);
    const second = await send(mail);
    send.close();
    const push = createNativePushFake({ platforms: ['fcm'], answers: [{ ok: false, status: 404, invalid: true }] });
    const pushed = await push.send({ platform: 'fcm', token: 't' });
    const fetchFake = createWebPushFetch({ answers: [{ status: 410 }] });
    const fetched = await fetchFake('https://push.example/x', { method: 'POST', body: new Uint8Array([1, 2]) });
    results = { first, second, pushed, platforms: push.platforms, fetched };
  } finally {
    process.stdout.write = write;
  }
  assert.deepEqual(results, {
    first: 'ECONNECTION',
    second: undefined,
    pushed: { ok: false, status: 404, invalid: true },
    platforms: ['fcm'],
    fetched: { status: 410 },
  });
  const records = captured.filter((l) => l.startsWith('[twin] ')).map((l) => JSON.parse(l.slice('[twin] '.length)));
  assert.equal(records.length, 5);
  assert.equal(records[0].mail.attachments[0].bytes, 3);
  assert.equal(records[2].call, 'close');
  assert.equal(records[4].bodyBase64, 'AQI=');
});

test('removing an install unlinks its node_modules link and leaves the packages it points at', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'relay-host-test-'));
  try {
    const packages = join(scratch, 'packages');
    mkdirSync(join(packages, 'ws'), { recursive: true });
    writeFileSync(join(packages, 'ws', 'package.json'), '{}');
    const root = join(scratch, 'relay-twin-x');
    mkdirSync(root);
    symlinkSync(packages, join(root, 'node_modules'), 'junction');
    removeInstall(root);
    assert.equal(existsSync(root), false);
    assert.equal(existsSync(join(packages, 'ws', 'package.json')), true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});