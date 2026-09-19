import assert from 'node:assert/strict';
import test from 'node:test';

import { createCanvas } from '@napi-rs/canvas';

import { reviewRenderedOfficePages } from './quality/assurance.mjs';
import { resolveOfficeDesign } from './design/design-system.mjs';
import { scoreOfficeReleaseQuality } from './quality/quality-score.mjs';
import { reviewOfficeDesign } from './quality/design-review.mjs';
import { reviewPptxDeckDiversity } from './quality/design-deck-diversity.mjs';
import { isAdvisoryOfficeIssue } from './quality/quality-pipeline.mjs';

function renderedImage(page, draw, { width = 320, height = 180 } = {}) {
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
  const repeated = await reviewRenderedOfficePages(
    Array.from({ length: 6 }, (_, index) =>
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
    ),
    { format: 'pptx' }
  );
  assert.ok(repeated.issues.some((entry) => entry.code === 'flat_visual_rhythm'));
  assert.ok(repeated.issues.some((entry) => entry.code === 'repeated_render_composition'));

  const varied = await reviewRenderedOfficePages(
    Array.from({ length: 6 }, (_, index) =>
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
    ),
    { format: 'pptx' }
  );
  assert.equal(
    varied.issues.some((entry) => entry.code === 'flat_visual_rhythm'),
    false
  );
  assert.equal(
    varied.issues.some((entry) => entry.code === 'repeated_render_composition'),
    false
  );
  assert.equal(varied.aesthetics.scoreVersion, 2);
  assert.deepEqual(Object.keys(varied.aesthetics.dimensions), ['contrast', 'palette', 'rhythm', 'composition']);
});

test('frontier render review rejects visually inactive content slides even when they are clean', async () => {
  const sparse = await reviewRenderedOfficePages(
    Array.from({ length: 6 }, (_, index) =>
      renderedImage(index + 1, (context, width, height) => {
        const edge = index === 0 || index === 5;
        context.fillStyle = edge ? '#132C3F' : '#FFFFFF';
        context.fillRect(0, 0, width, height);
        // A content page under the frontier tenth percentile on both reads: a
        // short title line and one small mark on an otherwise empty canvas.
        context.fillStyle = edge ? '#FFFFFF' : '#172B25';
        context.fillRect(24, 28, edge ? 190 : 90, edge ? 11 : 8);
        context.fillStyle = '#20B486';
        context.fillRect(edge ? 230 : 238, edge ? 70 : 116, edge ? 56 : 12, edge ? 64 : 10);
      })
    ),
    { format: 'pptx' }
  );
  assert.ok(sparse.issues.some((entry) => entry.code === 'under_composed_slide'));
  assert.ok(sparse.issues.some((entry) => entry.code === 'frontier_aesthetic_score_low'));
});

test('render review catches low-contrast Word pages and visually saturated worksheets', async () => {
  const lowContrast = await reviewRenderedOfficePages(
    [
      renderedImage(
        1,
        (context) => {
          context.fillStyle = '#DDDDDD';
          context.fillRect(32, 36, 256, 110);
        },
        { width: 320, height: 240 }
      ),
    ],
    { format: 'docx' }
  );
  assert.ok(lowContrast.issues.some((entry) => entry.code === 'low_visual_contrast'));

  const cluttered = await reviewRenderedOfficePages(
    [
      renderedImage(1, (context, width, height) => {
        for (let y = 0; y < height; y += 6) {
          for (let x = 0; x < width; x += 6) {
            context.fillStyle = (x / 6 + y / 6) % 2 ? '#FFFFFF' : '#111111';
            context.fillRect(x, y, 6, 6);
          }
        }
      }),
    ],
    { format: 'xlsx' }
  );
  assert.ok(cluttered.issues.some((entry) => entry.code === 'worksheet_visual_clutter'));
});

test('palette discipline does not reward rainbow saturation over a restrained accent system', async () => {
  const deck = (rainbow) =>
    Array.from({ length: 6 }, (_, index) =>
      renderedImage(index + 1, (context, width, height) => {
        context.fillStyle = index === 0 || index === 5 ? '#142A3B' : '#F7F9FC';
        context.fillRect(0, 0, width, height);
        context.fillStyle = index === 0 || index === 5 ? '#FFFFFF' : '#18242F';
        context.fillRect(24, 20, 210, 12);
        const colors = rainbow ? ['#E53935', '#FB8C00', '#FDD835', '#43A047', '#1E88E5', '#8E24AA'] : ['#0B8F78'];
        colors.forEach((color, colorIndex) => {
          context.fillStyle = color;
          context.fillRect(24 + colorIndex * 42, 58, rainbow ? 38 : 248, 82);
        });
      })
    );
  const disciplined = await reviewRenderedOfficePages(deck(false), { format: 'pptx' });
  const saturated = await reviewRenderedOfficePages(deck(true), { format: 'pptx' });
  assert.ok(
    disciplined.aesthetics.dimensions.palette > saturated.aesthetics.dimensions.palette,
    JSON.stringify({
      disciplined: disciplined.aesthetics.dimensions.palette,
      saturated: saturated.aesthetics.dimensions.palette,
    })
  );
});

test('role-aware composition allows editorial closing whitespace but expects denser chart evidence', async () => {
  const images = Array.from({ length: 6 }, (_, index) =>
    renderedImage(index + 1, (context, width, height) => {
      context.fillStyle = '#F7F9FC';
      context.fillRect(0, 0, width, height);
      context.fillStyle = '#18313E';
      context.fillRect(28, 34, 110, 12);
      context.fillStyle = '#178D75';
      context.fillRect(222, 112, 34, 24);
    })
  );
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
    })
  );
});

test('a statement beat is judged as a section, not as an under-composed content slide', async () => {
  const sparse = (page) =>
    renderedImage(page, (context) => {
      context.fillStyle = '#0B1F33';
      context.fillRect(0, 0, 320, 180);
      context.fillStyle = '#F7FAFC';
      context.fillRect(28, 60, 90, 12);
    });
  const images = [1, 2, 3, 4, 5].map(sparse);
  const asContent = await reviewRenderedOfficePages(images, { format: 'pptx' });
  const asBeat = await reviewRenderedOfficePages(images, {
    format: 'pptx',
    pageRoles: { 2: { slideRole: 'section', visualType: 'metric' } },
  });
  const underComposed = (review) =>
    review.issues.filter((issue) => issue.code === 'under_composed_slide').map((issue) => issue.path);
  assert.ok(underComposed(asContent).includes('/slide[2]'));
  assert.equal(underComposed(asBeat).includes('/slide[2]'), false);
  assert.equal(asBeat.aesthetics.pages[1].role, 'section');
});

test('a diagram slide is held to a lower under-composed floor than a text slide', async () => {
  // Light tinted fields and one hairline: what a brace-group or 2×2 slide leaves for the sampler.
  const diagram = (page) =>
    renderedImage(page, (context) => {
      context.fillStyle = '#F7F9FC';
      context.fillRect(0, 0, 320, 180);
      context.fillStyle = '#18242F';
      context.fillRect(24, 20, 100, 9);
      context.fillStyle = '#EEF2F6';
      context.fillRect(24, 50, 130, 110);
      context.fillRect(166, 50, 130, 110);
      context.fillStyle = '#178D75';
      context.fillRect(60, 100, 40, 6);
    });
  const images = [1, 2, 3, 4, 5].map(diagram);
  const asContent = await reviewRenderedOfficePages(images, { format: 'pptx' });
  const asDiagram = await reviewRenderedOfficePages(images, {
    format: 'pptx',
    pageRoles: { 3: { visualType: 'diagram' } },
  });
  const underComposed = (review) =>
    review.issues.filter((issue) => issue.code === 'under_composed_slide').map((issue) => issue.path);
  assert.ok(underComposed(asContent).includes('/slide[3]'));
  assert.equal(underComposed(asDiagram).includes('/slide[3]'), false);
  assert.equal(asDiagram.aesthetics.pages[2].role, 'diagram');
  assert.ok(asDiagram.aesthetics.pages[2].densityFit > asContent.aesthetics.pages[2].densityFit);
});

// Past twelve pages the render groups pages into contact sheets; the review
// must read the pages the sheet carries, never the sheet's grey field.
test('the render review reads the pages behind a contact sheet, not the sheet', async () => {
  const page = (number, dark) =>
    renderedImage(number, (context, width, height) => {
      context.fillStyle = dark ? '#0B1F33' : '#F7F9FC';
      context.fillRect(0, 0, width, height);
      context.fillStyle = dark ? '#F7FAFC' : '#18242F';
      context.fillRect(24, 20, 150, 12);
      context.fillStyle = '#178D75';
      context.fillRect(24, 50, 120, 90);
    });
  const sheet = (first, numbers) => ({
    ...renderedImage(first, (context, width, height) => {
      context.fillStyle = '#EEF0F4';
      context.fillRect(0, 0, width, height);
    }),
    pages: numbers,
    pageImages: numbers.map((number) => page(number, number === 1 || number === 6)),
  });
  const review = await reviewRenderedOfficePages([sheet(1, [1, 2, 3]), sheet(4, [4, 5, 6])], { format: 'pptx' });
  assert.deepEqual(
    review.aesthetics.pages.map((entry) => entry.page),
    [1, 2, 3, 4, 5, 6]
  );
  assert.equal(review.aesthetics.pages[0].role, 'opening');
  assert.equal(review.aesthetics.pages[5].role, 'closing');
  assert.ok(
    review.aesthetics.pages.every((entry) => entry.backgroundLuminance < 0.2 || entry.backgroundLuminance > 0.9),
    'every measured page is a deck page, not the grey sheet'
  );
});

test('PPTX diagnostics retain measured differences without approving the visual design', () => {
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
  assert.equal(clean.version, 3);
  assert.equal(clean.confidence, 1);
  assert.equal(clean.releaseReady, false);
  assert.equal(clean.automatedReady, true);
  assert.equal(clean.visualReview.status, 'not-reviewed');
  assert.equal(clean.scoreMeaning, 'automated-diagnostics-not-design-quality');
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

// Three of the same page in a row is what a reader notices at contact-sheet scale, even when the rest
// of the deck varies; and a kit structure signs its kind, so a timeline page and a hub page are two
// Three dark or field pages in a row past the front matter are a hole in the argument; beats on more than three
// pages in ten are a slideshow of covers (the reference decks run one in eight). A deck that is dark throughout
// is a theme, and neither reading applies.
test('deck review reports three consecutive beats and a deck that is mostly beats, and lets a dark theme through', () => {
  const beat = (index, color = '0F1B26') => ({
    index,
    background: { color },
    shapes: [{ type: 17, text: `Beat ${index}`, left: 58, top: 200, width: 700, height: 120, font: { size: 44 } }],
  });
  const evidence = (index) => ({
    index,
    background: { color: 'F7F9FC' },
    shapes: [
      { type: 17, text: `Title ${index}`, left: 58, top: 46, width: 780, height: 70, font: { size: 40 } },
      { chart: { type: index % 2 ? 'bar' : 'line' }, left: 58, top: 150, width: 800 - index * 7, height: 340 },
    ],
  });
  const review = (slides) =>
    reviewOfficeDesign({
      format: 'pptx',
      document: { slideWidth: 960, slideHeight: 540, slides },
      design: { intent: 'Approve the plan', signature: 'structure-led', deck: { backgroundMode: 'custom' } },
    }).issues;
  const run = review([
    beat(1),
    evidence(2),
    evidence(3),
    beat(4),
    beat(5),
    beat(6),
    evidence(7),
    evidence(8),
    evidence(9),
    beat(10),
  ]);
  const consecutive = run.find((entry) => entry.code === 'consecutive_beats');
  assert.ok(consecutive, 'three beats in a row are reported');
  assert.match(consecutive.message, /Slides 4-6/);
  assert.ok(
    run.some((entry) => entry.code === 'beat_share_high'),
    '3 of the 8 slides between the cover and the closing are beats'
  );
  const covers = review([beat(1), beat(2), evidence(3), evidence(4), evidence(5), evidence(6), evidence(7), beat(8)]);
  assert.equal(
    covers.some((entry) => entry.code === 'beat_share_high'),
    false,
    'one agenda beat among six inner pages is the ordinary shape'
  );
  assert.equal(
    covers.some((entry) => entry.code === 'consecutive_beats'),
    false,
    'two beats in the front matter and the closing are the ordinary shape'
  );
  const theme = review(
    Array.from({ length: 10 }, (_, i) =>
      i % 3 === 2 ? { ...evidence(i + 1), background: { color: '0F1B26' } } : beat(i + 1)
    )
  );
  assert.equal(
    theme.some((entry) => entry.code === 'beat_share_high'),
    false,
    'a deck dark on every page is a theme, not beats'
  );
  assert.equal(isAdvisoryOfficeIssue({ code: 'beat_share_high' }), true);
  assert.equal(isAdvisoryOfficeIssue({ code: 'consecutive_beats' }), false);
});

// A body page with one short sentence and no carrier is turned without being read; the same sentence beside a
// chart is a reading. The cover and the closing are statements by their job.
test('deck review reports a body page that carries one sentence and nothing else', () => {
  const title = (index) => ({
    type: 17,
    text: `Title ${index}`,
    left: 58,
    top: 46,
    width: 780,
    height: 70,
    font: { size: 40 },
  });
  const thin = (index) => ({
    index,
    background: { color: 'F7F9FC' },
    shapes: [
      title(index),
      { type: 17, text: '대기 시간이 줄었다.', left: 58, top: 200, width: 600, height: 40, font: { size: 15 } },
    ],
  });
  const charted = (index) => ({
    index,
    background: { color: 'F7F9FC' },
    shapes: [
      title(index),
      { type: 17, text: '대기 시간이 줄었다.', left: 58, top: 200, width: 300, height: 40, font: { size: 15 } },
      { chart: { type: 'bar' }, left: 400, top: 150, width: 500, height: 340 },
    ],
  });
  const cover = (index) => ({
    index,
    background: { color: '0F1B26' },
    shapes: [{ type: 17, text: `Beat ${index}`, left: 58, top: 200, width: 700, height: 120, font: { size: 44 } }],
  });
  const review = (slides) =>
    reviewOfficeDesign({
      format: 'pptx',
      document: { slideWidth: 960, slideHeight: 540, slides },
      design: { intent: 'Approve the plan', signature: 'structure-led', deck: { backgroundMode: 'custom' } },
    }).issues;
  const issues = review([cover(1), charted(2), thin(3), charted(4), cover(5)]);
  const underfill = issues.filter((entry) => entry.code === 'page_underfill');
  assert.equal(underfill.length, 1, JSON.stringify(issues.map((entry) => entry.code)));
  assert.equal(underfill[0].path, '/slide[3]');
  assert.equal(isAdvisoryOfficeIssue({ code: 'page_underfill' }), true);
  assert.equal(
    review([cover(1), charted(2), charted(3), cover(4)]).some((entry) => entry.code === 'page_underfill'),
    false,
    'a sentence beside a chart is a reading'
  );
});

// visual types although both are drawn from ellipses and lines.
test('deck review reports three consecutive same compositions and reads signed structures as distinct types', () => {
  const page = (index, kind, { name = '' } = {}) => ({
    index,
    background: { color: 'F7F9FC', followMaster: false, source: 'slide' },
    shapes: [
      { type: 17, text: `Point ${index}`, left: 58, top: 46, width: 780, height: 70, font: { size: 40 } },
      { type: 1, text: '', geometry: 'ellipse', left: 120, top: 200, width: 60, height: 60 },
      { type: 17, text: kind, name, left: 200, top: 210, width: 300, height: 40, font: { size: 14 } },
    ],
  });
  const review = (slides) =>
    reviewOfficeDesign({
      format: 'pptx',
      document: { slideWidth: 960, slideHeight: 540, slides },
      design: { intent: 'Approve the plan', signature: 'structure-led', deck: { backgroundMode: 'custom' } },
    }).issues;
  // Cover, three identical node pages, three different pages, closing: the run is reported, the ratio is not (3 of 6 < 0.6).
  const varied = [
    page(1, 'cover'),
    page(2, 'node'),
    page(3, 'node'),
    page(4, 'node'),
    {
      index: 5,
      background: { color: 'F7F9FC' },
      shapes: [{ type: 17, text: 'Claim', left: 58, top: 200, width: 700, height: 120, font: { size: 44 } }],
    },
    {
      index: 6,
      background: { color: 'F7F9FC' },
      shapes: [
        { type: 17, text: 'Title', left: 58, top: 46, width: 780, height: 70, font: { size: 40 } },
        { chart: { type: 'bar' }, left: 58, top: 150, width: 800, height: 340 },
      ],
    },
    {
      index: 7,
      background: { color: 'F7F9FC' },
      shapes: [
        { type: 17, text: 'Title', left: 58, top: 46, width: 780, height: 70, font: { size: 40 } },
        { table: { rows: 3 }, left: 58, top: 150, width: 800, height: 300 },
      ],
    },
    page(8, 'closing'),
  ];
  const run = review(varied).find((entry) => entry.code === 'consecutive_composition_repeat');
  assert.ok(run, 'three identical pages in a row are reported');
  assert.match(run.message, /Slides 2-4/);
  assert.equal(
    review(varied).some((entry) => entry.code === 'repeated_layout_grammar'),
    false
  );
  // The same three pages carrying three different signed structures are three visual types: no run.
  const signed = varied.map((slide, index) => {
    if (index < 1 || index > 3) return slide;
    const structure = ['timeline', 'hub', 'tiers'][index - 1];
    return {
      ...slide,
      shapes: slide.shapes.map((shape) =>
        shape.text === 'node' ? { ...shape, name: `mixdog-spec:structure:${structure}` } : shape
      ),
    };
  });
  assert.equal(
    review(signed).some((entry) => entry.code === 'consecutive_composition_repeat'),
    false
  );
  // The measured verdicts are targets, not information.
  assert.equal(isAdvisoryOfficeIssue({ code: 'consecutive_composition_repeat' }), false);
  assert.equal(isAdvisoryOfficeIssue({ code: 'repeated_layout_grammar' }), false);

  // A style carries a decoration set, so two anchors in a row drawing one device is the same page twice. The kit
  // writes the device into the picture's description, which is where the run is read from.
  const decorated = (kinds) =>
    review(
      varied.map((slide, index) =>
        kinds[index]
          ? {
              ...slide,
              shapes: [
                ...slide.shapes,
                { type: 13, altText: `${kinds[index]} motif`, left: 0, top: 0, width: 960, height: 540 },
              ],
            }
          : slide
      )
    );
  const repeatedDevice = decorated(['rings', '', '', '', 'rings', 'rings']).find(
    (entry) => entry.code === 'repeated_decoration'
  );
  assert.ok(repeatedDevice, 'one device on two pages in a row is reported');
  assert.match(repeatedDevice.message, /Slides 5-6/);
  assert.match(repeatedDevice.message, /rings/);
  // The same two pages taking the set's two devices, and one device echoed across the deck, are not runs.
  assert.equal(
    decorated(['rings', '', '', '', 'rings', 'arcs']).some((entry) => entry.code === 'repeated_decoration'),
    false
  );
  assert.equal(
    decorated(['rings', '', '', '', '', '', '', 'rings']).some((entry) => entry.code === 'repeated_decoration'),
    false
  );
  assert.equal(isAdvisoryOfficeIssue({ code: 'repeated_decoration' }), false);
});

// An authored deck declares its directions on the brief's own line, and the check read only the composer's payload:
// every authored deck was told it had no art direction, however carefully its brief compared the two compositions
// the skill asks for.
test('the art direction reading accepts the directions an authored brief declares', () => {
  const document = {
    slideWidth: 960,
    slideHeight: 540,
    slides: [1, 2, 3].map((index) => ({
      index,
      shapes: [{ type: 17, text: `쪽 ${index}`, left: 58, top: 46, width: 780, height: 70, font: { size: 40 } }],
    })),
  };
  const codes = (design) => reviewPptxDeckDiversity({ document, design }).map((entry) => entry.code);
  assert.ok(codes({}).includes('art_direction_candidates_missing'), 'a deck with neither payload nor brief is named');
  const brief = {
    directions: {
      candidates: [
        { id: 'A', text: 'editorial' },
        { id: 'B', text: 'swiss-minimal' },
      ],
      selected: 'A',
    },
  };
  assert.equal(codes({ brief }).includes('art_direction_candidates_missing'), false);
  // The brief must still say which one it took, and compare more than one.
  assert.ok(
    codes({ brief: { directions: { candidates: brief.directions.candidates, selected: '' } } }).includes(
      'art_direction_candidates_missing'
    )
  );
  assert.ok(
    codes({ brief: { directions: { candidates: [{ id: 'A', text: 'editorial' }], selected: 'A' } } }).includes(
      'art_direction_candidates_missing'
    )
  );
});
