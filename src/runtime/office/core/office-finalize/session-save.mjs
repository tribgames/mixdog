// Save and close for one Office session: Microsoft Office sessions go through
// the COM adapter, portable sessions persist through the snapshot already on
// disk. Both refuse while a transaction is open.
import { callMicrosoftOffice, closeMicrosoftOfficeSession } from '../../com/com-adapter.mjs';
import { documentSessionKey, documentSessions, isMicrosoftOfficeSession, sessions } from '../office-core.mjs';

export async function save(session) {
  if (session.transaction) throw new Error('Commit or roll back the active Office transaction before saving');
  if (isMicrosoftOfficeSession(session)) {
    const result = await callMicrosoftOffice(
      {
        action: 'save',
        session: session.id,
        format: session.format,
        mode: session.mode,
        path: session.target,
      },
      { signal: session.activeSignal || null }
    );
    if (!result.ok) throw new Error(result.error || 'Microsoft Office save failed');
  }
  return { ok: true, session: session.id, saved: true, path: session.target };
}

export async function closeSession(session, { save: shouldSave = false, signal = null } = {}) {
  if (session.transaction) throw new Error('Commit or roll back the active Office transaction before closing');
  let cleanup = null;
  if (isMicrosoftOfficeSession(session)) {
    const closed = await closeMicrosoftOfficeSession(session.id, { save: shouldSave, signal });
    if (!closed.ok) throw new Error(closed.error || 'Microsoft Office session close failed');
    cleanup = closed.cleanup || null;
  } else if (shouldSave) {
    await save(session);
  }
  sessions.delete(session.id);
  if (documentSessions.get(documentSessionKey(session.target)) === session.id) {
    documentSessions.delete(documentSessionKey(session.target));
  }
  return {
    ok: true,
    session: session.id,
    closed: true,
    path: session.target,
    ownership: session.ownership,
    ...(cleanup ? { cleanup } : {}),
  };
}
