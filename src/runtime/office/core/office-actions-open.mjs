import { rm } from 'node:fs/promises';
import { closeMicrosoftOfficeSession } from '../com/com-adapter.mjs';
import { applyBatch } from './office-actions-batch.mjs';
import { finalize } from './office-actions-lifecycle.mjs';
import {
  documentSessionKey,
  documentSessions,
  ensureOfficeSessionDesign,
  finalizeOfficeResult,
  isMicrosoftOfficeSession,
  sessions,
  toolResult,
} from './office-core.mjs';
import { createSession, openSession, snapshot } from './office-sessions.mjs';

function initialOfficeOperations(args) {
  if (Array.isArray(args.operations) && args.operations.length) return args.operations;
  return Array.isArray(args.design?.operations) ? args.design.operations : [];
}

async function discardFailedOfficeSession(session, { action, initialEditSettled }) {
  if (session.reused) return;
  if (isMicrosoftOfficeSession(session)) await closeMicrosoftOfficeSession(session.id).catch(() => {});
  sessions.delete(session.id);
  if (documentSessions.get(documentSessionKey(session.target)) === session.id) {
    documentSessions.delete(documentSessionKey(session.target));
  }
  // A create whose own operations failed must not leave the empty file
  // it just wrote: the obvious retry would hit "target already exists"
  // and the caller would be stuck choosing between overwrite and delete.
  // Only a file this call brought into being is removed.
  if (action === 'create' && session.createdNewFile === true && !initialEditSettled) {
    await rm(session.target, { force: true }).catch(() => {});
  }
}

function openedOfficeIdentity(session, action, extra = {}) {
  return {
    opened: true,
    created: action === 'create',
    reused: session.reused === true,
    ...(session.createReceipt || {}),
    ...extra,
  };
}

/** create / open / attach share one path: bind a session, optionally apply
 *  the operations this call named, then snapshot or finalize. */
export async function openCreateOrAttachOffice({ action, args, cwd, dataDir, signal, startedAt }) {
  if (action === 'attach' && args.finalize === true) {
    throw new Error('attach does not support finalize:true; attach first, then use batch with finalize:true when closing the document is intended');
  }
  const operationArgs = signal ? { ...args, __signal: signal } : args;
  const session = action === 'create'
    ? await createSession(operationArgs, cwd, dataDir)
    : await openSession(action === 'attach' ? { ...operationArgs, mode: 'attach' } : operationArgs, cwd, dataDir);
  await ensureOfficeSessionDesign(session, args, dataDir, { created: session.created === true });
  session.activeSignal = signal;
  let initialEditSettled = false;
  const initialOperations = initialOfficeOperations(args);
  try {
    const initialEdit = initialOperations.length
      ? await applyBatch(session, {
          ...args,
          operations: initialOperations,
          __cwd: cwd,
          ...(args.finalize === true ? { save: true } : {}),
        })
      : null;
    initialEditSettled = true;
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
          ...openedOfficeIdentity(session, action, initialEdit ? { batch: initialEdit } : {}),
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
        ...openedOfficeIdentity(session, action, {
          foregroundActivated: session.foregroundActivated === true,
          backgroundIsolation: initialEdit?.backgroundIsolation || session.backgroundIsolation || null,
        }),
      },
      { action, session, startedAt },
    ));
  } catch (error) {
    delete session.activeSignal;
    await discardFailedOfficeSession(session, { action, initialEditSettled });
    throw error;
  }
}
