/**
 * office-session-dispatch.mjs — one resolved session, one action: the
 * transaction verbs (begin/diff/commit/rollback), the read verbs
 * (snapshot/get/query/issues/validate/render/describe) and the write verbs
 * (batch/qa/save/finalize/close). Session resolution, design hydration and
 * result finalization stay with the caller.
 */
import { describeOfficeCapabilities } from '../capabilities.mjs';
import { applyBatch, closeSession, finalize, issues, qa, render, save, validate } from './office-actions.mjs';
import { getOfficeElement, queryOfficeDocument } from './office-actions-read.mjs';
import { snapshot } from './office-sessions.mjs';
import {
  assertTransactionUnchanged,
  beginTransaction,
  commitTransaction,
  rollbackTransaction,
  transactionDocumentDiff,
  transactionView,
} from './office-transactions.mjs';

async function diffTransaction(session) {
  if (!session.transaction) throw new Error('No active Office transaction to diff');
  const current = await assertTransactionUnchanged(session);
  session.transaction.currentDocument = current.document;
  session.transaction.diff = transactionDocumentDiff(session.transaction, current.document);
  return {
    ok: true,
    session: session.id,
    transaction: transactionView(session.transaction),
  };
}

// batch with finalize:true is one action: the batch runs with save forced on,
// and finalize is told the save already happened so it does not repeat it.
async function batchAction(session, args, cwd, signal) {
  if (args.finalize === true && session.transaction) {
    throw new Error('Commit or roll back the active Office transaction before using batch with finalize:true');
  }
  const batch = await applyBatch(session, {
    ...args,
    __cwd: cwd,
    ...(args.finalize === true ? { save: true } : {}),
  });
  if (args.finalize !== true) return batch;
  return {
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
  };
}

export async function dispatchOfficeSessionAction({ action, session, args, cwd, signal }) {
  if (action === 'describe') {
    return describeOfficeCapabilities({
      format: session.format,
      backend: session.backend,
      target: args.target,
      operation: args.operation,
    });
  }
  if (action === 'begin') return await beginTransaction(session);
  if (action === 'diff') return await diffTransaction(session);
  if (action === 'commit') return await commitTransaction(session);
  if (action === 'rollback') return await rollbackTransaction(session);
  if (action === 'snapshot') return await snapshot(session, args);
  if (action === 'get') return await getOfficeElement(session, args);
  if (action === 'query') return await queryOfficeDocument(session, args, cwd, signal);
  if (action === 'batch') return await batchAction(session, args, cwd, signal);
  if (action === 'issues') return await issues(session, args);
  if (action === 'qa') return await qa(session, args, cwd);
  if (action === 'validate') return await validate(session, args);
  if (action === 'render') return await render(session, args, cwd);
  if (action === 'save') return await save(session);
  if (action === 'finalize') return await finalize(session, args, cwd, signal);
  if (action === 'close') return await closeSession(session, { save: args.save === true, signal });
  throw new Error(
    `Unsupported Office Use action "${action || '(missing)'}". Use action:"describe" to inspect capabilities.`
  );
}
