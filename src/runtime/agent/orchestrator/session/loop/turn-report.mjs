// The report a finished ask hands its caller (an agent's owner).
//
// A turn's `content` is what the live view still needs at its end: the text
// since the last tool batch. An answer the turn kept going past (a todo
// reminder or queued input arrived after it) and a turn that queued input
// followed in the same ask are both older than that, so the result carries
// them in `reportContent`, ahead of the newest text.

export function joinReports(parts) {
  return parts
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

/** The whole report of a result: `reportContent` when the ask carried earlier
 *  answers, else its content. */
export function turnReportText(result) {
  if (typeof result?.reportContent === 'string') return result.reportContent;
  return typeof result?.content === 'string' ? result.content : '';
}

/** `result` with `earlier` answers ahead of its own report. */
export function withEarlierReport(result, earlier) {
  if (!earlier) return result;
  return { ...result, reportContent: joinReports([earlier, turnReportText(result)]) };
}

/** A turn that fails after such answers still hands them on: `error` carries
 *  them (`carriedReport`, earliest first) to whoever reports the failure. */
export function carryReportOnError(error, earlier) {
  if (!earlier || !error || typeof error !== 'object') return error;
  error.carriedReport = joinReports([earlier, typeof error.carriedReport === 'string' ? error.carriedReport : '']);
  return error;
}
