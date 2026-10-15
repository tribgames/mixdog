// The `author` action for a Word or Excel target: an HTML document laid out by a local browser and written as native
// Word (docx-html-runner.mjs) or Excel (xlsx-html-runner.mjs), landed over the target once it was written, then opened
// as an authored document — measured by the inline audit, rendered, and reviewed beside the browser's own picture of
// the same HTML: its print for a document, each sheet's section for a workbook.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { render } from '../core/office-actions.mjs';
import { documentFormat, officeSessionForDocument } from '../core/office-core.mjs';
import { createAuthoredSession, exists, fullPath, validatePptxAuthorMode } from '../core/office-sessions.mjs';
import { inlineOfficeAudit } from '../quality/inline-audit.mjs';
import { noteOfficeWrite } from '../core/office-write-ledger.mjs';
import { parseAuthoringBrief } from './pptx-brief.mjs';
import { htmlBriefScript } from './pptx-html-runner.mjs';
import {
  landStagedDeck,
  releaseExistingSession,
  releaseStagingTarget,
  stagingTarget,
  throwIfAuthoringCancelled,
} from './pptx-author-session.mjs';
import { runDocxHtmlAuthoring } from './docx-html-runner.mjs';
import { runXlsxHtmlAuthoring } from './xlsx-html-runner.mjs';
import { editsReplacedByAuthor, markAuthoredFromHtml } from './html-source-drift.mjs';

const require = createRequire(import.meta.url);

const KINDS = {
  docx: {
    run: runDocxHtmlAuthoring,
    noun: 'a Word file',
    skill: 'docx',
    contract: '@page sheet, what becomes a paragraph, a table, a box',
    left: 'the HTML as the browser printed it',
    checks:
      'reading order, page breaks, a box or table that lost its fill or width, type that changed size, a picture that moved',
  },
  xlsx: {
    run: runXlsxHtmlAuthoring,
    noun: 'an Excel workbook',
    skill: 'xlsx',
    contract: 'one <section data-sheet> per worksheet, data-formula, data-chart',
    left: 'the sheet as the browser drew it',
    checks:
      'a card or box that lost its fill, a text cut by its column, a figure that should be a number or a formula, a chart off its place, the printed page',
  },
};

// One image per page: the browser's picture of the HTML on the left, the Office render on the right, at one height.
async function writeComparisons(target, htmlPages, officePages) {
  const sharp = require('sharp');
  const height = 1100;
  const gap = 16;
  const pairs = [];
  const count = Math.max(htmlPages.length, officePages.length);
  const scaled = async (image) => {
    if (!image?.path) return null;
    const data = await sharp(image.path).resize({ height }).png().toBuffer();
    return { data, width: (await sharp(data).metadata()).width };
  };
  const blank = async (width) => ({
    data: await sharp({ create: { width, height, channels: 3, background: '#FFFFFF' } })
      .png()
      .toBuffer(),
    width,
  });
  for (let page = 1; page <= count; page += 1) {
    const left = (await scaled(htmlPages.find((image) => image.page === page))) || (await blank(778));
    const right =
      (await scaled(officePages.find((image) => image.page === page && (image.pages?.length || 1) === 1))) ||
      (await blank(left.width));
    const path = `${target}.mixdog-compare-page-${page}.png`;
    noteOfficeWrite(path);
    await sharp({ create: { width: left.width + right.width + gap, height, channels: 3, background: '#808080' } })
      .composite([
        { input: left.data, left: 0, top: 0 },
        { input: right.data, left: left.width + gap, top: 0 },
      ])
      .png()
      .toFile(path);
    pairs.push({ page, path });
  }
  return pairs;
}

export async function authorHtmlDocument(args, { cwd, dataDir, signal = null }) {
  const target = fullPath(String(args.path || args.output || '').trim(), cwd);
  const format = documentFormat(target);
  const kind = KINDS[format];
  if (!kind) throw new Error('author writes .pptx, .pdf, .docx, and .xlsx targets only');
  const sourcePath = `${target}.mixdog-source.html`;
  // Without a script the document is authored again from the HTML kept beside it.
  const fromSource = !String(args.script || '').trim();
  if (fromSource && !(await exists(sourcePath))) {
    throw new Error(
      `author requires script: an HTML document for ${kind.noun} (without one it re-authors from ${sourcePath}, and none is there). Load the \`${kind.skill}\` Skill first (Skill name:"${kind.skill}"): it carries the HTML route (${kind.contract}), then call author again with path and script.`
    );
  }
  const html = fromSource ? await readFile(sourcePath, 'utf8') : String(args.script);
  if (!/^\s*</.test(html))
    throw new Error(`author writes ${kind.noun} from an HTML document only (a source that opens with <).`);
  const mode = validatePptxAuthorMode(args.mode);
  const held = officeSessionForDocument(target);
  const replacedEdits = editsReplacedByAuthor(held);
  if ((await exists(target)) && !held && !fromSource && args.overwrite !== true) {
    throw new Error(`author target already exists: ${target}; pass overwrite:true to replace it`);
  }
  const staging = await stagingTarget(target);
  let run;
  let session;
  try {
    throwIfAuthoringCancelled(signal);
    run = await kind.run(html, staging, { target, signal });
    throwIfAuthoringCancelled(signal);
    if (!run.ok) {
      return {
        ok: false,
        reason: 'html_failed',
        output: target,
        htmlSource: sourcePath,
        error: run.error,
        elapsedMs: run.elapsedMs,
        nextAction: 'Fix the HTML the error names and call author again.',
      };
    }
    await releaseExistingSession(target, signal);
    await landStagedDeck(staging, target, signal);
    session = await createAuthoredSession(
      signal ? { ...args, mode, __signal: signal } : { ...args, mode },
      cwd,
      dataDir,
      target
    );
  } finally {
    await releaseStagingTarget(staging).catch(() => {});
  }
  markAuthoredFromHtml(session, sourcePath);
  const brief = parseAuthoringBrief(htmlBriefScript(html));
  if (brief.present) session.authoredBrief = brief;
  const audit = args.audit === false ? null : await inlineOfficeAudit(session);
  const result = {
    ok: true,
    session: session.id,
    mode: session.mode,
    backend: session.backend,
    output: target,
    bytes: run.bytes,
    htmlSource: sourcePath,
    logs: run.logs,
    ...(replacedEdits ? { replacedEdits } : {}),
    ...(audit ? { audit } : {}),
    elapsedMs: run.elapsedMs,
  };
  if (args.render === false) {
    result.nextAction =
      audit?.status === 'fail'
        ? audit.nextAction
        : 'Written and measured, not visually reviewed: call action:render on this session for the page images and reviewToken, then inspect every page before finalizing.';
    return result;
  }
  session.activeSignal = signal;
  try {
    const rendered = await render(session, { pages: args.pages, maxWidth: args.maxWidth }, cwd);
    result.render = {
      output: rendered.output,
      pageCount: rendered.pageCount,
      visualCoverage: rendered.visualCoverage,
      images: rendered.images,
      reviewToken: rendered.reviewToken,
    };
    result._images = Array.isArray(rendered._images) ? rendered._images : [];
    if (run.htmlPages?.length) {
      result.render.compare = await writeComparisons(target, run.htmlPages, rendered.images || []);
      result.render.htmlPageCount = run.htmlPages.length;
    }
  } finally {
    delete session.activeSignal;
  }
  result.nextAction =
    audit?.status === 'fail'
      ? `${audit.nextAction} The rendered pages are attached; the visual read starts once the audit passes.`
      : `Inspect every rendered page beside its compare pair (${kind.left} on the left, the Office render on the right): ${kind.checks}. Fix the HTML (edit ${sourcePath} and call author with no script) for a material difference, or finalize with design: { reviewed: true, reviewToken, critique }.`;
  return result;
}
