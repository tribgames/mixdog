import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { closeSession, render } from '../core/office-actions.mjs';
import { documentFormat, documentSessionKey, documentSessions, sessions } from '../core/office-core.mjs';
import { createAuthoredSession, fullPath, snapshot } from '../core/office-sessions.mjs';
import { runPptxAuthoringScript } from './pptx-script-runner.mjs';
import { parseAuthoringBrief } from './pptx-brief.mjs';
import { attachRenderedAir, compositionReceipt } from './pptx-receipt.mjs';
import { writeContactSheet } from './pptx-contact-sheet.mjs';
import { renderedAirByPage } from '../quality/render-air.mjs';

// What the saved deck carries, slide by slide, for the author to weigh
// against the plan. A receipt that cannot be read (an exotic package the
// snapshot refuses) is omitted rather than failing the authoring call.
async function readCompositionReceipt(session, brief) {
  try {
    const current = await snapshot(session, { includeStyles: true, limit: 100, maxChars: 100_000 }, { full: true });
    return compositionReceipt(current?.document, brief);
  } catch {
    return null;
  }
}

/** The design guide lives in the built-in `pptx` skill; the tool never
 *  serves it so one copy stays authoritative and user-overridable. */
export const PPTX_AUTHOR_NEEDS_SCRIPT =
  'author requires script. Load the `pptx` Skill first (Skill name:"pptx"): it carries the authoring workflow, composition grammar, device kit, and the pptxgenjs footguns, then call author again with path and script.';

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// Re-authoring replaces the deck, so a session still holding the previous
// file has to let go first; nothing in it is worth saving because the script
// is the source of truth.
async function releaseExistingSession(target, signal) {
  const existingId = documentSessions.get(documentSessionKey(target));
  const existing = existingId ? sessions.get(existingId) : null;
  if (!existing) return null;
  await closeSession(existing, { save: false, signal }).catch(() => {});
  sessions.delete(existing.id);
  if (documentSessions.get(documentSessionKey(target)) === existing.id) {
    documentSessions.delete(documentSessionKey(target));
  }
  return existing.id;
}

export async function authorPptx(args, { cwd, dataDir, signal = null }) {
  if (!String(args.script || '').trim()) throw new Error(PPTX_AUTHOR_NEEDS_SCRIPT);
  const requestedPath = String(args.path || args.output || '').trim();
  if (!requestedPath) throw new Error('author requires path');
  const target = fullPath(requestedPath, cwd);
  if (documentFormat(target) !== 'pptx') throw new Error('author writes .pptx targets only');
  const replacedSession = await releaseExistingSession(target, signal);
  if (await exists(target) && args.overwrite !== true && !replacedSession) {
    throw new Error(`author target already exists: ${target}; pass overwrite:true to replace it`);
  }
  const run = await runPptxAuthoringScript(args.script, target);
  if (!run.ok) {
    return {
      ok: false,
      reason: 'script_failed',
      output: target,
      error: run.error,
      logs: run.logs,
      elapsedMs: run.elapsedMs,
      nextAction: 'Fix the script at the reported line and call author again.',
    };
  }
  const session = await createAuthoredSession(signal ? { ...args, __signal: signal } : args, cwd, dataDir, target);
  session.authoredBrief = parseAuthoringBrief(args.script);
  const result = {
    ok: true,
    session: session.id,
    mode: session.mode,
    backend: session.backend,
    output: target,
    bytes: run.bytes,
    elapsedMs: run.elapsedMs,
    logs: run.logs,
    ...(run.normalizedParagraphs ? { normalizedParagraphs: run.normalizedParagraphs } : {}),
    ...(replacedSession ? { replacedSession } : {}),
  };
  const receipt = await readCompositionReceipt(session, session.authoredBrief);
  if (receipt) result.receipt = receipt;
  if (args.render === false) {
    result.nextAction = 'Measured only, not rendered: run action:qa on this session for the fit and bounds issues, fix the script, and author again with render:false until qa is clean; then author with render (default) once and inspect every slide before finalizing.';
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
    // The rendered page's own air beside the shape-based reading; a failure here loses a number, not the render.
    if (result.receipt) {
      const airByPage = await renderedAirByPage(result._images).catch(() => null);
      if (airByPage) attachRenderedAir(result.receipt, airByPage);
    }
    // The whole deck on one sheet, after the per-page renders, so the sequence can be read at once.
    const sheet = await writeContactSheet(result._images, target).catch(() => null);
    if (sheet) {
      const { data, ...meta } = sheet;
      result.render.contactSheet = meta;
      result._images.push({ page: 0, path: sheet.path, width: sheet.width, height: sheet.height, mimeType: sheet.mimeType, data });
    }
    result.nextAction = 'Inspect every rendered slide, then the contact sheet as a sequence (density rhythm, repeated moves, title positions), and read the receipt against the plan (a deck-wide absence or a contradicted carrier gets a reason or a fix). Fix defects in the script and author again with overwrite:true, or finalize with design: { reviewed: true, reviewToken, critique: [one entry per slide] }.';
  } finally {
    delete session.activeSignal;
  }
  return result;
}
