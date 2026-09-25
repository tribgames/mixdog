// The save worker forwards every stdout/stderr print to the parent as a
// `{ __log }` message: raw worker stdio would print over the TUI frame. That
// redirect must already be in place while store.mjs and its imports load,
// because ES imports evaluate before the importing module's own body.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import test from 'node:test';

const PROBE = 'store-load-probe';

test('prints made while store.mjs loads reach the parent as __log messages, not raw worker stdio', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-save-worker-stdio-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A load hook that makes store.mjs itself print while it evaluates.
  const hooksPath = join(root, 'hooks.mjs');
  const prefix = `process.stderr.write(${JSON.stringify(`${PROBE}\n`)});\n`;
  writeFileSync(
    hooksPath,
    `export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith('/orchestrator/session/store.mjs')) return result;
  return { ...result, source: ${JSON.stringify(prefix)} + String(result.source), shortCircuit: true };
}
`
  );
  // Hooks registered on this thread do not reach a worker; the worker
  // registers them itself before its entry module loads.
  const registerPath = join(root, 'register.mjs');
  writeFileSync(
    registerPath,
    `import { register } from 'node:module';\nregister(${JSON.stringify(pathToFileURL(hooksPath).href)});\n`
  );

  const worker = new Worker(new URL('./save-session-worker.mjs', import.meta.url), {
    stdout: true,
    stderr: true,
    execArgv: ['--import', pathToFileURL(registerPath).href],
    env: { ...process.env, MIXDOG_DATA_DIR: root },
  });
  t.after(() => worker.terminate());
  let rawStdio = '';
  worker.stdout.on('data', (chunk) => {
    rawStdio += chunk;
  });
  worker.stderr.on('data', (chunk) => {
    rawStdio += chunk;
  });
  const forwarded = [];
  const replied = new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', (message) => {
      if (message?.__log !== undefined) forwarded.push(String(message.__log));
      else if (message?.reqId === 1) resolve(message);
    });
  });
  // Any request proves the worker finished loading: a missing session fails.
  worker.postMessage({ reqId: 1, session: null });
  const reply = await replied;
  assert.equal(reply.ok, false);
  // Piped worker stdio is delivered asynchronously; let it drain.
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.ok((forwarded.join('') + rawStdio).includes(PROBE), 'the load hook made store.mjs print');
  assert.ok(forwarded.join('').includes(PROBE), 'load-time print is forwarded to the parent');
  assert.ok(!rawStdio.includes(PROBE), 'load-time print never reaches raw worker stdio');
});
