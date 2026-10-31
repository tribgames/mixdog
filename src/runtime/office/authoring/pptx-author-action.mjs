import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { render } from '../core/office-actions.mjs';
import { documentFormat, officeSessionForDocument } from '../core/office-core.mjs';
import { createAuthoredSession, fullPath, validatePptxAuthorMode } from '../core/office-sessions.mjs';
import { inlineOfficeAudit } from '../quality/inline-audit.mjs';
import {
  exists,
  landStagedDeck,
  releaseExistingSession,
  releaseStagingTarget,
  reusableAuthoredSession,
  stagingTarget,
  swapAuthoredDocument,
  throwIfAuthoringCancelled,
} from './pptx-author-session.mjs';
import { runPptxAuthoringScript } from './pptx-script-runner.mjs';
import {
  htmlArtifacts,
  htmlBriefScript,
  measureHtmlDrift,
  runPptxHtmlAuthoring,
  writeHtmlComparisons,
} from './pptx-html-runner.mjs';
import { factsGate, parseAuthoringBrief, planGate } from './pptx-brief.mjs';
import { editsReplacedByAuthor, markAuthoredFromHtml } from './html-source-drift.mjs';
import { readCompositionReceipt } from './pptx-review-artifacts.mjs';
import { receiptForDelivery } from './pptx-receipt.mjs';
import { snapshotPortableOoxml } from '../portable/portable-ooxml.mjs';

/** The design guide lives in the built-in `pptx` skill; the tool never
 *  serves it so one copy stays authoritative and user-overridable. */
const PPTX_AUTHOR_NEEDS_SOURCE =
  'author requires script: HTML slides or a pptxgenjs script (without one it re-authors from <deck>.pptx.mixdog-source.html, and none is there). Load the `pptx` Skill first (Skill name:"pptx"): it carries the authoring workflow, the HTML contract, the composition grammar, and the device kit, then call author again with path and script.';

// HTML opens with markup (a doctype, a comment, an element); a pptxgenjs script never does.
function isHtmlSource(source) {
  return /^\s*</.test(String(source || ''));
}

// The gates read the staged deck with the portable reader whatever backend
// will hold it; a package the reader cannot open is left to qa, never turned
// into a refusal. One snapshot answers both: the figures against the fact
// sheet, then the pages against the plan that was written before them.
export async function gateStagedDeck(path, brief) {
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
  // The snapshot rides on a pass so a caller can read the same deck further (a PDF's design read).
  return plan.blocked ? { ...plan, gate: 'plan' } : { blocked: false, document };
}

function describePlanSlide(entry) {
  if (entry.carrier) return `slide ${entry.slide}: ${entry.carrier} (${entry.label})`;
  if (entry.missing) return `slide ${entry.slide}: ${entry.missing.join(', ')}`;
  return `slide ${entry.slide}`;
}

export function planGateResult(target, gate, run) {
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

export function factsGateResult(target, brief, gate, run) {
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

// The HTML's own geometry, read in the browser before anything lands: a declared relation that does not
// hold, or a near miss no declaration covers (pptx-html-geometry.mjs).
export function geometryGateResult(target, run) {
  const listed = run.geometry
    .map((page) => `slide ${page.slide}: ${page.findings.map((finding) => finding.message).join('; ')}`)
    .join(' | ');
  return {
    ok: false,
    reason: 'geometry_gate',
    output: target,
    gate: { code: 'geometry', slides: run.geometry },
    logs: run.logs,
    elapsedMs: run.elapsedMs,
    nextAction: `The pages' geometry does not hold (${listed}), so nothing landed. Compute related positions from one source (flex or grid, calc() on shared custom properties, related shapes in one SVG) and declare the relation (data-on, data-inside, data-between, data-align, data-label); mark an offset that is deliberate data-free. Then call author again.`,
  };
}

function resolveAuthorTarget(args, cwd) {
  const requestedPath = String(args.path || args.output || '').trim();
  // A bare author (no path, no script) is a call made before reading the skill: it is pointed there.
  if (!requestedPath)
    throw new Error(String(args.script || '').trim() ? 'author requires path' : PPTX_AUTHOR_NEEDS_SOURCE);
  const target = fullPath(requestedPath, cwd);
  if (documentFormat(target) !== 'pptx') throw new Error('author writes .pptx and .pdf targets only');
  return { target, mode: validatePptxAuthorMode(args.mode) };
}

function scriptFailedResult(target, run, html) {
  return {
    ok: false,
    reason: html ? 'html_failed' : 'script_failed',
    output: target,
    error: run.error,
    logs: run.logs,
    elapsedMs: run.elapsedMs,
    nextAction: html
      ? 'Fix the HTML the error names and call author again.'
      : 'Fix the script at the reported line and call author again.',
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
    if (receipt) result.receipt = receiptForDelivery(receipt, session);
    result.nextAction = audit?.status === 'fail' ? audit.nextAction : UNRENDERED_NEXT_ACTION;
    return result;
  }
  session.activeSignal = signal;
  try {
    await renderAuthoredDeck(session, args, cwd, result, audit);
  } finally {
    delete session.activeSignal;
  }
  if (run.htmlShots?.length && result.render?.images?.length) {
    result.render.compare = await writeHtmlComparisons(target, run.htmlShots, result.render.images);
    const drift = await measureHtmlDrift(run.htmlShots, run.htmlText, result.render.images);
    result.render.drift = drift;
    const moved = drift.pages.map(
      (entry) =>
        `slide ${entry.page}: ${entry.items.map((item) => `"${item.text}" dy ${item.dy} dx ${item.dx}`).join(', ')}`
    );
    const drifted = moved.length
      ? ` html_render_drift: text PowerPoint drew more than ${drift.threshold}px from where the HTML put it (${moved.join('; ')}); open those pages' compare pairs and fix the HTML or report the residue.`
      : '';
    const unread = drift.unreadPages?.length
      ? ` Pages ${drift.unreadPages.join(', ')} were rendered in shared images, so their drift was not read; render them in batches of 12 or fewer to read it.`
      : '';
    result.nextAction = `${result.nextAction} render.compare holds one image per page, the HTML (left) beside the PPTX render (right): open a page's pair when its render differs from what the HTML drew.${drifted}${unread}`;
  }
  return result;
}

// The session the target already has, if any: a reusable authored session
// swaps its deck; an existing session hands its audit rounds on. A re-author
// replaces the session, but the audit fix rounds belong to the deck: the loop
// keeps counting across passes on the same path.
async function authoringSessionState(target, mode, args, fromSource) {
  const reusable = reusableAuthoredSession(target, mode);
  const existing = officeSessionForDocument(target);
  if (!reusable && !existing && !fromSource && (await exists(target)) && args.overwrite !== true) {
    throw new Error(`author target already exists: ${target}; pass overwrite:true to replace it`);
  }
  return { reusable, priorAudit: reusable ? null : existing?.inlineAudit || null };
}

export async function authorPptx(args, { cwd, dataDir, signal = null }) {
  const { target, mode } = resolveAuthorTarget(args, cwd);
  // Without a script the deck is authored again from the HTML kept beside it, as a PDF or Word document is: a fix
  // is an edit to that file, not the whole deck sent again.
  const sourcePath = htmlArtifacts(target).source;
  const fromSource = !String(args.script || '').trim();
  if (fromSource && !(await exists(sourcePath))) throw new Error(PPTX_AUTHOR_NEEDS_SOURCE);
  const script = fromSource ? await readFile(sourcePath, 'utf8') : String(args.script);
  throwIfAuthoringCancelled(signal);
  const replacedEdits = editsReplacedByAuthor(officeSessionForDocument(target));
  const { reusable, priorAudit } = await authoringSessionState(target, mode, args, fromSource);
  // The script always writes beside the target: a failed script or a refused
  // deck leaves the file on disk and the session holding the previous deck
  // untouched.
  const staging = await stagingTarget(target);
  const html = isHtmlSource(script);
  const brief = parseAuthoringBrief(html ? htmlBriefScript(script) : script);
  let run;
  let session = null;
  let reusedSession = false;
  let replacedSession = null;
  let discardStaging = true;
  try {
    throwIfAuthoringCancelled(signal);
    run = html
      ? await runPptxHtmlAuthoring(script, staging, { target, signal })
      : await runPptxAuthoringScript(script, staging, { cwd: dirname(target) });
    throwIfAuthoringCancelled(signal);
    if (!run.ok) return scriptFailedResult(target, run, html);
    if (run.geometry?.length) return geometryGateResult(target, run);
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
    if (discardStaging) await releaseStagingTarget(staging).catch(() => {});
  }
  session.authoredBrief = brief;
  // A deck from HTML counts the batch edits that land past its kept source; a pptxgenjs deck keeps no source.
  markAuthoredFromHtml(session, run.htmlSource || null);
  if (priorAudit && !session.inlineAudit) session.inlineAudit = { ...priorAudit };
  const result = await finishAuthoredDeck(session, { args, cwd, target, run, signal, replacedSession, reusedSession });
  if (replacedEdits) result.replacedEdits = replacedEdits;
  return result;
}

const UNRENDERED_NEXT_ACTION =
  'Written and measured clean, not visually reviewed: call action:render on this session for the page images, contact sheet, receipt, and reviewToken, then inspect every slide before finalizing. action:qa render:false adds the design read (theme, plan promises, facts) without pixels. Re-author only if the script changes.';

const RENDERED_NEXT_ACTION =
  'Inspect every rendered slide for message visibility, relevant evidence, legibility, and grouping; then read the sequence for coherence (the contact sheet image, attached past four slides). Use the receipt to investigate possible defects, not to require an inventory of charts, pictures, or shapes. Change the script only for an observed problem, or finalize with design: { reviewed: true, reviewToken, critique: [one entry per slide] }.';

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
    ...(run.htmlSource ? { htmlSource: run.htmlSource } : {}),
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
