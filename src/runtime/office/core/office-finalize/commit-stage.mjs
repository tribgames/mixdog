// The commit stage of finalize: persist the file (or reuse the batch that
// already saved it), run the post-save validation, then close the session and
// record the composition history for a newly created document.
import { summarizeOfficeCompositions } from '../../design/composition-system.mjs';
import { recordOfficeCompositionHistory } from '../../design/library/design-library.mjs';
import { isMicrosoftOfficeSession } from '../office-core.mjs';
import { validate } from '../office-actions-inspect.mjs';
import { closeSession, save } from './session-save.mjs';

export function saveForFinalize(session, args, reviewed) {
  const reuseSavedBatch = args.__alreadySaved === true && Number(reviewed?.fixesApplied || 0) === 0;
  if (reuseSavedBatch) {
    return {
      ok: true,
      session: session.id,
      saved: true,
      skipped: true,
      path: session.target,
    };
  }
  return save(session);
}

export function validateForFinalize(session, args) {
  return validate(session, {
    ...args,
    __postSave: isMicrosoftOfficeSession(session) && session.mode === 'background',
    __skipNative: false,
    __skipNativeIssues: false,
  });
}

export async function closeForFinalize(session, signal, { timedStep }) {
  const composition = summarizeOfficeCompositions(session.format, session.designState?.compositions || []);
  const closed = await timedStep('close', async () => await closeSession(session, { save: false, signal }));
  let compositionHistory = null;
  let compositionHistoryWarning = '';
  if (session.created && composition.fingerprint) {
    try {
      compositionHistory = await recordOfficeCompositionHistory(session.dataDir, {
        documentPath: session.target,
        format: session.format,
        profile: session.design?.profile,
        purpose: session.design?.purpose,
        expressionMode: session.design?.expressionMode,
        fingerprint: composition.fingerprint,
        compositionIds: composition.compositionIds,
      });
    } catch (error) {
      compositionHistoryWarning = error?.message || String(error);
    }
  }
  return { composition, closed, compositionHistory, compositionHistoryWarning };
}
