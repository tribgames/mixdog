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

function tournamentFamily(plan) {
  const variant = String(plan?.tournament?.selected || plan?.variant || '').toLowerCase();
  if (/(split|sidebar|left)/u.test(variant)) return 'split';
  if (/(bottom|band|ledger|hero)/u.test(variant)) return 'band';
  if (/(right|field|board|wide)/u.test(variant)) return 'field';
  return variant || 'unknown';
}

function isFreeformPlan(plan) {
  return ['freeform-board-v1', 'authored-scene-v1'].includes(String(plan?.sourceContract || ''));
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
  const adaptiveExpected = Number(design?.creative?.version) >= 2
    && design?.creative?.layoutSearch === 'adaptive-top-k';
  const freeformExpected = design?.freeform?.required === true;
  const tournamentFamilies = [];
  for (const slide of contentSlides(slides)) {
    const path = `/slide[${slide.index}]`;
    const plan = slidePlan(design, slide.index);
    const visualType = normalizedVisualType(plan);
    const sourceContract = String(plan?.sourceContract || '');
    const freeformPlan = isFreeformPlan(plan);
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
    if (!freeformPlan && adaptiveExpected && sourceContract !== 'authored') {
      const tournament = plan?.tournament;
      const metrics = tournament?.metrics || {};
      if (
        tournament?.method !== 'verifiable-layout-v1'
        || Number(tournament?.candidateCount) < 3
        || !String(tournament?.selected || '')
      ) {
        issues.push(issue(
          'adaptive_layout_selection_missing',
          path,
          'The generated slide has no verifiable Top-K layout tournament with at least three candidates.',
        ));
      } else {
        tournamentFamilies.push(tournamentFamily(plan));
        if (Number(metrics.capacity) < 0.78) {
          issues.push(issue(
            'layout_capacity_overflow',
            path,
            `Selected layout capacity fit is ${Number(metrics.capacity || 0).toFixed(2)}; reflow or choose a higher-capacity candidate.`,
          ));
        }
        if (Number(metrics.whitespaceFit) < 0.52) {
          issues.push(issue(
            'layout_whitespace_mismatch',
            path,
            `Selected layout whitespace fit is ${Number(metrics.whitespaceFit || 0).toFixed(2)} for its narrative density.`,
          ));
        }
        if (Number(metrics.balance) < 0.62) {
          issues.push(issue(
            'layout_visual_imbalance',
            path,
            `Selected layout visual balance is ${Number(metrics.balance || 0).toFixed(2)}.`,
          ));
        }
        if (Number(metrics.motifSafety) < 1) {
          issues.push(issue(
            'generic_motif_selected',
            path,
            'The selected candidate relies on a prohibited generic decorative motif.',
          ));
        }
      }
      if (
        plan?.referenceGenome?.coordinatePolicy !== 'constraints-only'
        || !String(plan?.referenceGenome?.id || '')
      ) {
        issues.push(issue(
          'reference_genome_missing',
          path,
          'The generated slide is not conditioned on a constraint-only reference genome.',
        ));
      }
      if (plan?.assetIntent?.required && plan.assetIntent.sourceSpecific !== true) {
        issues.push(issue(
          'source_specific_asset_missing',
          path,
          'The dominant visual is required but its asset intent is not source-specific.',
        ));
      }
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
  for (const slide of slides) {
    const path = `/slide[${slide.index}]`;
    const plan = slidePlan(design, slide.index);
    const freeformPlan = isFreeformPlan(plan);
    if (freeformExpected && !freeformPlan) {
      issues.push(issue(
        'freeform_compile_missing',
        path,
        'The deliverable used the adaptive coordinate tournament fallback instead of a visually selected free-form board.',
      ));
      continue;
    }
    if (!freeformPlan) continue;
    const selection = plan?.referenceSelection;
    const freeform = plan?.freeform;
    if (
      selection?.contract !== 'reference-visual-catalog-v1'
      || selection?.coordinatePolicy !== 'inspiration-only'
      || !Array.isArray(selection?.ids)
      || !selection.ids.length
    ) {
      issues.push(issue(
        'visual_reference_selection_missing',
        path,
        'The free-form board has no actual rendered-slide reference selection with inspiration-only coordinate policy.',
      ));
    }
    if (
      freeform?.editableCompile !== true
      || !['background', 'layout', 'content'].every((layer) => freeform?.layers?.includes?.(layer))
    ) {
      issues.push(issue(
        'freeform_layer_contract_missing',
        path,
        'The free-form board must preserve separate background, layout, and content layers for editable compilation.',
      ));
    }
    if (Array.isArray(freeform?.genericMotifs) && freeform.genericMotifs.length) {
      issues.push(issue(
        'generic_motif_selected',
        path,
        `The free-form board contains prohibited generic motifs: ${freeform.genericMotifs.join(', ')}.`,
      ));
    }
    if (design?.freeform?.authoredSceneRequired === true) {
      const scene = plan?.authoredScene;
      if (
        String(plan?.sourceContract || '') !== 'authored-scene-v1'
        || scene?.contract !== 'authored-scene-v1'
        || Number(scene?.nativeElementCount || 0) < 3
      ) {
        issues.push(issue(
          'authored_scene_missing',
          path,
          'The selected free-form candidate did not compile an authored scene into native PowerPoint elements.',
        ));
      }
    }
  }
  if (
    adaptiveExpected
    && tournamentFamilies.length >= 4
    && new Set(tournamentFamilies).size < 2
  ) {
    issues.push(issue(
      'adaptive_layout_rhythm_flat',
      '/',
      'All generated content slides selected the same coarse candidate family; vary split, band, and field rhythms.',
    ));
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
