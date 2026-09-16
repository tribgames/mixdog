import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveImageLayout } from './portable/image-layout.mjs';
import {
  measureTextBlock,
  measureTextWidth,
  reviewCjkTracking,
  reviewTextBoxFit,
  reviewVerticalBalance,
  wrapParagraph,
} from './portable/text-metrics.mjs';
import { isAdvisoryOfficeIssue } from './quality/quality-pipeline.mjs';
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
test("measured line pitch is PowerPoint's 1.2 em for Hangul and Latin faces alike", () => {
  for (const fontName of ['Noto Serif KR', 'Malgun Gothic', 'Arial']) {
    const single = measureTextBlock([{ text: '한 줄', fontName, fontSize: 20 }], { width: 0 });
    assert.equal(single.lines, 1);
    assert.ok(Math.abs(single.height - 24) < 0.01, `${fontName}: ${single.height}`);
    const spaced = measureTextBlock([{ text: '한 줄', fontName, fontSize: 20, lineSpacing: 1.5 }], { width: 0 });
    assert.ok(Math.abs(spaced.height - 36) < 0.01, `${fontName} at 150%: ${spaced.height}`);
  }
});

// Tracking is a Latin device: on Hangul it pulls the syllables of one word apart,
// which the skill states as a rule and the runtime could not see at all until the
// run's spacing was read back from the file.
test('tracking on Hangul is reported, tracking on a Latin kicker is not', () => {
  const box = (paragraph) => ({ slide: 1, shape: 2, paragraphs: [paragraph] });
  const hangul = reviewCjkTracking([box({ text: '야간 처리량이 주간을 넘어섰다', fontSize: 28, charSpacing: 4 })]);
  assert.equal(hangul.length, 1);
  assert.equal(hangul[0].code, 'cjk_letter_spacing');
  assert.match(hangul[0].message, /14% of the size/);
  assert.deepEqual(reviewCjkTracking([box({ text: 'OPERATIONS', fontSize: 12, charSpacing: 4 })]), []);
  assert.deepEqual(reviewCjkTracking([box({ text: '야간 처리량', fontSize: 28 })]), []);
  // A hair of tracking is a typographic nicety, not a broken word.
  assert.deepEqual(reviewCjkTracking([box({ text: '야간 처리량', fontSize: 28, charSpacing: 1 })]), []);
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

// A figure like 47,210 carries no space and no syllable break: PowerPoint breaks it between characters,
// so a measurement that keeps it on one line reports a height the render never uses and hides the overflow.
test('a run with no break opportunity wraps and overflows the way the renderer lays it out', () => {
  const font = { fontName: 'Arial', fontSize: 65, bold: true };
  const figure = '47,210';
  const measure = measureTextWidth(figure, font) * 0.83; // the column the stat band gave it
  const lines = wrapParagraph(figure, measure, font);
  assert.equal(lines.length, 2);
  assert.equal(lines.join(''), figure);
  const block = measureTextBlock([{ text: figure, fontName: 'Arial', fontSize: 65, bold: true }], { width: measure });
  assert.equal(block.lines, 2);
  assert.ok(block.longestRun > measure, `${block.longestRun} vs ${measure}`);
  const issues = reviewTextBoxFit(
    [
      {
        slide: 3,
        shape: 4,
        left: 40,
        top: 120,
        width: measure,
        height: 81,
        insetLeft: 0,
        insetRight: 0,
        insetTop: 0,
        insetBottom: 0,
        paragraphs: [{ text: figure, fontName: 'Arial', fontSize: 65, bold: true }],
      },
    ],
    { isFontAvailable: () => true, slideWidth: 960, slideHeight: 540 }
  );
  assert.equal(issues.find((issue) => issue.code === 'text_overflow')?.lines, 2);
  assert.match(issues.find((issue) => issue.code === 'text_box_too_narrow')?.message || '', /breaks mid-word/);
});

test("Hangul in a Latin face measures in PowerPoint's East Asian fallback, not a half-width substitute", () => {
  const hangul = '슬라이드유형을고르던아키타입함수카탈로그를없앴다'; // no spaces: a space stays in the Latin face
  const latinFace = measureTextWidth(hangul, { fontName: 'Arial', fontSize: 18 });
  const eastAsian = measureTextWidth(hangul, { fontName: 'Malgun Gothic', fontSize: 18 });
  const noto = measureTextWidth(hangul, { fontName: 'Noto Sans KR', fontSize: 18 });
  assert.ok(
    Math.abs(latinFace - eastAsian) < 0.5 || Math.abs(latinFace - noto) < 0.5,
    `${latinFace} vs ${eastAsian} / ${noto}`
  );
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
  assert.ok(Math.abs(centered.crop.top - 1 / 3) < 1e-9);
  assert.ok(Math.abs(centered.crop.bottom - 1 / 3) < 1e-9);

  const topFocused = resolveImageLayout({
    sourceWidth: 100,
    sourceHeight: 100,
    width: 300,
    height: 100,
    fit: 'cover',
    focusY: 0,
  });
  assert.equal(topFocused.crop.top, 0);
  assert.ok(Math.abs(topFocused.crop.bottom - 2 / 3) < 1e-9);
});

test('a text box narrower than its reading measure is reported once', () => {
  const sentence = '정시 출고율 하락분의 대부분은 대전 허브의 야간 인력 부족에서 나왔습니다.';
  const review = (width) =>
    reviewTextBoxFit(
      [
        {
          slide: 2,
          shape: 4,
          left: 40,
          top: 40,
          width,
          height: 400,
          paragraphs: [{ text: sentence, fontName: 'Malgun Gothic', fontSize: 13 }],
        },
      ],
      { isFontAvailable: () => true, slideWidth: 960, slideHeight: 540 }
    ).filter((issue) => issue.code === 'text_box_too_narrow');
  // 84 pt of measure for 13 pt text leaves one or two words a line.
  const narrow = review(84);
  assert.equal(narrow.length, 1);
  assert.match(narrow[0].message, /one or two words each/);
  // A readable measure says nothing.
  assert.deepEqual(review(360), []);
});

test('text review reports an unavailable presentation font', () => {
  const issues = reviewTextBoxFit(
    [
      {
        slide: 2,
        shape: 4,
        left: 20,
        top: 20,
        width: 500,
        height: 100,
        paragraphs: [{ text: 'Launch readiness', fontName: 'Brand Sans', fontSize: 18 }],
      },
    ],
    {
      isFontAvailable: () => false,
    }
  );
  assert.deepEqual(
    issues.filter((issue) => issue.code === 'font_unavailable'),
    [
      {
        code: 'font_unavailable',
        path: '/slide[2]/shape[4]',
        message: 'Font "Brand Sans" is not installed, so PowerPoint may substitute it and change the layout.',
        font: 'Brand Sans',
      },
    ]
  );
});

// A body that stops halfway down still measures a full canvas from its
// margins, because the source line and the page number sit at the bottom of
// every slide. The empty band between them is what a reader sees as an
// unfinished page, and it is a target the author answers, not a taste reading.
test('a hollow band between the body and the footer is reported; a filled one is not', () => {
  const box = (slide, top, height, fontSize, text) => ({
    slide,
    shape: 1,
    left: 48,
    top,
    width: 400,
    height,
    paragraphs: [{ text, fontSize }],
  });
  const slide = (index) => [
    box(index, 72, 54, 32, '정시 출고율은 92.8%로 목표를 넘었습니다'),
    box(index, 187, 81, 54, '92.8%'),
    box(index, 187, 81, 54, '12명'),
    box(index, 272, 20, 14, '10월 정시 출고율'),
    box(index, 272, 20, 14, '야간 증원 요청'),
    box(index, 484, 21, 11, '물류기획팀 10월 집계 시트 B4'),
    box(index, 504, 22, 10, '2'),
  ];
  // Slide 2 carries the same content plus the evidence the band was missing.
  const boxes = [...slide(1), ...slide(2), box(2, 320, 150, 14, '지연 사유 · 야간 처리량 · 인력 계획')];
  const bounds = boxes.map(({ slide: index, top, height, left, width }) => ({
    slide: index,
    top,
    height,
    left,
    width,
  }));
  const issues = reviewVerticalBalance(bounds, { slideWidth: 960, slideHeight: 540, boxes });
  assert.deepEqual(
    issues.map((issue) => issue.path),
    ['/slide[1]']
  );
  assert.equal(issues[0].code, 'vertical_imbalance');
  assert.equal(issues[0].hollowBand, 192);
  assert.equal(issues[0].hollowTop, 292);
  assert.match(issues[0].message, /empty band/);
  // The author answers it in the turn that wrote the slide: the runtime lists
  // it as a target, unlike the monotony and plan read-back advisories.
  assert.equal(isAdvisoryOfficeIssue(issues[0]), false);
});
