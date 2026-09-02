import { plainObject } from '../../shared/values.mjs';


function strings(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))];
}

function note(value, minimum, message) {
  const text = String(value || '').trim();
  if (text.length < minimum) throw new Error(message);
  return text;
}

function expectedCandidateIds(record) {
  return record.compiled.candidates.map((entry) => entry.id);
}

function requireAllCandidates(record, critique) {
  const compared = strings(critique.comparedCandidates);
  const expected = expectedCandidateIds(record);
  if (expected.some((id) => !compared.includes(id))) {
    throw new Error('Visual decision must compare every rendered candidate.');
  }
  return expected;
}

function renderReceipt(record, candidateId, slide) {
  return record.renderReceipts?.find((entry) => (
    entry.candidateId === candidateId && Number(entry.slide) === Number(slide)
  ));
}

function baselineReceipt(record, slide) {
  return record.baselineReceipts?.find((entry) => Number(entry.slide) === Number(slide));
}

function slideReviews(record, critique, candidateId, verdict) {
  const reviews = Array.isArray(critique.slides) ? critique.slides : [];
  const normalized = [];
  for (let slide = 1; slide <= record.compiled.slideCount; slide += 1) {
    const review = reviews.find((entry) => Number(entry?.slide) === slide);
    if (!plainObject(review)) throw new Error(`Visual decision requires a review for slide ${slide}.`);
    if (String(review.reviewMode || '').toLowerCase() !== 'full-size') {
      throw new Error(`Slide ${slide} must be reviewed from the persisted full-size render.`);
    }
    if (String(review.verdict || '').toLowerCase() !== verdict) {
      throw new Error(`Slide ${slide} verdict must be "${verdict}".`);
    }
    const normalizedReview = {
      slide,
      verdict,
      reviewMode: 'full-size',
      note: note(review.note, 60, `Slide ${slide} requires a specific visual note of at least 60 characters.`),
      strengths: strings(review.strengths),
      risks: strings(review.risks),
    };
    if (candidateId) {
      const receipt = renderReceipt(record, candidateId, slide);
      if (!receipt || String(review.renderSha256 || '') !== receipt.sha256) {
        throw new Error(`Slide ${slide} must cite the selected candidate full-size render receipt.`);
      }
      normalizedReview.renderSha256 = receipt.sha256;
    }
    const baseline = baselineReceipt(record, slide);
    if (baseline) {
      if (String(review.baselineSha256 || '') !== baseline.sha256) {
        throw new Error(`Slide ${slide} must cite the baseline full-size render receipt.`);
      }
      if (String(review.baselineVerdict || '').toLowerCase() !== (verdict === 'selected' ? 'better' : 'not-better')) {
        throw new Error(`Slide ${slide} must state whether it is better than the baseline.`);
      }
      normalizedReview.baselineSha256 = baseline.sha256;
      normalizedReview.baselineVerdict = verdict === 'selected' ? 'better' : 'not-better';
    }
    normalized.push(normalizedReview);
  }
  return normalized;
}

function rejectionSlideReviews(record, critique, comparedCandidates) {
  const reviews = Array.isArray(critique.slides) ? critique.slides : [];
  const normalized = [];
  for (let slide = 1; slide <= record.compiled.slideCount; slide += 1) {
    const review = reviews.find((entry) => Number(entry?.slide) === slide);
    if (!plainObject(review)) throw new Error(`Visual decision requires a review for slide ${slide}.`);
    if (String(review.reviewMode || '').toLowerCase() !== 'full-size') {
      throw new Error(`Slide ${slide} must be reviewed from the persisted full-size render.`);
    }
    if (String(review.verdict || '').toLowerCase() !== 'reject-all') {
      throw new Error(`Slide ${slide} verdict must be "reject-all".`);
    }
    const baseline = baselineReceipt(record, slide);
    if (baseline && String(review.baselineSha256 || '') !== baseline.sha256) {
      throw new Error(`Slide ${slide} must cite the baseline full-size render receipt.`);
    }
    const submitted = Array.isArray(review.candidateVerdicts) ? review.candidateVerdicts : [];
    const candidateVerdicts = comparedCandidates.map((candidateId) => {
      const candidate = submitted.find((entry) => String(entry?.candidateId || '') === candidateId);
      if (!plainObject(candidate)) {
        throw new Error(`Slide ${slide} reject-all requires a verdict for candidate "${candidateId}".`);
      }
      const receipt = renderReceipt(record, candidateId, slide);
      if (!receipt || String(candidate.renderSha256 || '') !== receipt.sha256) {
        throw new Error(`Slide ${slide} must cite candidate "${candidateId}" full-size render receipt.`);
      }
      const verdict = String(candidate.verdict || '').toLowerCase();
      const allowed = baseline ? ['better', 'not-better'] : ['reject'];
      if (!allowed.includes(verdict)) {
        throw new Error(`Slide ${slide} candidate "${candidateId}" verdict must be one of: ${allowed.join(', ')}.`);
      }
      return {
        candidateId,
        renderSha256: receipt.sha256,
        verdict,
      };
    });
    normalized.push({
      slide,
      verdict: 'reject-all',
      reviewMode: 'full-size',
      note: note(review.note, 60, `Slide ${slide} requires a specific visual note of at least 60 characters.`),
      strengths: strings(review.strengths),
      risks: strings(review.risks),
      ...(baseline ? { baselineSha256: baseline.sha256 } : {}),
      candidateVerdicts,
    });
  }
  for (const candidateId of comparedCandidates) {
    const winsEverySlide = normalized.every((review) => (
      review.candidateVerdicts.find((entry) => entry.candidateId === candidateId)?.verdict === 'better'
    ));
    if (winsEverySlide) {
      throw new Error(`reject-all is invalid because candidate "${candidateId}" is better than the baseline on every slide.`);
    }
  }
  return normalized;
}

export function evaluatePptxVisualDecision(record, design = {}) {
  const decision = String(design.decision || design.selectionCritique?.decision || 'accept').toLowerCase();
  if (decision === 'reject-all') {
    const critique = plainObject(design.rejectionCritique)
      ? design.rejectionCritique
      : design.selectionCritique;
    if (!plainObject(critique)) throw new Error('reject-all requires design.rejectionCritique.');
    const comparedCandidates = requireAllCandidates(record, critique);
    return {
      kind: 'reject-all',
      decision: 'reject-all',
      comparedCandidates,
      note: note(critique.note, 80, 'reject-all requires an evidence-based note of at least 80 characters.'),
      slides: rejectionSlideReviews(record, critique, comparedCandidates),
    };
  }
  if (decision !== 'accept') throw new Error(`Unknown PPTX visual decision "${decision}".`);
  const selectedCandidate = String(design.selectedCandidate || '');
  const candidate = record.compiled.candidates.find((entry) => entry.id === selectedCandidate);
  if (!candidate) throw new Error(`Unknown selectedCandidate "${selectedCandidate}".`);
  const critique = design.selectionCritique;
  if (!plainObject(critique)) throw new Error('compile requires design.selectionCritique.');
  if (String(critique.selectedCandidate || '') !== candidate.id) {
    throw new Error('selectionCritique.selectedCandidate must match design.selectedCandidate.');
  }
  const comparedCandidates = requireAllCandidates(record, critique);
  const comparisons = Array.isArray(critique.comparisons) ? critique.comparisons : [];
  for (const rejected of comparedCandidates.filter((id) => id !== candidate.id)) {
    const comparison = comparisons.find((entry) => String(entry?.rejectedCandidate || '') === rejected);
    note(comparison?.note, 40, `selectionCritique requires a 40-character pairwise comparison against "${rejected}".`);
  }
  return {
    kind: 'accept',
    decision: 'accept',
    candidateId: candidate.id,
    critique: {
      selectedCandidate: candidate.id,
      comparedCandidates,
      note: note(critique.note, 80, 'selectionCritique.note must explain the visual decision in at least 80 characters.'),
      comparisons: comparisons.map((entry) => ({
        rejectedCandidate: String(entry.rejectedCandidate || ''),
        note: String(entry.note || '').trim(),
      })),
      slides: slideReviews(record, critique, candidate.id, 'selected'),
    },
  };
}

export function evaluatePptxRevisionDecision(record, design = {}) {
  const input = plainObject(design.revisionDecision)
    ? design.revisionDecision
    : {
      selectedCandidate: design.revisionCritique?.selectedCandidate,
      selectionCritique: design.revisionCritique,
    };
  const decision = evaluatePptxVisualDecision(record, input);
  return {
    decision,
    historyEntry: decision.kind === 'accept' ? decision.critique : decision,
  };
}
