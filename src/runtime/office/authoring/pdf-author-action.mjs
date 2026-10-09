// The `author` action for a .pdf target: an HTML document printed by a local
// browser (pdf-html-runner.mjs), landed over the target only once it printed
// and passed its checks, then opened as a created PDF for review.
//
// Two kinds of document. A flowing one (running text the browser paginates)
// is checked for what print would cut. Designed pages — one <section
// class="slide"> per sheet — go through the deck's own frame first: the same
// browser measure, geometry gate, facts and plan gates, measured audit, and
// composition receipt the pptx route runs, on a working deck built at the
// sheet's size and discarded once read; then the browser prints the HTML
// itself, and finalize asks for the deck's scored critique.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { render } from '../core/office-actions.mjs';
import { officeSessionForDocument } from '../core/office-core.mjs';
import {
  createAuthoredSession,
  exists,
  fullPath,
  registerHtmlPdfSession,
  releaseOverwrittenSession,
} from '../core/office-sessions.mjs';
import { snapshotPdf } from '../pdf/pdf-adapter.mjs';
import { inlineOfficeAudit } from '../quality/inline-audit.mjs';
import {
  factsGate,
  parseAuthoringBrief,
  reviewBriefPromises,
  reviewSourceGrounding,
} from './pptx-brief.mjs';
import { editsReplacedByAuthor, markAuthoredFromHtml } from './html-source-drift.mjs';
import { hasSlideSections, htmlBriefScript, runPptxHtmlAuthoring } from './pptx-html-runner.mjs';
import {
  landStagedDeck,
  releaseExistingSession,
  releaseStagingTarget,
  stagingTarget,
  throwIfAuthoringCancelled,
} from './pptx-author-session.mjs';
import { factsGateResult, gateStagedDeck, geometryGateResult, planGateResult } from './pptx-author-action.mjs';
import { readCompositionReceipt } from './pptx-review-artifacts.mjs';
import { receiptForDelivery } from './pptx-receipt.mjs';
import { frameCanvas, pdfHtmlSourcePath, printHtmlPdf } from './pdf-html-runner.mjs';

const PDF_AUTHOR_NEEDS_SOURCE =
  'author requires script: an HTML document for a PDF (without one it re-authors from <file>.pdf.mixdog-source.html, and none is there). Load the `pdf` Skill first (Skill name:"pdf"): it carries the page contract (@page size and margins, page breaks, fonts), then call author again with path and script.';

const RENDERED_NEXT_ACTION =
  'Inspect every rendered page for reading order, page breaks (a heading left at a page foot, a table or figure split), clipping, and legibility; fix the HTML and author again for any defect, or finalize with design: { reviewed: true, reviewToken, critique: [one entry per page] }.';

const UNRENDERED_NEXT_ACTION =
  'Printed and laid out clean, not visually reviewed: call action:render on this session for the page images and reviewToken, then inspect every page before finalizing.';

const FRAME_RENDERED_NEXT_ACTION =
  'Inspect every rendered page for message visibility, relevant evidence, legibility, and grouping, then read the sequence for coherence; use the receipt to investigate possible defects. Change the HTML only for an observed problem, or finalize with design: { reviewed: true, reviewToken, critique: [one entry per page with page, verdict, hierarchy, balance, legibility, cohesion, evidence, note, fixes, checks] }.';

const FRAME_UNRENDERED_NEXT_ACTION =
  'Printed, gated, and measured clean, not visually reviewed: call action:render on this session for the page images and reviewToken, then inspect every page before finalizing with the scored critique.';

// The browser that prints set every line of the PDF; the working deck's PowerPoint text metrics
// (fit, clipping, box width) describe a renderer the reader never sees.
const BROWSER_SET_TEXT = ['text_overflow', 'text_clipped', 'text_box_too_narrow'];

// Designed pages through the deck's frame: measured on the sheet, gated, audited, and read into a
// receipt. `{ refused }` carries the result to return when a gate holds; otherwise the audit and
// receipt ride on to the printed PDF.
async function frameDesignedPages(html, target, brief, { args, cwd, dataDir, signal, priorAudit }) {
  const scratch = await mkdtemp(join(dirname(target), '.mixdog-pdf-frame-'));
  const deck = join(scratch, 'frame.pptx');
  try {
    const run = await runPptxHtmlAuthoring(html, deck, { target, signal, prepare: frameCanvas });
    throwIfAuthoringCancelled(signal);
    if (!run.ok) {
      return {
        refused: {
          ok: false,
          reason: 'html_failed',
          output: target,
          error: run.error,
          elapsedMs: run.elapsedMs,
          nextAction: 'Fix the HTML the error names and call author again.',
        },
      };
    }
    if (run.geometry?.length) return { refused: geometryGateResult(target, run) };
    const gate = await gateStagedDeck(deck, brief);
    if (gate.blocked) {
      return {
        refused: gate.gate === 'plan' ? planGateResult(target, gate, run) : factsGateResult(target, brief, gate, run),
      };
    }
    const shadow = await createAuthoredSession({ mode: 'portable' }, cwd, dataDir, deck);
    shadow.authoredBrief = brief;
    // The working deck's pages are paper: its audit holds them to the print type floors.
    shadow.printSheet = true;
    if (priorAudit) shadow.inlineAudit = { ...priorAudit };
    const audit = args.audit === false ? null : await inlineOfficeAudit(shadow, { exclude: BROWSER_SET_TEXT });
    const receipt = await readCompositionReceipt(shadow);
    // The deck's design read against the brief, kept for the PDF's qa: the plan's page count and the
    // facts' locators (the refusing readings already ran as gates).
    const designIssues = gate.document
      ? [...reviewBriefPromises(gate.document, brief), ...reviewSourceGrounding(brief)]
      : [];
    return { run, audit, receipt, designIssues, rounds: shadow.inlineAudit || null };
  } finally {
    await releaseExistingSession(deck, null).catch(() => {});
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

// A figure the pages show that the brief's facts line does not carry. The
// gate that refuses a deck only reports here: the document still lands.
// Page counters ("3 / 12") are chrome, not figures.
async function factsWarning(target, brief) {
  if (!brief.present || brief.factsMode === 'sample') return null;
  const { pages } = await snapshotPdf(target, { maxChars: 100_000, outline: false });
  const document = {
    slides: pages.map((page) => ({
      index: page.index,
      shapes: [{ text: String(page.text || '').replace(/(^|\n)\s*\d+\s*\/\s*\d+\s*(?=\n|$)/g, '$1') }],
    })),
  };
  const gate = factsGate(document, brief);
  if (!gate.blocked) return null;
  return {
    code: gate.code,
    pages: gate.slides.map((entry) => ({ page: entry.slide, figures: entry.figures })),
    message:
      gate.code === 'facts_missing'
        ? 'The document shows figures but its BRIEF comment has no facts line; list each figure with its source (F1 <value> — <source>).'
        : 'These figures appear on the pages but in no fact of the BRIEF comment; add each with its source, or correct the figure.',
  };
}

export async function authorPdf(args, { cwd, dataDir, signal = null }) {
  const target = fullPath(String(args.path || args.output || '').trim(), cwd);
  // Without a script the PDF is authored again from the HTML kept beside it, so a fix is an edit to
  // that file rather than the whole document sent again.
  const fromSource = !String(args.script || '').trim();
  if (fromSource && !(await exists(pdfHtmlSourcePath(target)))) throw new Error(PDF_AUTHOR_NEEDS_SOURCE);
  const html = fromSource ? await readFile(pdfHtmlSourcePath(target), 'utf8') : String(args.script);
  if (!/^\s*</.test(html))
    throw new Error('author writes a PDF from an HTML document only (a source that opens with <).');
  const targetExisted = await exists(target);
  const held = officeSessionForDocument(target);
  const replacedEdits = editsReplacedByAuthor(held);
  // Its own source names its own output: re-authoring from it replaces the file without overwrite:true.
  if (targetExisted && !held && !fromSource && args.overwrite !== true) {
    throw new Error(`author target already exists: ${target}; pass overwrite:true to replace it`);
  }
  // The browser prints beside the target: a failed print or a refused layout
  // leaves the file on disk and any session holding it untouched.
  const staging = await stagingTarget(target);
  const htmlSource = pdfHtmlSourcePath(target);
  const brief = parseAuthoringBrief(htmlBriefScript(html));
  const frame = hasSlideSections(html);
  let framed = null;
  let run;
  let session;
  try {
    throwIfAuthoringCancelled(signal);
    if (frame) {
      framed = await frameDesignedPages(html, target, brief, {
        args,
        cwd,
        dataDir,
        signal,
        priorAudit: held?.inlineAudit || null,
      });
      if (framed.refused) return framed.refused;
    }
    run = await printHtmlPdf(html, staging, { sourcePath: htmlSource, properties: args.properties, frame, signal });
    throwIfAuthoringCancelled(signal);
    if (run.ok && frame && run.pageCount !== framed.run.slideCount) {
      return {
        ok: false,
        reason: 'html_failed',
        output: target,
        htmlSource,
        error: {
          message: `${framed.run.slideCount} section.slide pages printed onto ${run.pageCount} sheets: a page is taller than the sheet, or the CSS hides or stacks pages in print. Keep every section.slide exactly the sheet's size and displayed.`,
        },
        elapsedMs: run.elapsedMs,
        nextAction: 'Fix the HTML the error names and call author again.',
      };
    }
    if (!run.ok) {
      return {
        ok: false,
        reason: run.layout ? 'layout_gate' : 'html_failed',
        output: target,
        htmlSource,
        ...(run.layout ? { findings: run.layout } : { error: run.error }),
        elapsedMs: run.elapsedMs,
        nextAction: run.layout
          ? 'Nothing landed: fix each finding in the HTML (its element and measure are named) and call author again.'
          : 'Fix the HTML the error names and call author again.',
      };
    }
    await releaseOverwrittenSession(target, true);
    await landStagedDeck(staging, target, signal);
    session = await registerHtmlPdfSession(args, dataDir, target, {
      targetExisted,
      receipt: { pageCount: run.pageCount, printableArea: run.area },
    });
  } finally {
    await releaseStagingTarget(staging).catch(() => {});
  }
  if (brief.present) session.authoredBrief = brief;
  markAuthoredFromHtml(session, htmlSource);
  if (frame) {
    // Designed pages are the author's deck on paper: reviewed and finalized as one.
    session.authored = true;
    session.authoredFrame = true;
    session.frameAudit = framed.audit;
    session.frameReceipt = framed.receipt;
    session.frameDesignIssues = framed.designIssues;
    if (framed.rounds) session.inlineAudit = framed.rounds;
  }
  // The facts gate already refused a designed page's unlisted figure; a flowing document only reports it.
  const facts = frame ? null : await factsWarning(target, brief);
  const result = {
    ok: true,
    session: session.id,
    mode: session.mode,
    backend: session.backend,
    output: target,
    bytes: run.bytes,
    pageCount: run.pageCount,
    printableArea: run.area,
    ...(frame ? { designedPages: true } : {}),
    htmlSource,
    ...(replacedEdits ? { replacedEdits } : {}),
    warnings: run.warnings,
    ...(frame && framed.run.logs?.length ? { logs: framed.run.logs } : {}),
    ...(facts ? { facts } : {}),
    ...(framed?.audit ? { audit: framed.audit } : {}),
    elapsedMs: run.elapsedMs + (framed?.run.elapsedMs || 0),
  };
  const auditFailed = framed?.audit?.status === 'fail';
  if (args.render === false) {
    if (framed?.receipt) result.receipt = receiptForDelivery(framed.receipt, session);
    result.nextAction = auditFailed
      ? framed.audit.nextAction
      : frame
        ? FRAME_UNRENDERED_NEXT_ACTION
        : UNRENDERED_NEXT_ACTION;
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
    // Designed pages: the render read the printed pixels into the receipt and wrote the contact sheet.
    if (rendered.contactSheet) result.render.contactSheet = rendered.contactSheet;
    if (rendered.receipt) result.receipt = rendered.receipt;
    result._images = Array.isArray(rendered._images) ? rendered._images : [];
  } finally {
    delete session.activeSignal;
  }
  if (auditFailed) {
    result.nextAction = `${framed.audit.nextAction} The rendered pages are attached; the visual read starts once the audit passes.`;
  } else result.nextAction = frame ? FRAME_RENDERED_NEXT_ACTION : RENDERED_NEXT_ACTION;
  return result;
}
