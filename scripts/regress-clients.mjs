#!/usr/bin/env node
// Regression of the protocol clients other than the desktop window: packages/protocol-client, the phone app
// (apps/mobile) and the TUI, against the integrated tree.
//   1. protocol-client typecheck and tests.
//   2. apps/mobile typecheck and tests, and the check that docs/internal/mobile-imports-of-desktop.md lists every file
//      outside apps/mobile that the phone app reaches through its imports (the deletion tasks keep those files).
//   3. The TUI smoke: a real `mixdogd serve` on an isolated profile, the protocol client of kind tui, a thread started
//      and a status call answered (scripts/rust-core/smoke-mixdogd.mjs bootOnce).
//   4. The corpus native/core/crates/mixdog-app-protocol/src/boundary/validate/fixtures/clients-accepted.json (every call
//      the TUI, the phone, the protocol client and the desktop send) sent over a real connection of each client kind to
//      a serving core: a refusal of a row (invalidParams, permissionDenied, methodNotFound) fails the run. Other errors
//      (a thread that does not exist, a host that is not attached) are not refusals of the row.
// A step whose prerequisite is not on this machine (a dependency that is not installed, no mixdogd binary) is reported
// as blocked with the reason and the run exits 2; a failed step exits 1; all passed exits 0.
// Usage: node scripts/regress-clients.mjs [--mixdogd <path>] [--only <step>[,<step>...]] [--list-mobile-imports]
//   --mixdogd defaults to $MIXDOGD_BIN. Steps: protocol-client, mobile, mobile-imports, tui-smoke, corpus.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const CORPUS = join(ROOT, 'native/core/crates/mixdog-app-protocol/src/boundary/validate/fixtures/clients-accepted.json');
const IMPORTS_DOC = join(ROOT, 'docs/internal/mobile-imports-of-desktop.md');
const REFUSALS = new Set(['invalidParams', 'permissionDenied', 'methodNotFound']);
const CALL_MS = 15_000;
const COMMAND_MS = 20 * 60_000;
// The connection kind each corpus client connects as (the protocol client's rows are the desktop's: the bridge kinds
// send a subset of them).
const KIND_OF = { tui: 'tui', desktop: 'desktop', phone: 'phone', 'protocol-client': 'desktop' };

class Blocked extends Error {}

// ---- commands ---------------------------------------------------------------------------------------------------------

/** Runs `node args` in `cwd`; throws a message with the last lines of the output when it exits non-zero. */
function node(cwd, args, label) {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: COMMAND_MS, maxBuffer: 64 << 20, windowsHide: true });
  const lines = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split(/\r?\n/).filter(Boolean);
  // Test runner output is reduced to the failed tests and the totals; anything else keeps its last lines.
  const totals = lines.filter((line) => /^# (tests|pass|fail) \d+$/.test(line));
  const failed = lines.filter((line) => /^\s*not ok /.test(line));
  if (r.error) throw new Error(`${label}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${label} exited ${r.status}:\n${(totals.length ? [...failed, ...totals] : lines.slice(-25)).slice(0, 40).join('\n')}`);
  return totals.map((line) => line.slice(2)).join(', ');
}

/** The file `specifier` resolves to from `dir`, else from the desktop app's dependencies (the one install the tools live in), or a Blocked. */
function need(dir, specifier) {
  for (const from of [dir, join(ROOT, 'apps/desktop'), ROOT]) {
    try {
      return createRequire(join(from, 'package.json')).resolve(specifier);
    } catch {
      // try the next place
    }
  }
  throw new Blocked(`${specifier} is not installed for ${relative(ROOT, dir) || '.'} (nothing is installed by this script)`);
}

function protocolClient() {
  const dir = join(ROOT, 'packages/protocol-client');
  const tsc = need(dir, 'typescript/bin/tsc');
  node(dir, [tsc, '-p', '.'], 'protocol-client typecheck');
  return node(dir, ['--import', pathToFileURL(need(dir, 'tsx/esm')).href, '--test', 'test/*.test.ts', 'test/rows/*.test.mjs'], 'protocol-client tests');
}

function mobile() {
  const dir = join(ROOT, 'apps/mobile');
  need(dir, '@capacitor/core');
  need(dir, '@capacitor-mlkit/barcode-scanning');
  const tsc = need(dir, 'typescript/bin/tsc');
  node(dir, [tsc, '--noEmit'], 'mobile typecheck');
  return node(dir, ['--import', pathToFileURL(need(dir, 'tsx/esm')).href, '--test', 'src/**/*.test.ts'], 'mobile tests');
}

// ---- the files outside apps/mobile that the phone app imports ----------------------------------------------------------

const IMPORT = /(?:\bfrom|\bimport|\bimport\s*\(|\brequire\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g;
const EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.mjs', '.js', '.d.ts', '/index.ts', '/index.mjs'];

function resolveImport(from, specifier) {
  const base = resolve(dirname(from), specifier);
  for (const extension of EXTENSIONS) {
    const file = base + extension;
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

function sourcesOf(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourcesOf(path));
    else if (/\.(ts|tsx|mts)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/**
 * Every file outside apps/mobile/src that the phone app (src, tests included) reaches by relative imports, followed
 * transitively through the files it reaches. `direct` are the ones its own files name, `closure` all of them;
 * repository-relative paths.
 */
export function mobileImports() {
  const mobileSrc = join(ROOT, 'apps/mobile/src');
  const direct = new Set();
  const closure = new Set();
  const queue = [];
  const visit = (file, isMobile) => {
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const target = resolveImport(file, m[1]);
      if (!target || target.startsWith(mobileSrc + sep)) continue;
      if (isMobile) direct.add(target);
      if (closure.has(target)) continue;
      closure.add(target);
      queue.push(target);
    }
  };
  for (const file of sourcesOf(mobileSrc)) visit(file, true);
  while (queue.length) visit(queue.pop(), false);
  const rel = (set) => [...set].map((f) => relative(ROOT, f).split(sep).join('/')).sort();
  return { direct: rel(direct), closure: rel(closure) };
}

function mobileImportsDoc() {
  if (!existsSync(IMPORTS_DOC)) throw new Error(`${relative(ROOT, IMPORTS_DOC)} does not exist`);
  const listed = new Set([...readFileSync(IMPORTS_DOC, 'utf8').matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]));
  const { closure } = mobileImports();
  const missing = closure.filter((f) => !listed.has(f));
  const gone = [...listed].filter((f) => !existsSync(join(ROOT, f)));
  if (missing.length || gone.length) {
    throw new Error(
      `${relative(ROOT, IMPORTS_DOC)} is out of date. Imported by the phone app but not listed: ${missing.join(', ') || 'none'}. Listed but not on disk: ${gone.join(', ') || 'none'}.`,
    );
  }
  return `${listed.size} files listed`;
}

// ---- a real connection ------------------------------------------------------------------------------------------------

/** A protocol-2 connection of `kind` to the core in `doc` (its discovery document), the handshake done unless `handshake` is false. */
async function open(doc, kind, version, { handshake = true } = {}) {
  const { default: WebSocket } = await import(pathToFileURL(need(ROOT, 'ws')).href);
  const socket = new WebSocket(`ws://127.0.0.1:${doc.core.rpc.port}/rpc`, {
    headers: { Authorization: `Bearer ${doc.endpoints.session.token}` },
    perMessageDeflate: false,
  });
  const pending = new Map();
  let next = 1;
  let closed = null;
  socket.on('message', (data, isBinary) => {
    if (isBinary) return;
    let m;
    try {
      m = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (m && typeof m === 'object' && typeof m.method !== 'string' && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  socket.on('close', (code, reason) => {
    closed = `${code} ${reason.toString('utf8')}`;
    for (const settleCall of pending.values()) settleCall({ closed });
    pending.clear();
  });
  await new Promise((done, fail) => {
    socket.once('open', done);
    socket.once('error', fail);
    socket.once('unexpected-response', (_request, response) => fail(new Error(`the core refused the connection (HTTP ${response.statusCode})`)));
  });
  const request = (method, params) =>
    new Promise((resolveCall) => {
      if (closed) return resolveCall({ closed });
      const id = next++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolveCall({ timeout: true });
      }, CALL_MS);
      pending.set(id, (m) => {
        clearTimeout(timer);
        resolveCall(m);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  if (handshake) {
    const hello = await request('initialize', { clientInfo: { name: `regress-${kind}`, version, kind }, capabilities: {} });
    if (hello.error) throw new Error(`initialize as ${kind} was answered with ${JSON.stringify(hello.error).slice(0, 300)}`);
    socket.send(JSON.stringify({ method: 'initialized' }));
  }
  return {
    request,
    notify: (method, params) => socket.send(JSON.stringify({ method, params })),
    isClosed: () => closed,
    close: () => socket.close(1000, 'done'),
  };
}

const refusalOf = (answer) => {
  const reason = answer.error?.data?.reason;
  return REFUSALS.has(reason) || answer.error?.code === -32601 ? `${reason ?? answer.error.code}: ${String(answer.error.message).slice(0, 160)}` : null;
};

/** The methods of the protocol's request table (the client notifications, a table of their own after it, get no answer). */
function requestMethods() {
  const text = readFileSync(join(ROOT, 'packages/protocol/src/index.ts'), 'utf8');
  const start = text.indexOf('"clientMethods": [');
  const end = text.indexOf('"clientNotifications": [', start);
  return new Set([...text.slice(start, end < 0 ? undefined : end).matchAll(/^\s{6}"method": "([^"]+)"/gm)].map((m) => m[1]));
}

/** Sends every row of the corpus, by client kind, to the serving core; throws the refusals, returns a one-line summary. */
async function sendCorpus(doc, version) {
  const rows = JSON.parse(readFileSync(CORPUS, 'utf8'));
  const requests = requestMethods();
  const failures = [];
  const counts = [];
  for (const client of Object.keys(KIND_OF)) {
    let connection = await open(doc, KIND_OF[client], version);
    const tally = { sent: 0, answered: 0, silent: 0 };
    for (const row of rows.filter((r) => r.client === client)) {
      const where = `${client} ${row.method} [${row.case}] (${row.source})`;
      tally.sent += 1;
      if (row.method === 'initialize') {
        // The row is the first message of a fresh connection (a second initialize is answered alreadyInitialized before its
        // params are looked at); the version gate (clientOutdated) is not a refusal of the row.
        const fresh = await open(doc, KIND_OF[client], version, { handshake: false });
        const answer = await fresh.request('initialize', row.params);
        fresh.close();
        const refusal = answer.error && refusalOf(answer);
        if (refusal) failures.push(`${where}: ${refusal}`);
        continue;
      }
      if (connection.isClosed()) connection = await open(doc, KIND_OF[client], version);
      if (!requests.has(row.method)) {
        // A client notification gets no answer: the row is accepted while the connection stays open.
        connection.notify(row.method, row.params);
        const probe = await connection.request('op/status', { opIds: [], scope: 'regress-probe' });
        if (probe.closed) failures.push(`${where}: the core closed the connection (${probe.closed})`);
        else tally.silent += 1;
        continue;
      }
      const answer = await connection.request(row.method, row.params);
      if (answer.closed) failures.push(`${where}: the core closed the connection (${answer.closed})`);
      else if (answer.timeout) tally.silent += 1;
      else {
        tally.answered += 1;
        const refusal = answer.error && refusalOf(answer);
        if (refusal) failures.push(`${where}: ${refusal}`);
      }
    }
    connection.close();
    counts.push(`${client}: ${tally.sent} sent, ${tally.answered} answered, ${tally.silent} without an answer`);
  }
  if (failures.length) {
    throw new Error(`${failures.length} row(s) refused by the core:\n${failures.slice(0, 40).join('\n')}${failures.length > 40 ? `\n... ${failures.length - 40} more` : ''}`);
  }
  return counts.join('; ');
}

async function corpus(bin) {
  const session = await import(pathToFileURL(join(ROOT, 'scripts/rust-core/lib/core-session.mjs')).href);
  const root = mkdtempSync(join(tmpdir(), 'mixdog-regress-clients-'));
  const version = String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
  let core;
  try {
    core = await session.startCore({ bin, root, config: {}, clientName: 'regress-clients' });
    return await sendCorpus(core.discovery, version);
  } finally {
    await core?.stop().catch((error) => console.error(`stop: ${error.message}`));
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      console.error(`could not remove ${root}: ${error.message}`);
    }
  }
}

async function tuiSmoke(bin) {
  const smoke = await import(pathToFileURL(join(ROOT, 'scripts/rust-core/smoke-mixdogd.mjs')).href);
  const { servingMs, answeredMs } = await smoke.bootOnce(bin);
  return `serving ${servingMs.toFixed(0)} ms, first answer ${answeredMs.toFixed(0)} ms`;
}

// ---- driver -----------------------------------------------------------------------------------------------------------

async function settle(work) {
  try {
    return { status: 'passed', detail: (await work()) || '' };
  } catch (error) {
    return { status: error instanceof Blocked ? 'blocked' : 'failed', detail: error.message };
  }
}

const STEPS = ['protocol-client', 'mobile', 'mobile-imports', 'tui-smoke', 'corpus'];

export async function main(argv) {
  const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  if (argv.includes('--list-mobile-imports')) {
    console.log(JSON.stringify(mobileImports(), null, 2));
    return 0;
  }
  const only = arg('--only');
  const want = new Set(only ? only.split(',') : STEPS);
  for (const step of want) if (!STEPS.includes(step)) throw new Error(`unknown step ${step} (steps: ${STEPS.join(', ')})`);
  const given = arg('--mixdogd') ?? process.env.MIXDOGD_BIN;
  const bin = given ? resolve(given) : null;
  const withCore = (work) => async () => {
    if (!bin) throw new Blocked('no mixdogd binary: pass --mixdogd <path> or set MIXDOGD_BIN');
    if (!existsSync(bin)) throw new Blocked(`the mixdogd binary ${bin} does not exist`);
    return work(bin);
  };
  const steps = {
    'protocol-client': protocolClient,
    mobile,
    'mobile-imports': mobileImportsDoc,
    'tui-smoke': withCore(tuiSmoke),
    corpus: withCore(corpus),
  };
  const results = {};
  for (const step of STEPS) if (want.has(step)) results[step] = await settle(steps[step]);
  for (const [step, { status, detail }] of Object.entries(results)) console.log(`${status.toUpperCase().padEnd(8)} ${step}${detail ? `: ${detail}` : ''}`);
  const statuses = Object.values(results).map((r) => r.status);
  return statuses.includes('failed') ? 1 : statuses.includes('blocked') ? 2 : 0;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
