// The repairs QA may apply on its own: one fit operation per audited layout
// issue, deduplicated by target.

// The fit repairs (fit_table, autofit_range, fit_text) exist on both the
// Microsoft Office and the portable OOXML backends; tabular and PDF sessions
// have no such operations.
const FIXABLE_BACKENDS = new Set(['microsoft-office-com', 'mixdog-ooxml']);

function fixOperationFor(session, issue) {
  if (session.format === 'docx' && ['table_width', 'table_wider_than_page'].includes(issue.code)) {
    // The audit names the table as /body/table[N] and asks for fit_table; the
    // repair looked for a code and a path shape the audit never emits, so a
    // table running off the page was reported and then left alone.
    const table = Number(/^\/body\/(?:tbl|table)\[(\d+)]$/.exec(String(issue.path || ''))?.[1]);
    return table ? { op: 'fit_table', table } : null;
  }
  if (session.format === 'xlsx' && ['cell_overflow', 'column_too_narrow', 'label_truncated'].includes(issue.code)) {
    // What the audit itself prescribes for a value shown as ### or a label cut
    // at its column edge: widen that column. Keyed to the column, so one sheet
    // with fifty cut cells is repaired once.
    const match = /^\/sheet\[([^\]]+)]\/cell\[([A-Z]+)(\d+)]$/i.exec(String(issue.path || ''));
    if (!match) return null;
    const column = match[2].toUpperCase();
    return { op: 'autofit_range', sheet: match[1], range: `${column}:${column}` };
  }
  // fit_text draws the box back inside the slide and fits its text there, for either backend's name of the fault.
  const textFaults = ['text_overflow', 'text_outside_slide', 'shape_out_of_bounds'];
  if (session.format === 'pptx' && textFaults.includes(issue.code)) {
    const match = /^\/slide\[(\d+)]\/shape\[(\d+)]$/.exec(String(issue.path || ''));
    return match ? { op: 'fit_text', slide: Number(match[1]), shape: Number(match[2]), minFontSize: 8 } : null;
  }
  return null;
}

export function qaFixOperations(session, issueList) {
  if (!FIXABLE_BACKENDS.has(session.backend)) return [];
  const operations = [];
  const seen = new Set();
  for (const issue of issueList || []) {
    const found = fixOperationFor(session, issue);
    if (!found) continue;
    // A repair that finds nothing to change is not a failed review: without it one no-op fit_text failed the batch
    // and qa returned an error in place of its findings.
    const operation = { ...found, allowNoChange: true };
    const key = JSON.stringify(operation);
    if (!seen.has(key)) {
      seen.add(key);
      operations.push(operation);
    }
  }
  return operations;
}
