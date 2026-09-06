import { rm } from 'node:fs/promises';
import { render } from '../core/office-actions.mjs';
import { documentFormat, documentSessionKey, documentSessions, sessions } from '../core/office-core.mjs';
import { createAuthoredSession, fullPath, validatePptxAuthorMode } from '../core/office-sessions.mjs';
import { inlineOfficeAudit } from '../quality/inline-audit.mjs';
import {
  exists,
  landStagedDeck,
  releaseExistingSession,
  reusableAuthoredSession,
  stagingTarget,
  swapAuthoredDocument,
  throwIfAuthoringCancelled,
} from './pptx-author-session.mjs';
import { runPptxAuthoringScript } from './pptx-script-runner.mjs';
import { factsGate, parseAuthoringBrief } from './pptx-brief.mjs';
import { readCompositionReceipt } from './pptx-review-artifacts.mjs';
import { snapshotPortableOoxml } from '../portable/portable-ooxml.mjs';

/** The design guide lives in the built-in `pptx` skill; the tool never
 *  serves it so one copy stays authoritative and user-overridable. */
const PPTX_AUTHOR_NEEDS_SCRIPT =
  'author requires script. Load the `pptx` Skill first (Skill name:"pptx"): it carries the authoring workflow, composition grammar, device kit, and the pptxgenjs footguns, then call author again with path and script.';

// The gate reads the staged deck with the portable reader whatever backend
// will hold it; a package the reader cannot open is left to qa, never turned
// into a refusal.
async function factsGateForDeck(path, brief) {
  if (!brief.present || brief.factsMode === 'sample') return { blocked: false };
  try {
    return factsGate(await snapshotPortableOoxml(path, 'pptx', {}), brief);
  } catch (error) {
    return { blocked: false, unavailable: error?.message || String(error) };
  }
}

function factsGateResult(target, brief, gate, run) {
  const listed = gate.slides.map((entry) => `slide ${entry.slide}: ${entry.figures.join(', ')}`).join('; ');
  return {
    ok: false,
    reason: 'facts_gate',
    output: target,
    gate: { code: gate.code, slides: gate.slides, facts: brief.facts.length },
    logs: run.logs,
    elapsedMs: run.elapsedMs,
    nextAction: gate.code === 'facts_missing'
      ? `The deck shows figures (${listed}) but the brief has no facts line, so nothing landed. Add \`// facts: F1 <value> — <source> · …\` for every figure the slides show, or declare \`// facts: sample — <why no source>\` to mark every figure illustrative; then call author again.`
      : `Figures with no fact behind them (${listed}), so nothing landed. Add each to the brief facts line with its source, remove it from the slide, or declare \`// facts: sample — <why>\`; then call author again.`,
  };
}

export async function authorPptx(args, { cwd, dataDir, signal = null }) {
  if (!String(args.script || '').trim()) throw new Error(PPTX_AUTHOR_NEEDS_SCRIPT);
  const requestedPath = String(args.path || args.output || '').trim();
  if (!requestedPath) throw new Error('author requires path');
  const target = fullPath(requestedPath, cwd);
  if (documentFormat(target) !== 'pptx') throw new Error('author writes .pptx targets only');
  const mode = validatePptxAuthorMode(args.mode);
  throwIfAuthoringCancelled(signal);
  const reusable = reusableAuthoredSession(target, mode);
  const existing = sessions.get(documentSessions.get(documentSessionKey(target)) || '') || null;
  // A re-author replaces the session, but the audit fix rounds belong to the
  // deck: the loop keeps counting across passes on the same path.
  const priorAudit = reusable ? null : existing?.inlineAudit || null;
  if (!reusable && !existing && await exists(target) && args.overwrite !== true) {
    throw new Error(`author target already exists: ${target}; pass overwrite:true to replace it`);
  }
  // The script always writes beside the target: a failed script or a refused
  // deck leaves the file on disk and the session holding the previous deck
  // untouched.
  const staging = stagingTarget(target);
  const brief = parseAuthoringBrief(args.script);
  let run;
  let session = null;
  let reusedSession = false;
  let replacedSession = null;
  let discardStaging = true;
  try {
    throwIfAuthoringCancelled(signal);
    run = await runPptxAuthoringScript(args.script, staging);
    throwIfAuthoringCancelled(signal);
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
    // The gate reads the staged deck before anything lands: a figure with no
    // fact behind it is refused here, not reported once the deck is open.
    const gate = await factsGateForDeck(staging, brief);
    if (gate.blocked) return factsGateResult(target, brief, gate, run);
    // Keep the valid staged deck recoverable if replacement fails for a non-cancellation reason.
    discardStaging = false;
    if (reusable) {
      reusedSession = await swapAuthoredDocument(reusable, staging, signal);
      if (reusedSession) session = reusable;
      else {
        await releaseExistingSession(target, signal);
        await landStagedDeck(staging, target, signal);
      }
    } else {
      replacedSession = await releaseExistingSession(target, signal);
      await landStagedDeck(staging, target, signal);
    }
    throwIfAuthoringCancelled(signal);
    if (!session) session = await createAuthoredSession(signal ? { ...args, mode, __signal: signal } : { ...args, mode }, cwd, dataDir, target);
    discardStaging = true;
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') discardStaging = true;
    throw error;
  } finally {
    if (discardStaging) await rm(staging, { force: true }).catch(() => {});
  }
  session.authoredBrief = brief;
  if (priorAudit && !session.inlineAudit) session.inlineAudit = { ...priorAudit };
  const audit = args.audit === false ? null : await inlineOfficeAudit(session);
  const result = {
    ok: true,
    session: session.id,
    mode: session.mode,
    backend: session.backend,
    output: target,
    bytes: run.bytes,
    elapsedMs: run.elapsedMs,
    logs: run.logs,
    kit: run.kit,
    ...(run.normalizedParagraphs ? { normalizedParagraphs: run.normalizedParagraphs } : {}),
    ...(run.nativeGradients ? { nativeGradients: run.nativeGradients } : {}),
    ...(replacedSession ? { replacedSession } : {}),
    ...(reusedSession ? { reusedSession: true } : {}),
    ...(audit ? { audit } : {}),
  };
  if (args.render === false) {
    const receipt = await readCompositionReceipt(session);
    if (receipt) result.receipt = receipt;
    result.nextAction = audit?.status === 'fail'
      ? audit.nextAction
      : 'Written and measured clean, not visually reviewed: call action:render on this session for the page images, contact sheet, receipt, and reviewToken, then inspect every slide before finalizing. action:qa render:false adds the design read (theme, plan promises, facts) without pixels. Re-author only if the script changes.';
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
      contactSheet: rendered.contactSheet,
    };
    result._images = Array.isArray(rendered._images) ? rendered._images : [];
    if (rendered.receipt) result.receipt = rendered.receipt;
    result.nextAction = audit?.status === 'fail'
      ? `${audit.nextAction} The rendered pages are attached; the visual read starts once the audit passes.`
      : 'Inspect every rendered slide for message visibility, relevant evidence, legibility, and grouping; then read the contact sheet for coherent sequence. Use the receipt to investigate possible defects, not to require an inventory of charts, pictures, or shapes. Change the script only for an observed problem, or finalize with design: { reviewed: true, reviewToken, critique: [one entry per slide] }.';
  } finally {
    delete session.activeSignal;
  }
  return result;
}
