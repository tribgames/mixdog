// Visualize exports as downloads (file-downloads.ts `registerExport`): the
// rendered temp file is offered to the one device that asked, redeemed through
// the ordinary grant → lease → range path, and its temp folder is removed once
// the export ends.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { fileDownloadErrorReason } from '../shared/file-downloads.ts';
import { createFileDownloadService, requiredFileDownloadRequest } from './file-downloads.ts';

const PHONE = { deviceId: 'phone-credential' };
const OTHER = { deviceId: 'tablet-credential' };

const refusedAs = async (promise, reason) => {
  const error = await promise.then(
    () => null,
    (failure) => failure
  );
  assert.ok(error, `expected a ${reason} refusal`);
  assert.equal(fileDownloadErrorReason(error), reason, String(error?.message));
};

const gone = async (path) => {
  for (let attempt = 0; attempt < 200 && existsSync(path); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !existsSync(path);
};

function fixture(t) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'file-downloads-export-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const exported = (name, bytes) => {
    const folder = mkdtempSync(join(base, 'mixdog-visualize-export-'));
    writeFileSync(join(folder, name), bytes);
    return join(folder, name);
  };
  const clock = { value: 1_800_000_000_000 };
  const host = {
    listSessions: async () => [
      { id: 's1', cwd: base, projectPath: base, classification: 'project' },
      { id: 's2', cwd: base, projectPath: base, classification: 'project' },
    ],
    projectDirectory: async (path) => path,
    readSessionTranscript: async () => null,
    invokeCapability: async () => null,
  };
  const service = createFileDownloadService({ host, now: () => clock.value });
  t.after(() => service.revokeAll());
  return { base, exported, clock, service };
}

test('a cut document export carries the page counts on its grant; a whole one carries none', async (t) => {
  const f = fixture(t);
  const cut = await f.service.registerExport(PHONE, {
    sessionId: 's1',
    path: f.exported('deck.png', 'PNG'),
    mime: 'image/png',
    pages: { included: 8, total: 23 },
  });
  const grant = await f.service.authorize(PHONE, { source: cut.source, purpose: 'save' });
  assert.deepEqual(grant.leftOut, { ignored: 0, secret: 0, pages: { included: 8, total: 23 } });
  const whole = await f.service.registerExport(PHONE, {
    sessionId: 's1',
    path: f.exported('one.png', 'PNG'),
    mime: 'image/png',
  });
  assert.equal((await f.service.authorize(PHONE, { source: whole.source, purpose: 'save' })).leftOut, undefined);
});

test('an export is downloadable by the device it was rendered for, through a normal grant and lease', async (t) => {
  const f = fixture(t);
  const path = f.exported('flow.png', 'PNGDATA');
  const offered = await f.service.registerExport(PHONE, { sessionId: 's1', path, mime: 'image/png' });
  assert.deepEqual(offered.source.kind, 'export');
  assert.equal(offered.source.sessionId, 's1');
  assert.match(offered.source.exportId, /^[0-9a-f-]{36}$/);
  assert.equal(offered.name, 'flow.png');
  // The device's request is validated like any other source.
  const request = requiredFileDownloadRequest({ source: offered.source, purpose: 'save' });
  assert.deepEqual(request.source, offered.source);
  assert.throws(
    () => requiredFileDownloadRequest({ source: { ...offered.source, exportId: '../x' }, purpose: 'save' }),
    /export id/
  );

  // Another device, or the same id under another session, is refused.
  await refusedAs(f.service.authorize(OTHER, request), 'expired');
  await refusedAs(
    f.service.authorize(PHONE, { source: { ...offered.source, sessionId: 's2' }, purpose: 'save' }),
    'expired'
  );

  const grant = await f.service.authorize(PHONE, request);
  assert.deepEqual([grant.name, grant.mime, grant.size], ['flow.png', 'image/png', 7]);
  const transfer = await f.service.begin(PHONE, grant.grantId);
  const chunk = await f.service.readRange(PHONE, transfer.transferId, 0, 7, transfer.version);
  assert.equal(Buffer.from(chunk.data, 'base64').toString(), 'PNGDATA');
  await f.service.finish(PHONE, transfer.transferId);
  // A retry asks again while the export lives.
  assert.equal((await f.service.authorize(PHONE, request)).size, 7);
});

test('only a visualize export folder can be offered', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.base, 'project'));
  writeFileSync(join(f.base, 'project', 'secret.txt'), 'host secret');
  await refusedAs(
    f.service.registerExport(PHONE, {
      sessionId: 's1',
      path: join(f.base, 'project', 'secret.txt'),
      mime: 'text/plain',
    }),
    'not-a-file'
  );
  await refusedAs(
    f.service.registerExport(PHONE, { sessionId: 's1', path: join(f.base, 'missing', 'x.png'), mime: 'image/png' }),
    'not-found'
  );
  assert.equal(existsSync(join(f.base, 'project', 'secret.txt')), true, 'nothing outside an export folder is removed');
});

test('an export folder is removed on expiry once nothing reads it, and on unpair', async (t) => {
  const f = fixture(t);
  const kept = f.exported('a.png', 'A');
  const offered = await f.service.registerExport(PHONE, { sessionId: 's1', path: kept, mime: 'image/png' });
  const request = { source: offered.source, purpose: 'save' };
  const grant = await f.service.authorize(PHONE, request);
  const transfer = await f.service.begin(PHONE, grant.grantId);
  // Expired but still being read (the lease stays active): the folder stays.
  for (let step = 0; step < 7; step += 1) {
    f.clock.value += 100_000;
    await f.service.readRange(PHONE, transfer.transferId, 0, 1, transfer.version);
  }
  const unknown = { kind: 'export', sessionId: 's1', exportId: '00000000-0000-0000-0000-000000000000' };
  await refusedAs(f.service.authorize(PHONE, { source: unknown, purpose: 'save' }), 'expired');
  assert.equal(existsSync(dirname(kept)), true);
  await f.service.finish(PHONE, transfer.transferId);
  await refusedAs(f.service.authorize(PHONE, request), 'expired');
  assert.equal(await gone(dirname(kept)), true, 'the expired, released export folder is removed');

  const unpaired = f.exported('b.png', 'B');
  await f.service.registerExport(PHONE, { sessionId: 's1', path: unpaired, mime: 'image/png' });
  const others = f.exported('c.png', 'C');
  await f.service.registerExport(OTHER, { sessionId: 's1', path: others, mime: 'image/png' });
  f.service.revokeDevice(PHONE.deviceId);
  assert.equal(await gone(dirname(unpaired)), true, "unpair removes the device's exports");
  assert.equal(existsSync(dirname(others)), true, 'another device keeps its own');
});

test('an expired export cannot be authorized again while a transfer already started finishes', async (t) => {
  const f = fixture(t);
  const offered = await f.service.registerExport(PHONE, {
    sessionId: 's1',
    path: f.exported('long.bin', 'ABCDEFGH'),
    mime: 'application/octet-stream',
  });
  const request = { source: offered.source, purpose: 'save' };
  const grant = await f.service.authorize(PHONE, request);
  const transfer = await f.service.begin(PHONE, grant.grantId);
  // The lease keeps the record alive past its deadline, so only authorization can refuse it.
  for (let step = 0; step < 7; step += 1) {
    f.clock.value += 100_000;
    await f.service.readRange(PHONE, transfer.transferId, 0, 1, transfer.version);
  }
  await refusedAs(f.service.authorize(PHONE, request), 'expired');
  const chunk = await f.service.readRange(PHONE, transfer.transferId, 0, 8, transfer.version);
  assert.equal(Buffer.from(chunk.data, 'base64').toString(), 'ABCDEFGH');
  await f.service.finish(PHONE, transfer.transferId);
});
