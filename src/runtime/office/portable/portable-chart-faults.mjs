// Chart XML PowerPoint refuses although the schema accepts it. Script generators
// (pptxgenjs and friends) emit both faults silently; LibreOffice and python-pptx
// open the result, so only a package scan at finalize catches them.
import { zipText } from './portable-opc.mjs';

const CHART_PART = /^ppt\/charts\/chart(\d+)\.xml$/;
const STACKED = new Set(['stacked', 'percentStacked']);
const LEGAL_ON_STACKED = ['ctr', 'inEnd', 'inBase'];
// Axis ids a plot group must resolve against the axes its own part declares.
const AXIS_MINIMUM = Object.freeze({
  barChart: 2, lineChart: 2, areaChart: 2, scatterChart: 2, bubbleChart: 2, radarChart: 2, stockChart: 2,
  bar3DChart: 2, area3DChart: 2, surfaceChart: 2, line3DChart: 3, surface3DChart: 3,
});

function stripExtLst(xml) {
  return xml.replace(/<c:extLst\b[^>]*\/>/g, '').replace(/<c:extLst\b[^>]*>[\s\S]*?<\/c:extLst>/g, '');
}

function plotGroups(xml) {
  const groups = [];
  const open = /<c:(\w+Chart)\b[^>]*(?<!\/)>/g;
  let match;
  while ((match = open.exec(xml))) {
    const name = match[1];
    const close = xml.indexOf(`</c:${name}>`, match.index);
    if (close < 0) continue;
    groups.push({ name, block: xml.slice(match.index, close) });
  }
  return groups;
}

function declaredAxisIds(xml) {
  const ids = new Set();
  const axis = /<c:(?:catAx|valAx|serAx|dateAx)\b[^>]*>\s*<c:axId\b[^>]*\bval="(-?\d+)"/g;
  let match;
  while ((match = axis.exec(xml))) ids.add(match[1]);
  return ids;
}

function stackedLabelFaults(part, block, name) {
  const grouping = /<c:grouping\b[^>]*\bval="(\w+)"/.exec(block)?.[1];
  if (!STACKED.has(grouping)) return [];
  const bad = [...block.matchAll(/<c:dLblPos\b[^>]*\bval="(\w+)"/g)].map((m) => m[1]).filter((pos) => pos === 'outEnd');
  if (!bad.length) return [];
  return [{
    severity: 'error',
    code: 'chart_stacked_label_position',
    path: `/${part}`,
    message: `${bad.length} data label(s) use dLblPos="outEnd" on a ${grouping} ${name}; PowerPoint allows only ${LEGAL_ON_STACKED.join(', ')} there and refuses the file. Use dataLabelPosition 'ctr', 'inEnd', or 'inBase' in the script.`,
    source: 'chart-scan',
  }];
}

function axisReferenceFaults(part, block, name, declared) {
  const minimum = AXIS_MINIMUM[name];
  if (!minimum) return [];
  const ids = [...block.matchAll(/<c:axId\b[^>]*\bval="(-?\d+)"/g)].map((m) => m[1]);
  const live = ids.filter((id) => declared.has(id));
  if (live.length >= 2) return [];
  const dead = ids.filter((id) => !declared.has(id));
  const detail = !ids.length
    ? `declares no <c:axId>; a plot group needs ${minimum}`
    : dead.length
      ? `references axId ${ids.join(', ')}, of which ${dead.join(', ')} name no axis this part declares`
      : `references only ${ids.length} axis id(s)`;
  return [{
    severity: 'error',
    code: 'chart_axis_undeclared',
    path: `/${part}`,
    message: `<c:${name}> ${detail}, leaving fewer than two live axes; PowerPoint discards the chart and reports the file as corrupt. A secondary-axis combo needs both valAxes and catAxes with two entries each.`,
    source: 'chart-scan',
  }];
}

export function chartFaultsInXml(part, xml) {
  const cleaned = stripExtLst(String(xml || ''));
  const declared = declaredAxisIds(cleaned);
  const issues = [];
  for (const { name, block } of plotGroups(cleaned)) {
    issues.push(...stackedLabelFaults(part, block, name));
    issues.push(...axisReferenceFaults(part, block, name, declared));
  }
  return issues;
}

export async function chartFaultIssues(zip) {
  const parts = Object.keys(zip.files)
    .filter((name) => CHART_PART.test(name))
    .sort((a, b) => Number(CHART_PART.exec(a)[1]) - Number(CHART_PART.exec(b)[1]));
  const issues = [];
  for (const part of parts) {
    const xml = await zipText(zip, part);
    if (xml) issues.push(...chartFaultsInXml(part, xml));
  }
  return issues;
}
