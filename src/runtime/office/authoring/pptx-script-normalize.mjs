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
      return props;
    });
    return cleaned === inner ? paragraph : `<a:p>${cleaned}</a:p>`;
  });
  return { xml: output, removed };
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

export async function normalizeAuthoredPptx(path) {
  const zip = await loadPackage(path);
  const parts = Object.keys(zip.files).filter((name) => TEXT_PARTS.test(name) || CHART_PARTS.test(name));
  let removed = 0;
  let changedParts = 0;
  for (const part of parts) {
    const xml = await zipText(zip, part);
    const result = CHART_PARTS.test(part) ? normalizeChartSeries(xml) : normalizeParagraphProperties(xml);
    if (!result.removed) continue;
    zip.file(part, result.xml);
    removed += result.removed;
    changedParts += 1;
  }
  if (changedParts) await savePackage(zip, path);
  return { removed, changedParts };
}
