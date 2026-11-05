#!/usr/bin/env node
// Additional tool goldens (T §8.2) beside record-tools.mjs: every `code_graph`
// mode, `office` (local mixdog-* backends only, portable mode), `read` of
// PDF / DOCX / XLSX / PPTX, and `memory`. Writes into native/core/fixtures/tools/
// without wiping what record-tools.mjs recorded, then refreshes the set manifest.
// Run record-tools.mjs first.
//
//   node benchmarks/rust-core/recorders/record-tools-extra.mjs --tree <dir> [--native-root <dir>]
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const work = mkdtempSync(join(tmpdir(), 'mixdog-tool-golden2-'));
process.env.MIXDOG_DATA_DIR = join(work, 'data');
process.env.MIXDOG_TOOL_FAILURE_LOG_PATH = join(work, 'failures.jsonl');
const nativeRoot = args.get('native-root') ?? join(tree, 'native');
const exe = process.platform === 'win32' ? '.exe' : '';
const graphBin = join(nativeRoot, 'mixdog-graph', 'target', 'release', 'mixdog-graph' + exe);
if (existsSync(graphBin)) process.env.MIXDOG_GRAPH_BIN = graphBin;

const ws = join(work, 'ws');
const FIXED = new Date('2026-01-02T03:04:05Z');
const src = {
  'src/main.mjs': "import { add, sub } from './lib/math.mjs';\n\nexport function main() {\n  return add(1, 2) + sub(5, 3);\n}\n\nexport function other() {\n  return add(3, 4);\n}\n",
  'src/lib/math.mjs': 'export function add(a, b) {\n  return a + b;\n}\n\nexport function sub(a, b) {\n  return a - b;\n}\n',
  'src/lib/util.mjs': "import { add } from './math.mjs';\n\nexport const twice = (x) => add(x, x);\n",
  'src/app.py': 'def greet(name):\n    return "hi " + name\n\n\nclass Greeter:\n    def run(self):\n        return greet("x")\n',
};
for (const [rel, data] of Object.entries(src)) {
  const p = join(ws, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, data);
  utimesSync(p, FIXED, FIXED);
}

const fwd = ws.replace(/\\/g, '/');
// Nested JSON envelopes double the backslashes of a Windows path at each level.
const pathForms = [1, 2, 4, 8, 16, 32].flatMap((n) => [ws.replace(/\\/g, '\\'.repeat(n)), ws.toLowerCase().replace(/\\/g, '\\'.repeat(n))]);
const scrub = (text) =>
  pathForms.reduce((s, form) => s.replaceAll(form, '<ROOT>'), String(text))
    .replaceAll(ws.toLowerCase(), '<ROOT>').replaceAll(fwd.toLowerCase(), '<ROOT>').replaceAll(ws, '<ROOT>').replaceAll(fwd, '<ROOT>').replaceAll(JSON.stringify(ws).slice(1, -1), '<ROOT>')
    .replace(/[A-Za-z]:(\\+)Users\1tempe.*?mixdog-tool-golden2-[A-Za-z0-9]+/g, '<WORK>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<UUID>')
    .replace(/\b(office|sess|session)_[A-Za-z0-9]{6,}\b/g, '$1_<ID>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<TS>')
    .replace(/(\\*)"(elapsedMs|durationMs|ms)\1":\s*\d+(\.\d+)?/g, '$1"$2$1": 0');
const { normalizeToolEnvelope } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/tool-envelope.mjs');
const { executeBuiltinTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin.mjs');
const { executeCodeGraphTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/code-graph.mjs');

const outDir = join(FIXTURES_ROOT, 'tools');
const recorded = [];
const impossible = [];
const timeout = (ms, label) => new Promise((_r, rej) => setTimeout(() => rej(new Error(`recorder timeout after ${ms}ms: ${label}`)), ms));
async function golden(dir, name, toolName, input, fn, { ms = 60000 } = {}) {
  let outcome;
  try {
    const raw = await Promise.race([fn(), timeout(ms, `${toolName}/${name}`)]);
    const env = normalizeToolEnvelope(raw);
    const text = typeof env.result === 'string' ? env.result : JSON.stringify(env.result ?? '');
    outcome = { text: scrub(text), isError: env.isError === true || /^Error[\s:[]/.test(text) };
  } catch (e) {
    outcome = { thrown: scrub(String(e?.message ?? e)) };
  }
  writeJson(join(outDir, dir, `${name}.json`), { tool: toolName, input: JSON.parse(scrub(JSON.stringify(input))), ...outcome });
  recorded.push(`${dir}/${name}`);
  return outcome;
}

// ---- code_graph: every mode ----------------------------------------------------
const cg = (name, input) => golden('code_graph', name, 'code_graph', input, () => executeCodeGraphTool('code_graph', input, ws));
await cg('mode-overview', { mode: 'overview', files: ['src/main.mjs'] });
await cg('mode-overview-depth2', { mode: 'overview', files: ['src/main.mjs'], depth: 2 });
await cg('mode-imports', { mode: 'imports', files: ['src/main.mjs'] });
await cg('mode-dependents', { mode: 'dependents', files: ['src/lib/math.mjs'] });
await cg('mode-related', { mode: 'related', files: ['src/lib/math.mjs'] });
await cg('mode-impact', { mode: 'impact', files: ['src/lib/math.mjs'] });
await cg('mode-symbols', { mode: 'symbols', files: ['src/lib/math.mjs'] });
await cg('mode-symbols-python', { mode: 'symbols', files: ['src/app.py'] });
await cg('mode-symbols-filter', { mode: 'symbols', files: ['src/lib/math.mjs'], symbols: ['sub'] });
await cg('mode-find_symbol', { mode: 'find_symbol', symbols: ['add'] });
await cg('mode-find_symbol-nobody', { mode: 'find_symbol', symbols: ['add'], body: false });
await cg('mode-symbol_search', { mode: 'symbol_search', symbols: ['gree'] });
await cg('mode-search', { mode: 'search', symbols: ['twice'] });
await cg('mode-references', { mode: 'references', symbols: ['add'] });
await cg('mode-references-body', { mode: 'references', symbols: ['add'], body: true, limit: 2 });
await cg('mode-callers', { mode: 'callers', symbols: ['add'] });
await cg('mode-callers-depth2', { mode: 'callers', symbols: ['add'], depth: 2 });
await cg('mode-callees', { mode: 'callees', symbols: ['main'] });
await cg('error-missing-symbols', { mode: 'find_symbol' });
await cg('error-bad-mode', { mode: 'nope' });
await cg('error-missing-file', { mode: 'symbols', files: ['src/missing.mjs'] });

// ---- minimal PDF + OOXML for read / office ----------------------------------------------
function minimalPdf(text) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 18 Tf 20 80 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}
writeFileSync(join(ws, 'sample.pdf'), minimalPdf('Mixdog golden PDF text'), 'latin1');
const rd = (name, input) => golden('read', name, 'read', input, () => executeBuiltinTool('read', input, ws));
await rd('read-pdf', { path: 'sample.pdf' });
await rd('read-pdf-bad', { path: 'sample.pdf', offset: 5 });
writeFileSync(join(ws, 'broken.pdf'), '%PDF-1.4\nnot really a pdf\n');
await rd('read-pdf-corrupt', { path: 'broken.pdf' });
writeFileSync(join(ws, 'broken.docx'), 'not a zip');
await rd('read-docx-corrupt', { path: 'broken.docx' });

// ---- office (portable backend, local files) -----------------------------------------------------
const { executeOfficeTool } = await importFrom(tree, 'src/runtime/office/index.mjs');
const office = (name, input, opts) => golden('office', name, 'office', input, () => executeOfficeTool(input, { cwd: ws, dataDir: join(work, 'office-data') }), opts);
const parse = (o) => { try { return JSON.parse(o.text); } catch { return null; } };
await office('describe', { action: 'describe' });
await office('describe-docx', { action: 'describe', format: 'docx' });
await office('describe-operation', { action: 'describe', format: 'xlsx', operation: 'set_range' });
await office('detect', { action: 'detect' });
for (const [fmt, file] of [['docx', 'a.docx'], ['xlsx', 'a.xlsx'], ['pptx', 'a.pptx']]) {
  const created = await office(`create-${fmt}`, { action: 'create', path: file, format: fmt, mode: 'portable' });
  const session = parse(created)?.session;
  if (session) {
    await office(`snapshot-${fmt}`, { action: 'snapshot', session });
    await office(`validate-${fmt}`, { action: 'validate', session });
    await office(`save-${fmt}`, { action: 'save', session });
    await office(`close-${fmt}`, { action: 'close', session });
  }
  await rd(`read-${fmt}`, { path: file });
}
await office('open-xlsx-batch', { action: 'open', path: 'a.xlsx', mode: 'portable' }).then(async (o) => {
  const session = parse(o)?.session;
  if (!session) return;
  await office('batch-xlsx-set_range', { action: 'batch', session, operations: [{ op: 'set_range', sheet: 'Sheet1', range: 'A1:B2', values: [['k', 'v'], ['one', 1]] }] });
  await office('query-xlsx', { action: 'query', session, query: 'Sheet1!A1:B2' });
  await office('save-xlsx-batch', { action: 'save', session });
  await office('close-xlsx-batch', { action: 'close', session });
  await rd('read-xlsx-after-batch', { path: 'a.xlsx' });
});
writeFileSync(join(ws, 'table.csv'), 'a,b\n1,2\n3,4\n');
await office('snapshot-csv', { action: 'open', path: 'table.csv', mode: 'portable' }).then(async (o) => {
  const session = parse(o)?.session;
  if (session) { await office('query-csv', { action: 'snapshot', session }); await office('close-csv', { action: 'close', session }); }
});
await office('error-unknown-action', { action: 'nope' });
await office('error-missing-path', { action: 'open', path: 'missing.docx' });
await office('error-no-session', { action: 'snapshot', session: 'no-such-session' });

let memoryStop;
// ---- memory ---------------------------------------------------------------------------------------
// The memory store is an embedded PostgreSQL instance; try once with a bounded wait.
try {
  const memoryModule = await importFrom(tree, 'src/runtime/memory/index.mjs');
  await Promise.race([memoryModule.init(), timeout(120000, 'memory init')]);
  const { handleToolCall } = memoryModule;
  memoryStop = () => memoryModule.stop();
  const mem = (name, input) => golden('memory', name, 'memory', input, () => handleToolCall('memory', input), { ms: 120000 });
  const first = await mem('list-empty', { op: 'list' });
  if (first.thrown) impossible.push({ tool: 'memory', reason: first.thrown });
  else {
    await mem('add', { op: 'add', content: 'golden memory entry' });
    await mem('list-after-add', { op: 'list' });
    await mem('error-edit-missing', { op: 'edit', id: 999999, content: 'x' });
    await mem('error-bad-op', { op: 'nope' });
  }
} catch (e) {
  impossible.push({ tool: 'memory', reason: String(e?.message ?? e) });
}
await memoryStop?.();
writeJson(join(outDir, 'extra-impossible.json'), { impossible });

// Refresh the set manifest (record-tools.mjs wrote the first version).
writeSetManifest(outDir, {
  set: 'tools',
  recorder: 'benchmarks/rust-core/recorders/record-tools.mjs + record-tools-extra.mjs',
  command: 'node benchmarks/rust-core/recorders/record-tools.mjs --tree <tree> && node benchmarks/rust-core/recorders/record-tools-extra.mjs --tree <tree>',
  extra: { extraCases: recorded, extraImpossible: impossible.map((i) => i.tool) },
});
rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
console.log(`extra recorded ${recorded.length}; impossible: ${impossible.map((i) => `${i.tool}: ${i.reason.slice(0, 120)}`).join(' | ') || 'none'}`);
process.exit(0);
