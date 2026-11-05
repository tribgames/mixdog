#!/usr/bin/env node
// LSP golden twin against a REAL language server (typescript-language-server),
// recorded from today's Node `LanguageServerManager` (WP-WS, WORK-PACKAGES §3.1
// note: "LSP with a real language server" is recorded by its owning package).
// The scripted sequence is open (type error) -> hover/definition -> fix -> new
// error -> save -> close -> unsupported method -> server crash -> restart.
// Only settled facts are recorded (the diagnostics a quiet server converges on,
// request results, statuses); intermediate publish counts are timing and are
// not part of the twin. Everything runs in a temp directory with fake data.
//
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs \
//        benchmarks/rust-core/recorders/record-lsp-real.mjs --tree <dir with node_modules>
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, sha256, writeJson } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const work = mkdtempSync(join(tmpdir(), 'mixdog-lsp-real-'));
const project = join(work, 'project');
mkdirSync(join(project, 'src'), { recursive: true });
writeFileSync(
  join(project, 'tsconfig.json'),
  JSON.stringify({ compilerOptions: { strict: true, target: 'es2022', module: 'esnext', noEmit: true }, include: ['src'] })
);
writeFileSync(join(project, 'src', 'util.ts'), 'export function twice(n: number): number {\n  return n * 2;\n}\n');
writeFileSync(join(project, 'src', 'a.ts'), 'import { twice } from "./util";\nconst x: number = twice(2);\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fwd = (p) => p.replace(/\\/g, '/');
const scrub = (value) => {
  let text = JSON.stringify(value ?? null);
  for (const root of [work, fwd(work), JSON.stringify(work).slice(1, -1)]) text = text.replaceAll(root, '<WORK>');
  text = text.replaceAll('file:///<WORK>', 'file://<WORK>');
  return JSON.parse(text);
};

const lsp = await importFrom(tree, 'apps/desktop/src/main/language-server-manager.ts');
const manager = new lsp.LanguageServerManager();
const diagnostics = new Map();
const statuses = [];
let lastDiagnosticAt = 0;
manager.subscribeDiagnostics((event) => {
  diagnostics.set(event.relPath, event.diagnostics);
  lastDiagnosticAt = Date.now();
});
manager.subscribeStatus((event) => statuses.push({ status: event.status, languageId: event.languageId, server: event.server, detail: event.detail ?? null }));

/** Waits until `ready(diagnostics)` holds and nothing arrived for `quietMs`. */
async function settled(relPath, ready, quietMs = 1200, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = diagnostics.get(relPath);
    if (list && ready(list) && Date.now() - lastDiagnosticAt >= quietMs) return list;
    await sleep(100);
  }
  throw new Error(`diagnostics for ${relPath} did not settle`);
}
const brief = (list) =>
  list
    .map((d) => ({ range: d.range, severity: d.severity, code: d.code, source: d.source, message: d.message }))
    .sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);

const entries = [];
const record = async (op, input, fn) => {
  let out;
  try {
    out = { result: await fn() };
  } catch (error) {
    out = { error: { name: error?.name ?? null, message: String(error?.message ?? error) } };
  }
  entries.push(scrub({ op, args: input, ...out }));
};
const doc = (kind, relPath, version, content) => ({ kind, relPath, languageId: 'typescript', version, content });
const bad = 'import { twice } from "./util";\nconst x: number = twice("2");\n';
const fixed = 'import { twice } from "./util";\nconst x: number = twice(2);\nconst y: string = x;\n';
const call = (name, ...a) => manager[name](project, project, ...a);

await record('document(open)', [doc('open', 'src/a.ts', 1, bad)], () => call('document', doc('open', 'src/a.ts', 1, bad)));
await record('diagnostics(after open)', ['src/a.ts'], async () => brief(await settled('src/a.ts', (l) => l.length > 0)));
await record('request(hover)', ['src/a.ts', 'textDocument/hover', { position: { line: 1, character: 6 } }], () =>
  call('request', 'src/a.ts', 'typescript', 'textDocument/hover', { position: { line: 1, character: 6 } })
);
await record('request(definition)', ['src/a.ts', 'textDocument/definition', { position: { line: 1, character: 21 } }], () =>
  call('request', 'src/a.ts', 'typescript', 'textDocument/definition', { position: { line: 1, character: 21 } })
);
await record('request(unsupported method)', ['src/a.ts', 'textDocument/notAMethod', {}], () =>
  call('request', 'src/a.ts', 'typescript', 'textDocument/notAMethod', {})
);
await record('document(change: fix first error, add second)', [doc('change', 'src/a.ts', 2, fixed)], () => call('document', doc('change', 'src/a.ts', 2, fixed)));
await record('diagnostics(after change)', ['src/a.ts'], async () => brief(await settled('src/a.ts', (l) => l.length === 1 && l[0].range.start.line === 2)));
await record('document(save)', [doc('save', 'src/a.ts', 2, fixed)], () => call('document', doc('save', 'src/a.ts', 2, fixed)));
await record('document(close)', [doc('close', 'src/a.ts', 2, '')], () => call('document', doc('close', 'src/a.ts', 2, '')));
await record('diagnostics(after close)', ['src/a.ts'], async () => brief(await settled('src/a.ts', (l) => l.length === 0, 300)));

// A crash: kill the server process; the next document restarts it after the cooldown.
const crashStart = statuses.length;
await record('crash(kill server)', [], async () => {
  const session = manager.state.activeSessions()[0];
  if (!session) throw new Error('no live session to crash');
  session.child.kill();
  for (let i = 0; i < 100 && !statuses.slice(crashStart).some((s) => s.status === 'stopped'); i += 1) await sleep(100);
  return statuses.slice(crashStart).map((s) => ({ status: s.status, detail: s.detail && s.detail.replace(/\d+s\./, 'Ns.') }));
});
await sleep(1500);
await record('document(open after crash)', [doc('open', 'src/a.ts', 3, bad)], () => call('document', doc('open', 'src/a.ts', 3, bad)));
await record('diagnostics(after restart)', ['src/a.ts'], async () => brief(await settled('src/a.ts', (l) => l.length > 0)));
await record('disposeUnder', [], async () => (await manager.disposeUnder(project)).map((p) => relative(work, p).split(sep).join('/')));
await manager.dispose();

const serverVersion = readFileSync(join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'typescript-language-server', 'package.json'), 'utf8').match(/"version":\s*"([^"]+)"/)?.[1] ?? null;
const out = join(FIXTURES_ROOT, 'desktop', 'lsp', 'typescript-real.json');
writeJson(out, {
  domain: 'lsp',
  recorder: 'record-lsp-real.mjs',
  server: { id: 'typescript-language-server', version: serverVersion },
  project: { 'tsconfig.json': 'strict es2022', 'src/util.ts': 'twice(n: number): number', 'src/a.ts': 'imports twice' },
  entries,
});

// Register the new file in the desktop set manifest without touching its product identity.
const manifestPath = join(FIXTURES_ROOT, 'desktop', 'MANIFEST.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const data = readFileSync(out);
manifest.files = manifest.files.filter((f) => f.path !== 'lsp/typescript-real.json');
manifest.files.push({ path: 'lsp/typescript-real.json', bytes: data.length, sha256: sha256(data) });
manifest.files.sort((a, b) => a.path.localeCompare(b.path));
manifest.fileCount = manifest.files.length;
manifest.totalBytes = manifest.files.reduce((s, f) => s + f.bytes, 0);
writeJson(manifestPath, manifest);
rmSync(work, { recursive: true, force: true });
console.log(`lsp/typescript-real.json: ${entries.length} entries`);
process.exit(0);
