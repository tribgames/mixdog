import { dirname, join, posix } from 'node:path';
import { createPortableChartWorkbook } from './portable-package.mjs';
import { toEmu } from './portable-slide-shapes.mjs';
import { CHART_CONTENT_TYPE, PACKAGE_RELATIONSHIP_NS, WORKBOOK_CONTENT_TYPE, ensureContentTypeOverride, ensureDefaultContentType, partRelationshipPath, relationshipMap, zipText } from './portable-opc.mjs';
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
  const part = posix.normalize(posix.join('ppt/slides', target));
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
