import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { app, BrowserWindow, type WebContents } from 'electron';
import { createBrowserGuestCdp } from './cdp';
import { createBrowserDocuments } from './documents';
import { BrowserGuestStateStore } from './guest-state';
import { browserRenderCheckpoint } from './render-checkpoint';

// Live Chromium, hidden windows and a disposable profile only; never attaches
// to the live app. A sandboxed frame without allow-scripts never fires timers,
// so the render checkpoint must not await one there, yet it must still wait for
// an independently scheduled out-of-process frame that has work pending.
const DEADLINE_MS = 800;
const OOPIF_BUSY_MS = 250;
app.setPath('userData', mkdtempSync(join(tmpdir(), 'mixdog-document-checkpoint-')));
app.commandLine.appendSwitch('site-per-process');
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  const port = (server.address() as { port: number }).port;
  const oopif = `<iframe src="http://localhost:${port}/frame"></iframe>`;
  const sandboxed = `<iframe sandbox src="about:blank"></iframe>
<iframe sandbox src="about:blank" style="display:none"></iframe>
<iframe sandbox srcdoc="<p>sandboxed srcdoc</p>"></iframe>`;
  if (req.url === '/frame') {
    res.end('<p>cross-origin frame</p>');
    return;
  }
  const extra = req.url === '/sandboxed' ? sandboxed : '';
  res.end(`<button id="go">go</button><iframe srcdoc="<p>normal srcdoc</p>"></iframe>${oopif}${extra}`);
});

async function run() {
  await app.whenReady();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const state = new BrowserGuestStateStore();
  const cdp = createBrowserGuestCdp({
    state,
    interceptFetchPatterns: () => [],
    matchInterceptRule: () => undefined,
  });
  const documents = createBrowserDocuments(
    { cdp, sessions: (guest) => state.for(guest).cdpSessions },
    { checkpointDeadlineMs: DEADLINE_MS }
  );
  const open = async (path: string) => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    const guest = window.webContents;
    await cdp.guestDebugger(guest);
    await guest.loadURL(`http://127.0.0.1:${port}${path}`);
    for (let tries = 0; tries < 80 && state.for(guest).cdpSessions.size === 0; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(state.for(guest).cdpSessions.size > 0, 'exercise a real out-of-process iframe');
    return { window, guest };
  };
  // Pending work in the out-of-process frame only: a task that occupies its event loop.
  const queueOopifWork = (guest: WebContents) =>
    documents.collect(
      guest,
      `(() => {
        if (location.hostname === 'localhost') globalThis.__oopifWorked = false;
        if (location.hostname === 'localhost') setTimeout(() => {
          const end = Date.now() + ${OOPIF_BUSY_MS};
          while (Date.now() < end);
          requestAnimationFrame(() => { globalThis.__oopifRaf = true; });
          globalThis.__oopifWorked = true;
        }, 0);
        return true;
      })()`
    );
  const oopifWorked = async (guest: WebContents) =>
    (
      await documents.collect<boolean | null>(
        guest,
        `location.hostname === 'localhost' ? globalThis.__oopifWorked === true : null`
      )
    ).filter((value) => value !== null);

  // Control: awaiting a timer in every frame hangs on a sandboxed frame (a
  // hidden one gets no animation frames either, so only its timers could end it).
  const control = await open('/sandboxed');
  await assert.rejects(
    documents.collect(
      control.guest,
      `(${browserRenderCheckpoint(false)}).then(() => true)`,
      AbortSignal.timeout(1_500)
    ),
    'a timer awaited in a script-blocked frame must never resolve'
  );
  control.window.destroy();

  // Healthy frames, including an out-of-process one with work still pending:
  // the checkpoint waits for it and confirms every frame.
  const healthy = await open('/');
  for (const background of [false, true]) {
    await queueOopifWork(healthy.guest);
    const startedAt = Date.now();
    assert.equal(await documents.renderCheckpoint(healthy.guest, background), true);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= OOPIF_BUSY_MS - 50, `the out-of-process frame was not waited for (${elapsed}ms)`);
    assert.ok(elapsed < DEADLINE_MS, `healthy frames must finish before the deadline (${elapsed}ms)`);
    assert.deepEqual(await oopifWorked(healthy.guest), [true]);
  }
  healthy.window.destroy();

  // Sandboxed and hidden frames never confirm: no hang, finished near the
  // deadline, reported unconfirmed, nothing left pending behind it.
  const { window, guest } = await open('/sandboxed');
  await queueOopifWork(guest);
  for (const background of [false, true, false]) {
    const startedAt = Date.now();
    assert.equal(await documents.renderCheckpoint(guest, background), false, 'script-blocked frames are unconfirmed');
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= DEADLINE_MS - 50 && elapsed < DEADLINE_MS + 1_500, `checkpoint took ${elapsed}ms`);
  }
  assert.deepEqual(await oopifWorked(guest), [true], 'the healthy out-of-process frame is still waited for');
  const startedAt = Date.now();
  assert.match(await documents.revision(guest), /^\d/);
  const text = await documents.pageText(guest);
  assert.ok(text.includes('sandboxed srcdoc') && text.includes('normal srcdoc') && text.includes('cross-origin frame'));
  assert.equal(await cdp.evaluate(guest, 'document.getElementById("go").textContent'), 'go');
  assert.ok(Date.now() - startedAt < 2_000, 'later commands must not wait on a cleanup fence');
  window.destroy();

  const message =
    'document checkpoint integration passed (out-of-process work awaited, sandboxed frames unconfirmed)\n';
  if (process.env.MIXDOG_BROWSER_INTEGRATION_LOG) appendFileSync(process.env.MIXDOG_BROWSER_INTEGRATION_LOG, message);
  console.log(message);
}
app.on('window-all-closed', () => {
  /* Keep the isolated test process alive between windows. */
});
run().then(
  () => {
    server.close();
    app.exit(0);
  },
  (error) => {
    console.error(error);
    server.close();
    app.exit(1);
  }
);
