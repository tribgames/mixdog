/**
 * What a page report says when the page is not an ordinary document:
 * downloads, PDFs, clipped text, capped console errors, credential
 * challenges, refused addresses, script failure positions and error status.
 * One measurement turn, background tabs only.
 */
import assert from 'node:assert/strict';

const REPORT_TURN = 40;

export async function runBrowserPageReportScenarios(
  command: (input: Record<string, unknown>) => Promise<{
    text: string;
    file?: { mimeType?: string; data?: string; name?: string };
  }>,
  origin: string,
  progress: (message: string) => void
): Promise<void> {
  const run = (input: Record<string, unknown>) => command({ ...input, turn_id: REPORT_TURN });
  const downloadNavigation = await run({
    action: 'navigate',
    url: `${origin}/download`,
    background: true,
    tab: 'download',
  });
  const download = await run({
    action: 'downloads',
    wait: true,
    attach: true,
    timeoutMs: 5_000,
  });
  assert.equal(download.file?.name, 'browser-fixture.txt');
  assert.equal(download.file?.mimeType, 'text/plain');
  assert.equal(Buffer.from(download.file?.data || '', 'base64').toString('utf8'), 'download attachment ready');
  // The page report mentions the download once, on whichever snapshot
  // first follows its start or completion.
  const downloadSnapshot = await run({ action: 'snapshot', tab: 'download' });
  assert.match(
    `${downloadNavigation.text}\n${downloadSnapshot.text}`,
    /Downloads since last report:\n- \[d\d+\] browser-fixture\.txt/
  );
  progress('download inline attachment and snapshot report complete');

  // A PDF link commits its address but renders nothing here, so the report
  // has to name the document instead of handing back an empty page.
  const pdfNavigation = await run({
    action: 'navigate',
    url: `${origin}/paper.pdf`,
    background: true,
    tab: 'paper',
  });
  assert.match(pdfNavigation.text, /This document is a PDF, which this browser cannot display/);
  // The viewer Chromium tries to load is its own component, so its blocked
  // resources must not surface as the page's console or network failures.
  assert.doesNotMatch(pdfNavigation.text, /chrome-extension:/);
  assert.match((await run({ action: 'snapshot', tab: 'paper' })).text, /This document is a PDF/);
  await run({ action: 'close_tab', tab: 'paper' });
  progress('pdf document report complete');

  // A page whose text exceeds the excerpt cap must say so; read as the whole
  // page, a silent excerpt turns a long document into a wrong answer.
  const longText = await run({
    action: 'navigate',
    url: `${origin}/long-text`,
    background: true,
    tab: 'long-text',
  });
  assert.match(longText.text, /the page holds more, so scroll or search it for the rest/);
  assert.doesNotMatch((await run({ action: 'read', tab: 'download' })).text, /the page holds more/);
  await run({ action: 'close_tab', tab: 'long-text' });
  progress('clipped page text is reported as clipped complete');

  // Twelve failures must not arrive looking like three: the capped list says
  // how many it stands for and where the rest are.
  await run({ action: 'navigate', url: `${origin}/root`, background: true, tab: 'console-cap' });
  // Every reply carries a page report, so the errors are said once, on the
  // first report after they were logged.
  const cappedErrors = await run({
    action: 'evaluate',
    script: 'for (let index = 0; index < 12; index += 1) console.error("bulk failure " + index); "logged"',
    tab: 'console-cap',
  });
  assert.match(cappedErrors.text, /New console errors \(3 of 1[0-9]; call console for the rest\)/);
  await run({ action: 'close_tab', tab: 'console-cap' });
  progress('capped console report names its total complete');

  // A server that demands credentials must answer as a page status; parking
  // the command behind a hidden credential prompt would strand the caller.
  const protectedStartedAt = Date.now();
  const protectedPage = await run({
    action: 'navigate',
    url: `${origin}/protected`,
    background: true,
    tab: 'protected',
  });
  assert.match(protectedPage.text, /^Status: HTTP 401 Unauthorized/m);
  assert.ok(Date.now() - protectedStartedAt < 5_000, 'a credential challenge must not hold the command');
  await run({ action: 'close_tab', tab: 'protected' });
  progress('basic auth challenge reports as a status complete');

  // An address the browser refuses must come back as a named failure rather
  // than a command that hangs on a page which never commits.
  const refusedStartedAt = Date.now();
  await assert.rejects(
    run({ action: 'navigate', url: 'http://127.0.0.1:1/unreachable', background: true, tab: 'refused' }),
    /ERR_UNSAFE_PORT/
  );
  assert.ok(Date.now() - refusedStartedAt < 5_000, 'a refused navigation returns without hanging');
  progress('refused navigation reports its failure complete');

  // A failing script must say where it failed; the message alone leaves the
  // caller guessing which line of their own script threw.
  await assert.rejects(
    run({ action: 'evaluate', script: '\n\nnull.missingProperty;\n', tab: 'alpha' }),
    /<anonymous>:\d+:\d+/
  );
  progress('evaluate failure carries its position complete');

  const missing = await run({
    action: 'navigate',
    url: `${origin}/missing`,
    background: true,
    tab: 'missing',
  });
  assert.match(missing.text, /^Status: HTTP 404 Not Found/m);
  assert.match(missing.text, /Nothing here/);
  progress('document error status report complete');
}
