import { isAutomatedReady, reviewStatus } from './document-acceptance.mjs';

// Mechanical diagnostics and a current rendered review are independent evidence.
// Neither a high pixel score nor an author's unacknowledged critique approves a deck.
export function assessPresentationAcceptance(evidence, { acknowledged = false, critique = null } = {}) {
  const automatedReady = isAutomatedReady(evidence);
  const visualStatus = reviewStatus(Boolean(critique), critique?.ok === true, acknowledged);
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
