function issue(code, message) {
  return {
    severity: 'warning',
    code,
    path: '/',
    message,
    source: 'design-review',
  };
}

function isPicture(shape) {
  return Number(shape?.type) === 13 || shape?.type === 'p:pic';
}

function shapeRole(shape) {
  if (shape?.chart) return 'chart';
  if (shape?.table) return 'table';
  if (isPicture(shape)) return 'image';
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
        positionBucket(left + (width / 2), canvas.width),
        positionBucket(top + (height / 2), canvas.height),
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
  ['process', /^(chevron|homePlate|rightArrow|leftArrow|leftRightArrow|upArrow|downArrow|bentArrow|curvedRightArrow|notchedRightArrow)$/],
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

function inferredVisualType(slide) {
  const shapes = slide?.shapes || [];
  const roles = new Set(shapes.map(shapeRole));
  if (roles.has('chart')) return 'chart';
  if (roles.has('table')) return 'table';
  const family = geometryFamily(slide);
  if (family) return family;
  if (roles.has('image')) return 'image';
  if (shapes.some(isMetricText)) return 'metric';
  if (roles.has('group') || roles.has('shape')) return 'diagram';
  return 'typography';
}

export function reviewPptxDeckDiversity({
  document,
  design,
} = {}) {
  if (design?.review?.allowRepetition) return [];
  const slides = Array.isArray(document?.slides) ? document.slides : [];
  const content = slides.length >= 3 ? slides.slice(1, -1) : slides.slice(1);
  if (!content.length) return [];
  const canvas = {
    width: Number(document?.slideWidth) || Number(design?.format?.canvasWidth) || 960,
    height: Number(document?.slideHeight) || Number(design?.format?.canvasHeight) || 540,
  };
  const signatures = new Map();
  for (const slide of content) {
    const signature = layoutGrammarSignature(slide, canvas);
    if (signature) signatures.set(signature, (signatures.get(signature) || 0) + 1);
  }
  const repeated = Math.max(0, ...signatures.values());
  const plans = new Map((design?.slidePlans || []).map((plan) => [Number(plan?.slide), plan]));
  const visualTypes = content.map((slide) => (
    String(plans.get(Number(slide?.index))?.visualType || '').toLowerCase()
      || inferredVisualType(slide)
  ));
  const uniqueVisualTypes = new Set(visualTypes.filter(Boolean));
  const issues = [];
  if (content.length >= 4 && repeated / content.length >= 0.6) {
    issues.push(issue(
      'repeated_layout_grammar',
      `${repeated} of ${content.length} content slides reuse the same coarse layout grammar.`,
    ));
  }
  const requiredVisualTypes = Math.min(3, Math.ceil(content.length / 2));
  if (content.length >= 5 && uniqueVisualTypes.size < requiredVisualTypes) {
    issues.push(issue(
      'visual_role_variety_low',
      `The deck uses ${uniqueVisualTypes.size} visual role(s) across ${content.length} content slides; use at least ${requiredVisualTypes}.`,
    ));
  }
  const directionCandidates = design?.artDirection?.candidates || [];
  if (directionCandidates.length < 3 || !design?.artDirection?.selected?.id) {
    issues.push(issue(
      'art_direction_candidates_missing',
      'The deck has no selected art direction backed by three distinct candidates.',
    ));
  }
  return issues;
}
