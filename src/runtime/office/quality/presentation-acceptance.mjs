// Mechanical diagnostics and a current rendered review are independent evidence.
// Neither a high pixel score nor an author's unacknowledged critique approves a deck.
export function assessPresentationAcceptance(evidence, {
  acknowledged = false,
  critique = null,
} = {}) {
  const automatedReady = evidence?.structuralAvailable === true
    && Number(evidence.expectedPages) > 0
    && Number(evidence.pageCoverage) === 1
    && Number(evidence.blockingIssueCount) === 0;
  const visualStatus = !critique
    ? 'not-reviewed'
    : critique.ok !== true ? 'needs-work'
      : acknowledged ? 'accepted' : 'not-acknowledged';
  return {
    scoreMeaning: 'automated-diagnostics-not-design-quality',
    automatedReady,
    visualReview: {
      status: visualStatus,
      required: true,
      basis: 'current-render-and-slide-specific-critique',
    },
    releaseReady: automatedReady && visualStatus === 'accepted',
  };
}
