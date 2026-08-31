import { copyFile, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { callMicrosoftOffice, detectMicrosoftOffice, openMicrosoftOfficeSession } from './com-adapter.mjs';
import { defaultOfficeDataDir, listOfficeJournals, readOfficeJournal, removeOfficeJournal, writeOfficeJournal } from './journal.mjs';
import { OfficeConflictError, documentFingerprint, documentSessionKey, documentSessions, isInteractiveOfficeSession, isMicrosoftOfficeSession, sessions } from './office-core.mjs';
import { diffDocuments, documentSnapshotFingerprint, operationChangeKind, operationDocumentPaths } from './office-documents.mjs';
import { exists, snapshot } from './office-sessions.mjs';

export function recordTransactionOperations(transaction, format, operations, results) {
  const changes = new Map((transaction.operationChanges || []).map((change) => [change.path, change]));
  operations.forEach((operation, index) => {
    const result = results?.[index] || {};
    if (result.changed === false) return;
    const kind = operationChangeKind(operation);
    for (const path of operationDocumentPaths(format, operation, result)) {
      const previous = changes.get(path);
      changes.set(path, {
        path,
        kind: previous?.kind === 'added' && kind === 'modified' ? 'added' : kind,
        operation: String(operation.op || ''),
      });
    }
  });
  transaction.operationChanges = [...changes.values()];
}


function mergeTransactionDiff(diff, operationChanges, limit = 500) {
  const merged = {
    summary: { ...diff.summary },
    changes: [...diff.changes],
    truncated: diff.truncated,
  };
  const known = new Set(merged.changes.map((change) => change.path));
  for (const change of operationChanges || []) {
    if (known.has(change.path)) continue;
    merged.summary[change.kind] += 1;
    merged.summary.total += 1;
    if (merged.changes.length < limit) {
      merged.changes.push({
        path: change.path,
        kind: change.kind,
        before: change.kind === 'added' ? null : { state: 'captured by transaction checkpoint' },
        after: change.kind === 'removed' ? null : { operation: change.operation },
      });
      known.add(change.path);
    } else {
      merged.truncated = true;
    }
  }
  return merged;
}


export function transactionDocumentDiff(transaction, currentDocument) {
  return mergeTransactionDiff(
    diffDocuments(transaction.beforeDocument, currentDocument),
    transaction.operationChanges,
  );
}


function transactionCheckpointPath(session) {
  return join(tmpdir(), `mixdog-office-transaction-${session.id}-${randomUUID()}${extname(session.target)}`);
}


export async function captureSessionState(session, checkpoint = '') {
  let fingerprintPath = session.target;
  let document;
  if (isMicrosoftOfficeSession(session)) {
    const needsFileCopy = ['xlsx', 'pptx'].includes(session.format);
    const temporaryCheckpoint = !checkpoint && needsFileCopy ? transactionCheckpointPath(session) : '';
    const snapshotPath = checkpoint || temporaryCheckpoint;
    const result = await callMicrosoftOffice({
      action: snapshotPath ? 'checkpoint' : 'snapshot',
      session: session.id,
      format: session.format,
      mode: session.mode,
      path: session.target,
      ...(snapshotPath ? { output: snapshotPath } : {}),
    }, { signal: session.activeSignal || null });
    if (!result.ok) throw new Error(result.error || `Microsoft Office ${snapshotPath ? 'checkpoint' : 'snapshot'} failed`);
    try {
      document = result.value;
      const fileBackedFingerprint = ['xlsx', 'pptx'].includes(session.format);
      const fingerprint = fileBackedFingerprint
        ? await documentFingerprint(snapshotPath || session.target, session.format)
        : documentSnapshotFingerprint(document);
      return { fingerprint, document, checkpoint: checkpoint || '' };
    } finally {
      if (temporaryCheckpoint) await rm(temporaryCheckpoint, { force: true }).catch(() => {});
    }
  } else {
    if (checkpoint) await copyFile(session.target, checkpoint);
    const current = await snapshot(session, { maxChars: 100_000 }, { full: true });
    document = current.document;
    fingerprintPath = checkpoint || session.target;
  }
  return {
    fingerprint: await documentFingerprint(fingerprintPath, session.format),
    document,
    checkpoint: checkpoint || '',
  };
}


export function transactionView(transaction, diff = transaction.diff) {
  return {
    id: transaction.id,
    startedAt: transaction.startedAt,
    conflict: false,
    undoUnits: transaction.undoUnits,
    diff,
  };
}


function officeJournalRecord(session) {
  const transaction = session.transaction;
  return {
    version: 1,
    id: transaction.id,
    startedAt: transaction.startedAt,
    updatedAt: new Date().toISOString(),
    phase: transaction.phase || 'active',
    checkpoint: transaction.checkpoint,
    baselinePdf: transaction.baselinePdf || '',
    session: {
      id: session.id,
      source: session.source,
      target: session.target,
      format: session.format,
      mode: session.mode,
      backend: session.backend,
      created: session.created === true,
      openedAt: session.openedAt,
      dataDir: session.dataDir,
    },
    transaction: {
      id: transaction.id,
      startedAt: transaction.startedAt,
      checkpoint: transaction.checkpoint,
      baselinePdf: transaction.baselinePdf || '',
      beforeFingerprint: transaction.beforeFingerprint,
      expectedFingerprint: transaction.expectedFingerprint,
      beforeDocument: transaction.beforeDocument,
      currentDocument: transaction.currentDocument,
      operationChanges: transaction.operationChanges || [],
      undoUnits: transaction.undoUnits,
      diff: transaction.diff,
      phase: transaction.phase || 'active',
      review: transaction.review || null,
    },
  };
}


export async function persistOfficeTransaction(session) {
  if (!session.transaction) return;
  const record = officeJournalRecord(session);
  session.transaction.journalPath = await writeOfficeJournal(record, session.dataDir);
}


async function clearOfficeTransactionArtifacts(session, transaction) {
  await removeOfficeJournal(transaction.id, session.dataDir).catch(() => {});
  await rm(transaction.checkpoint, { force: true }).catch(() => {});
  if (transaction.baselinePdf) await rm(transaction.baselinePdf, { force: true }).catch(() => {});
}


function officeJournalSummary(record) {
  const transaction = record.transaction || {};
  const session = record.session || {};
  return {
    id: record.id,
    phase: record.phase || transaction.phase || 'active',
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    session: session.id,
    format: session.format,
    mode: session.mode,
    backend: session.backend,
    source: session.source,
    output: session.target,
    checkpoint: record.checkpoint || transaction.checkpoint || '',
    baselinePdf: record.baselinePdf || transaction.baselinePdf || '',
    diff: transaction.diff || null,
    review: transaction.review || null,
  };
}


export async function assertTransactionUnchanged(session) {
  const transaction = session.transaction;
  if (!transaction) return null;
  const current = await captureSessionState(session);
  if (current.fingerprint !== transaction.expectedFingerprint) {
    throw new OfficeConflictError({
      ok: false,
      code: 'transaction_conflict',
      session: session.id,
      format: session.format,
      transaction: transaction.id,
      expectedFingerprint: transaction.expectedFingerprint,
      actualFingerprint: current.fingerprint,
      externalDiff: diffDocuments(transaction.currentDocument, current.document),
      message: 'The document changed outside Mixdog after the last transaction operation. Commit and rollback are blocked to avoid overwriting user edits.',
    });
  }
  return current;
}


export async function beginTransaction(session) {
  if (session.transaction) throw new Error(`Office transaction already active: ${session.transaction.id}`);
  const checkpoint = transactionCheckpointPath(session);
  const state = await captureSessionState(session, checkpoint);
  let baselinePdf = '';
  if (isMicrosoftOfficeSession(session) && isInteractiveOfficeSession(session) && session.format === 'docx') {
    baselinePdf = join(tmpdir(), `mixdog-office-transaction-${session.id}-${randomUUID()}-before.pdf`);
    const rendered = await callMicrosoftOffice({
      action: 'render',
      session: session.id,
      format: session.format,
      mode: session.mode,
      path: session.target,
      output: baselinePdf,
    }, { signal: session.activeSignal || null });
    if (!rendered.ok) baselinePdf = '';
  }
  const transaction = {
    id: `office_tx_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    startedAt: new Date().toISOString(),
    checkpoint,
    baselinePdf,
    beforeFingerprint: state.fingerprint,
    expectedFingerprint: state.fingerprint,
    beforeDocument: state.document,
    currentDocument: state.document,
    operationChanges: [],
    undoUnits: 0,
    diff: diffDocuments(state.document, state.document),
    phase: 'active',
    review: null,
  };
  session.transaction = transaction;
  try {
    await persistOfficeTransaction(session);
  } catch (error) {
    session.transaction = null;
    await rm(checkpoint, { force: true }).catch(() => {});
    throw error;
  }
  return {
    ok: true,
    session: session.id,
    mode: session.mode,
    backend: session.backend,
    transaction: transactionView(transaction),
  };
}


export async function commitTransaction(session) {
  if (!session.transaction) throw new Error('No active Office transaction to commit');
  const transaction = session.transaction;
  const current = await assertTransactionUnchanged(session);
  transaction.diff = transactionDocumentDiff(transaction, current.document);
  transaction.currentDocument = current.document;
  transaction.phase = 'committing';
  await persistOfficeTransaction(session);
  session.transaction = null;
  session.snapshotVersion = Number(session.snapshotVersion || 0) + 1;
  await clearOfficeTransactionArtifacts(session, transaction);
  return {
    ok: true,
    session: session.id,
    mode: session.mode,
    backend: session.backend,
    committed: true,
    saved: !isInteractiveOfficeSession(session),
    transaction: transactionView(transaction),
  };
}


export async function rollbackTransaction(session) {
  if (!session.transaction) throw new Error('No active Office transaction to roll back');
  const transaction = session.transaction;
  const current = await assertTransactionUnchanged(session);
  transaction.currentDocument = current.document;
  transaction.diff = transactionDocumentDiff(transaction, current.document);
  transaction.phase = 'rolling_back';
  await persistOfficeTransaction(session);
  if (isMicrosoftOfficeSession(session)) {
    const result = await callMicrosoftOffice({
      action: 'rollback',
      session: session.id,
      format: session.format,
      mode: session.mode,
      path: session.target,
      checkpoint: transaction.checkpoint,
      undoUnits: transaction.undoUnits,
    }, { signal: session.activeSignal || null });
    if (!result.ok) throw new Error(result.error || 'Microsoft Office rollback failed');
  } else {
    await copyFile(transaction.checkpoint, session.target);
  }
  const restored = await captureSessionState(session);
  const remainingDiff = diffDocuments(transaction.beforeDocument, restored.document);
  const fingerprintRestored = restored.fingerprint === transaction.beforeFingerprint;
  if (remainingDiff.summary.total > 0) {
    throw new Error(`Office rollback verification failed: fingerprintRestored=${fingerprintRestored}; diff=${JSON.stringify(remainingDiff)}`);
  }
  session.transaction = null;
  await clearOfficeTransactionArtifacts(session, transaction);
  return {
    ok: true,
    session: session.id,
    mode: session.mode,
    backend: session.backend,
    rolledBack: true,
    fingerprintRestored,
    fingerprintDrift: !fingerprintRestored,
    remainingDiff,
    transaction: transactionView(transaction, diffDocuments(transaction.beforeDocument, transaction.currentDocument)),
  };
}


export async function pendingOfficeTransactions(dataDir) {
  return (await listOfficeJournals(dataDir)).map(officeJournalSummary);
}


export async function initializeOfficeTransactions(dataDir = defaultOfficeDataDir()) {
  return await pendingOfficeTransactions(dataDir);
}


export async function recoverOfficeTransaction(args, dataDir) {
  const id = String(args.transaction || '').trim();
  if (!id) throw new Error('recover requires transaction');
  const strategy = String(args.strategy || '').toLowerCase();
  if (!['commit', 'rollback', 'discard'].includes(strategy)) {
    throw new Error('recover requires strategy: commit, rollback, or discard');
  }
  const record = await readOfficeJournal(id, dataDir);
  if (!record) throw new Error(`Office transaction journal not found: ${id}`);
  const savedSession = record.session || {};
  const savedTransaction = record.transaction || {};
  const session = sessions.get(savedSession.id) || {
    ...savedSession,
    dataDir: savedSession.dataDir || dataDir,
  };
  session.transaction = {
    ...savedTransaction,
    id,
    checkpoint: savedTransaction.checkpoint || record.checkpoint || '',
    baselinePdf: savedTransaction.baselinePdf || record.baselinePdf || '',
    phase: record.phase || savedTransaction.phase || 'active',
  };
  if (strategy === 'discard') {
    session.transaction = null;
    await clearOfficeTransactionArtifacts(session, savedTransaction);
    sessions.delete(savedSession.id);
    return { ok: true, recovered: true, discarded: true, transaction: id };
  }
  if (isInteractiveOfficeSession(savedSession)) {
    const detected = await detectMicrosoftOffice({
      format: savedSession.format,
      path: savedSession.target,
    });
    const application = detected.applications?.find((item) => item.format === savedSession.format);
    if (!application?.documentOpen) {
      if (strategy === 'commit') {
        session.transaction = null;
        await clearOfficeTransactionArtifacts(session, savedTransaction);
        return {
          ok: true,
          recovered: true,
          committed: true,
          transaction: id,
          documentOpen: false,
          message: 'The live Office document is no longer open; the journal was finalized without modifying disk.',
        };
      }
      return {
        ok: false,
        code: 'live_document_not_open',
        transaction: id,
        recoverable: false,
        message: 'Reopen the exact document in Microsoft Office before rolling back this transaction.',
      };
    }
  } else if (!await exists(savedSession.target)) {
    return {
      ok: false,
      code: 'document_missing',
      transaction: id,
      recoverable: false,
      path: savedSession.target,
    };
  }
  if (isMicrosoftOfficeSession(session)) {
    const reopened = await openMicrosoftOfficeSession({
      session: session.id,
      format: session.format,
      mode: isInteractiveOfficeSession(session) ? 'attach' : 'background',
      path: session.target,
    });
    if (!reopened.ok) throw new Error(reopened.error || 'Unable to restore Microsoft Office session');
    Object.assign(session, {
      mode: reopened.mode,
      ownership: reopened.ownership,
      visible: reopened.visible,
      appPid: reopened.appPid,
      windowHwnd: reopened.windowHwnd,
      foregroundActivated: reopened.foregroundActivated === true,
      documentId: reopened.documentId,
    });
  }
  sessions.set(session.id, session);
  documentSessions.set(documentSessionKey(session.target), session.id);
  return strategy === 'commit'
    ? await commitTransaction(session)
    : await rollbackTransaction(session);
}
