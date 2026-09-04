import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreDeck } from './pptx-deck-rubric.mjs';

const slide = (index, observe) => ({ slide: index, observe });

// A deck built the way the skill teaches: one body line, content filling its zone, planes carrying
// something, two spacing steps, one type scale, one color ladder, balanced pages, a varying density.
const GOOD = {
  slides: [
    slide(1, { air: 0.3, bodyTop: 4.6, bodyFill: 1, fieldFill: [0.62], renderBalance: { score: 0.88 }, textColumns: { rightStray: 1 } }),
    slide(2, { air: 0.42, bodyTop: 2.22, bodyFill: 0.94, fieldFill: [0.31], renderBalance: { score: 0.86 }, textColumns: { rightStray: 1 } }),
    slide(3, { air: 0.54, bodyTop: 2.22, bodyFill: 0.97, fieldFill: [0.95], renderBalance: { score: 0.82 }, textColumns: { rightStray: 2 } }),
    slide(4, { air: 0.33, bodyTop: 2.22, bodyFill: 1, fieldFill: [0.9], renderBalance: { score: 0.9 }, textColumns: { rightStray: 1 } }),
  ],
  deck: { textOnly: 0, rhythm: { gapSet: [0.1, 0.45, 0.95], typeSet: [11, 13, 18, 22, 36], textColors: ['A', 'B', 'C', 'D'] } },
};

// The same deck before today's repairs: two hollow planes, content stopping halfway, a hand-spaced
// vocabulary, a left-heavy render, and three measured defects.
const POOR = {
  slides: [
    slide(1, { air: 0.3, bodyTop: 4.6, bodyFill: 0.3, fieldFill: [0], renderBalance: { score: 0.6 }, textColumns: { rightStray: 3 } }),
    slide(2, { air: 0.31, bodyTop: 2.2, bodyFill: 0.4, fieldFill: [0.05], renderBalance: { score: 0.55 }, textColumns: { rightStray: 4 } }),
    slide(3, { air: 0.32, bodyTop: 3.1, bodyFill: 0.42, fieldFill: [0.1], renderBalance: { score: 0.62 }, textColumns: { rightStray: 3 } }),
    slide(4, { air: 0.3, bodyTop: 2.9, bodyFill: 0.45, fieldFill: [0.12], renderBalance: { score: 0.58 }, textColumns: { rightStray: 5 } }),
  ],
  deck: { textOnly: 3, rhythm: { gapSet: [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.75, 0.9, 1.1, 1.4], typeSet: [9, 10, 11, 12, 13, 14, 18, 22, 30, 36, 44, 56], textColors: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'] } },
};

test('the rubric separates a composed deck from a hand-spaced one and names the weakest readings', () => {
  const good = scoreDeck({ receipt: GOOD, issues: [] });
  const poor = scoreDeck({ receipt: POOR, issues: [{ code: 'text_overflow' }, { code: 'text_outside_slide' }, { code: 'low_contrast' }] });
  assert.ok(good.score >= 80, `a composed deck scores well: ${good.score} ${JSON.stringify(good.checks)}`);
  assert.ok(poor.score <= 55, `a hollow, hand-spaced deck scores low: ${poor.score}`);
  assert.ok(good.score - poor.score >= 25, 'the two are far apart');
  assert.ok(poor.weakest.includes('owned_planes') && poor.weakest.length === 3, `weakest names the hollow planes: ${poor.weakest}`);
  assert.equal(good.slides, 4);
});

test('each reading contributes only when the deck carries it, and every check keeps its evidence', () => {
  const measuredOnly = scoreDeck({
    receipt: { slides: [slide(1, { air: 0.3, bodyTop: 2.2, bodyFill: 0.9, textColumns: { rightStray: 1 } })], deck: { textOnly: 0, rhythm: {} } },
    issues: [],
  });
  const ids = measuredOnly.checks.map((check) => check.id);
  assert.ok(ids.includes('fit') && ids.includes('vertical_fill'));
  assert.ok(!ids.includes('balance'), 'a deck read without a render has no pixel balance to score');
  assert.ok(!ids.includes('owned_planes'), 'a deck with no tinted plane is not marked down for one');
  for (const check of measuredOnly.checks) {
    assert.ok(check.weight > 0 && typeof check.value !== 'undefined' && check.reads.length > 0, `${check.id} carries its evidence`);
  }
  const empty = scoreDeck({});
  assert.equal(empty.slides, 0);
  assert.ok(empty.score !== null, 'an empty deck still returns a number rather than throwing');
});
