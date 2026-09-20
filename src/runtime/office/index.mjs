import { appendFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { detectMicrosoftOffice, resetMicrosoftOfficeSessionsForTest } from './com/com-adapter.mjs';
import { pdfOcrReadiness } from './pdf/pdf-analysis.mjs';
import { describeOfficeCapabilities } from './capabilities.mjs';
import { qpdfAvailable, securePdf } from './pdf/pdf-security.mjs';
import { unicodeFontPath } from './pdf/pdf-fonts.mjs';
import { defaultOfficeDataDir } from './core/journal.mjs';
import { inspectOfficeDesignLibrary } from './design/library/design-library.mjs';
import { applyBatch, closeSession, finalize, issues, qa, render, save, validate } from './core/office-actions.mjs';
import { openCreateOrAttachOffice } from './core/office-actions-open.mjs';
import { getOfficeElement, queryOfficeDocument } from './core/office-actions-read.mjs';
import { authorPptx } from './authoring/pptx-author-action.mjs';
import {
  FILE_KIND_TO_FORMAT,
  OfficeConflictError,
  documentFormat,
  documentSessionKey,
  documentSessions,
  ensureOfficeSessionDesign,
  finalizeOfficeResult,
  isMicrosoftOfficeSession,
  normalizeOfficeFormat,
  sessions,
  toolResult,
} from './core/office-core.mjs';
import { fullPath, resolveSession, selectMode, snapshot } from './core/office-sessions.mjs';
import {
  assertTransactionUnchanged,
  beginTransaction,
  commitTransaction,
  pendingOfficeTransactions,
  recoverOfficeTransaction,
  rollbackTransaction,
  transactionDocumentDiff,
  transactionView,
} from './core/office-transactions.mjs';

export { initializeOfficeTransactions } from './core/office-transactions.mjs';

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
    if (action === 'detect') {
      const office = await detectMicrosoftOffice({
        format: args.path ? documentFormat(args.path) : '',
        path: args.path ? fullPath(args.path, cwd) : '',
      });
      return toolResult({
        ok: true,
        microsoftOffice: office,
        portable: {
          ooxml: true,
          pdf: true,
          formats: Object.keys(FILE_KIND_TO_FORMAT),
          pdfSecurity: { available: await qpdfAvailable(), backend: 'qpdf' },
          pdfUnicodeFont: await unicodeFontPath(),
          pdfOcr: await pdfOcrReadiness(dataDir),
        },
        pendingTransactions: await pendingOfficeTransactions(dataDir),
        designLibrary: await inspectOfficeDesignLibrary({ dataDir }),
      });
    }
    if (action === 'transactions') {
      return toolResult({ ok: true, transactions: await pendingOfficeTransactions(dataDir) });
    }
    if (action === 'recover') {
      return toolResult(await recoverOfficeTransaction(args, dataDir));
    }
    if (action === 'secure') {
      const input = fullPath(args.path, cwd);
      if (documentFormat(input) !== 'pdf') throw new Error('secure supports PDF files only');
      const output = fullPath(args.output, cwd);
      const mode = String(args.security || '').toLowerCase();
      if (!['encrypt', 'decrypt'].includes(mode)) throw new Error('secure requires security: encrypt or decrypt');
      await mkdir(dirname(output), { recursive: true });
      return toolResult(
        finalizeOfficeResult(
          await securePdf({
            input,
            output,
            mode,
            password: String(args.password || ''),
            ownerPassword: String(args.ownerPassword || ''),
          }),
          { action, startedAt }
        )
      );
    }
    if (action === 'describe' && !args.session) {
      let format = '';
      if (args.path) format = documentFormat(args.path);
      else if (args.format) format = normalizeOfficeFormat(args.format);
      let backend = '';
      if (format && args.path) {
        const selected = await selectMode(args.mode, format, fullPath(args.path, cwd));
        backend = selected.backend;
      }
      return toolResult(
        describeOfficeCapabilities({
          format,
          backend: backend || String(args.backend || ''),
          target: args.target,
          operation: args.operation,
        })
      );
    }
    if (action === 'author') {
      const authored = await authorPptx(args, { cwd, dataDir, signal });
      const images = Array.isArray(authored?._images) ? authored._images : [];
      delete authored._images;
      const session = authored.session ? sessions.get(authored.session) : null;
      return toolResult(finalizeOfficeResult(authored, { action, session, startedAt }), false, images);
    }
    if (action === 'open' || action === 'attach' || action === 'create') {
      return await openCreateOrAttachOffice({ action, args, cwd, dataDir, signal, startedAt });
    }
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
    let value;
    if (action === 'describe') {
      value = describeOfficeCapabilities({
        format: session.format,
        backend: session.backend,
        target: args.target,
        operation: args.operation,
      });
    } else if (action === 'begin') value = await beginTransaction(session);
    else if (action === 'diff') {
      if (!session.transaction) throw new Error('No active Office transaction to diff');
      const current = await assertTransactionUnchanged(session);
      session.transaction.currentDocument = current.document;
      session.transaction.diff = transactionDocumentDiff(session.transaction, current.document);
      value = {
        ok: true,
        session: session.id,
        transaction: transactionView(session.transaction),
      };
    } else if (action === 'commit') value = await commitTransaction(session);
    else if (action === 'rollback') value = await rollbackTransaction(session);
    else if (action === 'snapshot') value = await snapshot(session, args);
    else if (action === 'get') value = await getOfficeElement(session, args);
    else if (action === 'query') value = await queryOfficeDocument(session, args, cwd, signal);
    else if (action === 'batch') {
      if (args.finalize === true && session.transaction) {
        throw new Error('Commit or roll back the active Office transaction before using batch with finalize:true');
      }
      const batch = await applyBatch(session, {
        ...args,
        __cwd: cwd,
        ...(args.finalize === true ? { save: true } : {}),
      });
      value =
        args.finalize === true
          ? {
              ...(await finalize(
                session,
                {
                  ...args,
                  __alreadySaved: batch.saved === true,
                },
                cwd,
                signal
              )),
              batch,
            }
          : batch;
    } else if (action === 'issues') value = await issues(session, args);
    else if (action === 'qa') value = await qa(session, args, cwd);
    else if (action === 'validate') value = await validate(session, args);
    else if (action === 'render') value = await render(session, args, cwd);
    else if (action === 'save') value = await save(session);
    else if (action === 'finalize') value = await finalize(session, args, cwd, signal);
    else if (action === 'close') value = await closeSession(session, { save: args.save === true, signal });
    else {
      throw new Error(
        `Unsupported Office Use action "${action || '(missing)'}". Use action:"describe" to inspect capabilities.`
      );
    }
    if (implicit && action !== 'close') value.implicitSession = true;
    const images = Array.isArray(value?._images) ? value._images : [];
    if (value && typeof value === 'object') delete value._images;
    finalizeOfficeResult(value, { action, session, startedAt });
    if (activeSession) delete activeSession.activeSignal;
    return toolResult(value, false, images);
  } catch (error) {
    if (activeSession) delete activeSession.activeSignal;
    if (error instanceof OfficeConflictError) return toolResult(error.details, true);
    if (signal?.aborted || /cancelled/i.test(String(error?.message || ''))) {
      if (activeSession && isMicrosoftOfficeSession(activeSession)) {
        sessions.delete(activeSession.id);
        if (documentSessions.get(documentSessionKey(activeSession.target)) === activeSession.id) {
          documentSessions.delete(documentSessionKey(activeSession.target));
        }
      }
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
  }
}

export function resetOfficeSessionsForTest() {
  resetMicrosoftOfficeSessionsForTest();
  sessions.clear();
  documentSessions.clear();
}
