import { rm } from 'node:fs/promises';
import { render } from '../core/office-actions.mjs';
import { documentFormat, officeSessionForDocument } from '../core/office-core.mjs';
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
import { factsGate, parseAuthoringBrief, planGate } from './pptx-brief.mjs';
import { readCompositionReceipt } from './pptx-review-artifacts.mjs';
import { snapshotPortableOoxml } from '../portable/portable-ooxml.mjs';

/** The design guide lives in the built-in `pptx` skill; the tool never
 *  serves it so one copy stays authoritative and user-overridable. */
const PPTX_AUTHOR_NEEDS_SCRIPT =
  'author requires script. Load the `pptx` Skill first (Skill name:"pptx"): it carries the authoring workflow, composition grammar, device kit, and the pptxgenjs footguns, then call author again with path and script.';

// The gates read the staged deck with the portable reader whatever backend
// will hold it; a package the reader cannot open is left to qa, never turned
// into a refusal. One snapshot answers both: the figures against the fact
// sheet, then the pages against the plan that was written before them.
async function gateStagedDeck(path, brief) {
  if (!brief.present) return { blocked: false };
  let document;
  try {
    document = await snapshotPortableOoxml(path, 'pptx', {});
  } catch (error) {
    return { blocked: false, unavailable: error?.message || String(error) };
  }
  const facts = factsGate(document, brief);
  if (facts.blocked) return { ...facts, gate: 'facts' };
  const plan = planGate(document, brief);
  return plan.blocked ? { ...plan, gate: 'plan' } : { blocked: false };
}

function describePlanSlide(entry) {
  if (entry.carrier) return `slide ${entry.slide}: ${entry.carrier} (${entry.label})`;
  if (entry.missing) return `slide ${entry.slide}: ${entry.missing.join(', ')}`;
  return `slide ${entry.slide}`;
}

function planGateResult(target, gate, run) {
  const listed = gate.slides.map(describePlanSlide).join('; ');
  const nextAction = {
    plan_missing:
      'The deck holds more than one slide but the brief has no `// slide plan:` line, so nothing landed. Write one line per slide — `1 job: cover · move: <what the reader now holds> · composition: <the page move> · carriers: statement` — then call author again.',
    plan_slide_unplanned: `Slides the plan does not cover (${listed}), so nothing landed. Give every slide its plan line, or drop the slides the plan does not want; then call author again.`,
    plan_incomplete: `Plan lines that name no job or carriers (${listed}), so nothing landed. Every line says what the page does and what carries it; then call author again.`,
    plan_promise_missing: `Slides that do not carry what their own plan line named (${listed}), so nothing landed. Draw the carrier the line promises, or change the line to what the page actually carries; then call author again.`,
  }[gate.code];
  return {
    ok: false,
    reason: 'plan_gate',
    output: target,
    gate: { code: gate.code, slides: gate.slides },
    logs: run.logs,
    elapsedMs: run.elapsedMs,
    nextAction,
  };
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
    nextAction:
      gate.code === 'facts_missing'
        ? `The deck shows figures (${listed}) but the brief has no facts line, so nothing landed. Add \`// facts: F1 <value> — <source> · …\` for every figure the slides show, or declare \`// facts: sample — <why no source>\` to mark every figure illustrative; then call author again.`
        : `Figures with no fact behind them (${listed}), so nothing landed. Add each to the brief facts line with its source, remove it from the slide, or declare \`// facts: sample — <why>\`; then call author again.`,
  };
}

function resolveAuthorTarget(args, cwd) {
  if (!String(args.script || '').trim()) throw new Error(PPTX_AUTHOR_NEEDS_SCRIPT);
  const requestedPath = String(args.path || args.output || '').trim();
  if (!requestedPath) throw new Error('author requires path');
  const target = fullPath(requestedPath, cwd);
  if (documentFormat(target) !== 'pptx') throw new Error('author writes .pptx targets only');
  return { target, mode: validatePptxAuthorMode(args.mode) };
}

function scriptFailedResult(target, run) {
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

// Lands the gated staged deck: a reusable session swaps its document in
// place; otherwise the existing session is released before the file moves.
async function landAuthoredDeck({ reusable, staging, target, signal }) {
  if (reusable) {
    const reusedSession = await swapAuthoredDocument(reusable, staging, signal);
    if (reusedSession) return { session: reusable, reusedSession, replacedSession: null };
    await releaseExistingSession(target, signal);
    await landStagedDeck(staging, target, signal);
    return { session: null, reusedSession, replacedSession: null };
  }
  const replacedSession = await releaseExistingSession(target, signal);
  await landStagedDeck(staging, target, signal);
  return { session: null, reusedSession: false, replacedSession };
}

async function finishAuthoredDeck(session, { args, cwd, target, run, signal, replacedSession, reusedSession }) {
  const audit = args.audit === false ? null : await inlineOfficeAudit(session);
  const result = authoredResult(session, target, run, { replacedSession, reusedSession, audit });
  if (args.render === false) {
    const receipt = await readCompositionReceipt(session);
    if (receipt) result.receipt = receipt;
    result.nextAction = audit?.status === 'fail' ? audit.nextAction : UNRENDERED_NEXT_ACTION;
    return result;
  }
  session.activeSignal = signal;
  try {
    await renderAuthoredDeck(session, args, cwd, result, audit);
  } finally {
    delete session.activeSignal;
  }
  return result;
}

// The session the target already has, if any: a reusable authored session
// swaps its deck; an existing session hands its audit rounds on. A re-author
// replaces the session, but the audit fix rounds belong to the deck: the loop
// keeps counting across passes on the same path.
async function authoringSessionState(target, mode, args) {
  const reusable = reusableAuthoredSession(target, mode);
  const existing = officeSessionForDocument(target);
  if (!reusable && !existing && (await exists(target)) && args.overwrite !== true) {
    throw new Error(`author target already exists: ${target}; pass overwrite:true to replace it`);
  }
  return { reusable, priorAudit: reusable ? null : existing?.inlineAudit || null };
}

export async function authorPptx(args, { cwd, dataDir, signal = null }) {
  const { target, mode } = resolveAuthorTarget(args, cwd);
  throwIfAuthoringCancelled(signal);
  const { reusable, priorAudit } = await authoringSessionState(target, mode, args);
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
    if (!run.ok) return scriptFailedResult(target, run);
    // The gates read the staged deck before anything lands: a figure with no
    // fact behind it, and a page that does not carry what its plan line named,
    // are refused here, not reported once the deck is open.
    const gate = await gateStagedDeck(staging, brief);
    if (gate.blocked)
      return gate.gate === 'plan' ? planGateResult(target, gate, run) : factsGateResult(target, brief, gate, run);
    // Keep the valid staged deck recoverable if replacement fails for a non-cancellation reason.
    discardStaging = false;
    ({ session, reusedSession, replacedSession } = await landAuthoredDeck({ reusable, staging, target, signal }));
    throwIfAuthoringCancelled(signal);
    if (!session)
      session = await createAuthoredSession(
        signal ? { ...args, mode, __signal: signal } : { ...args, mode },
        cwd,
        dataDir,
        target
      );
    discardStaging = true;
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') discardStaging = true;
    throw error;
  } finally {
    if (discardStaging) await rm(staging, { force: true }).catch(() => {});
  }
  session.authoredBrief = brief;
  if (priorAudit && !session.inlineAudit) session.inlineAudit = { ...priorAudit };
  return finishAuthoredDeck(session, { args, cwd, target, run, signal, replacedSession, reusedSession });
}

const UNRENDERED_NEXT_ACTION =
  'Written and measured clean, not visually reviewed: call action:render on this session for the page images, contact sheet, receipt, and reviewToken, then inspect every slide before finalizing. action:qa render:false adds the design read (theme, plan promises, facts) without pixels. Re-author only if the script changes.';

const RENDERED_NEXT_ACTION =
  'Inspect every rendered slide for message visibility, relevant evidence, legibility, and grouping; then read the contact sheet for coherent sequence. Use the receipt to investigate possible defects, not to require an inventory of charts, pictures, or shapes. Change the script only for an observed problem, or finalize with design: { reviewed: true, reviewToken, critique: [one entry per slide] }.';

function authoredResult(session, target, run, { replacedSession, reusedSession, audit }) {
  return {
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
    ...(run.vectorIcons ? { vectorIcons: run.vectorIcons } : {}),
    ...(replacedSession ? { replacedSession } : {}),
    ...(reusedSession ? { reusedSession: true } : {}),
    ...(audit ? { audit } : {}),
  };
}

// Renders the landed deck onto the result: page images, review token and
// receipt, with the next step gated on the inline audit.
async function renderAuthoredDeck(session, args, cwd, result, audit) {
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
  result.nextAction =
    audit?.status === 'fail'
      ? `${audit.nextAction} The rendered pages are attached; the visual read starts once the audit passes.`
      : RENDERED_NEXT_ACTION;
}
