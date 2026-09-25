import { slideReceipt } from '../authoring/pptx-receipt.mjs';
import { isPictureShape } from '../design/design-discipline.mjs';

function issue(code, message) {
  return {
    severity: 'warning',
    code,
    path: '/',
    message,
    source: 'design-review',
  };
}

// The deck's shape, read from the page grammar the receipt assigns (beat | evidence | text). Thirteen reference
// decks (400 pages) run beats — dark or field pages — on 0-21% of their pages (median 13%) and never three in a
// row past the front matter; the one deck above that (Krafton, 38%) is dark on three pages in four, which is a
// theme, not beats. Beats on more than three pages in ten is a slideshow of covers; three in a row is a hole
// in the argument where the reader waits for content.
function deckShapeIssues(slides) {
  const receipts = slides.map((slide) => slideReceipt(slide));
  const grammar = receipts.map((receipt) => receipt.grammar);
  // The cover and the closing are beats by their job; the share is read over the pages between them.
  const inner = grammar.slice(1, -1);
  const beats = inner.filter((value) => value === 'beat').length;
  const dark = receipts.filter((receipt) => receipt.background === 'dark').length;
  const issues = [];
  if (slides.length >= 8 && beats / inner.length > 0.25 && dark / slides.length < 0.6) {
    issues.push(
      issue(
        'beat_share_high',
        `${beats} of the ${inner.length} slides between the cover and the closing are beats (dark or field pages); the reference decks run one in eight. Give the body pages their evidence and keep the field for the section marks.`
      )
    );
  }
  let run = 0;
  for (let index = 0; index < grammar.length; index += 1) {
    run = grammar[index] === 'beat' ? run + 1 : 0;
    // The first three slides may be front matter (cover, disclaimer, agenda); a run that ends inside them is not read.
    if (run === 3 && index >= 3) {
      const first = Number(slides[index - 2]?.index) || index - 1;
      issues.push(
        issue(
          'consecutive_beats',
          `Slides ${first}-${first + 2} are three beats in a row (dark or field pages with no evidence); a beat opens or closes a run of content pages, it never replaces them.`
        )
      );
      break;
    }
  }
  // A body page that carries one sentence and nothing else — no chart, table, picture, or structure — is a page
  // the reader turns without learning anything (the bento generators call it underfill at under 80 characters;
  // the reference body pages carry 330-900). The cover, the closing, and the beats are statements by their job.
  receipts.forEach((receipt, index) => {
    if (index === 0 || index === receipts.length - 1 || receipt.grammar === 'beat') return;
    // A structure the kit draws (lanes, a hub, a loop, the agenda) is the page's carrier as much as a chart is: the
    // receipt reads its signature as evidence, and a three-lane plan with 73 characters of labels is not a hollow.
    const structures = receipt.specs?.structure?.count || 0;
    const carriers =
      (receipt.charts || 0) + (receipt.tables || 0) + (receipt.pictures || 0) + (receipt.groups || 0) + structures;
    if (carriers > 0 || typeof receipt.chars !== 'number' || receipt.chars >= 80) return;
    issues.push({
      ...issue(
        'page_underfill',
        `Slide ${slides[index]?.index ?? index + 1} carries ${receipt.chars} characters and no chart, table, picture, or structure; a body page needs its payload or belongs to the page it introduces.`
      ),
      path: `/slide[${slides[index]?.index ?? index + 1}]`,
    });
  });
  return issues;
}

function shapeRole(shape) {
  if (shape?.chart) return 'chart';
  if (shape?.table) return 'table';
  if (isPictureShape(shape)) return 'image';
  if (shape?.group) return 'group';
  const text = String(shape?.text || '').trim();
  if (!text) return 'shape';
  const size = Number(shape?.font?.size) || 0;
  if (size >= 32) return 'title';
  if (size > 0 && size <= 12) return 'caption';
  return 'text';
}

function sizeBucket(value, total) {
  const ratio = total > 0 ? value / total : 0;
  if (ratio >= 0.62) return 'wide';
  if (ratio >= 0.3) return 'medium';
  return 'small';
}

function positionBucket(value, total) {
  if (total <= 0) return 0;
  return Math.min(2, Math.max(0, Math.floor((value / total) * 3)));
}

function layoutGrammarSignature(slide, canvas) {
  return (slide?.shapes || [])
    .filter((shape) => String(shape?.text || '').trim() || shapeRole(shape) !== 'shape')
    .map((shape) => {
      const left = Number(shape?.left) || 0;
      const top = Number(shape?.top) || 0;
      const width = Number(shape?.width) || 0;
      const height = Number(shape?.height) || 0;
      return [
        shapeRole(shape),
        positionBucket(left + width / 2, canvas.width),
        positionBucket(top + height / 2, canvas.height),
        sizeBucket(width, canvas.width),
        sizeBucket(height, canvas.height),
      ].join(':');
    })
    .sort()
    .join('|');
}

// Native preset geometry families, each a distinct evidence structure. Rect
// and line are surfaces and rules, not structures, so they fall through.
const GEOMETRY_FAMILIES = [
  [
    'process',
    /^(chevron|homePlate|rightArrow|leftArrow|leftRightArrow|upArrow|downArrow|bentArrow|curvedRightArrow|notchedRightArrow)$/,
  ],
  ['share', /^(blockArc|pie|donut|arc)$/],
  ['tiers', /^(trapezoid|triangle|funnel)$/],
  ['silhouette', /^(custGeom|parallelogram|hexagon|diamond)$/],
  ['module', /^(roundRect|round1Rect|round2SameRect|snip1Rect|snip2SameRect|snipRoundRect|frame)$/],
  ['callout', /^(wedgeRectCallout|wedgeRoundRectCallout|wedgeEllipseCallout|cloudCallout)$/],
  ['bracket', /^(leftBrace|rightBrace|bracePair|leftBracket|rightBracket|bracketPair)$/],
  ['node', /^ellipse$/],
];

function geometryFamily(slide) {
  const geometries = new Set((slide?.shapes || []).map((shape) => String(shape?.geometry || '')).filter(Boolean));
  for (const [family, pattern] of GEOMETRY_FAMILIES) {
    if ([...geometries].some((geometry) => pattern.test(geometry))) return family;
  }
  return '';
}

function isMetricText(shape) {
  const text = String(shape?.text || '').trim();
  return (Number(shape?.font?.size) || 0) >= 36 && /^[+\-−]?\d/.test(text) && text.length <= 12;
}

// The kit signs its carriers (`mixdog-spec:<carrier>[:<variant>]`, pptx-receipt.mjs); a signed structure
// names the slide's visual type exactly (a timeline is not "a diagram"), and a signed stat, chevron
// run, or table names its family before the geometry guess.
const SPEC_PREFIX = 'mixdog-spec:';
function signedVisualType(slide) {
  const signatures = (slide?.shapes || [])
    .map((shape) => String(shape?.name || ''))
    .filter((name) => name.startsWith(SPEC_PREFIX))
    .map((name) => name.slice(SPEC_PREFIX.length).split(':'));
  const structure = signatures.find(([spec, variant]) => spec === 'structure' && variant);
  if (structure) return `structure:${structure[1]}`;
  if (signatures.some(([spec]) => spec === 'chevrons')) return 'process';
  if (signatures.some(([spec]) => spec === 'table')) return 'table';
  if (signatures.some(([spec]) => spec === 'stat')) return 'metric';
  return '';
}

function inferredVisualType(slide) {
  const shapes = slide?.shapes || [];
  const roles = new Set(shapes.map(shapeRole));
  if (roles.has('chart')) return 'chart';
  if (roles.has('table')) return 'table';
  const signed = signedVisualType(slide);
  if (signed) return signed;
  const family = geometryFamily(slide);
  if (family) return family;
  if (roles.has('image')) return 'image';
  if (shapes.some(isMetricText)) return 'metric';
  if (roles.has('group') || roles.has('shape')) return 'diagram';
  return 'typography';
}

// The decoration a page carries, read from the description the kit writes on its device ("rings motif"). A style
// runs a set of devices, not one, and an anchor that names no kind takes the next of the set, so two pages in a
// row drawing the same device are one page twice however their type differs (composition.md §3 — three devices,
// one deck). A page with no device reads as its own kind and never joins a run.
const MOTIF_DESCRIPTION = /^([a-z]+) motif$/i;
function decorationKind(slide) {
  for (const shape of slide?.shapes || []) {
    const match = MOTIF_DESCRIPTION.exec(String(shape?.altText || '').trim());
    if (match) return match[1].toLowerCase();
  }
  return '';
}

// The longest run of consecutive content slides that share one coarse grammar and one visual type:
// the third same page in a row is what a reader notices first at contact-sheet scale.
function longestRepeatRun(entries) {
  let best = { length: 0, start: 0 };
  let start = 0;
  for (let index = 1; index <= entries.length; index += 1) {
    if (index < entries.length && entries[index] === entries[index - 1]) continue;
    if (index - start > best.length) best = { length: index - start, start };
    start = index;
  }
  return best;
}

function layoutGrammarIssue(content, grammar) {
  const signatures = new Map();
  for (const signature of grammar) {
    if (signature) signatures.set(signature, (signatures.get(signature) || 0) + 1);
  }
  const repeated = Math.max(0, ...signatures.values());
  if (content.length < 4 || repeated / content.length < 0.6) return null;
  return issue(
    'repeated_layout_grammar',
    `${repeated} of ${content.length} content slides reuse the same coarse layout grammar.`
  );
}

function compositionRepeatIssue(content, grammar, visualTypes) {
  const run = longestRepeatRun(
    grammar.map((signature, index) => (signature ? `${signature}\u0000${visualTypes[index]}` : `\u0000${index}`))
  );
  if (run.length < 3) return null;
  const first = Number(content[run.start]?.index) || run.start + 2;
  const last = Number(content[run.start + run.length - 1]?.index) || first + run.length - 1;
  return issue(
    'consecutive_composition_repeat',
    `Slides ${first}-${last} repeat one composition (${visualTypes[run.start]}) ${run.length} pages in a row; change the structure where the meaning changes, or merge the pages.`
  );
}

function decorationRepeatIssue(slides) {
  const decorations = slides.map((slide) => decorationKind(slide));
  const run = longestRepeatRun(decorations.map((kind, index) => kind || `\u0000${index}`));
  if (run.length < 2) return null;
  const first = Number(slides[run.start]?.index) || run.start + 1;
  const last = Number(slides[run.start + run.length - 1]?.index) || first + run.length - 1;
  return issue(
    'repeated_decoration',
    `Slides ${first}-${last} draw the same ${decorations[run.start]} device ${run.length} pages in a row; take the next device of the deck's set on the later page, or leave it undecorated.`
  );
}

function visualVarietyIssue(content, visualTypes) {
  const unique = new Set(visualTypes.filter(Boolean)).size;
  const required = Math.min(3, Math.ceil(content.length / 2));
  if (content.length < 5 || unique >= required) return null;
  return issue(
    'visual_role_variety_low',
    `The deck uses ${unique} visual role(s) across ${content.length} content slides; use at least ${required}.`
  );
}

// An authored deck declares its directions on the brief's `directions:` line — the two compared compositions and
// the one selected, which is what the skill asks for; the composer's own route builds three candidates instead.
// Reading only the composer's payload told every authored deck it had no art direction, whatever its brief said.
function artDirectionIssue(design) {
  const briefDirections = design?.brief?.directions;
  const composed = design?.artDirection?.candidates || [];
  const directionCandidates = composed.length ? composed : briefDirections?.candidates || [];
  const selected = design?.artDirection?.selected?.id || (composed.length ? '' : briefDirections?.selected || '');
  const required = composed.length || !briefDirections ? 3 : 2;
  if (directionCandidates.length >= required && selected) return null;
  return issue(
    'art_direction_candidates_missing',
    'The deck has no selected art direction backed by three distinct candidates.'
  );
}

export function reviewPptxDeckDiversity({ document, design } = {}) {
  if (design?.review?.allowRepetition) return [];
  const slides = Array.isArray(document?.slides) ? document.slides : [];
  const content = slides.length >= 3 ? slides.slice(1, -1) : slides.slice(1);
  if (!content.length) return [];
  const canvas = {
    width: Number(document?.slideWidth) || Number(design?.format?.canvasWidth) || 960,
    height: Number(document?.slideHeight) || Number(design?.format?.canvasHeight) || 540,
  };
  const grammar = content.map((slide) => layoutGrammarSignature(slide, canvas));
  const plans = new Map((design?.slidePlans || []).map((plan) => [Number(plan?.slide), plan]));
  const visualTypes = content.map(
    (slide) => String(plans.get(Number(slide?.index))?.visualType || '').toLowerCase() || inferredVisualType(slide)
  );
  return [
    layoutGrammarIssue(content, grammar),
    compositionRepeatIssue(content, grammar, visualTypes),
    decorationRepeatIssue(slides),
    visualVarietyIssue(content, visualTypes),
    ...deckShapeIssues(slides),
    artDirectionIssue(design),
  ].filter(Boolean);
}
