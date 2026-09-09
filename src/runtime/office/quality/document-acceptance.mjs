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
  const pages = [];
  for (let page = 1; page <= count; page += 1) {
    const matching = byPage.get(page) || [];
    const entry = matching[0];
    const passed = matching.length === 1 && entry?.verdict === 'pass'
      && checks.every((check) => entry[check] === undefined || entry[check] === true)
      && (!Array.isArray(entry?.fixes) || entry.fixes.length === 0)
      && String(entry?.note || '').trim().length > 0;
    pages.push({
      page, passed, note: String(entry?.note || ''),
      ...(checks.some((check) => entry?.[check] !== undefined)
        ? { checks: Object.fromEntries(checks.filter((check) => entry?.[check] !== undefined).map((check) => [check, entry[check]])) }
        : {}),
    });
  }
  const complete = count > 0 && entries.length === count && pages.every((page) => page.passed);
  const current = Boolean(state?.reviewToken)
    && design?.reviewToken === state.reviewToken
    && state.renderedVersion === state.snapshotVersion
    && state.renderedCoverage?.complete === true;
  return {
    format, checks, pages, complete,
    acknowledged: complete && current && design?.reviewed === true,
    status: !entries.length ? 'not-reviewed' : !complete ? 'needs-work'
      : current && design?.reviewed === true ? 'accepted' : 'not-acknowledged',
    basis: 'current-render-and-page-observations',
    authority: 'agent-self-review',
    userAcceptance: 'not-recorded',
  };
}

export function assessDocumentAcceptance(evidence, visual = null) {
  const automatedReady = evidence?.structuralAvailable === true
    && Number(evidence.expectedPages) > 0
    && Number(evidence.pageCoverage) === 1
    && Number(evidence.blockingIssueCount) === 0;
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
