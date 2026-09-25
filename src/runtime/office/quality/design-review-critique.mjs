// The model's own visual critique of a rendered deck (five axes, a note, and
// plan-derived checks per slide) and the acknowledgement gate finalize reads.
import { strings } from '../design/design-tokens.mjs';
import { plainObject } from '../shared/values.mjs';
import { issue } from './assurance-issue.mjs';

// The five axes a slide is scored on (1-5 each); the pptx skill §6 names them.
const PPTX_CRITIQUE_AXES = Object.freeze(['hierarchy', 'balance', 'legibility', 'cohesion', 'evidence']);

// Instance-specific checks: binary questions derived from the slide's own
// plan line ("the chart's accent bar is the category the title names"),
// answered against the render. A judged deck needs at least three per slide.
const MIN_CHECKS = 3;

function parseChecks(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter(plainObject)
    .map((check) => ({
      item: String(check.item || check.question || '').trim(),
      pass: check.pass === true || String(check.answer || '').toLowerCase() === 'yes',
    }))
    .filter((check) => check.item);
}

// A template answer is not a review: one sentence with the slide number swapped
// in, or the same three questions asked of every slide, says nothing about the
// page it judges. Both are read past the index so the formula cannot hide.
function repeatedCritiqueIssue(entries, total) {
  const asTemplate = (value) =>
    String(value || '')
      .toLowerCase()
      .replace(/\d+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const notes = entries.map((entry) => asTemplate(entry.note)).filter(Boolean);
  const repeatedNotes = total > 1 && notes.length === total && new Set(notes).size !== total;
  const checkSets = entries
    .map((entry) =>
      (entry.checks || [])
        .map((check) => asTemplate(check.item))
        .sort()
        .join(' | ')
    )
    .filter(Boolean);
  const repeatedChecks = total > 1 && checkSets.length === total && new Set(checkSets).size === 1;
  if (!repeatedNotes && !repeatedChecks) return null;
  let message = "Each slide's checks come from its own plan line; every slide here asks the same questions.";
  if (repeatedNotes && repeatedChecks) {
    message =
      'Each slide needs its own critique note and its own checks; this critique repeats one note and one set of questions across the deck.';
  } else if (repeatedNotes) {
    message = 'Each slide needs a distinct visual critique note; changing only the slide number is the same note.';
  }
  return issue('visual_critique_repeated_note', '/', message, 'visual-critique');
}

export function reviewPptxVisualCritique({ critique = [], pageCount = 0, requireChecks = false } = {}) {
  const total = Math.max(0, Number(pageCount) || 0);
  const issues = [];
  const entries = [];
  const bySlide = new Map();
  for (const raw of Array.isArray(critique) ? critique : []) {
    if (!plainObject(raw)) continue;
    const slide = Number(raw.slide);
    if (!Number.isInteger(slide) || slide < 1 || slide > total || bySlide.has(slide)) {
      issues.push(
        issue(
          'visual_critique_invalid_slide',
          '/',
          `Visual critique has an invalid or duplicate slide index: ${raw.slide}`,
          'visual-critique'
        )
      );
      continue;
    }
    const scores = Object.fromEntries(PPTX_CRITIQUE_AXES.map((axis) => [axis, Number(raw[axis])]));
    const note = String(raw.note || '').trim();
    const fixes = strings(raw.fixes);
    const verdict = String(raw.verdict || '').toLowerCase();
    const validScores = PPTX_CRITIQUE_AXES.every(
      (axis) => Number.isInteger(scores[axis]) && scores[axis] >= 1 && scores[axis] <= 5
    );
    const checks = parseChecks(raw.checks);
    // An anchor (cover, section, closing) carries a statement or a picture, not
    // evidence; its evidence score is recorded but never gates finalize.
    const role = String(raw.role || '')
      .trim()
      .toLowerCase();
    const anchor = ['anchor', 'cover', 'section', 'closing'].includes(role);
    const gatedAxes = anchor ? PPTX_CRITIQUE_AXES.filter((axis) => axis !== 'evidence') : PPTX_CRITIQUE_AXES;
    const entry = {
      slide,
      verdict,
      ...scores,
      note,
      fixes,
      ...(role ? { role } : {}),
      ...(checks.length ? { checks } : {}),
    };
    entries.push(entry);
    bySlide.set(slide, entry);
    if (!validScores || note.length < 40 || (requireChecks && checks.length < MIN_CHECKS)) {
      issues.push(
        issue(
          'visual_critique_incomplete',
          `/slide[${slide}]`,
          requireChecks
            ? `Visual critique requires five integer scores from 1-5, a slide-specific note of at least 40 characters, and at least ${MIN_CHECKS} checks ({ item, pass }) derived from the slide's plan line.`
            : 'Visual critique requires five integer scores from 1-5 and a slide-specific note of at least 40 characters.',
          'visual-critique'
        )
      );
    } else if (
      verdict !== 'pass' ||
      fixes.length ||
      gatedAxes.some((axis) => scores[axis] < 4) ||
      checks.some((check) => !check.pass)
    ) {
      issues.push(
        issue(
          'visual_critique_needs_polish',
          `/slide[${slide}]`,
          `Slide ${slide} still needs polish before finalization.`,
          'visual-critique'
        )
      );
    }
  }
  for (let slide = 1; slide <= total; slide += 1) {
    if (!bySlide.has(slide)) {
      issues.push(
        issue(
          'visual_critique_missing_slide',
          `/slide[${slide}]`,
          `Slide ${slide} has no visual critique.`,
          'visual-critique'
        )
      );
    }
  }
  const repeated = repeatedCritiqueIssue(entries, total);
  if (repeated) issues.push(repeated);
  return {
    ok: total > 0 && issues.length === 0,
    status: total > 0 && issues.length === 0 ? 'pass' : 'needs-polish',
    axes: [...PPTX_CRITIQUE_AXES],
    pageCount: total,
    entries,
    issues,
  };
}

export function pptxVisualReviewAcknowledged({
  reviewed = false,
  providedToken = '',
  expectedToken = '',
  renderedVersion = null,
  snapshotVersion = 0,
  coverageComplete = true,
  critiqueOk = false,
} = {}) {
  return (
    reviewed === true &&
    Boolean(expectedToken) &&
    String(providedToken || '') === String(expectedToken) &&
    renderedVersion != null &&
    Number(renderedVersion) === Number(snapshotVersion || 0) &&
    coverageComplete === true &&
    critiqueOk === true
  );
}
