import { recalculateLibreOfficeWorkbook } from '../portable/portable-ooxml.mjs';

/** A recalculation can change the file without a batch. Never acknowledge the
 *  pre-recalculation pixels, and never rewrite a successfully calculated version. */
export async function recalculateForReview(session, signal, calculate = recalculateLibreOfficeWorkbook) {
  if (session.backend !== 'mixdog-ooxml' || session.format !== 'xlsx') return null;
  const version = Number(session.snapshotVersion || 0);
  if (session.recalculationCache?.version === version) return session.recalculationCache.result;
  const result = await calculate(session.target, { force: version > 0, signal });
  if (result?.recalculated) {
    session.renderCache = null;
    session.designState ||= {};
    session.designState.renderedVersion = null;
    session.designState.reviewToken = '';
  }
  if (!result?.needed || result.recalculated) session.recalculationCache = { version, result };
  return result;
}
