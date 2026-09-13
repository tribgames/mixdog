import { dirname, join, posix } from 'node:path';
import { createPortableChartWorkbook } from './portable-package.mjs';
import { toEmu } from './portable-slide-shapes.mjs';
import { CHART_CONTENT_TYPE, PACKAGE_RELATIONSHIP_NS, WORKBOOK_CONTENT_TYPE, ensureContentTypeOverride, ensureDefaultContentType, partRelationshipPath, relationshipMap, relationshipTarget, zipText } from './portable-opc.mjs';
import { OFFICE_RELATIONSHIP_BASE, XML_HEADER, containerInner, topLevelElements, xmlDecode, xmlEncode } from './portable-xml.mjs';
import { slidePath } from './portable-pptx-package.mjs';

export const LABEL_POSITION_CODES = Object.freeze({
  inside_end: 'inEnd',
  inside_base: 'inBase',
  outside_end: 'outEnd',
  center: 'ctr',
  centre: 'ctr',
  best_fit: 'bestFit',
});


const LABEL_POSITION_NAMES = Object.freeze(Object.fromEntries(
  Object.entries(LABEL_POSITION_CODES).map(([name, code]) => [code, name]),
));

// How an existing chart presents itself: labels, number format, legend, base
// line, and the series fills. New numbers must not silently strip the treatment
// the deck was approved with, so a refresh reads these and keeps them unless the
// caller asks for something else.
export function readChartPresentation(xml) {
  const source = String(xml || '');
  const labels = /<c:dLbls>[\s\S]*?<\/c:dLbls>/.exec(source)?.[0] || '';
  const valueAxis = /<c:valAx>[\s\S]*?<\/c:valAx>/.exec(source)?.[0] || '';
  const categoryAxis = /<c:catAx>[\s\S]*?<\/c:catAx>/.exec(source)?.[0] || '';
  const code = /<c:dLblPos val="([^"]+)"\/>/.exec(labels)?.[1] || '';
  const scale = (pattern) => {
    const value = Number(pattern.exec(valueAxis)?.[1]);
    return Number.isFinite(value) ? value : null;
  };
  return {
    // The axis is part of the reading, not scaffolding: a hidden axis, a zoomed
    // range, and gridlines off are how the approved chart says what it says.
    axis: {
      hideValueAxis: /<c:delete val="1"\/>/.test(valueAxis),
      hideCategoryAxis: /<c:delete val="1"\/>/.test(categoryAxis),
      min: scale(/<c:min val="([^"]+)"\/>/),
      max: scale(/<c:max val="([^"]+)"\/>/),
      gridlines: /<c:majorGridlines/.test(valueAxis),
    },
    // The emphasized point (an accent bar, one highlighted slice) is per point,
    // not per series: rewriting the series alone flattens the chart's message.
    pointColors: [...source.matchAll(/<c:ser>[\s\S]*?<\/c:ser>/g)].map((match) => {
      const colors = [];
      for (const point of match[0].matchAll(/<c:dPt>[\s\S]*?<\/c:dPt>/g)) {
        const index = Number(/<c:idx val="(\d+)"\/>/.exec(point[0])?.[1]);
        const color = /<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(point[0])?.[1] || '';
        if (Number.isInteger(index) && color) colors[index] = color;
      }
      return colors;
    }),
    showValues: /<c:showVal val="1"\/>/.test(labels),
    dataLabelPosition: LABEL_POSITION_NAMES[code] || '',
    dataLabelColor: /<c:txPr>[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(labels)?.[1] || '',
    valueNumberFormat: xmlDecode(/<c:numFmt formatCode="([^"]*)"/.exec(valueAxis)?.[1] || ''),
    zeroBaseline: /<c:min val="0"\/>/.test(valueAxis),
    showLegend: /<c:legend>/.test(source),
    seriesColors: [...source.matchAll(/<c:ser>[\s\S]*?<\/c:ser>/g)]
      .map((match) => /<c:spPr>[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(match[0])?.[1] || ''),
  };
}

export function chartFrameXml({ id, relationshipId, left, top, width, height }) {
  return '<p:graphicFrame><p:nvGraphicFramePr>'
    + `<p:cNvPr id="${id}" name="Chart ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>`
    + `<p:xfrm><a:off x="${toEmu(left)}" y="${toEmu(top)}"/>`
    + `<a:ext cx="${Math.max(1, toEmu(width))}" cy="${Math.max(1, toEmu(height))}"/></p:xfrm>`
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">'
    + '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"'
    + ` xmlns:r="${OFFICE_RELATIONSHIP_BASE}" r:id="${relationshipId}"/>`
    + '</a:graphicData></a:graphic></p:graphicFrame>';
}



export const CHART_AXIS_ORDER = Object.freeze([
  'c:axId', 'c:scaling', 'c:delete', 'c:axPos', 'c:majorGridlines', 'c:minorGridlines',
  'c:title', 'c:numFmt', 'c:majorTickMark', 'c:minorTickMark', 'c:tickLblPos',
  'c:spPr', 'c:txPr', 'c:crossAx', 'c:crosses', 'c:crossesAt', 'c:crossBetween',
  'c:majorUnit', 'c:minorUnit',
]);



export async function resolveSlideChart(zip, slides, op) {
  const path = slidePath(slides, op.slide);
  const current = await zipText(zip, path);
  const tree = containerInner(current, 'p:spTree');
  if (!tree) throw new Error('PPTX slide shape tree is missing');
  const shapes = topLevelElements(tree.inner, ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp']);
  const shape = shapes[Number(op.shape) - 1];
  if (!shape) throw new Error(`PPTX shape ${op.shape} not found on slide ${op.slide}`);
  const reference = /<c:chart\b[^>]*\br:id="([^"]+)"/.exec(shape.xml)?.[1];
  if (!reference) throw new Error(`PPTX shape ${op.shape} on slide ${op.slide} is not a chart`);
  const target = relationshipMap(await zipText(zip, partRelationshipPath(path))).get(reference);
  if (!target) throw new Error(`PPTX chart relationship ${reference} is missing on slide ${op.slide}`);
  // The Target is relative to the slide ("../charts/chart1.xml") or an absolute part name
  // ("/ppt/charts/chart1.xml", which pptxgenjs writes); both name the same part.
  const part = relationshipTarget(partRelationshipPath(path), target);
  const xml = await zipText(zip, part);
  if (!xml) throw new Error(`PPTX chart part is missing: ${part}`);
  return { path, part, xml };
}



export function detectChartType(xml) {
  if (/<c:pieChart\b/.test(xml)) return 'pie';
  if (/<c:doughnutChart\b/.test(xml)) return 'doughnut';
  if (/<c:lineChart\b/.test(xml)) return 'line';
  if (/<c:areaChart\b/.test(xml)) return 'area';
  const stacked = /<c:grouping val="stacked"\/>/.test(xml);
  const horizontal = /<c:barDir val="bar"\/>/.test(xml);
  if (stacked) return horizontal ? 'stacked_bar' : 'stacked_column';
  return horizontal ? 'bar' : 'column';
}



export function chartCategories(xml) {
  const block = /<c:cat>[\s\S]*?<\/c:cat>/.exec(xml)?.[0] || '';
  return [...block.matchAll(/<c:pt idx="\d+"><c:v>([\s\S]*?)<\/c:v><\/c:pt>/g)]
    .map((match) => xmlDecode(match[1]));
}



export function chartTitleText(xml) {
  const block = /<c:title>[\s\S]*?<\/c:title>/.exec(xml)?.[0] || '';
  return [...block.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) => xmlDecode(match[1])).join('');
}



export async function writePresentationChart(zip, {
  chartPart,
  embeddingPart,
  chart,
  rows,
}) {
  zip.file(embeddingPart, await createPortableChartWorkbook(rows));
  await ensureDefaultContentType(zip, 'xlsx', WORKBOOK_CONTENT_TYPE);
  zip.file(partRelationshipPath(chartPart), `${XML_HEADER}<Relationships xmlns="${PACKAGE_RELATIONSHIP_NS}">`
    + `<Relationship Id="rId1" Type="${OFFICE_RELATIONSHIP_BASE}/package"`
    + ` Target="${xmlEncode(posix.relative(posix.dirname(chartPart), embeddingPart))}"/></Relationships>`);
  zip.file(chartPart, chart);
  await ensureContentTypeOverride(zip, `/${chartPart}`, CHART_CONTENT_TYPE);
}
