import { xmlEncode } from './portable-xml.mjs';

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

const LABEL_POSITIONS = Object.freeze({
  inside_end: 'inEnd',
  inside_base: 'inBase',
  outside_end: 'outEnd',
  center: 'ctr',
  centre: 'ctr',
  best_fit: 'bestFit',
});

function hex(value) {
  const raw = String(value ?? '').trim().replace(/^#/, '').toUpperCase();
  if (/^[0-9A-F]{6}$/.test(raw)) return raw;
  if (/^[0-9A-F]{3}$/.test(raw)) return raw.split('').map((digit) => `${digit}${digit}`).join('');
  return '';
}

export function resolveChartFamily(chartType) {
  const key = String(chartType || 'column').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return CHART_FAMILIES[key] ? { key, ...CHART_FAMILIES[key] } : null;
}

export function supportedChartTypes() {
  return Object.keys(CHART_FAMILIES);
}

export function columnLetter(index) {
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
  return `<c:strRef><c:f>${xmlEncode(formula)}</c:f>`
    + `<c:strCache><c:ptCount val="${values.length}"/>${points}</c:strCache></c:strRef>`;
}

function numberReference(formula, values, formatCode) {
  const points = values
    .map((value, index) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? `<c:pt idx="${index}"><c:v>${numeric}</c:v></c:pt>` : '';
    })
    .join('');
  return `<c:numRef><c:f>${xmlEncode(formula)}</c:f>`
    + `<c:numCache><c:formatCode>${xmlEncode(formatCode || 'General')}</c:formatCode>`
    + `<c:ptCount val="${values.length}"/>${points}</c:numCache></c:numRef>`;
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
  return colors.map((color, index) => {
    const shape = seriesShape(family, color);
    return shape ? `<c:dPt><c:idx val="${index}"/>${shape}</c:dPt>` : '';
  }).join('');
}

function dataLabels({ showValues, position, color, numberFormat, family }) {
  if (!showValues) return '';
  const resolved = LABEL_POSITIONS[String(position || '').toLowerCase()] || '';
  const usable = family.axes && family.grouping !== 'stacked'
    ? resolved
    : (resolved === 'outEnd' ? 'ctr' : resolved);
  const label = hex(color);
  return '<c:dLbls>'
    + (numberFormat ? `<c:numFmt formatCode="${xmlEncode(numberFormat)}" sourceLinked="0"/>` : '')
    + '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>'
    + (label
      ? `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1000" b="1"><a:solidFill><a:srgbClr val="${label}"/></a:solidFill></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`
      : '')
    + (usable && family.element !== 'pieChart' && family.element !== 'doughnutChart' ? `<c:dLblPos val="${usable}"/>` : '')
    + '<c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/>'
    + '<c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/>'
    + '</c:dLbls>';
}

function axisText() {
  return '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900">'
    + '<a:solidFill><a:srgbClr val="5F6368"/></a:solidFill></a:defRPr></a:pPr>'
    + '<a:endParaRPr lang="en-US"/></a:p></c:txPr>';
}

function categoryAxis() {
  return `<c:catAx><c:axId val="${CATEGORY_AXIS_ID}"/>`
    + '<c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>'
    + '<c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>'
    + '<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="C7CBD1"/></a:solidFill></a:ln></c:spPr>'
    + axisText()
    + `<c:crossAx val="${VALUE_AXIS_ID}"/><c:crosses val="autoZero"/><c:auto val="1"/>`
    + '<c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>';
}

function valueAxis({ numberFormat, zeroBaseline }) {
  return `<c:valAx><c:axId val="${VALUE_AXIS_ID}"/>`
    + `<c:scaling><c:orientation val="minMax"/>${zeroBaseline ? '<c:min val="0"/>' : ''}</c:scaling>`
    + '<c:delete val="0"/><c:axPos val="l"/>'
    + '<c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="E7E9EC"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>'
    + (numberFormat ? `<c:numFmt formatCode="${xmlEncode(numberFormat)}" sourceLinked="0"/>` : '')
    + '<c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>'
    + '<c:spPr><a:ln><a:noFill/></a:ln></c:spPr>'
    + axisText()
    + `<c:crossAx val="${CATEGORY_AXIS_ID}"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`;
}

function chartTitle(text) {
  if (!text) return '<c:autoTitleDeleted val="1"/>';
  return '<c:title><c:tx><c:rich><a:bodyPr rot="0" spcFirstLastPara="1" vertOverflow="ellipsis" vert="horz" wrap="square" anchor="ctr" anchorCtr="1"/>'
    + '<a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200" b="1">'
    + '<a:solidFill><a:srgbClr val="171717"/></a:solidFill></a:defRPr></a:pPr>'
    + `<a:r><a:rPr lang="en-US" sz="1200" b="1"/><a:t>${xmlEncode(text)}</a:t></a:r></a:p></c:rich></c:tx>`
    + '<c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>';
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
  zeroBaseline = false,
  externalDataId = '',
} = {}) {
  const family = resolveChartFamily(chartType);
  if (!family) {
    throw new Error(`Unsupported chartType: ${chartType}. Use one of: ${supportedChartTypes().join(', ')}`);
  }
  const rows = categories.map((entry) => String(entry ?? ''));
  const entries = series.filter((entry) => entry && Array.isArray(entry.values));
  if (!entries.length) throw new Error('add_chart requires at least one series with values');
  const sheet = references?.sheet || 'Sheet1';
  const categoryFormula = references?.category
    || `${sheet}!$A$2:$A$${rows.length + 1}`;
  const plots = entries.map((entry, index) => {
    const column = columnLetter(index + 2);
    const nameFormula = references?.names?.[index] || `${sheet}!$${column}$1`;
    const valueFormula = references?.values?.[index] || `${sheet}!$${column}$2:$${column}$${rows.length + 1}`;
    return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/>`
      + `<c:tx>${stringReference(nameFormula, [entry.name ?? `Series ${index + 1}`])}</c:tx>`
      + seriesShape(family, entry.color)
      + (family.element === 'barChart' ? '<c:invertIfNegative val="0"/>' : '')
      + dataPointShapes(family, entry.pointColors)
      + dataLabels({
        showValues,
        position: dataLabelPosition,
        color: dataLabelColor,
        numberFormat: entry.numberFormat || valueNumberFormat,
        family,
      })
      + `<c:cat>${stringReference(categoryFormula, rows)}</c:cat>`
      + `<c:val>${numberReference(valueFormula, entry.values, entry.numberFormat || valueNumberFormat)}</c:val>`
      + (family.element === 'lineChart' ? '<c:smooth val="0"/>' : '')
      + '</c:ser>';
  }).join('');
  const grouping = family.element === 'barChart'
    ? `<c:grouping val="${family.grouping || 'clustered'}"/>`
    : family.element === 'lineChart' || family.element === 'areaChart'
      ? `<c:grouping val="${family.grouping || 'standard'}"/>`
      : '';
  const plot = `<c:${family.element}>`
    + (family.direction ? `<c:barDir val="${family.direction}"/>` : '')
    + grouping
    + '<c:varyColors val="0"/>'
    + plots
    + (family.element === 'barChart' ? `<c:gapWidth val="${family.grouping === 'stacked' ? 60 : 90}"/>` : '')
    + (family.element === 'barChart' && family.grouping === 'stacked' ? '<c:overlap val="100"/>' : '')
    + (family.element === 'barChart' && family.grouping !== 'stacked' ? '<c:overlap val="-20"/>' : '')
    + (family.axes ? `<c:axId val="${CATEGORY_AXIS_ID}"/><c:axId val="${VALUE_AXIS_ID}"/>` : '')
    + `</c:${family.element}>`;
  const legend = showLegend === false || (showLegend == null && entries.length < 2)
    ? ''
    : '<c:legend><c:legendPos val="b"/><c:overlay val="0"/>'
      + '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"/></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>'
      + '</c:legend>';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
    + `<c:chartSpace xmlns:c="${CHART_NAMESPACE}" xmlns:a="${DRAWING_NAMESPACE}" xmlns:r="${RELATIONSHIP_NAMESPACE}">`
    + '<c:roundedCorners val="0"/>'
    + '<c:chart>'
    + chartTitle(title)
    + '<c:plotArea><c:layout/>'
    + plot
    + (family.axes ? `${categoryAxis()}${valueAxis({ numberFormat: valueNumberFormat, zeroBaseline })}` : '')
    + '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>'
    + '</c:plotArea>'
    + legend
    + '<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/>'
    + '</c:chart>'
    + '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>'
    + (externalDataId ? `<c:externalData r:id="${externalDataId}"><c:autoUpdate val="0"/></c:externalData>` : '')
    + '</c:chartSpace>';
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
