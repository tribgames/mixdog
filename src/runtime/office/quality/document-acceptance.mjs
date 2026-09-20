/** The review verdict ladder shared by document and presentation acceptance. */
export function reviewStatus(reviewed, complete, acknowledged) {
  if (!reviewed) return 'not-reviewed';
  if (!complete) return 'needs-work';
  return acknowledged ? 'accepted' : 'not-acknowledged';
}

// Rendering produces evidence, not an approval. Checks differ by document medium.
export const DOCUMENT_VISUAL_CHECKS = Object.freeze({
  docx: ['hierarchy', 'pagination', 'legibility'],
  xlsx: ['sheetReadability', 'chartVisibility', 'printLayout'],
  pdf: ['legibility', 'clipping', 'readingOrder'],
});

export function reviewDocumentPages(format, design, state) {
  const checks = DOCUMENT_VISUAL_CHECKS[format];
  if (!checks) return null;
  const count = Number(state?.renderedPageCount) || 0;
  const entries = Array.isArray(design?.critique) ? design.critique : [];
  const byPage = new Map();
  for (const entry of entries) {
    const page = Number(entry?.page);
    const bucket = byPage.get(page) || [];
    bucket.push(entry);
    byPage.set(page, bucket);
  }
  // A check is answered as a boolean or, in the deck critique's own vocabulary,
  // as a 1-5 score: a 4 or 5 passes. The same name (`hierarchy`, `legibility`)
  // carries a score on a slide and a check on a page, so a number is not a fail.
  const checkPassed = (value) =>
    value === undefined || value === true || (typeof value === 'number' && Number.isFinite(value) && value >= 4);
  const pages = [];
  for (let page = 1; page <= count; page += 1) {
    const matching = byPage.get(page) || [];
    const entry = matching[0];
    const reasons = [];
    if (!entry) reasons.push('no critique entry for this page');
    else {
      if (matching.length > 1) reasons.push(`${matching.length} critique entries name this page`);
      if (entry.verdict !== 'pass') reasons.push(`verdict is ${JSON.stringify(entry.verdict ?? null)}, not 'pass'`);
      const failed = checks.filter((check) => !checkPassed(entry[check]));
      if (failed.length) reasons.push(`${failed.join(', ')} not passed (true, or a score of 4 or 5)`);
      if (Array.isArray(entry.fixes) && entry.fixes.length)
        reasons.push(`${entry.fixes.length} unresolved fix(es) listed`);
      if (!String(entry.note || '').trim()) reasons.push('note is empty');
    }
    pages.push({
      page,
      passed: reasons.length === 0,
      note: String(entry?.note || ''),
      ...(reasons.length ? { reasons } : {}),
      ...(checks.some((check) => entry?.[check] !== undefined)
        ? {
            checks: Object.fromEntries(
              checks.filter((check) => entry?.[check] !== undefined).map((check) => [check, entry[check]])
            ),
          }
        : {}),
    });
  }
  const complete = count > 0 && entries.length === count && pages.every((page) => page.passed);
  const current =
    Boolean(state?.reviewToken) &&
    design?.reviewToken === state.reviewToken &&
    state.renderedVersion === state.snapshotVersion &&
    state.renderedCoverage?.complete === true;
  // Why the review is not accepted, in the order a caller can act on it.
  const blockers = [];
  if (!count) blockers.push('no rendered pages: render first');
  else if (entries.length !== count) blockers.push(`${entries.length} critique entries for ${count} rendered pages`);
  for (const page of pages) if (page.reasons) blockers.push(`page ${page.page}: ${page.reasons.join('; ')}`);
  if (complete) {
    if (!state?.reviewToken) blockers.push('no current render: render first');
    else if (design?.reviewToken !== state.reviewToken) blockers.push('reviewToken is not the current render token');
    else if (state.renderedVersion !== state.snapshotVersion)
      blockers.push('the document changed after the render: render again');
    else if (state.renderedCoverage?.complete !== true)
      blockers.push('the last render did not cover every page: render all pages');
    if (design?.reviewed !== true) blockers.push('design.reviewed is not true');
  }
  return {
    format,
    checks,
    pages,
    complete,
    acknowledged: complete && current && design?.reviewed === true,
    status: reviewStatus(entries.length > 0, complete, current && design?.reviewed === true),
    ...(blockers.length ? { blockers } : {}),
    basis: 'current-render-and-page-observations',
    authority: 'agent-self-review',
    userAcceptance: 'not-recorded',
  };
}

export function assessDocumentAcceptance(evidence, visual = null) {
  const automatedReady =
    evidence?.structuralAvailable === true &&
    Number(evidence.expectedPages) > 0 &&
    Number(evidence.pageCoverage) === 1 &&
    Number(evidence.blockingIssueCount) === 0;
  return {
    scoreMeaning: 'automated-diagnostics-not-design-quality',
    automatedReady,
    visualReview: visual || {
      status: 'not-reviewed',
      basis: 'current-render-and-page-observations',
      authority: 'agent-self-review',
      userAcceptance: 'not-recorded',
    },
    releaseReady: automatedReady && visual?.acknowledged === true,
  };
}
