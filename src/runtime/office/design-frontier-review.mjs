function issue(code, path, message) {
  return {
    severity: 'warning',
    code,
    path,
    message,
    source: 'frontier-design-review',
  };
}

function slideShapes(slide) {
  return Array.isArray(slide?.shapes) ? slide.shapes : [];
}

function shapeArea(shape, canvas) {
  const left = Math.max(0, Number(shape?.left) || 0);
  const top = Math.max(0, Number(shape?.top) || 0);
  const right = Math.min(canvas.width, left + Math.max(0, Number(shape?.width) || 0));
  const bottom = Math.min(canvas.height, top + Math.max(0, Number(shape?.height) || 0));
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function usedCanvasRatio(slide, canvas) {
  const weighted = slideShapes(slide).reduce((sum, shape) => {
    const area = shapeArea(shape, canvas);
    const hasText = Boolean(String(shape?.text || '').trim());
    const evidence = Boolean(shape?.chart || shape?.table || shape?.group || Number(shape?.type) === 13 || shape?.type === 'p:pic');
    return sum + (area * (evidence ? 1 : hasText ? 0.6 : 0.35));
  }, 0);
  return Math.min(1, weighted / (canvas.width * canvas.height));
}

function slidePlan(design, index) {
  return (design?.slidePlans || []).find((entry) => Number(entry?.slide) === Number(index)) || null;
}

function contentSlides(slides) {
  return slides.length >= 3 ? slides.slice(1, -1) : slides.slice(1);
}

function normalizedVisualType(plan) {
  return String(plan?.visualType || '').trim().toLowerCase();
}

export function reviewPptxFrontierQuality({
  document,
  design,
} = {}) {
  if (design?.review?.frontier !== true) return [];
  const slides = Array.isArray(document?.slides) ? document.slides : [];
  if (!slides.length) return [];
  const issues = [];
  if (design?.creative?.standard !== 'frontier-office-v1') {
    issues.push(issue(
      'creative_direction_missing',
      '/',
      'The deck has no frontier creative brief connecting its thesis, narrative arc, evidence, and visual motif.',
    ));
    return issues;
  }
  const canvas = {
    width: Number(document?.slideWidth) || Number(design?.format?.canvasWidth) || 960,
    height: Number(document?.slideHeight) || Number(design?.format?.canvasHeight) || 540,
  };
  const basicVisuals = new Set(['chart', 'table', 'process', 'metrics', 'comparison']);
  for (const slide of contentSlides(slides)) {
    const path = `/slide[${slide.index}]`;
    const plan = slidePlan(design, slide.index);
    const visualType = normalizedVisualType(plan);
    const shapes = slideShapes(slide);
    const hasChart = shapes.some((shape) => shape?.chart);
    const hasTable = shapes.some((shape) => shape?.table);
    if (!visualType) {
      issues.push(issue(
        'semantic_visual_plan_missing',
        path,
        'The content slide has no declared semantic visual treatment.',
      ));
    } else if (basicVisuals.has(visualType)) {
      issues.push(issue(
        'generic_visual_treatment',
        path,
        `The slide still uses the generic "${visualType}" treatment instead of an annotated or subject-specific visual.`,
      ));
    }
    if (hasChart && visualType !== 'annotated-chart') {
      issues.push(issue(
        'default_chart_treatment',
        path,
        'The native chart is not paired with a decision-relevant annotation rail or visual explanation.',
      ));
    }
    if (hasTable && visualType === 'table') {
      issues.push(issue(
        'raw_table_slide',
        path,
        'The slide presents a raw table instead of converting the decision logic into a scorecard, matrix, or allocation field.',
      ));
    }
    const usedRatio = usedCanvasRatio(slide, canvas);
    if (usedRatio < 0.14) {
      issues.push(issue(
        'under_composed_structure',
        path,
        `Only ${(usedRatio * 100).toFixed(1)}% of the canvas carries weighted content or evidence.`,
      ));
    }
  }
  const openingType = normalizedVisualType(slidePlan(design, slides[0]?.index));
  const closingType = normalizedVisualType(slidePlan(design, slides.at(-1)?.index));
  if (slides.length >= 3 && openingType && openingType === closingType) {
    issues.push(issue(
      'opening_closing_grammar_repeat',
      '/',
      `Opening and closing both use "${openingType}"; the close must land the decision with a distinct grammar.`,
    ));
  }
  const arc = Array.isArray(design?.creative?.narrativeArc) ? design.creative.narrativeArc : [];
  const requiredRoles = ['opening', 'proof', 'choice', 'execution', 'decision-close'];
  const available = new Set(arc);
  if (slides.length >= 6 && requiredRoles.filter((role) => available.has(role)).length < 4) {
    issues.push(issue(
      'narrative_arc_weak',
      '/',
      'The deck does not establish enough distinct story beats across opening, proof, choice, execution, and decision close.',
    ));
  }
  return issues;
}
