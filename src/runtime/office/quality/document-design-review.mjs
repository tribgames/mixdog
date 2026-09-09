import { reviewOfficeStructure } from './assurance-structure.mjs';

const GUIDANCE = {
  docx: [
    'Read the actual pages as the intended genre: essay, letter, report, or reference; do not impose an executive-summary structure.',
    'Judge typography, body width, paragraph rhythm, heading emphasis and page transitions together.',
    'Name visible problems by page and element. Fix their layout cause rather than deleting content to fit a preset.',
  ],
  xlsx: [
    'Read the report surface separately from the working grid: findings, chart meaning, units and editable inputs must be clear.',
    'Inspect calculated values, native chart labels, column proportions and the saved print area.',
    'Keep calculation integrity distinct from visual judgement; a compact working sheet does not need presentation decoration.',
  ],
  pdf: [
    'Judge the actual fixed pages for reading order, typography, spacing and clipping.',
    'For edits, compare against the source and preserve its visual system; for new work, follow the stated reading purpose.',
    'Inspect page transitions, tables, images, forms and annotations in their rendered positions.',
  ],
};

export function reviewNativeDocumentDesign(format, document, auditProfile) {
  const issues = reviewOfficeStructure({ format, document, auditProfile });
  return {
    ok: !issues.some((issue) => issue.severity === 'error'),
    status: 'diagnostics-only',
    authoring: 'native',
    issues,
    requiresVisualInspection: true,
    modelReview: [
      ...(GUIDANCE[format] || []),
      'A diagnostic pass is not a design approval. Inspect images with fresh eyes, record concrete keep/fix observations, and rerender material changes.',
      'The agent review is not the user acceptance. Do not infer user approval from a score or completed checklist.',
    ],
  };
}
