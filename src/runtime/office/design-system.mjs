import { bindOfficeContent, summarizeOfficeContentModel } from './content-model.mjs';
import { planOfficeComposition, summarizeOfficeCompositions } from './composition-system.mjs';
import { expandDocxDocument } from './design-docx.mjs';
import { coalesceCreatedPptxTemplateImports, expandPptxSlide, expandTemplatePptxSlide, pptxBackgroundSpec, pptxSlidePlan, selectPptxLayout } from './design-pptx.mjs';
import { expandPptxModelSlide } from './design-pptx-plan.mjs';
import { compactDesign, merge, resolveOfficeDesign } from './design-tokens.mjs';
import { expandXlsxSheet } from './design-xlsx.mjs';

export { officeDesignCatalog, resolveOfficeDesign } from './design-tokens.mjs';
export {
  pptxVisualReviewAcknowledged,
  reviewOfficeDesign,
  reviewPptxVisualCritique,
} from './design-review.mjs';

export function expandOfficeDesignOperations({
  format,
  backend = '',
  operations = [],
  design: request = {},
  library = null,
  created = false,
  snapshotVersion = 0,
} = {}) {
  const normalizedFormat = String(format || '').toLowerCase();
  const design = resolveOfficeDesign(normalizedFormat, request, { library });
  const output = [];
  const semantic = [];
  let nextSlide = created && Number(snapshotVersion || 0) === 0 ? 1 : null;
  const docxState = { paragraph: 0, table: 0 };
  const layoutUsage = new Map();
  const compositionUsage = new Map();
  for (const operation of operations || []) {
    const bound = bindOfficeContent(operation, design.content);
    const contentOperation = bound.operation;
    const name = String(contentOperation?.op || '');
    if (normalizedFormat === 'pptx' && name === 'compose_slide') {
      const composition = planOfficeComposition(normalizedFormat, contentOperation, design, {
        usage: compositionUsage,
      });
      const plannedOperation = {
        ...contentOperation,
        kind: composition.kind,
        __composition: composition,
      };
      const slide = Number(plannedOperation.slide) || nextSlide;
      if (!slide) throw new Error('compose_slide requires slide for an existing presentation');
      const templateRequested = Boolean(plannedOperation.layoutId)
        || ['prefer', 'strict'].includes(String(design.deck.templateMode || ''));
      const selectedLayout = templateRequested
        ? selectPptxLayout(plannedOperation, design, layoutUsage)
        : null;
      const layout = selectedLayout?.layout || null;
      const composed = layout ? merge(layout.defaults || {}, plannedOperation) : plannedOperation;
      const backgroundSpec = pptxBackgroundSpec(composed, design, composition.kind, slide);
      let plan;
      let renderMode;
      const templateOperations = layout
        ? expandTemplatePptxSlide(composed, layout, slide, backend)
        : null;
      if (templateRequested) {
        if (!layout || !templateOperations) {
          throw new Error(
            `compose_slide requires an explicit native template layout for kind "${operation.kind}"; no scratch fallback was applied`,
          );
        }
        output.push(...templateOperations);
        layoutUsage.set(layout.id, (layoutUsage.get(layout.id) || 0) + 1);
        plan = pptxSlidePlan(composed, composition.kind, slide);
        renderMode = 'native-template';
      } else if (design.deck.compositionMode === 'legacy') {
        output.push(...expandPptxSlide(composed, design, slide));
        plan = pptxSlidePlan(composed, composition.kind, slide);
        renderMode = 'legacy-scratch';
      } else {
        const modeled = expandPptxModelSlide(composed, design, slide, backgroundSpec);
        output.push(...modeled.operations);
        plan = modeled.plan;
        renderMode = 'model-plan';
      }
      semantic.push({
        op: name,
        kind: composition.kind,
        requestedKind: String(contentOperation.kind || 'content'),
        slide,
        slideRole: backgroundSpec.slideRole,
        backgroundRole: backgroundSpec.backgroundRole,
        plan,
        composition: layout ? {
          ...composition,
          id: `${composition.kind}:template:${layout.id}`,
          family: 'native-template',
          variant: layout.variant || composition.variant,
          source: 'native-template',
        } : composition,
        renderMode,
        ...(bound.binding ? { contentBinding: bound.binding } : {}),
        ...(layout ? {
          layout: layout.id,
          variant: layout.variant || '',
          sourceSlide: Number(layout.sourceSlide) || 0,
          templateId: layout.templateId || '',
          selection: {
            score: selectedLayout.score,
            demand: selectedLayout.demand,
            fit: selectedLayout.fit,
          },
        } : {}),
      });
      if (nextSlide != null) nextSlide += 1;
      continue;
    }
    if (normalizedFormat === 'docx' && name === 'compose_document') {
      const composition = planOfficeComposition(normalizedFormat, contentOperation, design, {
        usage: compositionUsage,
      });
      output.push(...expandDocxDocument(contentOperation, design, docxState, backend, composition));
      semantic.push({
        op: name,
        sections: Array.isArray(contentOperation.sections) ? contentOperation.sections.length : 0,
        composition,
        ...(bound.binding ? { contentBinding: bound.binding } : {}),
      });
      continue;
    }
    if (normalizedFormat === 'xlsx' && name === 'compose_sheet') {
      const composition = planOfficeComposition(normalizedFormat, contentOperation, design, {
        usage: compositionUsage,
      });
      output.push(...expandXlsxSheet(contentOperation, design, composition));
      semantic.push({
        op: name,
        sheet: String(contentOperation.sheet || 'Sheet1'),
        composition,
        ...(bound.binding ? { contentBinding: bound.binding } : {}),
      });
      continue;
    }
    output.push(contentOperation);
  }
  const expandedOperations = normalizedFormat === 'pptx' && created && Number(snapshotVersion || 0) === 0
    ? coalesceCreatedPptxTemplateImports(output)
    : output;
  return {
    operations: expandedOperations,
    semantic,
    design: compactDesign(design),
    content: summarizeOfficeContentModel(design.content),
    composition: summarizeOfficeCompositions(normalizedFormat, semantic),
  };
}



export function applyPdfDesign(blocks = [], designRequest = {}, { library = null } = {}) {
  const design = resolveOfficeDesign('pdf', designRequest, { library });
  const colors = design.tokens.colors;
  const type = design.tokens.typography;
  let headingIndex = 0;
  const styledBlocks = (blocks || []).map((block) => {
    const typeName = String(block?.type || 'paragraph').toLowerCase();
    if (typeName === 'heading') {
      headingIndex += 1;
      return {
        ...block,
        font: block.font || type.display,
        size: block.size || (headingIndex === 1 ? design.format.title : design.format.heading),
        color: block.color || (headingIndex === 1 ? colors.ink : colors.accent),
        after: block.after ?? (headingIndex === 1 ? 18 : 10),
      };
    }
    if (typeName === 'paragraph') {
      return {
        ...block,
        font: block.font || type.body,
        size: block.size || design.format.body,
        color: block.color || colors.ink,
        lineHeight: block.lineHeight || design.format.body * 1.5,
        after: block.after ?? 8,
      };
    }
    if (typeName === 'table') {
      return {
        ...block,
        font: block.font || type.data,
        color: block.color || colors.ink,
        headerFill: block.headerFill || colors.inverse,
        headerColor: block.headerColor || colors.onInverse,
        zebraFill: block.zebraFill || colors.surface,
        borderColor: block.borderColor || colors.surface2,
      };
    }
    return block;
  });
  return {
    blocks: styledBlocks,
    properties: {
      margin: design.format.margin,
      background: colors.canvas,
      fontName: type.body,
      ...compactDesign(design),
    },
    design: compactDesign(design),
  };
}
