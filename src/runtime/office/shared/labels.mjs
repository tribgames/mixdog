// Captions the runtime adds on its own — a preset's dashboard band, a decision
// panel, a callout label, the prefix on a provenance note. A document written in
// Korean must not carry an English caption the caller never wrote, so these
// follow the copy they sit with; a script with no wording here keeps English.
const LABELS = Object.freeze({
  latin: Object.freeze({
    eyebrow: 'EXECUTIVE DECISION DASHBOARD',
    decision: 'DECISION WINDOW',
    recommendation: 'RECOMMENDATION',
    checkpoint: 'NEXT CHECKPOINT',
    source: 'Source',
    gate: Object.freeze(['Track', 'Release', 'Stop']),
  }),
  hangul: Object.freeze({
    eyebrow: '의사결정 대시보드',
    decision: '결정 사항',
    recommendation: '권고',
    checkpoint: '다음 점검',
    source: '출처',
    gate: Object.freeze(['항목', '진행', '보류']),
  }),
});

export function presetLabels(sample) {
  const text = Array.isArray(sample) ? sample.flat(Infinity).join(' ') : String(sample ?? '');
  return /[\uac00-\ud7a3]/.test(text) ? LABELS.hangul : LABELS.latin;
}
