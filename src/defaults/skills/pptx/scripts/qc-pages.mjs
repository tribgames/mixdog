// Per-page layout QC. Each selected slide gets one fresh model session that
// sees only that page — its rendered image when a renderer is available, its
// element inventory, and its measured defects — with the office tool alone and
// a fix-only mandate. The fixer edits a working copy; the runner, not the
// model, decides whether that copy becomes the deck: it is adopted only when
// the page's measured defects did not grow and no other slide changed, and
// discarded otherwise. The author closes the deck's session before this runs
// and reopens it after.
import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const QC_MAX_PAGES = 20;
export const QC_MAX_ROUNDS = 2;

const CHILD_FEATURES = { MIXDOG_FEATURE_OFFICE: '1', MIXDOG_FEATURE_GIT: '0', MIXDOG_FEATURE_BROWSER: '0', MIXDOG_FEATURE_COMPUTER: '0' };
const text = (value) => typeof value === 'string' ? value.trim() : '';
const number = (value) => Number.isFinite(value) ? Number(value.toFixed(2)) : null;

// Portable sessions edit an output copy, never the source, so the fixer is
// pointed at a per-page working copy beside the deck.
export function workingCopyPath(deck, page) {
  const extension = extname(deck);
  return join(dirname(deck), `.${basename(deck, extension)}.qc-page-${page}${extension}`);
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function parsePages(spec, total) {
  if (!text(spec) || spec === 'all') return Array.from({ length: total }, (_, index) => index + 1);
  const pages = new Set();
  for (const part of String(spec).split(',')) {
    const range = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!range) throw new Error(`invalid page selection: ${part.trim()}`);
    const from = Number(range[1]);
    const to = range[2] ? Number(range[2]) : from;
    if (from < 1 || to < from || to > total) throw new Error(`page selection out of range: ${part.trim()} (the deck has ${total} slides)`);
    for (let page = from; page <= to; page += 1) pages.add(page);
  }
  return [...pages].sort((left, right) => left - right);
}

// The inventory the fixer reads: every shape on the page with the id the
// tools accept, its kind, geometry in points (the unit the portable snapshot
// reports and the batch operations take), type size, fill, and text.
export function slideInventory(document, page) {
  const slide = (document?.slides || []).find((entry) => Number(entry.index) === page);
  if (!slide) return [];
  return (slide.shapes || []).map((shape) => {
    const content = String(shape.text || '').replace(/\s+/g, ' ').trim();
    const kind = shape.chart ? 'chart'
      : shape.table ? `table ${shape.table.rows}×${shape.table.columns}`
        : shape.group ? 'group'
          : shape.type === 'p:pic' ? 'picture'
            : content ? 'text' : (shape.geometry || 'shape');
    const box = [shape.left, shape.top, shape.width, shape.height].map(number);
    const geometry = box.every((value) => value !== null) ? ` left ${box[0]} top ${box[1]} width ${box[2]} height ${box[3]}` : '';
    const font = shape.font?.size ? ` font ${shape.font.size}${shape.font.bold ? ' bold' : ''}` : '';
    const fill = shape.fill?.color ? ` fill ${shape.fill.color}` : '';
    const preview = content ? ` "${content.length > 120 ? `${content.slice(0, 117)}…` : content}"` : '';
    return `shape[${shape.index}] ${kind}${shape.placeholder ? ' placeholder' : ''}${geometry}${font}${fill}${preview}`;
  });
}

// Measured defects on one page: what a fix must answer (errors and warnings);
// advisories stay out, as in the inline audit.
export function pageDefects(issues, page) {
  const prefix = `/slide[${page}]`;
  return (issues || [])
    .filter((issue) => issue && String(issue.severity || '') !== 'info')
    .filter((issue) => {
      const path = String(issue.path || '');
      return path === prefix || path.startsWith(`${prefix}/`);
    })
    .map(({ severity, code, path, message }) => ({ severity, code, path, message }));
}

// What the guard compares: every slide's text and geometry. A change on any
// slide but the one under repair, or a different slide count, reverts the page.
export function slideFingerprints(document) {
  const fingerprints = new Map();
  for (const slide of document?.slides || []) {
    fingerprints.set(Number(slide.index), JSON.stringify({
      text: slide.text,
      shapes: (slide.shapes || []).map((shape) => [
        shape.type, shape.text, number(shape.left), number(shape.top), number(shape.width), number(shape.height), shape.font?.size ?? null,
      ]),
    }));
  }
  return fingerprints;
}

export function othersChanged(before, after, page) {
  if (before.size !== after.size) return true;
  for (const [index, fingerprint] of before) {
    if (index !== page && after.get(index) !== fingerprint) return true;
  }
  return false;
}

// One page's verdict from the measured evidence alone; the model's own
// account of what it fixed never decides.
export function decidePage({ before, after, scopeChanged, auditFailed }) {
  if (auditFailed) return { keep: false, reason: 'audit_failed' };
  if (scopeChanged) return { keep: false, reason: 'scope' };
  if (after > before) return { keep: false, reason: 'regression' };
  return { keep: true, reason: after < before ? 'improved' : 'unchanged' };
}

export function qcInstruction({ deck, copy, page, total, inventory, defects, imagePath }) {
  const rendering = imagePath
    ? `Rendered page: ${imagePath} — open it with the read tool first. The picture is the ground truth; the inventory below carries the ids the tools accept.`
    : 'No rendering is available: judge only from the inventory and the measured defects below, and do not infer a visual problem the measurements do not establish.';
  const measured = defects.length
    ? `Measured defects on this slide (${defects.length}):\n${defects.map((issue) => `- ${issue.code} ${issue.path}: ${issue.message}`).join('\n')}`
    : 'The measured audit found nothing on this slide — trust the rendering for what it cannot measure: collisions, clipping, contrast, crowding.';
  return `You are a slide layout QA fixer working on ONE slide of a saved PowerPoint deck. Fix objective layout defects on that slide only; never redesign it.
Deck: ${deck}
Slide ${page} of ${total}. Canvas 960 × 540 pt (13.33 × 7.5 in); the geometry below is in points from the top-left corner, and the tools take points too.
${rendering}

Element inventory (slide ${page}):
${inventory.length ? inventory.join('\n') : '(no shapes)'}

${measured}

Objective defects to fix: text overflowing or clipped by its box, text colliding with a neighbour, an element past the canvas edge, unreadable contrast, a distorted picture. Nothing else.

Tools: the office tool (and read, for the picture). Procedure:
1. office action:"open" path:"${deck}" mode:"portable" output:"${copy}" snapshotAfter:false — note the session id. Your edits land in that working copy; the runner adopts it only when the measurements agree.
2. office action:"batch" session:<id> operations:[…] — every operation names slide: ${page}. Allowed: set_shape (properties left, top, width, height in points, fontSize), fit_text (shape, minFontSize 12), and set_text only to mend a break or a stray space, never to rewrite copy. Put every change for this slide in ONE batch. The result carries audit: read it, and if it still lists a defect on slide ${page}, send at most ${QC_MAX_ROUNDS - 1} more batch.
3. office action:"close" session:<id>.
STRICTLY FORBIDDEN: touching any other slide, adding or deleting elements, changing colours, fonts, theme, or wording, regenerating the slide, any tool other than office and read. Every change is measured after you finish: a slide whose defects grew or whose neighbours changed is reverted.
When the slide is already clean, make NO tool call.
Final reply: one line under 15 words naming what you fixed, or exactly "OK".`;
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function defaultOffice() {
  const { executeOfficeTool } = await import('../../../../runtime/office/index.mjs');
  return async (args, cwd) => {
    const result = await executeOfficeTool(args, { cwd });
    const body = result?.content?.[0]?.text || '';
    if (result?.isError) throw new Error(body || 'office call failed');
    return JSON.parse(body);
  };
}

async function defaultMeasure() {
  const { issuesPortableOoxml, snapshotPortableOoxml } = await import('../../../../runtime/office/portable/portable-ooxml.mjs');
  return async (deck) => {
    const [measured, document] = await Promise.all([
      issuesPortableOoxml(deck, 'pptx', {}),
      snapshotPortableOoxml(deck, 'pptx', {}),
    ]);
    return { issues: measured.issues, document };
  };
}

// The page image comes from the same renderer the author reviews with; a
// missing renderer leaves the page to the geometry read.
async function renderPage(office, deck, page) {
  const cwd = dirname(deck);
  const scratch = join(dirname(deck), `.${basename(deck, extname(deck))}.qc-render${extname(deck)}`);
  const opened = await office({ action: 'open', path: deck, mode: 'portable', output: scratch, snapshotAfter: false }, cwd);
  try {
    const rendered = await office({ action: 'render', session: opened.session, pages: [page] }, cwd);
    const image = (rendered.images || []).find((entry) => Number(entry.page) === page) || rendered.images?.[0];
    return text(image?.path);
  } finally {
    await office({ action: 'close', session: opened.session }, cwd).catch(() => {});
    await rm(scratch, { force: true }).catch(() => {});
  }
}

function withChildFeatures(fn) {
  const saved = Object.fromEntries(Object.keys(CHILD_FEATURES).map((key) => [key, process.env[key]]));
  Object.assign(process.env, CHILD_FEATURES);
  return fn().finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

export async function runPageQc({
  deck: deckPath,
  pages: pageSpec = 'all',
  provider,
  model,
  effort = 'medium',
  output = '',
  vision = true,
  maxPages = QC_MAX_PAGES,
}, {
  execute,
  office,
  measure,
  createRuntime,
} = {}) {
  if (!text(provider) || !text(model)) throw new Error('explicit --provider and --model are required');
  const deck = resolve(deckPath);
  const callOffice = office || await defaultOffice();
  const measureDeck = measure || await defaultMeasure();
  const target = text(output) ? resolve(output) : '';
  if (target) await mkdir(dirname(target), { recursive: true });
  const { runHeadlessExec } = execute ? {} : await import('../../../../headless-exec.mjs');
  const run = execute || runHeadlessExec;
  const initial = await measureDeck(deck);
  const total = (initial.document.slides || []).length;
  const requested = parsePages(pageSpec, total);
  const selected = requested.slice(0, maxPages);
  const report = {
    ok: true,
    deck,
    route: { provider, model, effort },
    isolation: 'pristine-per-page',
    total,
    pages: [],
    skippedPages: requested.slice(maxPages),
    fixed: 0,
    polished: 0,
    discarded: 0,
    skipped: 0,
  };
  await withChildFeatures(async () => {
    for (const page of selected) {
      const entry = { page, vision: false, before: 0, after: 0, edited: false, kept: true, reason: '', reply: '' };
      report.pages.push(entry);
      const copy = workingCopyPath(deck, page);
      try {
        const start = await measureDeck(deck);
        const defects = pageDefects(start.issues, page);
        entry.before = defects.length;
        entry.after = defects.length;
        let imagePath = '';
        if (vision) {
          try {
            imagePath = await renderPage(callOffice, deck, page);
          } catch (error) {
            entry.renderError = error?.message || String(error);
          }
        }
        entry.vision = Boolean(imagePath);
        // A text-only read with nothing measured has nothing to act on: no
        // request, no chance of a speculative edit.
        if (!imagePath && !defects.length) {
          entry.reason = 'clean';
          report.skipped += 1;
          continue;
        }
        await rm(copy, { force: true }).catch(() => {});
        const hashBefore = await sha256(deck);
        const fingerprints = slideFingerprints(start.document);
        let raw = '';
        const errors = [];
        let code = 1;
        try {
          code = await run({
            message: qcInstruction({ deck, copy, page, total, inventory: slideInventory(start.document, page), defects, imagePath }),
            provider,
            model,
            effort,
            cwd: dirname(deck),
            webSearch: false,
            ...(target ? { usageLogPath: `${target}.page-${page}.usage.json` } : {}),
            ...(createRuntime ? { runtimeFactory: async (options) => createRuntime({ ...options, toolMode: 'full' }) } : {}),
            write: (chunk) => { raw += chunk; },
            writeErr: (chunk) => { errors.push(String(chunk)); process.stderr.write(chunk); },
          });
        } catch (error) {
          errors.push(error?.message || String(error));
        }
        entry.reply = raw.trim().slice(0, 400);
        if (errors.length) entry.errors = errors.slice(-5);
        entry.edited = await fileExists(copy) && (await sha256(copy)) !== hashBefore;
        let decision;
        if (!entry.edited) {
          decision = { keep: true, reason: code === 0 ? 'unchanged' : 'execution_failed' };
        } else {
          let end = null;
          try { end = await measureDeck(copy); } catch { end = null; }
          entry.after = end ? pageDefects(end.issues, page).length : entry.before;
          decision = decidePage({
            before: entry.before,
            after: entry.after,
            scopeChanged: end ? othersChanged(fingerprints, slideFingerprints(end.document), page) : false,
            auditFailed: !end,
          });
        }
        entry.kept = decision.keep;
        entry.reason = decision.reason;
        if (!decision.keep) {
          entry.after = entry.before;
          report.discarded += 1;
        } else if (entry.edited) {
          await copyFile(copy, deck);
          if (decision.reason === 'improved') report.fixed += 1;
          else report.polished += 1;
        }
      } catch (error) {
        entry.kept = true;
        entry.reason = 'error';
        entry.error = error?.message || String(error);
        report.ok = false;
      } finally {
        await rm(copy, { force: true }).catch(() => {});
      }
    }
  });
  if (target) await writeFile(target, JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values, positionals } = parseArgs({
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
      throw new Error('Usage: qc-pages.mjs deck.pptx --provider <provider> --model <model> --output qc-report.json [--pages 1-12] [--no-vision]');
    }
    const report = await runPageQc({
      deck: positionals[0],
      pages: values.pages,
      provider: values.provider,
      model: values.model,
      effort: values.effort,
      output: values.output,
      vision: values['no-vision'] !== true,
    });
    console.log(JSON.stringify({
      ok: report.ok,
      output: resolve(values.output),
      fixed: report.fixed,
      polished: report.polished,
      discarded: report.discarded,
      skipped: report.skipped,
      skippedPages: report.skippedPages,
      pages: report.pages.map((entry) => `${entry.page}:${entry.reason}`),
    }));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
