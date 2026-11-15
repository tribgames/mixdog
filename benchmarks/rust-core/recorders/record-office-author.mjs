#!/usr/bin/env node
// Golden of the office author action (crate mixdog-office, module author): what Node's
// `runtime/office/authoring/pptx-author-action.mjs`, `pdf-author-action.mjs`, `html-document-author.mjs` and
// `pptx-author-session.mjs` answer without a browser, a script runtime or Microsoft Office:
//
//   gates     the refusals the geometry, facts and plan gates build (planGateResult, factsGateResult, geometryGateResult)
//   refusals  the author calls of every route that end before anything runs: a bare author, no kept source, an invalid mode,
//             a source that is not HTML, an existing target (each with the files the folder held), as the error text
//   reuse     reusableAuthoredSession over sessions that differ in one boundary, for each requested mode
//   swap      swapAuthoredDocument against scripted Microsoft Office answers (and a cancellation): the session afterwards
//   landing   landStagedDeck, cancelled and not
//
//   node benchmarks/rust-core/recorders/record-office-author.mjs --tree <product tree> [--modules <folder with node_modules>]
//
// Every path is written relative to `<root>`, the temporary folder, with `/` separators. Nothing is launched: no browser, no
// Office, no LibreOffice.
import { register } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, productIdentity, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-author.mjs';
const args = parseArgs();
const tree = path.resolve(args.get('tree') ?? process.cwd());
const modules = args.get('modules') ? path.resolve(args.get('modules')) : null;
let identity;
try {
  identity = productIdentity(tree);
} catch {
  identity = { tree: 'product tree loaded by the recorder', treeKind: 'export' };
}

for (const name of [
  'MIXDOG_OFFICE_DESIGN_LIBRARY_CONFIG',
  'MIXDOG_OFFICE_DESIGN_PACK_URL',
  'MIXDOG_OFFICE_DESIGN_PACK_KEY_ID',
  'MIXDOG_OFFICE_DESIGN_PACK_PUBLIC_KEY',
  'MIXDOG_OFFICE_TEMPLATE_DIRS',
]) {
  delete process.env[name];
}
process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

// A tree without its own node_modules reads the packages of the one `--modules` names.
async function resolveHook(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (!MODULES || /^(\.|file:|node:|data:)/.test(specifier)) throw error;
    return await next(specifier, { ...context, parentURL: MODULES });
  }
}
const modulesUrl = modules ? pathToFileURL(path.join(modules, 'package.json')).href : '';
const hooks = `const MODULES = ${JSON.stringify(modulesUrl)};\nexport ${resolveHook.toString().replace('resolveHook', 'resolve')}\n`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`, import.meta.url);

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'office-author-')));
process.chdir(root);
const finalDir = path.join(FIXTURES_ROOT, 'office-author');
const stage = stageSet(finalDir);

const plain = (value) => JSON.parse(JSON.stringify(value));
const slashed = (text) => String(text).replaceAll('\\', '/');
const norm = (text) => slashed(text).split(slashed(root)).join('<root>');
const normValue = (value) => JSON.parse(norm(JSON.stringify(value).replaceAll('\\\\', '/')));

const authorModule = await importFrom(tree, 'src/runtime/office/authoring/pptx-author-action.mjs');
const pdfModule = await importFrom(tree, 'src/runtime/office/authoring/pdf-author-action.mjs');
const htmlModule = await importFrom(tree, 'src/runtime/office/authoring/html-document-author.mjs');
const sessionModule = await importFrom(tree, 'src/runtime/office/authoring/pptx-author-session.mjs');
const core = await importFrom(tree, 'src/runtime/office/core/office-core.mjs');

// ---- gates ----------------------------------------------------------------------------------------------------------------
const gates = [];
const runShape = { logs: ['ok'], elapsedMs: 12 };
for (const gate of [
  { code: 'plan_missing', slides: [] },
  { code: 'plan_slide_unplanned', slides: [{ slide: 3 }, { slide: 4 }] },
  { code: 'plan_incomplete', slides: [{ slide: 2, missing: ['job', 'carriers'] }] },
  { code: 'plan_promise_missing', slides: [{ slide: 2, carrier: 'chart', label: 'chart' }, { slide: 5, carrier: 'gauge', label: 'gauge' }] },
  { code: 'something_else', slides: [{ slide: 1 }] },
]) {
  gates.push({ kind: 'plan', input: { target: '/work/deck.pptx', gate, run: runShape }, output: plain(authorModule.planGateResult('/work/deck.pptx', gate, runShape)) });
}
for (const [brief, gate] of [
  [{ facts: [] }, { code: 'facts_missing', slides: [{ slide: 2, figures: ['41%', '1,250'] }, { slide: 3, figures: ['38건'] }] }],
  [{ facts: [{ id: 'F1' }, { id: 'F2' }] }, { code: 'number_without_fact', slides: [{ slide: 1, figures: ['97%'] }] }],
]) {
  gates.push({ kind: 'facts', input: { target: '/work/deck.pptx', brief, gate, run: runShape }, output: plain(authorModule.factsGateResult('/work/deck.pptx', brief, gate, runShape)) });
}
for (const geometry of [
  [{ slide: 2, findings: [{ message: 'label is 14px off its mark' }] }],
  [{ slide: 1, findings: [{ message: 'a' }, { message: 'b' }] }, { slide: 4, findings: [{ message: 'c' }] }],
]) {
  const run = { ...runShape, geometry };
  gates.push({ kind: 'geometry', input: { target: '/work/deck.pptx', run }, output: plain(authorModule.geometryGateResult('/work/deck.pptx', run)) });
}

// ---- refusals -------------------------------------------------------------------------------------------------------------
const HTML = '<!doctype html><section class="slide"><h1>Retention rose</h1></section>';
const refusalCases = [
  { route: 'pptx', files: {}, args: {} },
  { route: 'pptx', files: {}, args: { script: HTML } },
  { route: 'pptx', files: {}, args: { path: 'deck.pptx' } },
  { route: 'pptx', files: {}, args: { path: 'deck.txt', script: HTML } },
  { route: 'pptx', files: {}, args: { path: 'deck.pptx', script: HTML, mode: 'visible' } },
  { route: 'pptx', files: {}, args: { path: 'deck.pptx', script: HTML, mode: 'live' } },
  { route: 'pptx', files: {}, args: { path: 'deck.pptx', script: HTML, mode: 'attach' } },
  { route: 'pptx', files: {}, args: { path: 'deck.pptx', script: HTML, mode: 'unsupported' } },
  { route: 'pptx', files: { 'deck.pptx': 'old' }, args: { path: 'deck.pptx', script: HTML } },
  { route: 'pdf', files: {}, args: { path: 'report.pdf' } },
  { route: 'pdf', files: {}, args: { path: 'report.pdf', script: 'plain text' } },
  { route: 'pdf', files: { 'report.pdf': 'old' }, args: { path: 'report.pdf', script: '<!doctype html><h1>x</h1>' } },
  { route: 'html', files: {}, args: { path: 'memo.docx' } },
  { route: 'html', files: {}, args: { path: 'book.xlsx' } },
  { route: 'html', files: {}, args: { path: 'memo.docx', script: 'plain text' } },
  { route: 'html', files: {}, args: { path: 'book.xlsx', script: 'plain text' } },
  { route: 'html', files: {}, args: { path: 'memo.docx', script: HTML, mode: 'visible' } },
  { route: 'html', files: { 'memo.docx': 'old' }, args: { path: 'memo.docx', script: '<!doctype html><p>x</p>' } },
  { route: 'html', files: { 'book.xlsx': 'old' }, args: { path: 'book.xlsx', script: '<!doctype html><p>x</p>' } },
];
const refusals = [];
for (const [index, entry] of refusalCases.entries()) {
  const cwd = path.join(root, `refusal-${index}`);
  mkdirSync(cwd, { recursive: true });
  for (const [name, text] of Object.entries(entry.files)) writeFileSync(path.join(cwd, name), text);
  const author = { pptx: authorModule.authorPptx, pdf: pdfModule.authorPdf, html: htmlModule.authorHtmlDocument }[entry.route];
  let output;
  try {
    const result = await author(entry.args, { cwd, dataDir: path.join(root, 'data') });
    output = { result: normValue(plain(result)) };
  } catch (error) {
    output = { error: norm(String(error?.message ?? error)) };
  }
  refusals.push({ input: entry, output, left: readdirSync(cwd).sort() });
}

// ---- reuse ----------------------------------------------------------------------------------------------------------------
const reuse = [];
const base = { id: 'reuse', authored: true, backend: 'microsoft-office-com', format: 'pptx', mode: 'background', ownership: 'owned', visible: false };
const changes = [{}, { ownership: 'attached' }, { visible: true }, { transaction: {} }, { authored: false }, { backend: 'mixdog-ooxml' }, { format: 'docx' }, { mode: 'portable' }, { mode: 'visible' }];
for (const change of changes) {
  for (const mode of ['auto', 'background', 'portable', 'visible', 'attach']) {
    const target = path.join(root, 'reuse.pptx');
    const session = { ...base, ...change, target };
    core.sessions.set(session.id, session);
    core.documentSessions.set(core.documentSessionKey(target), session.id);
    reuse.push({ input: { session: change, mode }, output: sessionModule.reusableAuthoredSession(target, mode) === session });
    core.sessions.delete(session.id);
    core.documentSessions.delete(core.documentSessionKey(target));
  }
}

// ---- swap -----------------------------------------------------------------------------------------------------------------
const swap = [];
const swapSession = () => ({
  id: 'swapped',
  format: 'pptx',
  mode: 'background',
  target: 'unused.pptx',
  appPid: 101,
  windowHwnd: 10,
  snapshotVersion: 7,
  snapshotCache: { old: true },
  renderCache: { old: true },
  designState: { requiresVisualReview: true, renderedVersion: 3 },
});
const swapCases = [
  { answer: { ok: true, appPid: 202, windowHwnd: 20, documentId: 'doc-2', backgroundIsolation: { desktop: 'x' } } },
  { answer: { ok: true } },
  { answer: { ok: false, error: 'busy' } },
  { answer: { ok: false, cancelled: true, error: 'cancelled by host' } },
  { answer: { ok: true, appPid: 202 }, abortDuring: true },
  { answer: { ok: true, appPid: 202 }, abortBefore: true },
];
for (const entry of swapCases) {
  const session = swapSession();
  const controller = new AbortController();
  if (entry.abortBefore) controller.abort();
  const requests = [];
  let threw = null;
  let result = null;
  try {
    result = await sessionModule.swapAuthoredDocument(session, 'staged.pptx', controller.signal, {
      callOffice: async (request) => {
        requests.push(request);
        if (entry.abortDuring) controller.abort();
        return structuredClone(entry.answer);
      },
    });
  } catch (error) {
    threw = { name: error.name, message: error.message };
  }
  const { openedAt, ...after } = session;
  swap.push({ input: entry, output: { result, threw, requests: plain(requests), session: plain(after), opened: typeof openedAt === 'string' } });
}

// ---- landing --------------------------------------------------------------------------------------------------------------
const landing = [];
for (const cancelled of [false, true]) {
  const cwd = path.join(root, `landing-${cancelled}`);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(path.join(cwd, 'target.pptx'), 'old deck');
  writeFileSync(path.join(cwd, 'staged.pptx'), 'new deck');
  let threw = null;
  try {
    await sessionModule.landStagedDeck(path.join(cwd, 'staged.pptx'), path.join(cwd, 'target.pptx'), cancelled ? AbortSignal.abort() : null);
  } catch (error) {
    threw = { name: error.name, message: error.message };
  }
  landing.push({
    input: { cancelled },
    output: { threw, target: readFileSync(path.join(cwd, 'target.pptx'), 'utf8'), left: readdirSync(cwd).sort() },
  });
}

writeJson(path.join(stage, 'golden.json'), { gates, refusals, reuse, swap, landing });
writeSetManifest(stage, { set: 'office-author', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
commitStage(stage, finalDir);
process.chdir(tmpdir());
rmSync(root, { recursive: true, force: true });
console.log(`office-author: ${gates.length} gates, ${refusals.length} refusals, ${reuse.length} reuse, ${swap.length} swaps, ${landing.length} landings`);
