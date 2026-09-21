// Save and close for one Office session: Microsoft Office sessions go through
// the COM adapter, portable sessions persist through the snapshot already on
// disk. Both refuse while a transaction is open.
import { callMicrosoftOffice, closeMicrosoftOfficeSession } from '../../com/com-adapter.mjs';
import { isMicrosoftOfficeSession, releaseOfficeSession } from '../office-core.mjs';

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
  let unconfirmed = '';
  if (isMicrosoftOfficeSession(session)) {
    const closed = await closeMicrosoftOfficeSession(session.id, { save: shouldSave, signal });
    // A session whose application already died cannot be closed through it.
    // Release the record anyway and say the cleanup was not confirmed; refusing
    // would leave the session unusable and unclosable for the rest of the run.
    if (!closed.ok && !closed.reaped) throw new Error(closed.error || 'Microsoft Office session close failed');
    cleanup = closed.cleanup || null;
    if (!closed.ok) unconfirmed = closed.error || 'Microsoft Office application was already gone.';
  } else if (shouldSave) {
    await save(session);
  }
  releaseOfficeSession(session);
  return {
    ok: true,
    session: session.id,
    closed: true,
    path: session.target,
    ownership: session.ownership,
    ...(cleanup ? { cleanup } : {}),
    ...(unconfirmed ? { reaped: true, warning: unconfirmed } : {}),
  };
}
