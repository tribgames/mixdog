import JSZip from 'jszip';
import { loadPackage, savePackage, zipText } from '../portable/portable-opc.mjs';

// pptxgenjs 4.x writes an <a:pPr> for every run of a paragraph, not only the
// first; DrawingML allows one pPr and it must be the first child, so any
// paragraph with two or more runs fails schema validation even though
// PowerPoint repairs it silently on open. The authored file is normalized in
// place so the portable path (no Office re-save) produces the same package
// the COM path does.
const TEXT_PARTS = /^ppt\/(slides|slideLayouts|slideMasters|notesSlides)\/[^/]+\.xml$/;
const PARAGRAPH = /<a:p>([\s\S]*?)<\/a:p>/g;
const PARAGRAPH_PROPS = /<a:pPr\b[^>]*\/>|<a:pPr\b[^>]*>[\s\S]*?<\/a:pPr>/g;

// PowerPoint's East Asian default lets a trailing period or comma hang past the
// box edge (hangingPunct), so a measured Korean box reads 1-4 pt wider than it
// was sized and the review raises text_overflow on copy that fits. Authored
// decks turn it off on every paragraph so the box is the measure.
const HANGING_PUNCT = /\bhangingPunct="[^"]*"/;
function withoutHangingPunctuation(props) {
  if (HANGING_PUNCT.test(props)) return props.replace(HANGING_PUNCT, 'hangingPunct="0"');
  return props.replace(/^<a:pPr\b/, '<a:pPr hangingPunct="0"');
}

export function normalizeParagraphProperties(xml) {
  let removed = 0;
  const output = String(xml || '').replace(PARAGRAPH, (paragraph, inner) => {
    let seen = false;
    const cleaned = inner.replace(PARAGRAPH_PROPS, (props) => {
      if (seen) {
        removed += 1;
        return '';
      }
      seen = true;
      return withoutHangingPunctuation(props);
    });
    return `<a:p>${seen ? cleaned : `<a:pPr hangingPunct="0"/>${cleaned}`}</a:p>`;
  });
  return { xml: output, removed, changed: output !== String(xml || '') };
}

// pptxgenjs also writes <c:invertIfNegative> into every series, but the
// schema allows it only on bar and bubble series; line, area, pie, radar,
// and scatter series fail validation with it present.
const CHART_PARTS = /^ppt\/charts\/chart[^/]+\.xml$/;
const NON_BAR_CHART = /<c:(lineChart|line3DChart|areaChart|area3DChart|pieChart|pie3DChart|doughnutChart|radarChart|scatterChart|ofPieChart)\b[\s\S]*?<\/c:\1>/g;
const INVERT_IF_NEGATIVE = /<c:invertIfNegative\b[^>]*\/>|<c:invertIfNegative\b[^>]*>[\s\S]*?<\/c:invertIfNegative>/g;

function normalizeChartSeries(xml) {
  let removed = 0;
  const output = String(xml || '').replace(NON_BAR_CHART, (chart) => chart.replace(INVERT_IF_NEGATIVE, () => {
    removed += 1;
    return '';
  }));
  return { xml: output, removed };
}

// pptxgenjs has no per-point fill for a bar series, so the kit's chart() draws
// one accented bar as two stacked series — the base with a zero at the accent
// index, an overlay named "<series> ·" carrying only that value. The saved
// chart merges them back into one clustered series with a <c:dPt> override on
// the accent point, and the embedded workbook loses its second column, so
// "Edit data" in PowerPoint shows one column of real values.
const SERIES = /<c:ser>[\s\S]*?<\/c:ser>/g;
const OVERLAY_NAME = /<c:tx>[\s\S]*?<c:v>([^<]*) ·<\/c:v>[\s\S]*?<\/c:tx>/;

function seriesValues(ser) {
  const val = /<c:val>[\s\S]*?<\/c:val>/.exec(ser)?.[0] || '';
  const values = new Map();
  for (const point of val.matchAll(/<c:pt idx="(\d+)"><c:v>([^<]*)<\/c:v><\/c:pt>/g)) values.set(Number(point[1]), point[2]);
  return values;
}

export function mergeAccentSeries(xml) {
  const chart = /<c:barChart>[\s\S]*?<\/c:barChart>/.exec(String(xml || ''));
  if (!chart || !/<c:grouping val="stacked"\/>/.test(chart[0])) return { xml, changed: false, accent: [] };
  const series = chart[0].match(SERIES) || [];
  if (series.length !== 2 || !OVERLAY_NAME.test(series[1])) return { xml, changed: false, accent: [] };
  const [base, overlay] = series;
  const baseValues = seriesValues(base);
  const overlayValues = seriesValues(overlay);
  const accent = [...overlayValues].filter(([, value]) => value !== '' && Number(value) !== 0).map(([idx]) => idx);
  const color = /<c:spPr>[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(overlay)?.[1];
  if (!accent.length || !color) return { xml, changed: false, accent: [] };
  const merged = new Map([...baseValues].map(([idx, value]) => [idx, accent.includes(idx) ? overlayValues.get(idx) : value]));
  let ser = base.replace(/<c:val>[\s\S]*?<\/c:val>/, (val) => val.replace(/<c:pt idx="(\d+)"><c:v>[^<]*<\/c:v><\/c:pt>/g, (_, idx) => `<c:pt idx="${idx}"><c:v>${merged.get(Number(idx)) ?? ''}</c:v></c:pt>`));
  const points = accent.map((idx) => `<c:dPt><c:idx val="${idx}"/><c:invertIfNegative val="0"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr></c:dPt>`).join('');
  ser = /<c:invertIfNegative\b[^>]*\/>/.test(ser)
    ? ser.replace(/<c:invertIfNegative\b[^>]*\/>/, (tag) => `${tag}${points}`)
    : ser.replace(/<\/c:spPr>/, (tag) => `${tag}${points}`);
  const bar = chart[0].replace(overlay, '').replace(base, ser)
    .replace('<c:grouping val="stacked"/>', '<c:grouping val="clustered"/>')
    .replace(/<c:overlap val="[^"]*"\/>/, '');
  return { xml: String(xml).replace(chart[0], bar), changed: true, accent, values: merged };
}

// The workbook behind the chart: one value column, the accent row holding its real value.
function mergeWorkbookColumns(sheetXml, values) {
  let xml = String(sheetXml || '');
  xml = xml.replace(/<c r="C\d+"[^>]*>[\s\S]*?<\/c>|<c r="C\d+"[^>]*\/>/g, '');
  xml = xml.replace(/<c r="B(\d+)"([^>]*)><v>[^<]*<\/v><\/c>/g, (cell, row, attrs) => {
    const idx = Number(row) - 2;
    return idx >= 0 && values.has(idx) ? `<c r="B${row}"${attrs}><v>${values.get(idx)}</v></c>` : cell;
  });
  xml = xml.replace(/spans="1:3"/g, 'spans="1:2"').replace(/<dimension ref="A1:C(\d+)"\/>/, '<dimension ref="A1:B$1"/>');
  return xml;
}

function mergeWorkbookTable(tableXml) {
  return String(tableXml || '').replace(/ref="A1:C(\d+)"/g, 'ref="A1:B$1"')
    .replace(/<tableColumns count="3">([\s\S]*?)<\/tableColumns>/, (_, columns) => `<tableColumns count="2">${columns.replace(/<tableColumn id="3"[^>]*\/>/, '')}</tableColumns>`);
}

async function mergeEmbeddedWorkbook(zip, chartPart, values) {
  const relsPart = chartPart.replace(/charts\/(chart\d+\.xml)$/, 'charts/_rels/$1.rels');
  const rels = zip.file(relsPart) ? await zipText(zip, relsPart) : '';
  const target = /Target="([^"]+\.xlsx)"/.exec(rels)?.[1];
  if (!target) return false;
  const embeddedPart = `ppt/${target.replace(/^\.\.\//, '')}`;
  const file = zip.file(embeddedPart);
  if (!file) return false;
  const workbook = await JSZip.loadAsync(await file.async('nodebuffer'));
  const sheet = workbook.file('xl/worksheets/sheet1.xml');
  if (!sheet) return false;
  workbook.file('xl/worksheets/sheet1.xml', mergeWorkbookColumns(await sheet.async('string'), values));
  const table = workbook.file('xl/tables/table1.xml');
  if (table) workbook.file('xl/tables/table1.xml', mergeWorkbookTable(await table.async('string')));
  zip.file(embeddedPart, await workbook.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return true;
}

export async function normalizeAuthoredPptx(path) {
  const zip = await loadPackage(path);
  const parts = Object.keys(zip.files).filter((name) => TEXT_PARTS.test(name) || CHART_PARTS.test(name));
  let removed = 0;
  let changedParts = 0;
  let mergedCharts = 0;
  for (const part of parts) {
    const xml = await zipText(zip, part);
    let result = CHART_PARTS.test(part) ? normalizeChartSeries(xml) : normalizeParagraphProperties(xml);
    if (CHART_PARTS.test(part)) {
      const merged = mergeAccentSeries(result.xml);
      if (merged.changed) {
        result = { ...result, xml: merged.xml, changed: true };
        mergedCharts += 1;
        await mergeEmbeddedWorkbook(zip, part, merged.values);
      }
    }
    if (!result.removed && !result.changed) continue;
    zip.file(part, result.xml);
    removed += result.removed;
    changedParts += 1;
  }
  if (changedParts) await savePackage(zip, path);
  return { removed, changedParts, mergedCharts };
}
