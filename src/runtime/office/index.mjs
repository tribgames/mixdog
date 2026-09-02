import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { closeMicrosoftOfficeSession, detectMicrosoftOffice, resetMicrosoftOfficeSessionsForTest } from './com/com-adapter.mjs';
import { extractPdfImages, extractPdfTextLayout, inferPdfTables } from './pdf/pdf-analysis.mjs';
import { describeOfficeCapabilities } from './capabilities.mjs';
import { qpdfAvailable, securePdf } from './pdf/pdf-security.mjs';
import { defaultOfficeDataDir } from './core/journal.mjs';
import { resolveOfficeDesign } from './design/design-system.mjs';
import { inspectOfficeDesignLibrary, persistOfficeDesignBinding } from './design/library/design-library.mjs';
import { applyBatch, closeSession, finalize, issues, qa, render, save, validate } from './core/office-actions.mjs';
import { compilePptxCandidate, previewPptxCandidates, resetOfficeCandidatePreviewsForTest } from './core/office-candidate-actions.mjs';
import { FILE_KIND_TO_FORMAT, OfficeConflictError, documentFormat, documentSessionKey, documentSessions, finalizeOfficeResult, isMicrosoftOfficeSession, mergeOfficeDesignRequest, normalizeOfficeFormat, resolveOfficeDesignContext, sessions, toolResult } from './core/office-core.mjs';
import { createSession, findByDocumentPath, fullPath, openSession, queryObject, resolveSession, selectMode, snapshot, snapshotSelectionForTarget } from './core/office-sessions.mjs';
import { assertTransactionUnchanged, beginTransaction, commitTransaction, pendingOfficeTransactions, recoverOfficeTransaction, rollbackTransaction, transactionDocumentDiff, transactionView } from './core/office-transactions.mjs';

export { initializeOfficeTransactions } from './core/office-transactions.mjs';

export async function executeOfficeTool(args = {}, {
  cwd = process.cwd(),
  dataDir = defaultOfficeDataDir(),
  signal = null,
} = {}) {
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
      return toolResult(finalizeOfficeResult(await securePdf({
        input,
        output,
        mode,
        password: String(args.password || ''),
        ownerPassword: String(args.ownerPassword || ''),
      }), { action, startedAt }));
    }
    if (action === 'describe' && !args.session) {
      const format = args.path ? documentFormat(args.path) : (args.format ? normalizeOfficeFormat(args.format) : '');
      let backend = '';
      if (format && args.path) {
        const selected = await selectMode(args.mode, format, fullPath(args.path, cwd));
        backend = selected.backend;
      }
      return toolResult(describeOfficeCapabilities({
        format,
        backend: backend || String(args.backend || ''),
        target: args.target,
        operation: args.operation,
      }));
    }
    if (action === 'open' || action === 'attach' || action === 'create') {
      if (action === 'attach' && args.finalize === true) {
        throw new Error('attach does not support finalize:true; attach first, then use batch with finalize:true when closing the document is intended');
      }
      const operationArgs = signal ? { ...args, __signal: signal } : args;
      const session = action === 'create'
        ? await createSession(operationArgs, cwd, dataDir)
        : await openSession(action === 'attach' ? { ...operationArgs, mode: 'attach' } : operationArgs, cwd, dataDir);
      if (!session.design) {
        const designContext = await resolveOfficeDesignContext({
          args,
          dataDir,
          target: session.target,
          source: session.source,
          format: session.format,
          created: session.created === true,
        });
        Object.assign(session, designContext);
        session.designState = {
          renderedVersion: null,
          semanticCount: 0,
          requiresVisualReview: false,
          slidePlans: [],
          compositions: [],
        };
      } else if (args.design) {
        session.designRequest = mergeOfficeDesignRequest(session.designRequest, args.design);
        session.design = resolveOfficeDesign(session.format, session.designRequest, { library: session.designLibrary });
      }
      session.activeSignal = signal;
      try {
        const initialEdit = Array.isArray(args.operations) && args.operations.length
          ? await applyBatch(session, {
              ...args,
              __cwd: cwd,
              ...(args.finalize === true ? { save: true } : {}),
            })
          : null;
        if (args.finalize === true) {
          const completed = await finalize(session, {
            ...args,
            __alreadySaved: initialEdit?.saved === true,
          }, cwd, signal);
          const images = Array.isArray(completed?._images) ? completed._images : [];
          if (completed && typeof completed === 'object') delete completed._images;
          delete session.activeSignal;
          return toolResult(finalizeOfficeResult(
            {
              ...completed,
              opened: true,
              created: action === 'create',
              reused: session.reused === true,
              ...(initialEdit ? { batch: initialEdit } : {}),
            },
            { action, session, startedAt },
          ), false, images);
        }
        const initial = args.snapshotAfter === false || (initialEdit && args.snapshotAfter !== true)
          ? {
              session: session.id,
              mode: session.mode,
              backend: session.backend,
              fileKind: session.fileKind,
              source: session.source,
              output: session.target,
              ownership: session.ownership,
              visible: session.visible,
              appPid: session.appPid,
              windowHwnd: session.windowHwnd,
              foregroundActivated: session.foregroundActivated === true,
              backgroundIsolation: session.backgroundIsolation || null,
              documentId: session.documentId,
              batch: initialEdit,
            }
          : {
              ...await snapshot(session, args),
              ...(initialEdit ? { batch: initialEdit } : {}),
            };
        delete session.activeSignal;
        return toolResult(finalizeOfficeResult(
          {
            ...initial,
            opened: true,
            created: action === 'create',
            reused: session.reused === true,
            foregroundActivated: session.foregroundActivated === true,
            backgroundIsolation: initialEdit?.backgroundIsolation || session.backgroundIsolation || null,
          },
          { action, session, startedAt },
        ));
      } catch (error) {
        delete session.activeSignal;
        if (!session.reused) {
          if (isMicrosoftOfficeSession(session)) await closeMicrosoftOfficeSession(session.id).catch(() => {});
          sessions.delete(session.id);
          if (documentSessions.get(documentSessionKey(session.target)) === session.id) {
            documentSessions.delete(documentSessionKey(session.target));
          }
        }
        throw error;
      }
    }
    const { session, implicit } = await resolveSession(signal ? { ...args, __signal: signal } : args, cwd, dataDir);
    if (!session.design) {
      const designContext = await resolveOfficeDesignContext({
        args,
        dataDir,
        target: session.target,
        source: session.source,
        format: session.format,
        created: session.created === true,
      });
      Object.assign(session, designContext);
      session.designState = {
        renderedVersion: null,
        semanticCount: 0,
        requiresVisualReview: false,
        slidePlans: [],
        compositions: [],
      };
    } else if (args.design) {
      if (args.design.upgradeLibrary === true) {
        const upgraded = await resolveOfficeDesignContext({
          args,
          dataDir,
          target: session.target,
          source: session.source,
          format: session.format,
          created: false,
        });
        session.designLibrary = upgraded.designLibrary;
        await persistOfficeDesignBinding(dataDir, session.target, session.designLibrary.binding);
      }
      session.designRequest = mergeOfficeDesignRequest(session.designRequest, args.design);
      session.design = resolveOfficeDesign(session.format, session.designRequest, { library: session.designLibrary });
    }
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
    }
    else if (action === 'begin') value = await beginTransaction(session);
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
    else if (action === 'get') {
      const target = String(args.target || '').trim();
      if (!target) throw new Error('get requires target');
      const selection = snapshotSelectionForTarget(session.format, target);
      const current = await snapshot(session, { ...args, ...selection, target, limit: 1, maxChars: 100_000 });
      const element = findByDocumentPath(current.document, target);
      if (!element) throw new Error(`Document element not found: ${target}`);
      value = { session: session.id, target, element };
    } else if (action === 'query') {
      const queryKind = String(args.queryKind || 'text').toLowerCase();
      if (queryKind !== 'text') {
        if (session.format !== 'pdf') throw new Error(`${queryKind} query is supported for PDF sessions only`);
        if (queryKind === 'pdf-layout') {
          value = {
            session: session.id,
            queryKind,
            ...(await extractPdfTextLayout(session.target, {
              pages: args.pages,
              maxItems: args.limit || 10_000,
              signal,
            })),
          };
        } else if (queryKind === 'pdf-tables') {
          const layout = await extractPdfTextLayout(session.target, {
            pages: args.pages,
            maxItems: args.limit || 10_000,
            signal,
          });
          value = { session: session.id, queryKind, ...inferPdfTables(layout) };
        } else if (queryKind === 'pdf-images') {
          value = {
            session: session.id,
            queryKind,
            ...(await extractPdfImages(session.target, { pages: args.pages, signal })),
          };
        } else {
          throw new Error(`Unsupported Office queryKind: ${queryKind}`);
        }
      } else {
      const needle = String(args.query || '').trim().toLowerCase();
      if (!needle) throw new Error('query requires non-empty query text');
      const current = await snapshot(session, { ...args, maxChars: 100_000 }, { full: true });
      value = {
        session: session.id,
        query: args.query,
        matches: queryObject(current.document, needle),
      };
      }
    } else if (action === 'batch') {
      if (args.finalize === true && session.transaction) {
        throw new Error('Commit or roll back the active Office transaction before using batch with finalize:true');
      }
      const batch = await applyBatch(session, {
        ...args,
        __cwd: cwd,
        ...(args.finalize === true ? { save: true } : {}),
      });
      value = args.finalize === true
        ? {
            ...await finalize(session, {
              ...args,
              __alreadySaved: batch.saved === true,
            }, cwd, signal),
            batch,
          }
        : batch;
    }
    else if (action === 'issues') value = await issues(session, args);
    else if (action === 'qa') value = await qa(session, args, cwd);
    else if (action === 'validate') value = await validate(session, args);
    else if (action === 'render') value = await render(session, args, cwd);
    else if (action === 'preview') value = await previewPptxCandidates(session, args, cwd, dataDir, signal);
    else if (action === 'compile') {
      if (args.finalize === true) throw new Error('compile does not support finalize:true; render and visually review the compiled deck first');
      value = await compilePptxCandidate(session, args, cwd);
    }
    else if (action === 'save') value = await save(session);
    else if (action === 'finalize') value = await finalize(session, args, cwd, signal);
    else if (action === 'close') value = await closeSession(session, { save: args.save === true, signal });
    else {
      throw new Error(`Unsupported Office Use action "${action || '(missing)'}". Use action:"describe" to inspect capabilities.`);
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
      return toolResult({ ok: false, code: 'cancelled', message: 'Office Use operation was cancelled' }, true);
    }
    return toolResult(`Error: ${error?.message || String(error)}`, true);
  }
}


export function resetOfficeSessionsForTest() {
  resetMicrosoftOfficeSessionsForTest();
  resetOfficeCandidatePreviewsForTest();
  sessions.clear();
  documentSessions.clear();
}
