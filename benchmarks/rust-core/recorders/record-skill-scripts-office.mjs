#!/usr/bin/env node
// Recording of the pptx skill scripts (source-extract, qc-pages, review-deck), for the Rust twin
// (native/core/crates/mixdog-skill-scripts/tests/office_scripts_twin.rs). Node runs the scripts of a product tree on
// inputs this file builds in a temporary folder; the stdout, stderr, exit code, the report files and the calls the
// script made to its collaborators are written to native/core/fixtures/skill-scripts-office/golden.json, with the
// inputs and the stubs, so the twin builds the same folders and answers the same calls. Nothing in the tree is
// written. Node built-ins only.
//
//   node benchmarks/rust-core/recorders/record-skill-scripts-office.mjs --tree C:\Project\mixdog [--out <fixture folder>]
//
// The collaborators are stubs, as the scripts' own injection points allow: `execute` (the model turn: a recorded
// answer, which for qc-pages also edits the page's working copy as told), `office` and `measure` (the office engine:
// a recorded snapshot and issue list per file name, a renderer that answers one image or an error). The engine's own
// output is the office tracks' twin; this one pins what the scripts do with it. Cases that need no stub (usage and
// argument errors, plain-text sources) run the script file itself with `node`.
//
// Paths in the output: the temporary root is written <root> (separators as slashes) and the random part of a work
// folder `review-input-<id>`.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const flags = parseArgs({ options: { tree: { type: 'string' }, out: { type: 'string' } } }).values;
if (!flags.tree) throw new Error('usage: record-skill-scripts-office.mjs --tree <product tree> [--out <folder>]');
const TREE = resolve(flags.tree);
const OUT = resolve(flags.out ?? join(REPO_ROOT, 'native', 'core', 'fixtures', 'skill-scripts-office'));

const SCRIPTS = join(TREE, 'src', 'defaults', 'skills', 'pptx', 'scripts');
const EXTRACT = join(SCRIPTS, 'source-extract.mjs');
const QC = join(SCRIPTS, 'qc-pages.mjs');
const REVIEW = join(SCRIPTS, 'review-deck.mjs');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const url = (path) => pathToFileURL(path).href;
const { extractSource, formatExtract, DEFAULT_CHARS } = await import(url(EXTRACT));
const { runPageQc } = await import(url(QC));
const { runReview } = await import(url(REVIEW));

const slashes = (text) => text.replaceAll('\\', '/');

// ---------------------------------------------------------------------------------------------------------------------
// Inputs and normalisation
// ---------------------------------------------------------------------------------------------------------------------
function materialise(root, input) {
  mkdirSync(root, { recursive: true });
  for (const [rel, spec] of Object.entries(input.files ?? {})) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    const bytes = typeof spec === 'string' ? Buffer.from(spec, 'utf8') : Buffer.from(spec.base64, 'base64');
    writeFileSync(join(root, rel), bytes);
  }
}

function normaliser(root) {
  const forms = [root.replaceAll('\\', '\\\\'), root, slashes(root)];
  const str = (text) => {
    let out = String(text);
    for (const form of forms) out = out.split(form).join('<root>');
    return slashes(out.replaceAll('\\\\', '/')).replace(/review-input-[A-Za-z0-9]{6}/g, 'review-input-<id>');
  };
  const value = (item) => {
    if (typeof item === 'string') return str(item);
    if (Array.isArray(item)) return item.map(value);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, value(child)]));
    return item;
  };
  return { str, value };
}

function readCaptured(root, rels, norm) {
  const files = {};
  for (const rel of rels) {
    const path = join(root, rel);
    if (!existsSync(path)) {
      files[rel] = null;
    } else {
      // A report is compared as a document; a file that is not one (an output that was there already) as text.
      const text = readFileSync(path, 'utf8');
      let parsed;
      try {
        parsed = norm.value(JSON.parse(text));
      } catch {
        parsed = norm.str(text);
      }
      files[rel] = parsed;
    }
  }
  return files;
}

// The work folders a review leaves beside its report: each one's files with their sizes.
function workFolders(root, dir, norm) {
  const base = join(root, dir);
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((name) => name.startsWith('review-input-'))
    .map((name) => ({
      folder: norm.str(name),
      files: readdirSync(join(base, name)).sort().map((file) => [file, statSync(join(base, name, file)).size]),
    }));
}

async function capture(fn) {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  const write = process.stderr.write;
  console.log = (...args) => out.push(`${args.join(' ')}\n`);
  console.error = (...args) => err.push(`${args.join(' ')}\n`);
  process.stderr.write = (chunk) => {
    err.push(String(chunk));
    return true;
  };
  process.exitCode = undefined;
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = error;
    process.stderr.write = write;
  }
  const status = process.exitCode ?? 0;
  process.exitCode = undefined;
  return { stdout: out.join(''), stderr: err.join(''), status };
}

// ---------------------------------------------------------------------------------------------------------------------
// The scripts' main blocks, as they are in the files (the files only run them when started as a program).
// ---------------------------------------------------------------------------------------------------------------------
const EXTRACT_USAGE = 'Usage: source-extract.mjs <file.pdf|docx|xlsx|pptx|md|txt> [--chars 4000]';
async function mainExtract(argv, root, office) {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { chars: { type: 'string' } } });
    if (positionals.length !== 1) throw new Error(EXTRACT_USAGE);
    console.log(formatExtract(await extractSource(positionals[0], { chars: values.chars ?? DEFAULT_CHARS, cwd: root, office })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

async function mainQc(argv, execute, office, measure) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        provider: { type: 'string' },
        model: { type: 'string' },
        effort: { type: 'string' },
        output: { type: 'string' },
        pages: { type: 'string' },
        'no-vision': { type: 'boolean' },
      },
    });
    if (positionals.length !== 1 || !values.output) {
      throw new Error(
        'Usage: qc-pages.mjs deck.pptx --provider <provider> --model <model> --output qc-report.json [--pages 1-12] [--no-vision]'
      );
    }
    const report = await runPageQc(
      {
        deck: positionals[0],
        pages: values.pages,
        provider: values.provider,
        model: values.model,
        effort: values.effort,
        output: values.output,
        vision: values['no-vision'] !== true,
      },
      { execute, office, measure }
    );
    console.log(
      JSON.stringify({
        ok: report.ok,
        output: resolve(values.output),
        fixed: report.fixed,
        polished: report.polished,
        discarded: report.discarded,
        skipped: report.skipped,
        failed: report.failed,
        skippedPages: report.skippedPages,
        pages: report.pages.map((entry) => `${entry.page}:${entry.reason}`),
      })
    );
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

async function mainReview(argv, execute) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { provider: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, output: { type: 'string' } },
    });
    if (positionals.length !== 1 || !values.output)
      throw new Error('Usage: review-deck.mjs packet.json --provider <provider> --model <model> --output new-report.json');
    const result = await runReview({ input: positionals[0], ...values }, { execute });
    console.log(
      JSON.stringify({ ok: result.ok, output: resolve(values.output), error: result.error, selection: result.review?.selection })
    );
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------------------------------------------------
function officeStub(spec, calls, norm) {
  let opened = '';
  return async (args) => {
    calls.push(norm.value(args));
    switch (args.action) {
      case 'open':
        if (spec.openError) throw new Error(spec.openError);
        opened = basename(args.path);
        return { session: 's1' };
      case 'snapshot':
        return { document: spec.documents?.[opened] };
      case 'render':
        if (spec.render?.error !== undefined) throw new Error(spec.render.error);
        if (spec.render?.images?.[args.pages[0]] === undefined) return { images: [] };
        return { images: [{ page: args.pages[0], path: spec.render.images[args.pages[0]] }] };
      default:
        return {};
    }
  };
}

function measureStub(spec) {
  return async (path) => {
    const found = spec.measures?.[basename(path)];
    if (!found) throw new Error(`cannot measure ${basename(path)}`);
    return found;
  };
}

function recordedCall(options, norm) {
  return norm.value({
    message: options.message,
    provider: options.provider,
    model: options.model,
    effort: options.effort ?? null,
    cwd: options.cwd ?? null,
    usageLogPath: options.usageLogPath ?? null,
    webSearch: options.webSearch,
  });
}

function execStub(spec, calls, norm) {
  return async (options) => {
    calls.push(recordedCall(options, norm));
    const page = /^Slide (\d+) of/m.exec(options.message)?.[1];
    const answer = (page && spec.pages?.[page]) || spec.default || { code: 0, out: 'OK' };
    if (answer.edit !== undefined && answer.edit !== null) {
      writeFileSync(/output:"([^"]*)"/.exec(options.message)[1], answer.edit);
    }
    if (answer.out) options.write(answer.out);
    if (answer.err) options.writeErr(answer.err);
    return answer.code ?? 0;
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------------------------------------------------
const cases = { extract: [], qc: [], review: [] };

function cli(script, argv, root) {
  const result = spawnSync(process.execPath, [script, ...argv], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

async function record(kind, name, spec) {
  const root = mkdtempSync(join(tmpdir(), 'office-scripts-'));
  try {
    materialise(root, spec.input ?? {});
    const norm = normaliser(root);
    const argv = spec.argv.map((arg) => arg.replaceAll('<root>', slashes(root)));
    const calls = [];
    let run;
    if (spec.cli) {
      run = cli({ extract: EXTRACT, qc: QC, review: REVIEW }[kind], argv, root);
    } else if (kind === 'extract') {
      run = await capture(() => mainExtract(argv, root, officeStub(spec.stub ?? {}, calls, norm)));
    } else if (kind === 'qc') {
      const stub = spec.stub ?? {};
      const images = Object.fromEntries(
        Object.entries(stub.render?.images ?? {}).map(([page, path]) => [page, path.replaceAll('<root>', slashes(root))])
      );
      const office = officeStub({ ...stub, render: stub.render ? { ...stub.render, images } : undefined }, calls, norm);
      const execCalls = [];
      run = await capture(() => mainQc(argv, execStub(stub, execCalls, norm), office, measureStub(stub)));
      run.exec = execCalls;
    } else {
      const execCalls = [];
      run = await capture(() => mainReview(argv, execStub({ default: spec.stub ?? { code: 0 } }, execCalls, norm)));
      run.exec = execCalls;
    }
    const observed = {
      stdout: norm.str(run.stdout),
      stderr: norm.str(run.stderr),
      status: run.status,
      files: readCaptured(root, spec.capture ?? [], norm),
    };
    if (!spec.cli && kind !== 'review') observed.office = calls;
    if (!spec.cli && kind !== 'extract') observed.exec = run.exec;
    if (spec.workFolders) observed.workFolders = workFolders(root, spec.workFolders, norm);
    cases[kind].push({ case: name, ...spec, observed });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ----- source-extract -------------------------------------------------------------------------------------------------
const extractText = (name, files, argv, extra = {}) =>
  record('extract', name, { input: { files }, argv, cli: true, ...extra });
await extractText('a text file, every non-empty line a block', { 'notes.md': '  Alpha figure 12 \n\n\tBeta  \r\nGamma\n' }, ['<root>/notes.md']);
await extractText('a text file cut by --chars', { 'notes.txt': 'aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\ndddddddddd\n' }, ['<root>/notes.txt', '--chars', '15']);
await extractText('--chars given as =', { 'notes.txt': 'one\ntwo\nthree\n' }, ['<root>/notes.txt', '--chars=4']);
await extractText('a fractional --chars', { 'notes.txt': 'one\ntwo\nthree\n' }, ['<root>/notes.txt', '--chars', '0.5']);
await extractText('a zero --chars', { 'notes.txt': 'one\n' }, ['<root>/notes.txt', '--chars', '0']);
await extractText('a negative --chars', { 'notes.txt': 'one\n' }, ['<root>/notes.txt', '--chars=-5']);
await extractText('a non-numeric --chars', { 'notes.txt': 'one\n' }, ['<root>/notes.txt', '--chars', 'abc']);
await extractText('an infinite --chars', { 'notes.txt': 'one\n' }, ['<root>/notes.txt', '--chars', 'Infinity']);
await extractText('a hexadecimal --chars', { 'notes.txt': 'one\ntwo\n' }, ['<root>/notes.txt', '--chars', '0x10']);
await extractText('an empty --chars', { 'notes.txt': 'one\n' }, ['<root>/notes.txt', '--chars', '']);
await extractText('a file that is not there', {}, ['<root>/gone.md']);
await extractText('a relative path', { 'sub/n.md': 'in a folder\n' }, ['sub/n.md']);
await extractText('a path of spaces', {}, ['   ']);
await extractText('no arguments', {}, []);
await extractText('two files', { 'a.md': 'a', 'b.md': 'b' }, ['<root>/a.md', '<root>/b.md']);
await extractText('an unknown option', { 'a.md': 'a' }, ['<root>/a.md', '--bogus']);
await extractText('--chars without a value', { 'a.md': 'a' }, ['<root>/a.md', '--chars']);
await extractText('CJK and astral text counts UTF-16 units', { 'n.md': '가나다라마바사아자차\n😀😀😀😀😀\n끝\n' }, ['<root>/n.md', '--chars', '10']);
await extractText('a byte order mark and an unknown extension', { 'n.log': '\ufeffalpha\nbeta\n' }, ['<root>/n.log']);
await extractText('an empty file', { 'n.md': '' }, ['<root>/n.md']);

const slide = (number, shapes) => ({ number, index: number, shapes });
const DOCUMENTS = {
  'a.pdf': { pages: [{ number: 1, text: 'First   page\n text' }, { index: 2, text: 'x'.repeat(700) }, { number: 3, text: '   ' }, { number: 4, text: 'Fourth' }] },
  'deck.pptx': {
    slides: [
      slide(1, [
        { text: 'Title', placeholder: true, name: 'Title 1' },
        { text: '1', placeholder: true, name: 'Slide Number Placeholder 3' },
        { text: 'Footer text', placeholder: true, name: 'Footer Placeholder 4' },
        { text: '2024-01-01', placeholder: true, name: 'Date Placeholder 5' },
        { text: 'not chrome', placeholder: false, name: 'Footer note' },
        { text: 'Body\n line' },
      ]),
      slide(2, [{ text: 'Second slide' }, { text: '' }, {}]),
    ],
  },
  'doc.docx': { blocks: [{ page: 2, text: 'On page two' }, { text: 'No page' }, { index: 9, text: 'Indexed' }, { text: 'Last' }] },
  'para.docx': { paragraphs: [{ text: 'Only paragraph' }], blocks: null },
  'book.xlsx': {
    sheets: [
      { name: 'Sheet1', cells: [{ ref: 'A1', value: 'Revenue' }, { ref: 'B1', value: 1200.5 }, { ref: 'C1', formula: '=B1*2' }, { ref: 'D1', value: 0 }, { ref: 'E1' }] },
      { name: 'Data', cells: [{ ref: 'A1', value: true }, { ref: 'A2', value: null, formula: 'SUM(A1:A1)' }] },
    ],
  },
  'mixed.pptx': { pages: [{ number: 1, text: 'p' }], slides: [slide(2, [{ text: 's' }])], blocks: [{ text: 'b' }], sheets: [{ name: 'S', cells: [{ ref: 'A1', value: 'c' }] }] },
  'empty.pdf': {},
};
const extractOffice = (name, file, argv, stub = {}) =>
  record('extract', name, { input: { files: { [file]: 'x' } }, argv: [`<root>/${file}`, ...argv], stub: { documents: DOCUMENTS, ...stub } });
await extractOffice('a pdf, page numbers and the block cut', 'a.pdf', []);
await extractOffice('a pdf cut by --chars', 'a.pdf', ['--chars', '20']);
await extractOffice('a deck without its page chrome', 'deck.pptx', []);
await extractOffice('a document, blocks with and without a page', 'doc.docx', []);
await extractOffice('a document that has paragraphs', 'para.docx', []);
await extractOffice('a workbook, cells by their references', 'book.xlsx', []);
await extractOffice('every kind in one snapshot', 'mixed.pptx', []);
await extractOffice('a snapshot with nothing in it', 'empty.pdf', []);
await extractOffice('the extension is read in lower case', 'deck.pptx', ['--chars', '40']);
await extractOffice('the engine refuses to open', 'a.pdf', [], { openError: 'password protected' });

// ----- review-deck ----------------------------------------------------------------------------------------------------
const packet = (change = {}) => ({
  task: 'Pick the clearer deck',
  sources: ['s1.md'],
  questions: [{ id: 'Q1', question: 'What grew?' }],
  candidates: [{ id: 'C1', pages: ['p1.png', 'p2.jpg'] }],
  ...change,
});
const REVIEW_FILES = { 's1.md': 'Revenue grew 12%.', 'p1.png': 'png-one', 'p2.jpg': 'jpg-two', 's2.txt': 'second source' };
const answer = (change = {}) => ({
  selection: { candidateId: 'C1', reason: '명확한 위계' },
  candidates: [
    {
      id: 'C1',
      pages: [
        { page: 1, verdict: 'pass', observations: ['제목과 근거의 크기 비율이 좋다'] },
        { page: 2, verdict: 'fix', observations: ['표 간격이 좁다'] },
      ],
      answers: [{ id: 'Q1', status: 'answered', answer: '매출이 늘었다', evidencePages: [1] }],
    },
  ],
  ...change,
});
const reviewCase = (name, { files = REVIEW_FILES, packetJson = packet(), stub, argv, extra = {}, cliOnly = false }) =>
  record('review', name, {
    input: { files: { ...files, 'in.json': typeof packetJson === 'string' ? packetJson : JSON.stringify(packetJson) } },
    argv: argv ?? ['<root>/in.json', '--provider', 'p', '--model', 'm', '--output', '<root>/out/r.json'],
    stub,
    cli: cliOnly,
    capture: ['out/r.json'],
    workFolders: 'out',
    ...extra,
  });
await reviewCase('a valid review', { stub: { code: 0, out: JSON.stringify(answer()), err: 'note\n' } });
await reviewCase('a review in a code fence', { stub: { code: 0, out: `\`\`\`JSON\n${JSON.stringify(answer())}\n\`\`\`` } });
await reviewCase('a review with null selection', { stub: { code: 0, out: JSON.stringify(answer({ selection: { candidateId: null, reason: '모두 부적합' } })) } });
await reviewCase('an effort and a second source', {
  packetJson: packet({ sources: ['s1.md', 's2.txt'] }),
  argv: ['<root>/in.json', '--provider', 'p', '--model', 'm', '--effort', 'low', '--output', '<root>/out/r.json'],
  stub: { code: 0, out: JSON.stringify(answer()) },
});
await reviewCase('an empty effort', {
  argv: ['<root>/in.json', '--provider', 'p', '--model', 'm', '--effort', '', '--output', '<root>/out/r.json'],
  stub: { code: 0, out: JSON.stringify(answer()) },
});
await reviewCase('an unknown candidate selected', { stub: { code: 0, out: JSON.stringify(answer({ selection: { candidateId: 'ZZ', reason: 'x' } })) } });
await reviewCase('a selection without a reason', { stub: { code: 0, out: JSON.stringify(answer({ selection: { candidateId: null, reason: ' ' } })) } });
await reviewCase('no candidates reported', { stub: { code: 0, out: JSON.stringify(answer({ candidates: [] })) } });
await reviewCase('a page missing', {
  stub: { code: 0, out: JSON.stringify(answer({ candidates: [{ ...answer().candidates[0], pages: [answer().candidates[0].pages[0]] }] })) },
});
await reviewCase('a verdict that is neither pass nor fix', {
  stub: { code: 0, out: JSON.stringify(answer({ candidates: [{ ...answer().candidates[0], pages: [{ page: 1, verdict: 'ok', observations: ['x'] }, answer().candidates[0].pages[1]] }] })) },
});
await reviewCase('a page without observations', {
  stub: { code: 0, out: JSON.stringify(answer({ candidates: [{ ...answer().candidates[0], pages: [{ page: 1, verdict: 'pass', observations: [' '] }, answer().candidates[0].pages[1]] }] })) },
});
await reviewCase('an answer cites a page that does not exist', {
  stub: { code: 0, out: JSON.stringify(answer({ candidates: [{ ...answer().candidates[0], answers: [{ id: 'Q1', status: 'answered', answer: 'a', evidencePages: [3] }] }] })) },
});
await reviewCase('an answered question without evidence', {
  stub: { code: 0, out: JSON.stringify(answer({ candidates: [{ ...answer().candidates[0], answers: [{ id: 'Q1', status: 'answered', answer: 'a', evidencePages: [] }] }] })) },
});
await reviewCase('a missing answer needs none', {
  stub: { code: 0, out: JSON.stringify(answer({ candidates: [{ ...answer().candidates[0], answers: [{ id: 'Q1', status: 'missing', answer: '없음', evidencePages: [] }] }] })) },
});
await reviewCase('a fractional evidence page', {
  stub: { code: 0, out: JSON.stringify(answer({ candidates: [{ ...answer().candidates[0], answers: [{ id: 'Q1', status: 'answered', answer: 'a', evidencePages: [1.5] }] }] })) },
});
await reviewCase('an answer that is not JSON', { stub: { code: 0, out: 'I could not decide.' } });
await reviewCase('an empty answer', { stub: { code: 0, out: '' } });
await reviewCase('a failed run', { stub: { code: 3, out: 'partial', err: 'boom\n' } });
await reviewCase('a candidate that is null', { stub: { code: 0, out: JSON.stringify(answer({ candidates: [null] })) } });
await reviewCase('a packet without a task', { packetJson: packet({ task: ' ' }), stub: { code: 0 } });
await reviewCase('a packet with no sources', { packetJson: packet({ sources: [] }), stub: { code: 0 } });
await reviewCase('a packet with nine sources', { packetJson: packet({ sources: Array(9).fill('s1.md') }), stub: { code: 0 } });
await reviewCase('a packet with no questions', { packetJson: packet({ questions: [] }), stub: { code: 0 } });
await reviewCase('a packet without candidates', { packetJson: packet({ candidates: [] }), stub: { code: 0 } });
await reviewCase('duplicate question ids', {
  packetJson: packet({ questions: [{ id: 'Q', question: 'a' }, { id: 'Q', question: 'b' }] }),
  stub: { code: 0 },
});
await reviewCase('a candidate id that is not simple', { packetJson: packet({ candidates: [{ id: 'C 1', pages: ['p1.png'] }] }), stub: { code: 0 } });
await reviewCase('a question without text', { packetJson: packet({ questions: [{ id: 'Q1', question: ' ' }] }), stub: { code: 0 } });
await reviewCase('a candidate without pages', { packetJson: packet({ candidates: [{ id: 'C1', pages: [] }] }), stub: { code: 0 } });
await reviewCase('more than twenty-four pages', {
  packetJson: packet({ candidates: [{ id: 'C1', pages: Array(25).fill('p1.png') }] }),
  stub: { code: 0 },
});
await reviewCase('a source of the wrong kind', { packetJson: packet({ sources: ['p1.png'] }), stub: { code: 0 } });
await reviewCase('an image of the wrong kind', { packetJson: packet({ candidates: [{ id: 'C1', pages: ['s1.md'] }] }), stub: { code: 0 } });
await reviewCase('an extension is read in lower case', {
  files: { ...REVIEW_FILES, 'P3.PNG': 'upper' },
  packetJson: packet({ candidates: [{ id: 'C1', pages: ['P3.PNG'] }] }),
  stub: { code: 0, out: JSON.stringify(answer({ candidates: [{ ...answer().candidates[0], pages: [answer().candidates[0].pages[0]] }] })) },
});
await reviewCase('a source that is not there', { packetJson: packet({ sources: ['gone.md'] }), stub: { code: 0 } });
await reviewCase('a source over its bound', {
  files: { ...REVIEW_FILES, 'big.md': 'x'.repeat(512_001) },
  packetJson: packet({ sources: ['big.md'] }),
  stub: { code: 0 },
});
await reviewCase('a packet that is not JSON', { packetJson: '{"task": ', stub: { code: 0 } });
await reviewCase('an output that exists', { files: { ...REVIEW_FILES, 'out/r.json': 'existing' }, stub: { code: 0 } });
await reviewCase('no provider', { argv: ['<root>/in.json', '--model', 'm', '--output', '<root>/out/r.json'], extra: { cli: true } });
await reviewCase('a blank model', { argv: ['<root>/in.json', '--provider', 'p', '--model', '  ', '--output', '<root>/out/r.json'], extra: { cli: true } });
await reviewCase('no output', { argv: ['<root>/in.json', '--provider', 'p', '--model', 'm'], extra: { cli: true } });
await reviewCase('an empty output', { argv: ['<root>/in.json', '--provider', 'p', '--model', 'm', '--output', ''], extra: { cli: true } });
await reviewCase('two packets', { argv: ['<root>/in.json', '<root>/in.json', '--provider', 'p', '--model', 'm', '--output', '<root>/out/r.json'], extra: { cli: true } });
await reviewCase('an unknown option', { argv: ['<root>/in.json', '--bogus', '--output', '<root>/o.json'], extra: { cli: true } });

// ----- qc-pages -------------------------------------------------------------------------------------------------------
const shape = (index, text, extra = {}) => ({ index, type: 'p:sp', text, left: 10, top: 20, width: 300.125, height: 40.004, font: { size: 18 }, ...extra });
const issue = (page, code, severity = 'error') => ({ severity, code, path: `/slide[${page}]/shape[1]`, message: `${code} on ${page}` });
const deckDoc = (texts = ['one', 'two', 'three']) => ({ slides: texts.map((text, at) => ({ index: at + 1, text, shapes: [shape(1, text)] })) });
const measured = (issues, document = deckDoc()) => ({ issues, document });
const QC_ARGS = ['<root>/deck.pptx', '--provider', 'p', '--model', 'm', '--output', '<root>/out/qc.json'];
const qcCase = (name, { stub, argv = QC_ARGS, files = { 'deck.pptx': 'original-deck' }, cliOnly = false, capture = ['out/qc.json', 'deck.pptx'] }) =>
  record('qc', name, { input: { files }, argv, stub, cli: cliOnly, capture });
const IMAGES = { 1: '<root>/img/page-1.png', 2: '<root>/img/page-2.png', 3: '<root>/img/page-3.png' };
const copyOf = (page) => `deck.qc-page-${page}.pptx`;

await qcCase('a fix that lowers the defects is adopted', {
  stub: {
    measures: { 'deck.pptx': measured([issue(1, 'overflow'), issue(1, 'collide'), issue(2, 'other')]), [copyOf(1)]: measured([issue(1, 'overflow'), issue(2, 'other')]) },
    render: { images: IMAGES },
    pages: { 1: { code: 0, out: ' fitted the title \n', edit: 'fixed-deck' }, 2: { code: 0, out: 'OK' }, 3: { code: 0, out: 'OK' } },
  },
});
await qcCase('a fix that changes nothing measurable is polish', {
  stub: {
    measures: { 'deck.pptx': measured([issue(1, 'overflow')]), [copyOf(1)]: measured([issue(1, 'overflow')]) },
    render: { images: IMAGES },
    pages: { 1: { code: 0, out: 'nudged', edit: 'polished-deck' } },
    default: { code: 0, out: 'OK' },
  },
  argv: [...QC_ARGS, '--pages', '1'],
});
await qcCase('a fix that raises the defects is discarded', {
  stub: {
    measures: { 'deck.pptx': measured([issue(1, 'overflow')]), [copyOf(1)]: measured([issue(1, 'overflow'), issue(1, 'collide')]) },
    render: { images: IMAGES },
    pages: { 1: { code: 0, out: 'tried', edit: 'worse-deck' } },
  },
  argv: [...QC_ARGS, '--pages', '1'],
});
await qcCase('a fix that changes another slide is discarded', {
  stub: {
    measures: { 'deck.pptx': measured([issue(1, 'overflow')]), [copyOf(1)]: measured([], deckDoc(['one', 'CHANGED', 'three'])) },
    render: { images: IMAGES },
    pages: { 1: { code: 0, out: 'tried', edit: 'scope-deck' } },
  },
  argv: [...QC_ARGS, '--pages', '1'],
});
await qcCase('a fix that changes the slide count is discarded', {
  stub: {
    measures: { 'deck.pptx': measured([issue(1, 'overflow')]), [copyOf(1)]: measured([], deckDoc(['one', 'two'])) },
    render: { images: IMAGES },
    pages: { 1: { code: 0, out: 'tried', edit: 'count-deck' } },
  },
  argv: [...QC_ARGS, '--pages', '1'],
});
await qcCase('an edited copy that cannot be measured is discarded', {
  stub: { measures: { 'deck.pptx': measured([issue(1, 'overflow')]) }, render: { images: IMAGES }, pages: { 1: { code: 0, out: 'tried', edit: 'broken-deck' } } },
  argv: [...QC_ARGS, '--pages', '1'],
});
await qcCase('a model turn that fails with no edit', {
  stub: { measures: { 'deck.pptx': measured([issue(1, 'overflow')]) }, render: { images: IMAGES }, pages: { 1: { code: 2, out: '', err: 'provider down\n' } } },
  argv: [...QC_ARGS, '--pages', '1'],
});
await qcCase('a model turn that fails after an edit', {
  stub: { measures: { 'deck.pptx': measured([issue(1, 'overflow')]), [copyOf(1)]: measured([]) }, render: { images: IMAGES }, pages: { 1: { code: 2, out: 'half', edit: 'half-deck' } } },
  argv: [...QC_ARGS, '--pages', '1'],
});
await qcCase('a model turn that writes errors and succeeds', {
  stub: { measures: { 'deck.pptx': measured([issue(1, 'overflow')]) }, render: { images: IMAGES }, pages: { 1: { code: 0, out: 'OK', err: 'warning: slow\n' } } },
  argv: [...QC_ARGS, '--pages', '1'],
});
await qcCase('a long reply is cut at 400 characters', {
  stub: { measures: { 'deck.pptx': measured([issue(1, 'overflow')]) }, render: { images: IMAGES }, pages: { 1: { code: 0, out: `  ${'가'.repeat(500)}  ` } } },
  argv: [...QC_ARGS, '--pages', '1'],
});
await qcCase('a clean page without a renderer is not sent', {
  stub: { measures: { 'deck.pptx': measured([]) }, render: { error: 'no renderer' } },
});
await qcCase('a clean page with --no-vision is not sent', {
  stub: { measures: { 'deck.pptx': measured([]) }, render: { images: IMAGES } },
  argv: [...QC_ARGS, '--no-vision'],
});
await qcCase('a defect without a renderer is sent without a picture', {
  stub: { measures: { 'deck.pptx': measured([issue(2, 'overflow')]) }, render: { error: 'no renderer' }, pages: { 2: { code: 0, out: 'OK' } } },
});
await qcCase('a renderer error with no message', {
  stub: { measures: { 'deck.pptx': measured([issue(1, 'overflow')]) }, render: { error: '' }, pages: { 1: { code: 0, out: 'OK' } } },
  argv: [...QC_ARGS, '--pages', '1'],
});
await qcCase('a renderer that answers no image', {
  stub: { measures: { 'deck.pptx': measured([issue(1, 'overflow')]) }, render: { images: {} }, pages: { 1: { code: 0, out: 'OK' } } },
  argv: [...QC_ARGS, '--pages', '1'],
});
await qcCase('advisories are not defects', {
  stub: { measures: { 'deck.pptx': measured([issue(1, 'note', 'info')]) }, render: { images: IMAGES }, default: { code: 0, out: 'OK' } },
  argv: [...QC_ARGS, '--pages', '1'],
});
await qcCase('a page selection of ranges and a list', {
  stub: { measures: { 'deck.pptx': measured([]) }, render: { error: 'none' } },
  argv: [...QC_ARGS, '--pages', '3, 1-2 ,2'],
});
await qcCase('a page selection outside the deck', { stub: { measures: { 'deck.pptx': measured([]) } }, argv: [...QC_ARGS, '--pages', '4'] });
await qcCase('a page selection that is not a range', { stub: { measures: { 'deck.pptx': measured([]) } }, argv: [...QC_ARGS, '--pages', '1-x'] });
await qcCase('a reversed page range', { stub: { measures: { 'deck.pptx': measured([]) } }, argv: [...QC_ARGS, '--pages', '3-1'] });
await qcCase('all pages named', { stub: { measures: { 'deck.pptx': measured([]) }, render: { error: 'none' } }, argv: [...QC_ARGS, '--pages', 'all'] });
await qcCase('an effort is passed on', {
  stub: { measures: { 'deck.pptx': measured([issue(1, 'overflow')]) }, render: { images: IMAGES }, pages: { 1: { code: 0, out: 'OK' } } },
  argv: [...QC_ARGS, '--pages', '1', '--effort', 'high'],
});
await qcCase('more than twenty pages', {
  stub: { measures: { 'deck.pptx': measured([], deckDoc(Array.from({ length: 23 }, (_, n) => `s${n + 1}`))) } },
  argv: [...QC_ARGS, '--no-vision'],
});
await qcCase('a deck that cannot be measured', { stub: { measures: {} } });
await qcCase('no provider', { argv: ['<root>/deck.pptx', '--model', 'm', '--output', '<root>/out/qc.json'], cliOnly: true });
await qcCase('no output', { argv: ['<root>/deck.pptx', '--provider', 'p', '--model', 'm'], cliOnly: true });
await qcCase('no deck', { argv: ['--provider', 'p', '--model', 'm', '--output', '<root>/out/qc.json'], cliOnly: true });
await qcCase('an unknown option', { argv: ['<root>/deck.pptx', '--bogus'], cliOnly: true });

// ---------------------------------------------------------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
const scripts = Object.fromEntries(
  [EXTRACT, QC, REVIEW].map((path) => [slashes(path).slice(slashes(TREE).length + 1), sha256(readFileSync(path))])
);
writeFileSync(join(OUT, 'golden.json'), `${JSON.stringify({ node: process.version, scripts, cases }, null, 1)}\n`);
const counts = Object.fromEntries(Object.entries(cases).map(([key, list]) => [key, list.length]));
const files = readdirSync(OUT)
  .filter((name) => name !== 'MANIFEST.json')
  .map((name) => ({ path: name, bytes: statSync(join(OUT, name)).size, sha256: sha256(readFileSync(join(OUT, name))) }));
writeFileSync(
  join(OUT, 'MANIFEST.json'),
  `${JSON.stringify(
    {
      set: 'skill-scripts-office',
      recorder: 'benchmarks/rust-core/recorders/record-skill-scripts-office.mjs',
      recorderSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
      command: 'node benchmarks/rust-core/recorders/record-skill-scripts-office.mjs --tree <product tree>',
      nodeVersion: process.version,
      cases: counts,
      scripts,
      values: 'plain JSON: argv, stdin-free inputs, stubs, and what each run printed (stdout, stderr, exit status), the report files and the calls the script made to its stubs; the temporary root is written <root> (separators as slashes), a work folder review-input-<id>',
      replay:
        'native/core/crates/mixdog-skill-scripts/tests/office_scripts_twin.rs runs run_source_extract, run_qc_pages and run_review_deck on the same inputs with the same stubs and compares byte for byte',
      fileCount: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      files,
    },
    null,
    2
  )}\n`
);
console.log(`skill-scripts-office: ${JSON.stringify(counts)}`);
