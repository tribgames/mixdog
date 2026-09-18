import { applyPortableOoxmlBatch, recalculatePortableWorkbook } from '../portable/portable-ooxml.mjs';

/** A recalculation can change the file without a batch. Never acknowledge the
 *  pre-recalculation pixels, and never rewrite a successfully calculated version. */
export async function recalculateForReview(session, signal, calculate = recalculatePortableWorkbook) {
  if (session.backend !== 'mixdog-ooxml' || session.format !== 'xlsx') return null;
  const version = Number(session.snapshotVersion || 0);
  if (session.recalculationCache?.version === version) return session.recalculationCache.result;
  const result = await calculate(session.target, { force: version > 0, signal });
  if (result?.recalculated) {
    // A width measured before the values existed fits an empty cell, so the
    // computed column renders as ###. The fit the caller already asked for is
    // repeated now that the numbers are there.
    const ranges = Array.isArray(session.autofitRanges) ? session.autofitRanges : [];
    if (ranges.length) {
      try {
        const refit = await applyPortableOoxmlBatch(
          session.target,
          'xlsx',
          ranges.map((entry) => ({
            op: 'autofit_range',
            ...(entry.sheet ? { sheet: entry.sheet } : {}),
            range: entry.range,
          }))
        );
        result.refittedColumns = refit.reduce((total, entry) => total + Number(entry.columns || 0), 0);
      } catch (error) {
        result.refitError = String(error?.message || error);
      }
    }
    session.renderCache = null;
    session.designState ||= {};
    session.designState.renderedVersion = null;
    session.designState.reviewToken = '';
  }
  if (!result?.needed || result.recalculated) session.recalculationCache = { version, result };
  return result;
}
