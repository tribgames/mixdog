import assert from 'node:assert/strict';
import test from 'node:test';

import { createCanvas } from '@napi-rs/canvas';

import { reviewRenderedOfficePages } from './assurance.mjs';
import { resolveOfficeDesign, reviewOfficeDesign } from './design-system.mjs';
import { scoreOfficeReleaseQuality } from './quality-score.mjs';

function renderedImage(page, draw, {
  width = 320,
  height = 180,
} = {}) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#FFFFFF';
  context.fillRect(0, 0, width, height);
  draw(context, width, height);
  return {
    page,
    width,
    height,
    mimeType: 'image/png',
    data: canvas.toBuffer('image/png').toString('base64'),
  };
}

test('Office design resolves three subject-specific directions and preserves explicit brand colors', () => {
  const design = resolveOfficeDesign('pptx', {
    profile: 'technical',
    intent: 'Launch a local-first coding harness for product leaders',
    audience: 'product and engineering leaders',
    purpose: 'decide',
    expressionMode: 'strong-fit',
    palette: { accent: '#00A896' },
    signature: 'local-first evidence loop',
  });
  assert.equal(design.artDirection.candidates.length, 3);
  assert.ok(design.artDirection.selected.id);
  assert.equal(design.deck.directionId, design.artDirection.selected.id);
  assert.equal(design.deck.directionCandidates.length, 3);
  assert.match(design.deck.motif, /local-first evidence loop/i);
  assert.equal(design.tokens.colors.accent, '00A896');
});

test('rendered PPTX aesthetics reject a flat repeated deck and accept deliberate visual rhythm', async () => {
  const repeated = await reviewRenderedOfficePages(Array.from({ length: 6 }, (_, index) => (
    renderedImage(index + 1, (context, width, height) => {
      context.fillStyle = '#080C12';
      context.fillRect(0, 0, width, height);
      context.fillStyle = '#F8FAFC';
      context.fillRect(24, 20, 190, 12);
      context.fillStyle = '#151D28';
      context.fillRect(24, 58, 272, 96);
      context.fillStyle = '#58A6FF';
      context.fillRect(34, 70, 70, 58);
    })
  )), { format: 'pptx' });
  assert.ok(repeated.issues.some((entry) => entry.code === 'flat_visual_rhythm'));
  assert.ok(repeated.issues.some((entry) => entry.code === 'repeated_render_composition'));

  const varied = await reviewRenderedOfficePages(Array.from({ length: 6 }, (_, index) => (
    renderedImage(index + 1, (context, width, height) => {
      if (index === 0 || index === 5) {
        context.fillStyle = '#132C3F';
        context.fillRect(0, 0, width, height);
        context.fillStyle = '#FFFFFF';
        context.fillRect(28, 60, 190, 18);
        return;
      }
      const accents = ['#1F7A55', '#A3425A', '#276FBF', '#8F5B24'];
      context.fillStyle = '#F7F9FC';
      context.fillRect(0, 0, width, height);
      context.fillStyle = '#17212C';
      context.fillRect(20, 16, 220, 10);
      context.fillStyle = accents[index - 1];
      if (index === 1) context.fillRect(20, 50, 92, 108);
      if (index === 2) {
        context.fillRect(20, 58, 270, 18);
        context.fillRect(20, 92, 210, 18);
        context.fillRect(20, 126, 145, 18);
      }
      if (index === 3) {
        context.fillRect(172, 46, 120, 112);
        context.fillStyle = '#DCE8F2';
        context.fillRect(20, 46, 124, 48);
      }
      if (index === 4) {
        context.fillRect(20, 54, 72, 90);
        context.fillRect(124, 54, 72, 90);
        context.fillRect(228, 54, 72, 90);
      }
    })
  )), { format: 'pptx' });
  assert.equal(varied.issues.some((entry) => entry.code === 'flat_visual_rhythm'), false);
  assert.equal(varied.issues.some((entry) => entry.code === 'repeated_render_composition'), false);
  assert.equal(varied.aesthetics.scoreVersion, 2);
  assert.deepEqual(
    Object.keys(varied.aesthetics.dimensions),
    ['contrast', 'palette', 'rhythm', 'composition'],
  );
});

test('frontier render review rejects visually inactive content slides even when they are clean', async () => {
  const sparse = await reviewRenderedOfficePages(Array.from({ length: 6 }, (_, index) => (
    renderedImage(index + 1, (context, width, height) => {
      const edge = index === 0 || index === 5;
      context.fillStyle = edge ? '#132C3F' : '#FFFFFF';
      context.fillRect(0, 0, width, height);
      context.fillStyle = edge ? '#FFFFFF' : '#172B25';
      context.fillRect(24, 28, edge ? 190 : 130, 11);
      context.fillStyle = '#20B486';
      context.fillRect(edge ? 230 : 238, edge ? 70 : 116, edge ? 56 : 28, edge ? 64 : 24);
    })
  )), { format: 'pptx' });
  assert.ok(sparse.issues.some((entry) => entry.code === 'under_composed_slide'));
  assert.ok(sparse.issues.some((entry) => entry.code === 'frontier_aesthetic_score_low'));
});

test('render review catches low-contrast Word pages and visually saturated worksheets', async () => {
  const lowContrast = await reviewRenderedOfficePages([
    renderedImage(1, (context) => {
      context.fillStyle = '#DDDDDD';
      context.fillRect(32, 36, 256, 110);
    }, { width: 320, height: 240 }),
  ], { format: 'docx' });
  assert.ok(lowContrast.issues.some((entry) => entry.code === 'low_visual_contrast'));

  const cluttered = await reviewRenderedOfficePages([
    renderedImage(1, (context, width, height) => {
      for (let y = 0; y < height; y += 6) {
        for (let x = 0; x < width; x += 6) {
          context.fillStyle = ((x / 6) + (y / 6)) % 2 ? '#FFFFFF' : '#111111';
          context.fillRect(x, y, 6, 6);
        }
      }
    }),
  ], { format: 'xlsx' });
  assert.ok(cluttered.issues.some((entry) => entry.code === 'worksheet_visual_clutter'));
});

test('palette discipline does not reward rainbow saturation over a restrained accent system', async () => {
  const deck = (rainbow) => Array.from({ length: 6 }, (_, index) => (
    renderedImage(index + 1, (context, width, height) => {
      context.fillStyle = index === 0 || index === 5 ? '#142A3B' : '#F7F9FC';
      context.fillRect(0, 0, width, height);
      context.fillStyle = index === 0 || index === 5 ? '#FFFFFF' : '#18242F';
      context.fillRect(24, 20, 210, 12);
      const colors = rainbow
        ? ['#E53935', '#FB8C00', '#FDD835', '#43A047', '#1E88E5', '#8E24AA']
        : ['#0B8F78'];
      colors.forEach((color, colorIndex) => {
        context.fillStyle = color;
        context.fillRect(24 + (colorIndex * 42), 58, rainbow ? 38 : 248, 82);
      });
    })
  ));
  const disciplined = await reviewRenderedOfficePages(deck(false), { format: 'pptx' });
  const saturated = await reviewRenderedOfficePages(deck(true), { format: 'pptx' });
  assert.ok(
    disciplined.aesthetics.dimensions.palette > saturated.aesthetics.dimensions.palette,
    JSON.stringify({
      disciplined: disciplined.aesthetics.dimensions.palette,
      saturated: saturated.aesthetics.dimensions.palette,
    }),
  );
});

test('role-aware composition allows editorial closing whitespace but expects denser chart evidence', async () => {
  const images = Array.from({ length: 6 }, (_, index) => (
    renderedImage(index + 1, (context, width, height) => {
      context.fillStyle = '#F7F9FC';
      context.fillRect(0, 0, width, height);
      context.fillStyle = '#18313E';
      context.fillRect(28, 34, 110, 12);
      context.fillStyle = '#178D75';
      context.fillRect(222, 112, 34, 24);
    })
  ));
  const closing = await reviewRenderedOfficePages(images, {
    format: 'pptx',
    pageRoles: { 3: 'decision-close' },
  });
  const chart = await reviewRenderedOfficePages(images, {
    format: 'pptx',
    pageRoles: { 3: 'annotated-chart' },
  });
  assert.ok(
    closing.aesthetics.pages[2].densityFit > chart.aesthetics.pages[2].densityFit,
    JSON.stringify({
      closing: closing.aesthetics.pages[2],
      chart: chart.aesthetics.pages[2],
    }),
  );
});

test('release quality score combines render evidence, structural penalties, and confidence', () => {
  const clean = scoreOfficeReleaseQuality({
    format: 'pptx',
    aesthetics: { score: 0.73 },
    issues: [],
    renderedPages: 6,
    expectedPages: 6,
    structuralAvailable: true,
    planCoverage: 1,
  });
  const flawed = scoreOfficeReleaseQuality({
    format: 'pptx',
    aesthetics: { score: 0.73 },
    issues: [{ severity: 'warning', code: 'small_font' }],
    renderedPages: 6,
    expectedPages: 6,
    structuralAvailable: true,
    planCoverage: 1,
  });
  assert.equal(clean.version, 2);
  assert.equal(clean.confidence, 1);
  assert.equal(clean.releaseReady, true);
  assert.equal(flawed.releaseReady, false);
  assert.ok(flawed.score < clean.score);
  assert.ok(flawed.dimensions.structural < clean.dimensions.structural);
});

test('deck review recognizes repeated layout grammar despite small coordinate changes', () => {
  const slides = Array.from({ length: 7 }, (_, index) => ({
    index: index + 1,
    background: { color: 'F7F9FC', followMaster: false, source: 'slide' },
    shapes: [
      {
        type: 17,
        text: `Decision ${index + 1}`,
        left: 58 + index,
        top: 46,
        width: 780,
        height: 70,
        font: { size: 40 },
      },
      {
        type: 13,
        text: '',
        left: 510 + index,
        top: 170,
        width: 360,
        height: 250,
      },
      {
        type: 17,
        text: 'Supporting evidence',
        left: 70,
        top: 190 + index,
        width: 360,
        height: 90,
        font: { size: 18 },
      },
    ],
  }));
  const review = reviewOfficeDesign({
    format: 'pptx',
    document: {
      slideWidth: 960,
      slideHeight: 540,
      slides,
    },
    design: {
      intent: 'Approve the operating plan',
      signature: 'evidence-led operating decision',
      deck: { backgroundMode: 'custom' },
      slidePlans: slides.map((slide) => ({
        slide: slide.index,
        visualType: 'image',
      })),
    },
  });
  assert.ok(review.issues.some((entry) => entry.code === 'repeated_layout_grammar'));
  assert.ok(review.issues.some((entry) => entry.code === 'visual_role_variety_low'));
});
