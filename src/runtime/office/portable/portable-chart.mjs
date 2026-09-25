import { xmlEncode } from './portable-xml.mjs';
import { contrastRatio } from './text-metrics.mjs';

const CHART_NAMESPACE = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const DRAWING_NAMESPACE = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const RELATIONSHIP_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CATEGORY_AXIS_ID = 111_111_111;
const VALUE_AXIS_ID = 222_222_222;

const CHART_FAMILIES = Object.freeze({
  column: { element: 'barChart', direction: 'col', axes: true },
  bar: { element: 'barChart', direction: 'bar', axes: true },
  stacked_column: { element: 'barChart', direction: 'col', axes: true, grouping: 'stacked' },
  stacked_bar: { element: 'barChart', direction: 'bar', axes: true, grouping: 'stacked' },
  line: { element: 'lineChart', axes: true },
  area: { element: 'areaChart', axes: true },
  pie: { element: 'pieChart', axes: false },
  doughnut: { element: 'doughnutChart', axes: false },
});

// Excel fills an unstyled series from the workbook theme, so a chart part
// written without a style or colour map is left to the reader — and a reader
// that resolves nothing draws a plot of invisible bars under visible labels.
// Every series therefore carries an explicit fill unless the caller names one;
// one hue family in light and dark steps keeps a multi-series plot readable in
// print and on a projector.
export const DEFAULT_SERIES_COLORS = Object.freeze(['2F6DB5', '9FB6CE', '1B4374', '6FA0D8', '4E6274', 'C3D0DD']);

const LABEL_POSITIONS = Object.freeze({
  inside_end: 'inEnd',
  inside_base: 'inBase',
  outside_end: 'outEnd',
  center: 'ctr',
  centre: 'ctr',
  best_fit: 'bestFit',
});

function hex(value) {
  const raw = String(value ?? '')
    .trim()
    .replace(/^#/, '')
    .toUpperCase();
  if (/^[0-9A-F]{6}$/.test(raw)) return raw;
  if (/^[0-9A-F]{3}$/.test(raw))
    return raw
      .split('')
      .map((digit) => `${digit}${digit}`)
      .join('');
  return '';
}

function resolveChartFamily(chartType) {
  const key = String(chartType || 'column')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return CHART_FAMILIES[key] ? { key, ...CHART_FAMILIES[key] } : null;
}

function supportedChartTypes() {
  return Object.keys(CHART_FAMILIES);
}

function columnLetter(index) {
  let value = Math.max(1, Math.trunc(index));
  let label = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = `${String.fromCharCode(65 + remainder)}${label}`;
    value = Math.trunc((value - 1) / 26);
  }
  return label;
}

function stringReference(formula, values) {
  const points = values
    .map((value, index) => `<c:pt idx="${index}"><c:v>${xmlEncode(value ?? '')}</c:v></c:pt>`)
    .join('');
  return (
    `<c:strRef><c:f>${xmlEncode(formula)}</c:f>` +
    `<c:strCache><c:ptCount val="${values.length}"/>${points}</c:strCache></c:strRef>`
  );
}

function numberReference(formula, values, formatCode) {
  const points = values
    .map((value, index) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? `<c:pt idx="${index}"><c:v>${numeric}</c:v></c:pt>` : '';
    })
    .join('');
  return (
    `<c:numRef><c:f>${xmlEncode(formula)}</c:f>` +
    `<c:numCache><c:formatCode>${xmlEncode(formatCode || 'General')}</c:formatCode>` +
    `<c:ptCount val="${values.length}"/>${points}</c:numCache></c:numRef>`
  );
}

function seriesShape(family, color) {
  const fill = hex(color);
  if (!fill) return '';
  if (family.element === 'lineChart') {
    return `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill><a:round/></a:ln><a:effectLst/></c:spPr>`;
  }
  return `<c:spPr><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill><a:ln><a:noFill/></a:ln><a:effectLst/></c:spPr>`;
}

function dataPointShapes(family, colors) {
  if (!Array.isArray(colors) || family.element === 'lineChart') return '';
  return colors
    .map((color, index) => {
      const shape = seriesShape(family, color);
      return shape ? `<c:dPt><c:idx val="${index}"/>${shape}</c:dPt>` : '';
    })
    .join('');
}

// The text sizes a chart's parts take, in hundredths of a point: a worksheet chart reads at Excel's scale (a 12 pt
// title over 9 pt axes), a slide chart at PowerPoint's own — the 18.6 pt title over 12 pt text AddChart2 writes on the
// wide canvas. The worksheet sizes on a slide set a chart's axes at 9 pt beside the 12 pt Office drew for the same one.
export const CHART_TEXT = {
  sheet: { title: 1200, body: 900, label: 1000 },
  slide: { title: 1862, body: 1197, label: 1197 },
};

// A value printed on a slice reads in the ink that slice can carry — white on the navy one, near-black on the pale
// one — when the caller names no label colour: one dark ink for every slice vanished into the darkest.
function sliceLabels(pointColors, size) {
  return (Array.isArray(pointColors) ? pointColors : [])
    .map((fill, index) => {
      const field = hex(fill);
      if (!field) return '';
      const ink = (contrastRatio('FFFFFF', field) ?? 0) >= (contrastRatio('1F2429', field) ?? 0) ? 'FFFFFF' : '1F2429';
      return (
        `<c:dLbl><c:idx val="${index}"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>` +
        `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}"><a:solidFill><a:srgbClr val="${ink}"/></a:solidFill></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>` +
        '<c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbl>'
      );
    })
    .join('');
}

function dataLabels({
  showValues,
  position,
  color,
  numberFormat,
  family,
  size = CHART_TEXT.sheet.label,
  pointColors = null,
}) {
  if (!showValues) return '';
  const resolved = LABEL_POSITIONS[String(position || '').toLowerCase()] || '';
  const outEndAllowed = family.axes && family.grouping !== 'stacked';
  const usable = !outEndAllowed && resolved === 'outEnd' ? 'ctr' : resolved;
  const label = hex(color);
  const slices = family.element === 'pieChart' || family.element === 'doughnutChart';
  return (
    '<c:dLbls>' +
    (slices && !label ? sliceLabels(pointColors, size) : '') +
    (numberFormat ? `<c:numFmt formatCode="${xmlEncode(numberFormat)}" sourceLinked="0"/>` : '') +
    '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>' +
    // The labels carry their size whether or not a colour is named: unnamed, a slide chart's labels fell to the
    // reader's 10 pt beside 12 pt axes.
    (label
      ? `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}" b="1"><a:solidFill><a:srgbClr val="${label}"/></a:solidFill></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`
      : `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}"/></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`) +
    (usable && family.element !== 'pieChart' && family.element !== 'doughnutChart'
      ? `<c:dLblPos val="${usable}"/>`
      : '') +
    '<c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/>' +
    '<c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/>' +
    '</c:dLbls>'
  );
}

function axisText(size) {
  return (
    `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}">` +
    '<a:solidFill><a:srgbClr val="5F6368"/></a:solidFill></a:defRPr></a:pPr>' +
    '<a:endParaRPr lang="en-US"/></a:p></c:txPr>'
  );
}

// Horizontal bars (barDir bar) read top-down in the order given: the category axis runs max-to-min on the left and
// the value axis crosses it at the far end, along the bottom — the default stacked the first category at the foot.
// A series below zero sets the category names at the foot of the plot (low), not on the zero line, where a loss
// bar's value label and its category name ran over each other.
function categoryAxis({ hidden = false, horizontal = false, size = CHART_TEXT.sheet.body, low = false } = {}) {
  return (
    `<c:catAx><c:axId val="${CATEGORY_AXIS_ID}"/>` +
    `<c:scaling><c:orientation val="${horizontal ? 'maxMin' : 'minMax'}"/></c:scaling><c:delete val="${hidden ? 1 : 0}"/><c:axPos val="${horizontal ? 'l' : 'b'}"/>` +
    `<c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="${low ? 'low' : 'nextTo'}"/>` +
    '<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="C7CBD1"/></a:solidFill></a:ln></c:spPr>' +
    axisText(size) +
    `<c:crossAx val="${VALUE_AXIS_ID}"/><c:crosses val="autoZero"/><c:auto val="1"/>` +
    '<c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>'
  );
}

/** Per-point colors: the series' own list, a default cycle for pie and doughnut slices, else none. */
function pointColorsFor(family, entry, rows) {
  if (Array.isArray(entry.pointColors) && entry.pointColors.length) return entry.pointColors;
  if (family.element === 'pieChart' || family.element === 'doughnutChart') {
    return rows.map((_, point) => DEFAULT_SERIES_COLORS[point % DEFAULT_SERIES_COLORS.length]);
  }
  return null;
}

function valueAxis({
  numberFormat,
  zeroBaseline,
  hidden = false,
  min = null,
  max = null,
  gridlines = true,
  horizontal = false,
  size = CHART_TEXT.sheet.body,
}) {
  let low = min;
  if (min == null) low = zeroBaseline ? 0 : null;
  return (
    `<c:valAx><c:axId val="${VALUE_AXIS_ID}"/>` +
    '<c:scaling><c:orientation val="minMax"/>' +
    `${max == null ? '' : `<c:max val="${max}"/>`}${low == null ? '' : `<c:min val="${low}"/>`}</c:scaling>` +
    `<c:delete val="${hidden ? 1 : 0}"/><c:axPos val="${horizontal ? 'b' : 'l'}"/>` +
    (gridlines
      ? '<c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="E7E9EC"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>'
      : '') +
    (numberFormat ? `<c:numFmt formatCode="${xmlEncode(numberFormat)}" sourceLinked="0"/>` : '') +
    '<c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>' +
    '<c:spPr><a:ln><a:noFill/></a:ln></c:spPr>' +
    axisText(size) +
    `<c:crossAx val="${CATEGORY_AXIS_ID}"/><c:crosses val="${horizontal ? 'max' : 'autoZero'}"/><c:crossBetween val="between"/></c:valAx>`
  );
}

// The faces a run names when the chart has one: a title is its own rich text, and the chart's default face did not
// reach it through the recalculation's roundtrip.
function runFaces(font) {
  return font
    ? `<a:latin typeface="${xmlEncode(font)}"/><a:ea typeface="${xmlEncode(font)}"/><a:cs typeface="${xmlEncode(font)}"/>`
    : '';
}

function chartTitle(text, font = '', size = CHART_TEXT.sheet.title) {
  if (!text) return '<c:autoTitleDeleted val="1"/>';
  const rPr = font
    ? `<a:rPr lang="en-US" sz="${size}" b="1">${runFaces(font)}</a:rPr>`
    : `<a:rPr lang="en-US" sz="${size}" b="1"/>`;
  return (
    '<c:title><c:tx><c:rich><a:bodyPr rot="0" spcFirstLastPara="1" vertOverflow="ellipsis" vert="horz" wrap="square" anchor="ctr" anchorCtr="1"/>' +
    `<a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}" b="1">` +
    `<a:solidFill><a:srgbClr val="171717"/></a:solidFill>${runFaces(font)}</a:defRPr></a:pPr>` +
    `<a:r>${rPr}<a:t>${xmlEncode(text)}</a:t></a:r></a:p></c:rich></c:tx>` +
    '<c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>'
  );
}

export function chartXml({
  chartType = 'column',
  title = '',
  categories = [],
  series = [],
  references = null,
  showValues = false,
  dataLabelPosition = '',
  dataLabelColor = '',
  valueNumberFormat = '',
  showLegend = null,
  zeroBaseline = null,
  // How the chart's axes were set up when it already exists: a data refresh
  // keeps the hidden axis, the zoomed range, and the gridline decision the deck
  // was approved with instead of redrawing a default chart around new numbers.
  axis = null,
  externalDataId = '',
  // The face every text in the chart takes by default. A worksheet chart names its workbook's: named nowhere, the
  // portable recalculation's roundtrip set it in Arial beside a Calibri table.
  font = '',
  // CHART_TEXT.sheet or CHART_TEXT.slide.
  text = CHART_TEXT.sheet,
} = {}) {
  const family = resolveChartFamily(chartType);
  if (!family) {
    throw new Error(`Unsupported chartType: ${chartType}. Use one of: ${supportedChartTypes().join(', ')}`);
  }
  // A bar or column says "this much" by its length, so its axis starts at zero
  // unless the caller deliberately zooms in; a line or scatter reads as a path
  // and keeps the range that shows its movement.
  const rows = categories.map((entry) => String(entry ?? ''));
  const entries = series.filter((entry) => entry && Array.isArray(entry.values));
  if (!entries.length) throw new Error('add_chart requires at least one series with values');
  // A loss reaches below the zero line: pinning the axis at 0 drew the "-8" column as nothing, where the Office
  // backend's axis ran to -10.
  const negative = entries.some((entry) => entry.values.some((value) => Number(value) < 0));
  const baseline =
    !negative &&
    (zeroBaseline == null ? family.element === 'barChart' || family.element === 'areaChart' : zeroBaseline === true);
  const sheet = references?.sheet || 'Sheet1';
  const categoryFormula = references?.category || `${sheet}!$A$2:$A$${rows.length + 1}`;
  const plots = entries
    .map((entry, index) => {
      const column = columnLetter(index + 2);
      const nameFormula = references?.names?.[index] || `${sheet}!$${column}$1`;
      const valueFormula = references?.values?.[index] || `${sheet}!$${column}$2:$${column}$${rows.length + 1}`;
      return (
        `<c:ser><c:idx val="${index}"/><c:order val="${index}"/>` +
        `<c:tx>${stringReference(nameFormula, [entry.name ?? `Series ${index + 1}`])}</c:tx>` +
        seriesShape(family, entry.color || DEFAULT_SERIES_COLORS[index % DEFAULT_SERIES_COLORS.length]) +
        // A line is the line, as Microsoft Excel and PowerPoint draw chartType 'line': left to the reader's default a
        // 21-day series carried a diamond on every day and read as a dotted band, and the same chart written through
        // Office had none.
        (family.element === 'lineChart' ? '<c:marker><c:symbol val="none"/></c:marker>' : '') +
        (family.element === 'barChart' ? '<c:invertIfNegative val="0"/>' : '') +
        dataPointShapes(family, pointColorsFor(family, entry, rows)) +
        dataLabels({
          showValues,
          position: dataLabelPosition,
          color: dataLabelColor,
          numberFormat: entry.numberFormat || valueNumberFormat,
          family,
          size: text.label,
          pointColors: pointColorsFor(family, entry, rows),
        }) +
        `<c:cat>${stringReference(categoryFormula, rows)}</c:cat>` +
        `<c:val>${numberReference(valueFormula, entry.values, entry.numberFormat || valueNumberFormat)}</c:val>` +
        (family.element === 'lineChart' ? '<c:smooth val="0"/>' : '') +
        '</c:ser>'
      );
    })
    .join('');
  let grouping = '';
  if (family.element === 'barChart') grouping = `<c:grouping val="${family.grouping || 'clustered'}"/>`;
  else if (family.element === 'lineChart' || family.element === 'areaChart') {
    grouping = `<c:grouping val="${family.grouping || 'standard'}"/>`;
  }
  const gapWidth = family.grouping === 'stacked' ? 60 : 90;
  const plot =
    `<c:${family.element}>` +
    (family.direction ? `<c:barDir val="${family.direction}"/>` : '') +
    grouping +
    // A pie or doughnut varies its colours by point, so its legend lists the slices; left at 0, LibreOffice's legend
    // named the one series instead of the categories.
    `<c:varyColors val="${family.element === 'pieChart' || family.element === 'doughnutChart' ? 1 : 0}"/>` +
    plots +
    (family.element === 'barChart' ? `<c:gapWidth val="${gapWidth}"/>` : '') +
    (family.element === 'barChart' && family.grouping === 'stacked' ? '<c:overlap val="100"/>' : '') +
    (family.element === 'barChart' && family.grouping !== 'stacked' ? '<c:overlap val="-20"/>' : '') +
    // A ring states its hole: without holeSize PowerPoint drew the doughnut as a full pie.
    (family.element === 'doughnutChart' ? '<c:firstSliceAng val="0"/><c:holeSize val="55"/>' : '') +
    (family.axes ? `<c:axId val="${CATEGORY_AXIS_ID}"/><c:axId val="${VALUE_AXIS_ID}"/>` : '') +
    `</c:${family.element}>`;
  // A pie or doughnut is its categories, and its value labels do not name them: it keeps a legend by default, where
  // one series of bars or a line does without.
  const slices = family.element === 'pieChart' || family.element === 'doughnutChart';
  const legend =
    showLegend === false || (showLegend == null && entries.length < 2 && !slices)
      ? ''
      : '<c:legend><c:legendPos val="b"/><c:overlay val="0"/>' +
        `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${text.body}"/></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>` +
        '</c:legend>';
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    `<c:chartSpace xmlns:c="${CHART_NAMESPACE}" xmlns:a="${DRAWING_NAMESPACE}" xmlns:r="${RELATIONSHIP_NAMESPACE}">` +
    '<c:roundedCorners val="0"/>' +
    '<c:chart>' +
    chartTitle(title, font, text.title) +
    '<c:plotArea><c:layout/>' +
    plot +
    (family.axes
      ? `${categoryAxis({
          hidden: axis?.hideCategoryAxis === true,
          horizontal: family.direction === 'bar',
          size: text.body,
          low: negative,
        })}${valueAxis({
          size: text.body,
          horizontal: family.direction === 'bar',
          numberFormat: valueNumberFormat,
          zeroBaseline: baseline,
          hidden: axis?.hideValueAxis === true,
          min: axis?.min ?? null,
          max: axis?.max ?? null,
          gridlines: axis?.gridlines !== false,
        })}`
      : '') +
    '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>' +
    '</c:plotArea>' +
    legend +
    '<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/>' +
    '</c:chart>' +
    '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>' +
    (font
      ? `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr>${runFaces(font)}</a:defRPr></a:pPr>` +
        '<a:endParaRPr lang="en-US"/></a:p></c:txPr>'
      : '') +
    (externalDataId ?`<c:externalData r:id="${externalDataId}"><c:autoUpdate val="0"/></c:externalData>` : '') +
    '</c:chartSpace>'
  );
}

export function chartWorkbookRows(categories = [], series = []) {
  const header = ['', ...series.map((entry, index) => entry?.name ?? `Series ${index + 1}`)];
  const rows = categories.map((category, rowIndex) => [
    String(category ?? ''),
    ...series.map((entry) => {
      const value = Number(entry?.values?.[rowIndex]);
      return Number.isFinite(value) ? value : '';
    }),
  ]);
  return [header, ...rows];
}
