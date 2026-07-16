import test from 'node:test';
import assert from 'node:assert/strict';
import sliceAnsi from 'slice-ansi';

// Make the Windows Terminal policy deterministic on every test host. Dynamic
// imports matter because both policy copies resolve the gate once at load.
process.env.MIXDOG_TUI_AMBIGUOUS_WIDE = '1';

const [{ displayStringWidth }, {
  default: wrapText,
  sliceTextByDisplayWidth,
  sliceTextByDisplayWidthWithPolicy,
}, { default: Output }] = await Promise.all([
  import('../vendor/ink/build/display-width.js'),
  import('../vendor/ink/build/wrap-text.js'),
  import('../vendor/ink/build/output.js'),
]);

const BODY = '①첫째 ②둘째 ③셋째 한국어 본문 텍스트가 이어집니다';

test('Windows Terminal wide glyph wrapping keeps every transcript body line in budget', () => {
  const budget = 12;
  const lines = wrapText(BODY, budget, 'wrap').split('\n');
  assert.ok(lines.length > 1, 'harness input must wrap');
  for (const line of lines) {
    assert.ok(
      displayStringWidth(line) <= budget,
      `${JSON.stringify(line)} is ${displayStringWidth(line)} cells (budget ${budget})`,
    );
  }
});

test('horizontal output clipping uses the wide-glyph display columns', () => {
  const budget = 12;
  const output = new Output({ width: 40, height: 1 });
  output.clip({ x1: 0, x2: budget });
  output.write(0, 0, BODY, { transformers: [] });
  output.unclip();

  const rendered = output.get().output;
  assert.ok(
    displayStringWidth(rendered) <= budget,
    `${JSON.stringify(rendered)} escaped clip at ${displayStringWidth(rendered)} cells`,
  );
});

test('left-edge clipping drops a glyph intersected by x1 and keeps mixed Korean text aligned', () => {
  const output = new Output({ width: 40, height: 1 });
  output.clip({ x1: 3, x2: 15 });
  output.write(0, 0, '가①나②다③ 한국어', { transformers: [] });
  output.unclip();

  const rendered = output.get().output;
  assert.ok(rendered.startsWith('   나'), JSON.stringify(rendered));
  assert.ok(displayStringWidth(rendered) <= 15);
});

test('one-cell clip drops a two-cell circled digit instead of crossing x2', () => {
  const output = new Output({ width: 10, height: 1 });
  output.clip({ x1: 0, x2: 1 });
  output.write(0, 0, '①A', { transformers: [] });
  output.unclip();

  const rendered = output.get().output;
  assert.equal(rendered, '');
  assert.ok(displayStringWidth(rendered) <= 1);
});

test('policy-off and no-problem slices preserve upstream slice-ansi bytes', () => {
  const styledProblem = '\x1b[31m①AB\x1b[39m';
  assert.equal(
    sliceTextByDisplayWidthWithPolicy(styledProblem, 0, 2, false),
    sliceAnsi(styledProblem, 0, 2),
  );

  const styledPlain = '\x1b[31mplain\x1b[39m';
  assert.equal(
    sliceTextByDisplayWidth(styledPlain, 1, 4),
    sliceAnsi(styledPlain, 1, 4),
  );

  const excludedArrows = '\x1b[36m←↑→↓ ↻ tail\x1b[39m';
  assert.equal(
    sliceTextByDisplayWidth(excludedArrows, 1, 7),
    sliceAnsi(excludedArrows, 1, 7),
  );
});

test('left clipping re-opens parameterized OSC 8 hyperlinks', () => {
  const open = '\x1b]8;id=x;https://example.test\x07';
  const linked = `${open}가①나\x1b]8;;\x07`;
  const sliced = sliceTextByDisplayWidth(linked, 2, 6);
  assert.ok(sliced.startsWith(open), JSON.stringify(sliced));
  assert.match(sliced, /①나/);
});
