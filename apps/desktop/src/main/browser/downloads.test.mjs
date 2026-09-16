import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'node:fs/promises' ? {
      url: 'data:text/javascript,' + encodeURIComponent(`
        export const open = (...args) => globalThis.downloadFileFixture.open(...args);
      `), shortCircuit: true,
    } : next(specifier, context);
  },
});
const {
  createBrowserDownloadLedger, createBrowserDownloads,
  MAX_BROWSER_DOWNLOAD_BYTES, MAX_BROWSER_SESSION_DOWNLOAD_BYTES,
} = await import('./downloads.ts');

function ledgerFixture() {
  const ledger = createBrowserDownloadLedger({
    downloadsDirectory: () => process.env.MIXDOG_DATA_DIR,
    sessionIdForGuest: guest => guest.session,
    defaultSessionId: 'default',
  });
  let next = 0;
  const start = (session = 's') => {
    const filename = `fixture-${++next}.bin`;
    const item = Object.assign(new EventEmitter(), {
      received: 0, cancels: 0,
      getFilename: () => filename,
      setSavePath() {},
      getURL: () => 'https://fixture.example/download',
      getMimeType: () => 'application/octet-stream',
      getTotalBytes: () => -1,
      getReceivedBytes() { return this.received; },
      cancel() { this.cancels++; },
    });
    ledger.onWillDownload({}, item, { session });
    return item;
  };
  return { ledger, start };
}

test('parallel downloads share one session byte budget rather than overwriting each other', () => {
  for (const event of ['updated', 'done']) {
    const { ledger, start } = ledgerFixture();
    const items = Array.from({ length: 5 }, () => start());
    const portion = Math.floor(MAX_BROWSER_SESSION_DOWNLOAD_BYTES / 5);
    assert.ok(portion < MAX_BROWSER_DOWNLOAD_BYTES);
    for (const item of items) { item.received = portion; item.emit('updated'); }
    assert.ok(items.every(item => item.cancels === 0));
    const remainder = MAX_BROWSER_SESSION_DOWNLOAD_BYTES - portion * 5;
    items[4].received += remainder;
    items[4].emit('updated');
    assert.equal(items[4].cancels, 0, 'the exact session limit is allowed');
    items[4].received++;
    items[4].emit(event, {}, 'completed');
    if (event === 'updated') assert.equal(items[4].cancels, 1);
    else assert.equal(ledger.downloadsForSession('s')[0].state, 'cancelled_size_limit');
    assert.equal(start('independent').cancels, 0, 'another session keeps its own budget');
  }
});

test('completion accounts only for new bytes, not progress already counted', () => {
  const { start } = ledgerFixture();
  for (let index = 0; index < 4; index++) {
    const item = start();
    item.received = MAX_BROWSER_DOWNLOAD_BYTES;
    item.emit('updated');
    item.emit('done', {}, 'completed');
    assert.equal(item.cancels, 0);
  }
  const last = start();
  assert.equal(last.cancels, 0);
  last.received = MAX_BROWSER_SESSION_DOWNLOAD_BYTES - MAX_BROWSER_DOWNLOAD_BYTES * 4;
  last.emit('updated');
  assert.equal(last.cancels, 0);
  last.received++;
  last.emit('updated');
  assert.equal(last.cancels, 1);
});

test('retired download events cannot alter a reopened session budget', () => {
  const { ledger, start } = ledgerFixture();
  const old = start();
  old.received = MAX_BROWSER_DOWNLOAD_BYTES;
  old.emit('updated');
  old.emit('done', {}, 'completed');
  const oldPeer = start();
  ledger.release('s');
  const current = Array.from({ length: 4 }, () => start());
  for (const item of current) { item.received = MAX_BROWSER_DOWNLOAD_BYTES; item.emit('updated'); }
  oldPeer.received = MAX_BROWSER_DOWNLOAD_BYTES;
  oldPeer.emit('updated');
  oldPeer.emit('done', {}, 'completed');
  const last = start();
  last.received = MAX_BROWSER_SESSION_DOWNLOAD_BYTES - MAX_BROWSER_DOWNLOAD_BYTES * 4;
  last.emit('updated');
  assert.equal(last.cancels, 0, 'late events must not consume the new session budget');
  last.received++;
  last.emit('updated');
  assert.equal(last.cancels, 1, 'late events must not reset the new session budget either');
  assert.equal(ledger.downloadsForSession('s').length, 5);
});

const completed = {
  id: 'd1', state: 'completed', file: 'fixture.txt', path: 'fixture.txt',
  url: 'https://fixture.example/download', mimeType: 'text/plain', received: 4, total: 4,
};

test('a cancelled download list or completed wait does not inspect or attach a file', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled download');
  controller.abort(reason);
  const downloads = createBrowserDownloads({
    downloads: () => assert.fail('a pre-cancelled operation must not inspect the ledger'),
    pause: async () => assert.fail('cancelled wait'), attachMaxBytes: 8,
  });
  for (const command of [{}, { wait: true }, { attach: true }]) {
    await assert.rejects(downloads.listDownloads('s', command, controller.signal), error => error === reason);
  }
  const waiting = new AbortController();
  const entry = { ...completed, state: 'in_progress' };
  const finishing = createBrowserDownloads({
    downloads: () => [entry], attachMaxBytes: 8,
    pause: async () => { entry.state = 'completed'; waiting.abort(reason); },
  });
  await assert.rejects(finishing.listDownloads('s', { wait: true }, waiting.signal), error => error === reason);
});

test('cancellation during download attachment closes the handle and never returns file bytes', async () => {
  for (const phase of ['open', 'stat', 'read', 'final-stat', 'close']) {
    const controller = new AbortController();
    const reason = new Error(`cancel during ${phase}`);
    const calls = [];
    let stats = 0;
    const finish = name => { calls.push(name); if (phase === name) controller.abort(reason); };
    globalThis.downloadFileFixture = { open: async () => {
      finish('open');
      return {
        stat: async () => { finish(++stats === 1 ? 'stat' : 'final-stat'); return { size: 4, isFile: () => true }; },
        read: async buffer => { finish('read'); buffer.write('test'); return { bytesRead: 4 }; },
        close: async () => finish('close'),
      };
    } };
    const downloads = createBrowserDownloads({ downloads: () => [completed], pause: async () => {}, attachMaxBytes: 8 });
    await assert.rejects(downloads.listDownloads('s', { attach: true }, controller.signal), error => error === reason);
    const sequence = ['open', 'stat', 'read', 'final-stat'];
    assert.deepEqual(calls, phase === 'close' ? [...sequence, 'close'] : [...sequence.slice(0, sequence.indexOf(phase) + 1), 'close']);
  }
});

test('download attachment still preserves exact bytes and enforces size and in-flight file integrity', async () => {
  for (const variant of ['valid', 'too-large', 'changed', 'short-read']) {
    let stats = 0;
    let closed = 0;
    let reads = 0;
    globalThis.downloadFileFixture = { open: async () => ({
      stat: async () => ({ size: variant === 'too-large' ? 9 : ++stats > 1 && variant === 'changed' ? 5 : 4, isFile: () => true }),
      read: async buffer => {
        reads++;
        if (variant === 'short-read') return { bytesRead: 0 };
        buffer.write('test');
        return { bytesRead: 4 };
      },
      close: async () => { closed++; },
    }) };
    const downloads = createBrowserDownloads({ downloads: () => [completed], pause: async () => {}, attachMaxBytes: 8 });
    if (variant === 'valid') {
      const result = await downloads.listDownloads('s', { attach: true });
      assert.equal(Buffer.from(result.file.data, 'base64').toString(), 'test');
    } else {
      await assert.rejects(downloads.listDownloads('s', { attach: true }), /inline attachment limit|changed while/);
    }
    assert.equal(closed, 1);
    if (variant === 'too-large') assert.equal(reads, 0);
  }
});
