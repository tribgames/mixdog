import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generatedSessionTitle,
  hasMeaningfulSessionTitleText,
  normalizeSessionTitle,
  promptTitle,
  sessionSummaryTitle,
  sessionTitleNormalizationStats,
} from './session-title.mjs';

test('repeated titling of the same preview normalizes it once', () => {
  const raw = `${'catalog preview text '.repeat(20)} unique-${Math.random()}`;
  sessionTitleNormalizationStats.cleaned = 0;
  const first = generatedSessionTitle(raw, '');
  const afterFirst = sessionTitleNormalizationStats.cleaned;
  assert.ok(afterFirst <= 2);
  assert.equal(generatedSessionTitle(raw, ''), first);
  assert.equal(generatedSessionTitle(raw), first);
  assert.equal(normalizeSessionTitle(raw, ''), normalizeSessionTitle(raw, ''));
  assert.equal(sessionTitleNormalizationStats.cleaned, afterFirst);
});

const EDGE = [
  '',
  '   \n\t ',
  '<system-reminder>unterminated tail',
  'hi <system-reminder>x</system-reminder> there',
  'a <file path="x">body',
  '한글 제목 😀 テスト',
  'x'.repeat(5000),
  'word '.repeat(300),
  '[Image: a.png 10x10]',
  '[Mixdog-runtime] hi',
  'Reference files: Reference files: x',
  '!!! ???',
  '# Session\nCwd: /a\nModel: m\nWorkflow: w\nreal title',
];

test('a title of file chips alone is the first file name; words win; image-only stays provisional', () => {
  // The runtime and the catalog keep the composer's chip text as a title or preview.
  assert.equal(generatedSessionTitle('[PDF #1: report.pdf]\n[File #2: main.ts]', ''), 'report.pdf');
  assert.equal(sessionSummaryTitle({ title: '[File #3: budget.xlsx]' }), 'budget.xlsx');
  assert.equal(sessionSummaryTitle({ preview: 'review these\n[PDF #1: report.pdf]' }), 'review these');
  assert.equal(
    promptTitle([{ type: 'file', data: 'x', mimeType: 'application/pdf', filename: 'report.pdf' }]),
    'report.pdf'
  );
  assert.equal(promptTitle([{ type: 'image', data: 'x', mimeType: 'image/png' }]), '[Image]');
  assert.equal(promptTitle([{ type: 'file', data: 'x', mimeType: 'application/pdf' }]), '[File]');
  assert.equal(generatedSessionTitle('[Image #1]', ''), '[Image]');
  assert.equal(generatedSessionTitle('[File] notes', ''), '[File] notes', 'a literal bracket stays');
});

test('memoized output equals uncached output for edge inputs', () => {
  for (const input of EDGE) {
    const cold = [
      generatedSessionTitle(input, ''),
      normalizeSessionTitle(input, ''),
      hasMeaningfulSessionTitleText(input),
    ];
    const warm = [
      generatedSessionTitle(input, ''),
      normalizeSessionTitle(input, ''),
      hasMeaningfulSessionTitleText(input),
    ];
    assert.deepEqual(warm, cold);
  }
});
