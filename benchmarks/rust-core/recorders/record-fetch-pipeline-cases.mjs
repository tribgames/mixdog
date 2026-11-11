#!/usr/bin/env node
// Records Node's fetch pipeline for the k1 UNTESTED fetch-pipeline.test.mjs (gaps-tools.md row 83, mixdog-tools `web`).
// Every run of the test goes through Node's real `runFetchPipeline`. Its HTTP stage answers what the HTTP stage would
// produce for the served response the Rust replay serves: Node's real `assertDocumentResponse` on the status and
// headers, then Node's real `extractDocument` on the body (`assertPublicUrl` for the private-address run). The browser
// stage is the test's own fake. Each run's whole outcome is kept: the page (title, content, extractor) or the error
// (code, message, status), the failures and the attempts (elapsed times dropped), and the retry waits it asked for.
//
//   node benchmarks/rust-core/recorders/record-fetch-pipeline-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/fetch-pipeline-cases/{golden.json,MANIFEST.json}.
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-fetch-pipeline-cases.mjs';
const TEST = 'src/runtime/web-search/lib/fetch-pipeline.test.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);

const { HostPacer, runFetchPipeline } = await importFrom(tree, 'src/runtime/web-search/lib/fetch-pipeline.mjs');
const { assertDocumentResponse } = await importFrom(tree, 'src/runtime/web-search/lib/http-fetch.mjs');
const { assertPublicUrl } = await importFrom(tree, 'src/runtime/web-search/lib/ssrf-guard.mjs');
const { extractDocument } = await importFrom(tree, 'src/runtime/web-search/lib/document-content.mjs');

// The replay serves on loopback; only the host reaches a message (the private-address one).
const url = 'http://127.0.0.1:9/docs';
const page = { url, format: 'html', title: 'Guide', content: 'Useful page content.' };
const error = (message, props) => Object.assign(new Error(message), props);
const served = (status, body = '', headers = {}) => ({ status, body, headers });
const CHALLENGE = { 'cf-mitigated': 'challenge' };

function httpStage(spec, controller) {
  let call = 0;
  if (spec === 'private') return async () => (assertPublicUrl(url), page);
  if (spec === 'hang') return async () => new Promise(() => {});
  if (spec === 'cancel') return async () => (controller.abort(new Error('user stopped')), page);
  return async () => {
    const response = spec[Math.min(call++, spec.length - 1)];
    assertDocumentResponse(response.status, new Headers(response.headers), url);
    return extractDocument(url, response.body, 'text/markdown');
  };
}

function browserStage(spec) {
  if (spec === 'page') return async () => page;
  if (spec === 'challenge') return async () => {
    throw error('Explicit challenge response', { code: 'BLOCKED_CONTENT', status: 200 });
  };
  if (spec === 'hang') return async () => new Promise(() => {});
  return async () => {
    throw error(`browser stage must not run (${spec})`);
  };
}

const attemptsOf = (attempts) => attempts.map(({ elapsedMs: _, ...rest }) => rest);

async function run(spec) {
  const delays = [];
  const controller = spec.http === 'cancel' ? new AbortController() : undefined;
  try {
    const result = await runFetchPipeline(url, {
      timeoutMs: spec.timeoutMs ?? 3000,
      hostPacer: new HostPacer({ intervalMs: 0 }),
      signal: controller?.signal,
      sleep: async (delayMs) => void delays.push(delayMs),
      http: httpStage(spec.http, controller),
      browser: browserStage(spec.browser),
    });
    return {
      page: { title: result.title, content: result.content, extractor: result.extractor ?? null },
      triedExtractors: result.triedExtractors,
      failures: result.failures,
      attempts: attemptsOf(result.attempts),
      delays,
    };
  } catch (failure) {
    return {
      error: { code: failure.code, message: failure.message, status: failure.status ?? null },
      triedExtractors: failure.attempts.map((a) => a.stage),
      failures: failure.failures,
      attempts: attemptsOf(failure.attempts),
      delays,
    };
  }
}

const groups = [
  ['HTTP success avoids browser startup and reports only actual attempts', [{ http: [served(200, 'Useful page content.')], browser: 'lazy' }]],
  [
    'empty documents, HTTP 403 and explicit challenge responses escalate once',
    [
      { http: [served(200, '')], browser: 'page' },
      { http: [served(403)], browser: 'page' },
      { http: [served(200, '   ')], browser: 'page' },
      ...[200, 403, 503].map((status) => ({ http: [served(status, '', CHALLENGE)], browser: 'page' })),
      { http: [served(403)], browser: 'challenge' },
    ],
  ],
  [
    'security blocks and terminal HTTP errors do not retry or launch a browser',
    [{ http: 'private', browser: 'terminal' }, { http: [served(404)], browser: 'terminal' }, { http: [served(401)], browser: 'terminal' }],
  ],
  [
    'transient HTTP failures retry within budget and respect Retry-After',
    [
      { http: [served(429, '', { 'retry-after': '0.45' }), served(200, 'Useful page content.')], browser: 'none' },
      { http: [served(429, '', { 'retry-after': '10' })], browser: 'rate-limit', timeoutMs: 100 },
      { http: [served(429, '', { ...CHALLENGE, 'retry-after': '10' })], browser: 'rate-limit', timeoutMs: 100 },
    ],
  ],
  ['total deadline and caller cancellation stop queued or hanging stages', [{ http: 'hang', browser: 'hang', timeoutMs: 120 }, { http: 'cancel', browser: 'cancelled' }]],
];
const cases = [];
for (const [name, specs] of groups) {
  const runs = [];
  for (const spec of specs) runs.push({ spec, outcome: await run(spec) });
  cases.push({ case: name, kind: 'runs', runs });
}

// The pacer case through Node's real HostPacer, as the test drives it: the order the operations ran.
{
  const pacer = new HostPacer({ intervalMs: 0 });
  const calls = [];
  let release;
  const blocker = new Promise((resolve) => (release = resolve));
  const first = pacer.run(url, undefined, async () => {
    calls.push('first');
    await blocker;
  });
  const controller = new AbortController();
  const cancelled = pacer.run(url, controller.signal, async () => calls.push('cancelled'));
  const third = pacer.run(url, undefined, async () => void calls.push('third'));
  controller.abort(new Error('cancel queued'));
  const cancelledOutcome = await cancelled.then(() => 'ran', () => 'rejected');
  await pacer.run('https://example.org', undefined, async () => void calls.push('other'));
  const beforeRelease = [...calls];
  release();
  await Promise.all([first, third]);
  cases.push({
    case: 'host pacing serializes a site, isolates other sites and skips cancelled waiters',
    kind: 'pacer',
    recorded: { beforeRelease, afterRelease: calls, cancelled: cancelledOutcome },
  });
}

// Runs the Rust pipeline answers differently, named `<case> #<run>`.
const excluded = {
  'total deadline and caller cancellation stop queued or hanging stages #0':
    'DIFFERENCE: Node traces the render stage cut off by the total deadline (failure and attempt FETCH_TIMEOUT); Rust drops the stage with the deadline and its trace holds only the http attempt',
  'total deadline and caller cancellation stop queued or hanging stages #1':
    "DIFFERENCE: a caller cancel during the http stage: Node fails with the abort reason ('user stopped') and traces the http attempt as NETWORK_ERROR; Rust fails with 'Fetch cancelled' and traces no attempt",
};
const finalDir = join(FIXTURES_ROOT, 'fetch-pipeline-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's fetch pipeline at ${NODE_COMMIT}, per case of ${RECORDER}`, test: TEST, url, cases });
writeSetManifest(stage, {
  set: 'fetch-pipeline-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared:
      "runs: each whole outcome of Pipeline::run against a local server serving the recorded responses (page or error, failures, attempts without elapsed times; the tried stages are the attempts' stages); a run that asked for retry waits took at least that long and less than one more retry floor. pacer: the order the operations reached the server, and that the cancelled fetch never ran",
    excluded,
  },
});
commitStage(stage, finalDir);
console.log(`fetch-pipeline-cases: ${cases.length} case(s), ${Object.keys(excluded).length} named exclusion(s)`);
process.exit(0);
