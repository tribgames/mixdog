import { appendFileSync } from 'node:fs';
import { resetMicrosoftOfficeSessionsForTest } from './com/com-adapter.mjs';
import { defaultOfficeDataDir } from './core/journal.mjs';
import { runSessionlessOfficeAction } from './core/office-sessionless-actions.mjs';
import { dispatchOfficeSessionAction } from './core/office-session-dispatch.mjs';
import {
  OfficeConflictError,
  documentSessions,
  ensureOfficeSessionDesign,
  finalizeOfficeResult,
  isMicrosoftOfficeSession,
  releaseOfficeSession,
  sessions,
  toolResult,
} from './core/office-core.mjs';
import { resolveSession } from './core/office-sessions.mjs';

// Office work is minutes of real application time, and guessing which action carries it is how
// tuning goes wrong. MIXDOG_OFFICE_TRACE writes one line per call so a slow run maps itself; it
// names a file because a test runner keeps the child process's own streams to itself.
const OFFICE_TRACE = process.env.MIXDOG_OFFICE_TRACE || '';

// Actions that only look at the document. Opening one of these on a path reads
// the file itself instead of stamping a working copy over whatever an earlier
// edit left at that name.
// qa with autoFix repairs the document, so it is excluded at the call site.
const READ_ONLY_ACTIONS = new Set(['snapshot', 'get', 'query', 'issues', 'validate', 'describe', 'render', 'qa']);

export async function executeOfficeTool(args = {}, context = {}) {
  if (!OFFICE_TRACE) return await runOfficeTool(args, context);
  const startedAt = performance.now();
  try {
    return await runOfficeTool(args, context);
  } finally {
    const line = `${String(args.action || '?')}\t${Math.round(performance.now() - startedAt)}\t${args.path || args.session || ''}\n`;
    if (OFFICE_TRACE === '1') process.stderr.write(`[office-trace] ${line}`);
    else
      try {
        appendFileSync(OFFICE_TRACE, line);
      } catch {}
  }
}

async function runOfficeTool(args = {}, { cwd = process.cwd(), dataDir = defaultOfficeDataDir(), signal = null } = {}) {
  const startedAt = performance.now();
  let activeSession = null;
  try {
    if (signal?.aborted) throw new Error('Office Use operation was cancelled');
    const action = String(args.action || '').toLowerCase();
    const sessionless = await runSessionlessOfficeAction({ action, args, cwd, dataDir, signal, startedAt });
    if (sessionless) return sessionless;
    const { session, implicit } = await resolveSession(signal ? { ...args, __signal: signal } : args, cwd, dataDir, {
      readOnly: READ_ONLY_ACTIONS.has(action) && args.autoFix !== true,
    });
    await ensureOfficeSessionDesign(session, args, dataDir, {
      created: session.created === true,
      allowLibraryUpgrade: true,
      preserveNativeDesign: true,
    });
    activeSession = session;
    session.activeSignal = signal;
    const value = await dispatchOfficeSessionAction({ action, session, args, cwd, signal });
    if (implicit && action !== 'close') value.implicitSession = true;
    const images = Array.isArray(value?._images) ? value._images : [];
    if (value && typeof value === 'object') delete value._images;
    finalizeOfficeResult(value, { action, session, startedAt });
    return toolResult(value, false, images);
  } catch (error) {
    if (error instanceof OfficeConflictError) return toolResult(error.details, true);
    if (signal?.aborted || /cancelled/i.test(String(error?.message || ''))) {
      if (activeSession && isMicrosoftOfficeSession(activeSession)) releaseOfficeSession(activeSession);
      return toolResult(
        {
          ok: false,
          code: 'cancelled',
          message: 'Office Use operation was cancelled',
          detail: error?.message || String(error),
        },
        true
      );
    }
    return toolResult(`Error: ${error?.message || String(error)}`, true);
  } finally {
    if (activeSession) delete activeSession.activeSignal;
  }
}

export function resetOfficeSessionsForTest() {
  resetMicrosoftOfficeSessionsForTest();
  sessions.clear();
  documentSessions.clear();
}
