import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveImageLayout } from './portable/image-layout.mjs';
import { reviewTextBoxFit } from './portable/text-metrics.mjs';
import { OFFICE_SKILL_ROUTING, TOOL_DEFS } from './tool-defs.mjs';

test('Office Use routes every format to its built-in skill', () => {
  const office = TOOL_DEFS.find((tool) => tool.name === 'office');
  assert.ok(office);
  assert.ok(office.description.includes(OFFICE_SKILL_ROUTING));
  for (const skill of ['pptx', 'docx', 'xlsx', 'pdf']) {
    assert.match(OFFICE_SKILL_ROUTING, new RegExp(`\\b${skill}\\b`));
  }
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
