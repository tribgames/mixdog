#!/usr/bin/env node
// Golden of the render action's preview (crate mixdog-office: render/preview.rs, render/page_cache.rs). Each scenario is a
// list of steps run in order on one session by the product's `renderOfficePreview` / `cachedOfficePreview`
// (src/runtime/office/core/office-render-preview.mjs) and `pptxPageSignatures` (core/pptx-page-cache.mjs), the way
// office-render-preview.test.mjs and pptx-incremental.test.mjs run them: the export and the rasteriser are the test
// adapters (an export writes the text "export"; a raster of a page writes `pixels-p<page>-f<fill>` to
// `<output>-<page>.png` and answers it as the page image), so no LibreOffice, Office or window is involved and the
// recording is the same on every machine. The recording holds, per step, the call's answer (its result with the scratch
// folder written `<dir>`, or null, or the error message) and the session after it: the design-review counters, whether
// the whole-result cache and the export key are held, and the pages the page cache holds. The decks are generated here
// from literal parts that the recording carries, so Rust builds the same packages and the signatures are compared exactly.
// The live LibreOffice export and the contents-page numbering are not recorded here: they need the program installed
// and are checked by the ignored `twin_live_render` on the migration PC.
//
//   node benchmarks/rust-core/recorders/record-office-render.mjs --tree <product tree with node_modules>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-render.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);
const { cachedOfficePreview, renderOfficePreview } = await importFrom(tree, 'src/runtime/office/core/office-render-preview.mjs');
const { completePageCoverage, pptxPageSignatures } = await importFrom(tree, 'src/runtime/office/core/pptx-page-cache.mjs');
const { loadPackage, savePackage, zipText } = await importFrom(tree, 'src/runtime/office/portable/portable-opc.mjs');
const { defaultRenderOutput } = await importFrom(tree, 'src/runtime/office/core/office-sessions.mjs');
const JSZip = (await import(pathToFileURL(path.join(tree, 'node_modules/jszip/lib/index.js')).href)).default;

// ---- decks ---------------------------------------------------------------------------------------------------------

const RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** The parts of a deck of one slide per text: a presentation, its relationships, the slides, a layout link and a theme. */
function deckParts(texts) {
  const parts = {};
  let ids = '';
  let rels = '';
  texts.forEach((text, index) => {
    const number = index + 1;
    ids += `<p:sldId id="${255 + number}" r:id="rId${number}"/>`;
    rels += `<Relationship Id="rId${number}" Type="${RELATIONSHIPS}/slide" Target="slides/slide${number}.xml"/>`;
    parts[`ppt/slides/slide${number}.xml`] = `<p:sld><p:txBody>${text}</p:txBody></p:sld>`;
    parts[`ppt/slides/_rels/slide${number}.xml.rels`] =
      `<Relationships><Relationship Id="rId1" Type="${RELATIONSHIPS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`;
  });
  parts['ppt/presentation.xml'] =
    `<p:presentation xmlns:r="${RELATIONSHIPS}"><p:sldIdLst>${ids}</p:sldIdLst></p:presentation>`;
  parts['ppt/_rels/presentation.xml.rels'] = `<Relationships>${rels}</Relationships>`;
  parts['ppt/theme/theme1.xml'] = '<a:theme name="Office"/>';
  return parts;
}

async function writeDeck(file, parts) {
  const zip = new JSZip();
  for (const [name, text] of Object.entries(parts)) zip.file(name, text);
  await savePackage(zip, file);
}

// ---- scenarios -----------------------------------------------------------------------------------------------------

const scenarios = [];
const scenario = (name, spec) => scenarios.push({ name, ...spec });

// office-render-preview.test.mjs: a COM-held deck (the adapters stand for Microsoft Office and the rasteriser).
scenario('reuse-and-invalidation', {
  session: { format: 'pptx', backend: 'microsoft-office-com', mode: 'background', ownership: 'owned', visible: false },
  pageCount: 2,
  steps: [
    { do: 'render', args: { output: 'chosen.pdf', maxWidth: 1600 } },
    { do: 'render', args: {}, reuseLatest: true },
    { do: 'cached', args: { maxWidth: 800 }, reuseLatest: true },
    { do: 'cached', args: { output: 'other.pdf' }, reuseLatest: true },
    { do: 'cached', args: { pages: [2] }, reuseLatest: true },
    { do: 'render', args: { output: 'chosen.pdf', maxWidth: 1600 } },
    { do: 'bump' },
    { do: 'cached', args: {}, reuseLatest: true },
    { do: 'render', args: { pages: [2] } },
    { do: 'cached', args: {}, reuseLatest: true },
    { do: 'render', args: {} },
    { do: 'rm', what: 'pdf' },
    { do: 'render', args: {} },
    { do: 'rm', what: 'image', index: 0 },
    { do: 'render', args: {} },
    { do: 'render', args: { pages: [2, 1, 2] } },
    { do: 'render', args: { maxWidth: 'wide' } },
    { do: 'render', args: { output: 'report.docx' } },
  ],
});

scenario('failures-and-cancellation', {
  session: { format: 'pptx', backend: 'microsoft-office-com', mode: 'background', ownership: 'owned', visible: false },
  pageCount: 2,
  steps: [
    { do: 'render', args: {} },
    { do: 'fail', what: 'export', on: true },
    { do: 'render', args: { maxWidth: 700 } },
    { do: 'cached', args: {}, reuseLatest: true },
    { do: 'fail', what: 'export', on: false },
    { do: 'render', args: {} },
    { do: 'fail', what: 'raster', on: true },
    { do: 'bump' },
    { do: 'render', args: {} },
    { do: 'fail', what: 'raster', on: false },
    { do: 'render', args: {} },
    { do: 'abort' },
    { do: 'render', args: {} },
    { do: 'cached', args: {}, reuseLatest: true },
  ],
});

scenario('visible-and-attached-documents', {
  session: { format: 'pptx', backend: 'microsoft-office-com', mode: 'background', ownership: 'owned', visible: false },
  pageCount: 2,
  steps: [
    { do: 'set', patch: { visible: true } },
    { do: 'render', args: {} },
    { do: 'render', args: {} },
    { do: 'set', patch: { ownership: 'attached', visible: false } },
    { do: 'render', args: {} },
    { do: 'render', args: {} },
    { do: 'set', patch: { ownership: 'owned', mode: 'attach' } },
    { do: 'render', args: {} },
    { do: 'render', args: {} },
    { do: 'fill', value: 1 },
    { do: 'render', args: {} },
  ],
});

// A session of another format: the renderer a result names.
for (const [format, backend, mode, renderer] of [
  ['docx', 'mixdog-ooxml', 'portable', 'LibreOffice'],
  ['xlsx', 'microsoft-office-com', 'background', 'Microsoft Excel'],
  ['pdf', 'mixdog-pdf', 'portable', 'pdfjs'],
]) {
  scenario(`renderer-of-${format}`, {
    session: { format, backend, mode, ownership: 'owned', visible: false },
    pageCount: 1,
    note: renderer,
    steps: [{ do: 'render', args: {} }],
  });
}

// pptx-incremental.test.mjs: a portable deck drawn page by page.
const deck = deckParts(['Revenue', 'Growth', 'Spending']);
scenario('deck-incremental', {
  session: { format: 'pptx', backend: 'mixdog-ooxml', mode: 'portable', ownership: 'owned', visible: false },
  pageCount: 3,
  deck,
  steps: [
    { do: 'signatures' },
    { do: 'render', args: {} },
    { do: 'edit', part: 'ppt/slides/slide2.xml', replace: ['Growth', 'Updated growth'] },
    { do: 'bump' },
    { do: 'fill', value: 1 },
    { do: 'signatures' },
    { do: 'render', args: { pages: [2] } },
    { do: 'render', args: {} },
    { do: 'render', args: { pages: [3, 1] } },
    { do: 'render', args: { maxWidth: 1000 } },
    { do: 'render', args: { pages: [4] } },
    { do: 'render', args: { pages: [1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1] } },
    { do: 'edit', part: 'ppt/theme/theme1.xml', replace: ['Office', 'Changed Theme'] },
    { do: 'signatures' },
    { do: 'bump' },
    { do: 'fail', what: 'raster', on: true },
    { do: 'render', args: {} },
    { do: 'fail', what: 'raster', on: false },
    { do: 'edit', part: 'ppt/slides/slide3.xml', replace: ['<p:sld>', '<p:sld show="0">'] },
    { do: 'bump' },
    { do: 'signatures' },
  ],
});

// ---- the run -------------------------------------------------------------------------------------------------------

const scratch = mkdtempSync(path.join(tmpdir(), 'office-render-'));
/** The value with the scratch folder written `<dir>` and every backslash of a text a slash. */
const clean = (value, dir) => {
  if (typeof value === 'string') return value.split(dir).join('<dir>').replaceAll('\\', '/');
  if (Array.isArray(value)) return value.map((item) => clean(item, dir));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item, dir)]));
  return value;
};

async function run(spec) {
  const dir = path.join(scratch, spec.name);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `doc.${spec.session.format}`);
  if (spec.deck) await writeDeck(target, spec.deck);
  const session = {
    id: 'preview',
    snapshotVersion: 0,
    designState: { renderedVersion: null, semanticCount: 0, requiresVisualReview: false, compositions: [] },
    target,
    ...spec.session,
  };
  const state = { exports: 0, rasters: [], fill: 0, failExport: false, failRaster: false };
  const adapters = {
    exportPreview: async (_, output) => {
      if (state.failExport) throw new Error('export failed');
      state.exports++;
      await writeFile(output, 'export');
    },
    rasterize: async (output, options) => {
      state.rasters.push(options.pages ?? null);
      if (state.failRaster) throw new Error('raster failed');
      const pages = options.pages || Array.from({ length: spec.pageCount }, (_, index) => index + 1);
      const images = [];
      for (const page of pages) {
        const file = `${output}-${page}.png`;
        const data = `pixels-p${page}-f${state.fill}`;
        await writeFile(file, data);
        images.push({ page, path: file, width: 800, height: 450, mimeType: 'image/png', data });
      }
      return {
        pageCount: spec.pageCount,
        images,
        visualCoverage: { complete: pages.length === spec.pageCount, reviewedPages: pages, reviewed: pages.length, total: spec.pageCount },
      };
    },
  };
  let last = null;
  const steps = [];
  for (const step of spec.steps) {
    let outcome = null;
    try {
      if (step.do === 'render') {
        last = await renderOfficePreview(session, step.args, dir, { ...adapters, reuseLatest: step.reuseLatest === true });
        outcome = last;
      } else if (step.do === 'cached') {
        outcome = await cachedOfficePreview(session, step.args, dir, { reuseLatest: step.reuseLatest === true });
      } else if (step.do === 'signatures') {
        outcome = await pptxPageSignatures(target);
      } else if (step.do === 'bump') session.snapshotVersion++;
      else if (step.do === 'set') Object.assign(session, step.patch);
      else if (step.do === 'fill') state.fill = step.value;
      else if (step.do === 'fail') state[step.what === 'export' ? 'failExport' : 'failRaster'] = step.on;
      else if (step.do === 'abort') session.activeSignal = AbortSignal.abort();
      else if (step.do === 'rm') await rm(step.what === 'pdf' ? last.output : last._images[step.index].path);
      else if (step.do === 'edit') {
        const zip = await loadPackage(target);
        zip.file(step.part, (await zipText(zip, step.part)).replace(step.replace[0], step.replace[1]));
        await savePackage(zip, target);
      } else throw new Error(`unknown step ${step.do}`);
    } catch (error) {
      outcome = { error: error instanceof Error ? error.message : String(error) };
    }
    const design = session.designState;
    const held = {};
    for (const key of ['renderedVersion', 'reviewToken', 'renderedMaxWidth', 'renderedPageCount', 'renderedCoverage']) {
      if (design[key] !== undefined) held[key] = design[key];
    }
    steps.push({
      step,
      outcome: outcome === undefined ? null : clean(outcome, dir),
      exports: state.exports,
      rasters: [...state.rasters],
      design: clean(held, dir),
      renderCache: session.renderCache ? { version: session.renderCache.version, request: clean(session.renderCache.request, dir) } : null,
      pageRenderPages: session.pageRenderCache ? session.pageRenderCache.pages.map((entry) => entry.page) : null,
      exportKeyHeld: session.previewExportKey != null,
    });
  }
  return { name: spec.name, session: spec.session, pageCount: spec.pageCount, deck: spec.deck ?? null, note: spec.note ?? null, steps };
}

const out = {
  note: 'renderOfficePreview, cachedOfficePreview and pptxPageSignatures of src/runtime/office/core on test adapters (no LibreOffice, Office or window). Each case is a session and its steps; every step records the outcome (the result with the scratch folder written <dir> and backslashes as slashes, a null for a cache miss, the signatures, or the error), the exports and rasteriser page lists so far, and the session afterwards: design counters, the whole-result cache (version and request), the pages the page cache holds and whether the export key is held. Review tokens are compared by shape (the twin helper normalises reviewToken). pure holds completePageCoverage and defaultRenderOutput on literal inputs.',
  scenarios: [],
  pure: {
    coverage: [
      { total: 4, pages: [3, 1, 3], result: completePageCoverage(4, [3, 1, 3]) },
      { total: 2, pages: [1, 2], result: completePageCoverage(2, [1, 2]) },
      { total: 5, pages: [], result: completePageCoverage(5, []) },
    ],
    defaultOutput: ['deck.pptx', 'a.b.docx', 'sub/deck.xlsx'].map((source) => ({ source, output: path.basename(defaultRenderOutput(source)) })),
  },
};
try {
  for (const spec of scenarios) out.scenarios.push(await run(spec));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const fixtures = path.join(FIXTURES_ROOT, 'office-render');
mkdirSync(fixtures, { recursive: true });
const data = [
  '{',
  `  "note": ${JSON.stringify(out.note)},`,
  `  "pure": ${JSON.stringify(out.pure)},`,
  `  "scenarios": [\n${out.scenarios.map((c) => `    ${JSON.stringify(c)}`).join(',\n')}\n  ]`,
  '}',
  '',
].join('\n');
writeFileSync(path.join(fixtures, 'golden.json'), data);
writeSetManifest(fixtures, { set: 'office-render', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${data.length} bytes, ${out.scenarios.length} scenarios`);
