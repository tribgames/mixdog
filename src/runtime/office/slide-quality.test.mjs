import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveImageLayout } from './portable/image-layout.mjs';
import { measureTextBlock, measureTextWidth, reviewTextBoxFit, wrapParagraph } from './portable/text-metrics.mjs';
import { OFFICE_SKILL_ROUTING, TOOL_DEFS } from './tool-defs.mjs';

test('Office Use routes every format to its built-in skill', () => {
  const office = TOOL_DEFS.find((tool) => tool.name === 'office');
  assert.ok(office);
  assert.ok(office.description.includes(OFFICE_SKILL_ROUTING));
  for (const skill of ['pptx', 'docx', 'xlsx', 'pdf']) {
    assert.match(OFFICE_SKILL_ROUTING, new RegExp(`\\b${skill}\\b`));
  }
});

// PowerPoint (probe 2026-09-04) lays every face out at 1.2 em per single line: Noto Sans KR,
// Noto Serif KR, Malgun Gothic, Arial, and Calibri all read BoundHeight / lines / size = 1.200.
test('measured line pitch is PowerPoint\'s 1.2 em for Hangul and Latin faces alike', () => {
  for (const fontName of ['Noto Serif KR', 'Malgun Gothic', 'Arial']) {
    const single = measureTextBlock([{ text: '한 줄', fontName, fontSize: 20 }], { width: 0 });
    assert.equal(single.lines, 1);
    assert.ok(Math.abs(single.height - 24) < 0.01, `${fontName}: ${single.height}`);
    const spaced = measureTextBlock([{ text: '한 줄', fontName, fontSize: 20, lineSpacing: 1.5 }], { width: 0 });
    assert.ok(Math.abs(spaced.height - 36) < 0.01, `${fontName} at 150%: ${spaced.height}`);
  }
});

test('a closing mark never starts a wrapped line and an opening mark never ends one', () => {
  const font = { fontName: 'Malgun Gothic', fontSize: 18 };
  // The width just fits "정한 뒤 킷으로 직접 그린다" so a naive per-character wrap would strand the period.
  const body = '정한 뒤 킷으로 직접 그린다';
  const width = measureTextWidth(body, font) + 1;
  const lines = wrapParagraph(`${body}. 런타임은 측정한다.`, width, font);
  assert.equal(lines[0], '정한 뒤 킷으로 직접 그린');
  assert.equal(lines[1].startsWith('다.'), true);
  for (const line of lines) assert.doesNotMatch(line, /^[.,)]/);
  const opening = wrapParagraph('킷으로 직접 (그린다)', measureTextWidth('킷으로 직접 (', font) + 1, font);
  assert.equal(opening[0], '킷으로 직접');
  assert.equal(opening[1], '(그린다)');
});

test('Hangul in a Latin face measures in PowerPoint\'s East Asian fallback, not a half-width substitute', () => {
  const hangul = '슬라이드유형을고르던아키타입함수카탈로그를없앴다';   // no spaces: a space stays in the Latin face
  const latinFace = measureTextWidth(hangul, { fontName: 'Arial', fontSize: 18 });
  const eastAsian = measureTextWidth(hangul, { fontName: 'Malgun Gothic', fontSize: 18 });
  const noto = measureTextWidth(hangul, { fontName: 'Noto Sans KR', fontSize: 18 });
  assert.ok(Math.abs(latinFace - eastAsian) < 0.5 || Math.abs(latinFace - noto) < 0.5, `${latinFace} vs ${eastAsian} / ${noto}`);
  const mixed = measureTextWidth('abc 가나다', { fontName: 'Arial', fontSize: 18 });
  const latinOnly = measureTextWidth('abc ', { fontName: 'Arial', fontSize: 18 });
  assert.ok(mixed > latinOnly + eastAsian * 0.05, 'the CJK run adds fallback width to the Latin run');
});

test('image layout contains an asset without changing its aspect ratio', () => {
  const placed = resolveImageLayout({
    sourceWidth: 400,
    sourceHeight: 200,
    left: 10,
    top: 20,
    width: 300,
    height: 300,
    fit: 'contain',
  });
  assert.deepEqual(placed, {
    left: 10,
    top: 95,
    width: 300,
    height: 150,
    fit: 'contain',
    crop: null,
  });
});

test('image layout covers a frame with focus-aware source cropping', () => {
  const centered = resolveImageLayout({
    sourceWidth: 100,
    sourceHeight: 100,
    width: 300,
    height: 100,
    fit: 'cover',
  });
  assert.equal(centered.crop.left, 0);
  assert.equal(centered.crop.right, 0);
  assert.ok(Math.abs(centered.crop.top - (1 / 3)) < 1e-9);
  assert.ok(Math.abs(centered.crop.bottom - (1 / 3)) < 1e-9);

  const topFocused = resolveImageLayout({
    sourceWidth: 100,
    sourceHeight: 100,
    width: 300,
    height: 100,
    fit: 'cover',
    focusY: 0,
  });
  assert.equal(topFocused.crop.top, 0);
  assert.ok(Math.abs(topFocused.crop.bottom - (2 / 3)) < 1e-9);
});

test('text review reports an unavailable presentation font', () => {
  const issues = reviewTextBoxFit([{
    slide: 2,
    shape: 4,
    left: 20,
    top: 20,
    width: 500,
    height: 100,
    paragraphs: [{ text: 'Launch readiness', fontName: 'Brand Sans', fontSize: 18 }],
  }], {
    isFontAvailable: () => false,
  });
  assert.deepEqual(issues.filter((issue) => issue.code === 'font_unavailable'), [{
    code: 'font_unavailable',
    path: '/slide[2]/shape[4]',
    message: 'Font "Brand Sans" is not installed, so PowerPoint may substitute it and change the layout.',
    font: 'Brand Sans',
  }]);
});
