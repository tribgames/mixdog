import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBrowserActionApproval } from './action-approval.ts';
import { createBrowserCommandRunner } from './command-runner.ts';
import { BrowserSessionRegistry } from './session-registry.ts';

const dir = mkdtempSync(join(tmpdir(), 'runner-upload-'));
const file = join(dir, 'a.txt');
writeFileSync(file, 'x');
test.after(() => rmSync(dir, { recursive: true, force: true }));

function fixture({ confirmSubmit = true, ask, receivers }) {
  const sessions = new BrowserSessionRegistry();
  const primary = {
    id: 1,
    isDestroyed: () => false,
    getURL: () => 'https://app.example/page',
  };
  sessions.registerVisibleGuest(primary);
  sessions.bindVisibleGuest('s', 1, true);
  const refSet = { refs: new Set(['p1-e9']) };
  const log = { resolved: 0, uploads: [] };
  const state = {
    peek: () => ({ refSet }),
    for: () => ({ documentGeneration: 1, pendingDialog: null }),
    pageId: () => 'p1',
    redactText: (_guest, text) => text,
    invalidateInteraction() {},
  };
  const next = receivers();
  const run = createBrowserCommandRunner({
    state,
    approvals: createBrowserActionApproval({ confirmSubmit, ask }),
    browserSessions: sessions,
    lifecycle: {
      restoreSession: async () => {},
      ensureGuest: async () => primary,
      recoverCrashedGuest: async () => {},
      discardUntouchedBlank() {},
    },
    tabs: { resolveTargetGuest: () => null },
    downloads: {},
    taskLifecycle: { begin() {}, use() {} },
    retainGuest() {},
    drivePage: () => () => {},
    assertNoTakeover() {},
    services: {
      state,
      cdp: { waitForIdle: async () => {} },
      reply: {
        dialogResult: () => null,
        refRecoveryFor: () => ({ source: undefined, resolvedTargets: [] }),
        snapshotResult: async () => ({ text: 'ok' }),
      },
      settle: {},
      targets: {
        resolveTargetRefs: async () => {
          log.resolved++;
          return [{ ref: 'p1-e9', description: 'button "Attach"' }];
        },
      },
      refActions: {
        uploadReceiver: async () => next(),
        uploadRef: async (...args) => log.uploads.push(args),
      },
    },
  });
  return { run, log };
}
const upload = () => ({ action: 'upload', session_id: 's', target: { role: 'button', name: 'Attach' }, paths: [file] });

test('an upload by target is resolved before the person is asked; the card shows the real frame and the handler uses that ref', async () => {
  let shown;
  const f = fixture({
    ask: async (request) => {
      shown = request;
      return true;
    },
    receivers: () => () => ({ key: 'S9\nhttps://pay.other.example/embed', url: 'https://pay.other.example/embed' }),
  });
  await f.run(upload());
  assert.equal(shown.receiverOrigin, 'https://pay.other.example');
  assert.equal(shown.target, 'button "Attach"');
  assert.equal(f.log.resolved, 1, 'resolved once, before asking, not again by the handler');
  assert.equal(f.log.uploads.length, 1);
  const [, ref, , , , approved] = f.log.uploads[0];
  assert.equal(ref, 'p1-e9');
  assert.equal(approved, 'S9\nhttps://pay.other.example/embed');
});

test('an upload whose receiving frame changes while the card is open is refused and nothing is handed over', async () => {
  let frame = 'https://app.example/frame';
  const f = fixture({
    ask: async () => {
      frame = 'https://evil.example/frame';
      return true;
    },
    receivers: () => () => ({ key: `S1\n${frame}`, url: frame }),
  });
  await assert.rejects(f.run(upload()), /target changed; nothing was dispatched/);
  assert.equal(f.log.uploads.length, 0);
});

test('with the default switched off nothing is resolved early and no frame is bound', async () => {
  const f = fixture({
    confirmSubmit: false,
    ask: async () => assert.fail('no prompt'),
    receivers: () => () => assert.fail('no early resolution'),
  });
  await f.run(upload());
  assert.equal(f.log.resolved, 1, 'the handler resolves the target as before');
  assert.equal(f.log.uploads[0][5], undefined);
});
