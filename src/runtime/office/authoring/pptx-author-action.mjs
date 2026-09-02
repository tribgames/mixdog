import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { closeSession, render } from '../core/office-actions.mjs';
import { documentFormat, documentSessionKey, documentSessions, sessions } from '../core/office-core.mjs';
import { createAuthoredSession, fullPath } from '../core/office-sessions.mjs';
import { runPptxAuthoringScript } from './pptx-script-runner.mjs';

/** The design guide lives in the built-in `pptx` skill; the tool never
 *  serves it so one copy stays authoritative and user-overridable. */
export const PPTX_AUTHOR_NEEDS_SCRIPT =
  'author requires script. Load the `pptx` Skill first (Skill name:"pptx"): it carries the authoring workflow, design system, helper kit, and the pptxgenjs footguns, then call author again with path and script.';

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
  const result = {
    ok: true,
    session: session.id,
    mode: session.mode,
    backend: session.backend,
    output: target,
    bytes: run.bytes,
    elapsedMs: run.elapsedMs,
    logs: run.logs,
    ...(replacedSession ? { replacedSession } : {}),
  };
  if (args.render === false) {
    result.nextAction = 'Render the deck and inspect every slide before finalizing.';
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
    result.nextAction = 'Inspect every rendered slide. Fix defects in the script and author again with overwrite:true, or finalize with design: { reviewed: true, reviewToken, critique: [one entry per slide] }.';
  } finally {
    delete session.activeSignal;
  }
  return result;
}
