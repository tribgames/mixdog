// The paragraph writer one compose_document expansion shares: the output
// operation list, the composition flags that drive spacing and sizes, and
// `append`, which stamps every paragraph with the document typography.
import { documentTypography } from '../document-typography.mjs';

export function createDocxWriter({ operation, design, state, composition }) {
  const output = [];
  const type = documentTypography(operation, design.tokens.typography);
  const format = design.format;
  const compositionId = String(composition?.id || 'decision-brief');
  const compactMemo = compositionId === 'compact-memo';
  const editorialReport = compositionId === 'editorial-report';
  // Composition-specific spacing: the editorial report breathes, the compact memo tightens.
  const spacing = (editorial, compact, standard) => {
    if (editorialReport) return editorial;
    return compactMemo ? compact : standard;
  };
  let pageMargin = format.margin;
  if (compactMemo) pageMargin = Math.max(46.8, format.margin * 0.84);
  else if (editorialReport) pageMargin = format.margin * 1.08;
  const bodySize = compactMemo ? Math.max(9.5, format.body - 0.5) : format.body;

  const append = (text, style, properties = {}) => {
    if (text == null || text === '') return 0;
    state.paragraph += 1;
    const eastAsia = type.eastAsiaFor(properties.name);
    output.push({
      op: 'append_text',
      text: String(text),
      style,
      properties: {
        alignment: 'left',
        keepWithNext: false,
        widowControl: true,
        ...(eastAsia ? { nameEastAsia: eastAsia } : {}),
        ...properties,
      },
    });
    return state.paragraph;
  };

  return {
    output,
    state,
    design,
    type,
    format,
    colors: design.tokens.colors,
    compactMemo,
    editorialReport,
    evidenceBrief: compositionId === 'evidence-brief',
    decisionBrief: compositionId === 'decision-brief',
    spacing,
    pageMargin,
    bodySize,
    append,
  };
}
