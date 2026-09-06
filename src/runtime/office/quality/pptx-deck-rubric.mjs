// A deck's score, read from what the runtime already measures. The rubric benchmarks the field settled on
// (PPTEval, PresentBench) grade a finished deck against fixed criteria; this is the local stand-in: every
// check reads a number the composition receipt or the measured review produced, so one round can be compared
// with the last instead of judged by eye. It grades, it never gates — a deliberate breathing page or a motif
// plane costs points and is still the right call; the score is a conversation starter, not a verdict.

const clamp01 = (value) => Math.min(1, Math.max(0, value));
// 1 at `good`, 0 at `bad`, linear between — for readings where lower is better (defects, distinct gaps).
const band = (value, good, bad) => clamp01((bad - value) / (bad - good));
const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
const deviation = (list) => {
  const average = mean(list);
  if (average === null) return null;
  return Math.sqrt(mean(list.map((v) => (v - average) ** 2)));
};

const CHECKS = [
  // id, weight, what it reads
  ['fit', 3, 'measured defects — overflow, out of bounds, contrast, broken chart, fragmentation'],
  ['body_line', 2, 'content slides sharing one body top'],
  ['vertical_fill', 2, 'content reaching down its zone instead of stopping halfway'],
  ['owned_planes', 2, 'tinted planes their own content covers'],
  ['spacing_vocabulary', 2, 'distinct vertical gaps across the deck'],
  ['type_scale', 2, 'distinct type sizes across the deck'],
  ['color_ladder', 2, 'distinct text colors across the deck'],
  ['balance', 3, 'pixel weight balance of the rendered pages'],
  ['rhythm', 2, 'density varying across the sequence instead of flatlining'],
  ['carriers', 2, 'slides carrying something besides text'],
  ['presence', 2, 'the largest carrier on a content slide at a readable share of the canvas'],
  ['alignment', 1, 'text boxes whose right edge aligns with nothing'],
];
const WEIGHT = new Map(CHECKS.map(([id, weight]) => [id, weight]));
const NOTE = new Map(CHECKS.map(([id, , note]) => [id, note]));

export function scoreDeck({ receipt, issues = [] } = {}) {
  const slides = Array.isArray(receipt?.slides) ? receipt.slides : [];
  const rhythm = receipt?.deck?.rhythm || {};
  const observed = slides.map((slide) => slide.observe).filter(Boolean);
  const checks = [];
  const add = (id, score, value) => {
    if (score === null || Number.isNaN(score)) return;
    checks.push({ id, weight: WEIGHT.get(id), score: Number(clamp01(score).toFixed(2)), value, reads: NOTE.get(id) });
  };

  add('fit', band(issues.length, 0, 6), issues.length);

  const bodyTops = observed.map((o) => o.bodyTop).filter((v) => typeof v === 'number');
  if (bodyTops.length > 1) {
    const counts = new Map();
    for (const top of bodyTops) counts.set(top, (counts.get(top) || 0) + 1);
    add('body_line', Math.max(...counts.values()) / bodyTops.length, [...counts.keys()].length);
  }

  const fills = observed.map((o) => o.bodyFill).filter((v) => typeof v === 'number');
  // Half a zone is where a page stops reading as composed and starts reading as unfinished.
  if (fills.length) add('vertical_fill', fills.filter((v) => v >= 0.5).length / fills.length, Number(mean(fills).toFixed(2)));

  const planes = observed.map((o) => o.fieldFill?.[0]).filter((v) => typeof v === 'number');
  if (planes.length) add('owned_planes', planes.filter((v) => v >= 0.25).length / planes.length, Number(Math.min(...planes).toFixed(2)));

  if (Array.isArray(rhythm.gapSet)) add('spacing_vocabulary', band(rhythm.gapSet.length, 4, 12), rhythm.gapSet.length);
  if (Array.isArray(rhythm.typeSet)) add('type_scale', band(rhythm.typeSet.length, 7, 14), rhythm.typeSet.length);
  if (Array.isArray(rhythm.textColors)) add('color_ladder', band(rhythm.textColors.length, 5, 10), rhythm.textColors.length);

  const balances = observed.map((o) => o.renderBalance?.score).filter((v) => typeof v === 'number');
  if (balances.length) add('balance', mean(balances), Number(mean(balances).toFixed(2)));

  const air = observed.map((o) => o.air).filter((v) => typeof v === 'number');
  if (air.length > 2) {
    const spread = deviation(air);
    add('rhythm', clamp01((spread - 0.02) / 0.08), Number(spread.toFixed(3)));
  }

  if (slides.length) add('carriers', 1 - Number(receipt?.deck?.textOnly || 0) / slides.length, Number(receipt?.deck?.textOnly || 0));

  // A quarter of the canvas is where a chart's labels and a picture's subject still read from the back of the
  // room; content slides (those with a body under a title) are read, anchors carry a statement on purpose.
  const carriers = observed.filter((o) => typeof o.bodyTop === 'number' && typeof o.presence === 'number').map((o) => o.presence);
  if (carriers.length) add('presence', mean(carriers.map((v) => clamp01(v / 0.25))), Number(mean(carriers).toFixed(2)));

  const strays = observed.map((o) => o.textColumns?.rightStray).filter((v) => typeof v === 'number');
  if (strays.length) add('alignment', band(mean(strays), 1, 4), Number(mean(strays).toFixed(1)));

  const total = checks.reduce((sum, check) => sum + check.weight, 0);
  const score = total ? Math.round(checks.reduce((sum, check) => sum + check.weight * check.score, 0) / total * 100) : null;
  return {
    score,
    slides: slides.length,
    checks,
    weakest: [...checks].sort((a, b) => a.score - b.score).slice(0, 3).map((check) => check.id),
    note: 'Every check is a reading, not a rule: a breathing page lowers vertical_fill and a motif plane lowers owned_planes on purpose. Compare the same deck across rounds, and read `weakest` before the total.',
  };
}
