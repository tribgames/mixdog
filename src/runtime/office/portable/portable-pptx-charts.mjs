import { posix } from 'node:path';
import { CHART_TEXT, chartWorkbookRows, chartXml } from './portable-chart.mjs';
import {
  addPackageRelationship,
  partRelationshipPath,
  relationshipTarget,
  relationshipTargetByType,
  zipText,
} from './portable-opc.mjs';
import { OFFICE_RELATIONSHIP_BASE, tagPattern, upsertOrderedChild, xmlEncode } from './portable-xml.mjs';
import {
  CHART_AXIS_ORDER,
  LABEL_POSITION_CODES,
  chartCategories,
  chartFrameXml,
  chartTitleText,
  detectChartType,
  readChartPresentation,
  resolveSlideChart,
  writePresentationChart,
} from './portable-pptx-chart.mjs';
import { slidePath } from './portable-pptx-package.mjs';
import { appendSlideShape, nextShapeId } from './portable-pptx-core.mjs';

export async function handleAddChart(context, op) {
  const { zip } = context;
  const slides = context.slides;
  const path = slidePath(slides, op.slide);
  const current = await zipText(zip, path);
  const categories = Array.isArray(op.categories) ? op.categories : [];
  const series = Array.isArray(op.series) ? op.series : [];
  let ordinal = 1;
  while (zip.file(`ppt/charts/chart${ordinal}.xml`)) ordinal += 1;
  const chartPart = `ppt/charts/chart${ordinal}.xml`;
  await writePresentationChart(zip, {
    chartPart,
    embeddingPart: `ppt/embeddings/chartData${ordinal}.xlsx`,
    chart: chartXml({
      chartType: op.chartType,
      title: op.title,
      categories,
      series,
      showValues: op.showValues === true,
      dataLabelPosition: op.dataLabelPosition,
      dataLabelColor: op.dataLabelColor,
      valueNumberFormat: op.valueNumberFormat,
      showLegend: op.showLegend,
      zeroBaseline: op.zeroBaseline,
      externalDataId: 'rId1',
      text: CHART_TEXT.slide,
    }),
    rows: chartWorkbookRows(categories, series),
  });
  const relationshipId = await addPackageRelationship(
    zip,
    partRelationshipPath(path),
    `${OFFICE_RELATIONSHIP_BASE}/chart`,
    posix.relative('ppt/slides', chartPart)
  );
  const id = nextShapeId(current);
  zip.file(
    path,
    appendSlideShape(
      current,
      chartFrameXml({
        id,
        relationshipId,
        left: op.left ?? 72,
        top: op.top ?? 72,
        width: op.width ?? 480,
        height: op.height ?? 280,
      })
    )
  );
  return { op: op.op, changed: true, shapeId: id, chart: chartPart };
}

// A data refresh changes the numbers, not the chart: the deck's label face and size, the number format on the
// labels, the gap between the bars, the accent point, and the axis the author hid all stay as authored. The chart
// used to be written again from the generic template around the new values, which kept a list of properties and
// lost the rest ("1,420" came back "1510" in a bold label face with an axis line drawn). When the new data has the
// chart's own series and every series one value per category, the caches and ranges are rewritten in place;
// anything else (another series count, a type or title change) takes the rebuild below.
const REBUILD_FIELDS = ['chartType', 'title', 'showValues', 'showLegend', 'zeroBaseline', 'valueNumberFormat', 'dataLabelPosition', 'dataLabelColor'];
function refreshChartDataInPlace(xml, categories, series, op) {
  if (REBUILD_FIELDS.some((field) => op[field] !== undefined)) return null;
  const blocks = [...String(xml).matchAll(/<c:ser>[\s\S]*?<\/c:ser>/g)];
  const count = categories.length;
  if (!blocks.length || blocks.length !== series.length || !count) return null;
  if (series.some((entry) => !Array.isArray(entry?.values) || entry.values.length !== count)) return null;
  const lastRow = count + 1;
  const toRow = (formula) => formula.replace(/\$(\d+)$/, () => `$${lastRow}`);
  const categoryPoints = categories.map((entry, index) => `<c:pt idx="${index}"><c:v>${xmlEncode(String(entry ?? ''))}</c:v></c:pt>`).join('');
  let next = String(xml);
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    let block = blocks[index][0];
    const entry = series[index];
    if (!/<c:val>[\s\S]*?<c:numCache>/.test(block)) return null;
    if (entry.name != null) {
      block = block.replace(
        /(<c:tx>\s*<c:strRef>[\s\S]*?<c:strCache>)[\s\S]*?(<\/c:strCache>)/,
        (_, open, close) => `${open}<c:ptCount val="1"/><c:pt idx="0"><c:v>${xmlEncode(String(entry.name))}</c:v></c:pt>${close}`
      );
    }
    if (/<c:cat>[\s\S]*?<c:multiLvlStrCache>/.test(block)) {
      block = block.replace(
        /(<c:cat>[\s\S]*?<c:multiLvlStrCache>)[\s\S]*?(<\/c:multiLvlStrCache>)/,
        (_, open, close) => `${open}<c:ptCount val="${count}"/><c:lvl>${categoryPoints}</c:lvl>${close}`
      );
    } else if (/<c:cat>[\s\S]*?<c:strCache>/.test(block)) {
      block = block.replace(
        /(<c:cat>[\s\S]*?<c:strCache>)[\s\S]*?(<\/c:strCache>)/,
        (_, open, close) => `${open}<c:ptCount val="${count}"/>${categoryPoints}${close}`
      );
    } else return null;
    const valuePoints = entry.values
      .map((value, point) => (value === null || value === '' || !Number.isFinite(Number(value)) ? '' : `<c:pt idx="${point}"><c:v>${Number(value)}</c:v></c:pt>`))
      .join('');
    block = block
      .replace(
        /(<c:val>[\s\S]*?<c:numCache>\s*(?:<c:formatCode>[\s\S]*?<\/c:formatCode>\s*)?)[\s\S]*?(<\/c:numCache>)/,
        (_, open, close) => `${open}<c:ptCount val="${count}"/>${valuePoints}${close}`
      )
      .replace(/(<c:cat>[\s\S]*?<c:f>)([^<]*)(<\/c:f>)/, (_, open, formula, close) => `${open}${toRow(formula)}${close}`)
      .replace(/(<c:val>[\s\S]*?<c:f>)([^<]*)(<\/c:f>)/, (_, open, formula, close) => `${open}${toRow(formula)}${close}`)
      // A point override past the new last point has nothing to colour.
      .replace(/<c:dPt>[\s\S]*?<\/c:dPt>/g, (point) => (Number(/<c:idx val="(\d+)"/.exec(point)?.[1]) < count ? point : ''));
    next = `${next.slice(0, blocks[index].index)}${block}${next.slice(blocks[index].index + blocks[index][0].length)}`;
  }
  return next;
}

export async function handleSetChartData(context, op) {
  const { zip } = context;
  const { part: chartPart, xml: existing } = await resolveSlideChart(zip, context.slides, op);
  const series = Array.isArray(op.series) ? op.series : [];
  if (!series.length) throw new Error('set_chart_data requires series');
  const categories = Array.isArray(op.categories) ? op.categories : chartCategories(existing);
  const chartRelationships = await zipText(zip, partRelationshipPath(chartPart));
  const embedded = relationshipTargetByType(chartRelationships, 'package');
  const embeddingPart = embedded
    ? relationshipTarget(partRelationshipPath(chartPart), embedded)
    : `ppt/embeddings/chartData${Number(/chart(\d+)\.xml$/.exec(chartPart)?.[1]) || 1}.xlsx`;
  // The chart is rewritten around the new numbers, so its own presentation is
  // read back first: a monthly refresh keeps the labels, number format, legend,
  // base line, and series colours the deck was approved with.
  const kept = readChartPresentation(existing);
  const coloured = series.map((entry, index) => {
    if (!entry) return entry;
    const points = kept.pointColors?.[index] || [];
    // Point colors are kept only where the new data still has that point, so a
    // shorter refresh never leaves the accent on a category that is gone.
    const valueCount = Array.isArray(entry.values) ? entry.values.length : 0;
    const carried =
      entry.pointColors === undefined && points.some(Boolean) ? { pointColors: points.slice(0, valueCount) } : {};
    const filled = entry.color === undefined && kept.seriesColors[index] ? { color: kept.seriesColors[index] } : {};
    return Object.keys(carried).length || Object.keys(filled).length ? { ...entry, ...filled, ...carried } : entry;
  });
  const refreshed = refreshChartDataInPlace(existing, categories, series, op);
  await writePresentationChart(zip, {
    chartPart,
    embeddingPart,
    chart: refreshed || chartXml({
      chartType: op.chartType || detectChartType(existing),
      title: op.title ?? chartTitleText(existing),
      categories,
      series: coloured,
      showValues: op.showValues === undefined ? kept.showValues : op.showValues === true,
      dataLabelPosition: op.dataLabelPosition ?? kept.dataLabelPosition,
      dataLabelColor: op.dataLabelColor ?? kept.dataLabelColor,
      valueNumberFormat: op.valueNumberFormat ?? kept.valueNumberFormat,
      showLegend: op.showLegend ?? kept.showLegend,
      zeroBaseline: op.zeroBaseline === undefined ? kept.zeroBaseline : op.zeroBaseline === true,
      axis: kept.axis,
      externalDataId: 'rId1',
      text: CHART_TEXT.slide,
    }),
    rows: chartWorkbookRows(categories, coloured),
  });
  // A zero baseline is already reported on its own; the axis line is what the
  // caller could not have asked for: a hidden axis, a zoomed range, no grid.
  const axisKept =
    kept.axis.hideValueAxis ||
    kept.axis.hideCategoryAxis ||
    kept.axis.max != null ||
    (kept.axis.min != null && kept.axis.min !== 0) ||
    !kept.axis.gridlines;
  const preserved = [
    ...(kept.showValues ? ['dataLabels'] : []),
    ...(kept.valueNumberFormat ? ['numberFormat'] : []),
    ...(kept.showLegend ? ['legend'] : []),
    ...(kept.zeroBaseline ? ['zeroBaseline'] : []),
    ...(kept.seriesColors.some(Boolean) ? ['seriesColors'] : []),
    ...(coloured.some((entry) => entry?.pointColors?.some(Boolean)) ? ['pointColors'] : []),
    ...(axisKept ? ['axis'] : []),
  ];
  return {
    op: op.op,
    changed: true,
    slide: Number(op.slide),
    chart: chartPart,
    ...(preserved.length ? { preserved } : {}),
  };
}

// Rewrites the chart's series blocks in place. `wanted` is a 1-based series
// number; anything else (no number, 0, NaN) means every series. `changed` says
// whether any series was reached, which is how a caller learns that the series
// it named does not exist.
function rewriteChartSeries(xml, wanted, rewrite) {
  let index = 0;
  let changed = false;
  const next = xml.replace(/<c:ser>[\s\S]*?<\/c:ser>/g, (series) => {
    index += 1;
    if (Number.isInteger(wanted) && wanted > 0 && wanted !== index) return series;
    changed = true;
    return rewrite(series);
  });
  return { xml: next, changed };
}

export async function handleSetChartAxis(context, op) {
  const { zip } = context;
  const slides = context.slides;
  const axis = String(op.axis || '').toLowerCase();
  let tag = '';
  if (axis === 'category') tag = 'c:catAx';
  else if (axis === 'value') tag = 'c:valAx';
  if (!tag) throw new Error('set_chart_axis axis must be category or value');
  const chart = await resolveSlideChart(zip, slides, op);
  const pattern = new RegExp(`<${tagPattern(tag)}>[\\s\\S]*?<\\/${tagPattern(tag)}>`);
  const block = pattern.exec(chart.xml);
  if (!block) throw new Error(`Chart has no ${axis} axis`);
  let updated = block[0];
  if (op.minimum != null || op.maximum != null) {
    updated = updated.replace(/<c:scaling>[\s\S]*?<\/c:scaling>/, (scaling) => {
      const cleaned = scaling.replace(/<c:min\b[^>]*\/>/, '').replace(/<c:max\b[^>]*\/>/, '');
      const bounds =
        `${op.maximum != null ? `<c:max val="${Number(op.maximum)}"/>` : ''}` +
        `${op.minimum != null ? `<c:min val="${Number(op.minimum)}"/>` : ''}`;
      return cleaned.replace('</c:scaling>', `${bounds}</c:scaling>`);
    });
  }
  if (op.numberFormat != null) {
    updated = upsertOrderedChild(
      updated,
      CHART_AXIS_ORDER,
      'c:numFmt',
      op.numberFormat ? `<c:numFmt formatCode="${xmlEncode(op.numberFormat)}" sourceLinked="0"/>` : ''
    );
  }
  if (op.majorUnit != null) {
    updated = upsertOrderedChild(
      updated,
      CHART_AXIS_ORDER,
      'c:majorUnit',
      Number(op.majorUnit) > 0 ? `<c:majorUnit val="${Number(op.majorUnit)}"/>` : ''
    );
  }
  if (op.title != null) {
    const title = String(op.title);
    updated = upsertOrderedChild(
      updated,
      CHART_AXIS_ORDER,
      'c:title',
      title
        ? '<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r>' +
            `<a:rPr lang="en-US" sz="900"/><a:t>${xmlEncode(title)}</a:t>` +
            '</a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>'
        : ''
    );
  }
  zip.file(chart.part, `${chart.xml.slice(0, block.index)}${updated}${chart.xml.slice(block.index + block[0].length)}`);
  return { op: op.op, changed: updated !== block[0], slide: Number(op.slide), axis };
}

export async function handleSetChartSeries(context, op) {
  const { zip } = context;
  const slides = context.slides;
  if (op.chartType != null || op.secondaryAxis != null) {
    throw new Error(
      'Portable set_chart_series cannot change the series type or axis; rebuild the chart with add_chart'
    );
  }
  const chart = await resolveSlideChart(zip, slides, op);
  const wanted = Math.max(1, Number(op.series) || 1);
  const { xml: next, changed } = rewriteChartSeries(chart.xml, wanted, (series) => {
    let updated = series;
    if (op.name != null) {
      updated = updated.replace(
        /(<c:tx>[\s\S]*?<c:strCache>[\s\S]*?<c:pt idx="0"><c:v>)[\s\S]*?(<\/c:v>)/,
        `$1${xmlEncode(String(op.name))}$2`
      );
    }
    if (Array.isArray(op.categories) && op.categories.length) {
      const points = op.categories
        .map((entry, position) => `<c:pt idx="${position}"><c:v>${xmlEncode(entry ?? '')}</c:v></c:pt>`)
        .join('');
      updated = updated.replace(/<c:cat>[\s\S]*?<\/c:cat>/, (block) =>
        block
          .replace(
            /<c:strCache>[\s\S]*?<\/c:strCache>/,
            `<c:strCache><c:ptCount val="${op.categories.length}"/>${points}</c:strCache>`
          )
          .replace(/(<c:f>[^<]*\$[A-Z]+\$\d+:\$[A-Z]+\$)\d+(<\/c:f>)/, `$1${op.categories.length + 1}$2`)
      );
    }
    if (Array.isArray(op.values) && op.values.length) {
      const points = op.values
        .map((entry, position) => {
          const numeric = Number(entry);
          return Number.isFinite(numeric) ? `<c:pt idx="${position}"><c:v>${numeric}</c:v></c:pt>` : '';
        })
        .join('');
      updated = updated.replace(/<c:val>[\s\S]*?<\/c:val>/, (block) =>
        block
          .replace(/<c:numCache>[\s\S]*?<\/c:numCache>/, (cache) =>
            cache.replace(
              /<c:ptCount val="\d+"\/>[\s\S]*?(?=<\/c:numCache>)/,
              `<c:ptCount val="${op.values.length}"/>${points}`
            )
          )
          .replace(/(<c:f>[^<]*\$[A-Z]+\$\d+:\$[A-Z]+\$)\d+(<\/c:f>)/, `$1${op.values.length + 1}$2`)
      );
    }
    return updated;
  });
  if (!changed) throw new Error(`Chart has no series ${wanted}`);
  zip.file(chart.part, next);
  return { op: op.op, changed: true, slide: Number(op.slide), series: wanted };
}

// The kinds by their names (exponential, moving_average) or the file's own codes (exp, movingAvg): the Office
// backend took only the names and drew 'exp' as a straight line, this one only the codes.
const TRENDLINE_TYPES = Object.freeze({
  linear: 'linear',
  exponential: 'exp',
  exp: 'exp',
  logarithmic: 'log',
  log: 'log',
  polynomial: 'poly',
  poly: 'poly',
  power: 'power',
  movingaverage: 'movingAvg',
  movingavg: 'movingAvg',
});

function trendlineXml(op) {
  const type = TRENDLINE_TYPES[String(op.type || 'linear').trim().toLowerCase().replace(/[\s_-]+/g, '')];
  if (!type) {
    throw new Error(
      'set_chart_trendline type must be linear, exponential, logarithmic, polynomial, power, or moving_average'
    );
  }
  return (
    `<c:trendline><c:trendlineType val="${type}"/>` +
    `<c:dispRSqr val="${op.displayRSquared === true ? 1 : 0}"/>` +
    `<c:dispEq val="${op.displayEquation === true ? 1 : 0}"/></c:trendline>`
  );
}

function errorBarsXml(op) {
  const directions = { y: 'y', x: 'x', vertical: 'y', horizontal: 'x' };
  const direction = directions[String(op.direction || 'y').toLowerCase()];
  if (!direction) throw new Error('set_chart_error_bars direction must be x or y');
  const style = String(op.endStyle || 'both').toLowerCase();
  const barType = ['both', 'minus', 'plus'].includes(style) ? style : 'both';
  const amount = Number(op.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('set_chart_error_bars requires a positive amount');
  }
  return (
    `<c:errBars><c:errDir val="${direction}"/><c:errBarType val="${barType}"/>` +
    `<c:errValType val="fixedVal"/><c:noEndCap val="0"/><c:val val="${amount}"/></c:errBars>`
  );
}

export async function handleSetChartTrendlineOrSetChartErrorBars(context, op) {
  const { zip } = context;
  const slides = context.slides;
  const chart = await resolveSlideChart(zip, slides, op);
  const wanted = Number(op.series);
  const element = op.op === 'set_chart_trendline' ? trendlineXml(op) : errorBarsXml(op);
  const tag = op.op === 'set_chart_trendline' ? 'c:trendline' : 'c:errBars';
  const { xml: next, changed } = rewriteChartSeries(chart.xml, wanted, (series) => {
    const cleaned = series.replace(new RegExp(`<${tagPattern(tag)}>[\\s\\S]*?<\\/${tagPattern(tag)}>`, 'g'), '');
    const anchor = /<c:cat>/.exec(cleaned) || /<c:val>/.exec(cleaned);
    return anchor
      ? `${cleaned.slice(0, anchor.index)}${element}${cleaned.slice(anchor.index)}`
      : cleaned.replace('</c:ser>', `${element}</c:ser>`);
  });
  if (!changed) throw new Error(`Chart has no series ${op.series ?? ''}`.trim());
  zip.file(chart.part, next);
  return { op: op.op, changed: true, slide: Number(op.slide), series: wanted || 'all' };
}

export async function handleSetChartDataLabels(context, op) {
  const { zip } = context;
  const slides = context.slides;
  const chart = await resolveSlideChart(zip, slides, op);
  const position = LABEL_POSITION_CODES[String(op.position || '').toLowerCase()] || '';
  const stacked = /<c:grouping val="stacked"\/>/.test(chart.xml);
  const pie = /<c:(?:pie|doughnut)Chart\b/.test(chart.xml);
  const usable = stacked && position === 'outEnd' ? 'ctr' : position;
  let labels = '';
  if (op.showValue !== false || op.showCategoryName === true) {
    labels =
      '<c:dLbls>' +
      (op.numberFormat ? `<c:numFmt formatCode="${xmlEncode(op.numberFormat)}" sourceLinked="0"/>` : '') +
      '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>' +
      (usable && !pie ? `<c:dLblPos val="${usable}"/>` : '') +
      '<c:showLegendKey val="0"/>' +
      `<c:showVal val="${op.showValue === false ? 0 : 1}"/>` +
      `<c:showCatName val="${op.showCategoryName === true ? 1 : 0}"/>` +
      '<c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/>' +
      '</c:dLbls>';
  }
  const wanted = Number(op.series);
  const { xml: next, changed } = rewriteChartSeries(chart.xml, wanted, (series) => {
    const cleaned = series.replace(/<c:dLbls>[\s\S]*?<\/c:dLbls>/, '');
    if (!labels) return cleaned;
    const anchor = /<c:cat>/.exec(cleaned);
    return anchor
      ? `${cleaned.slice(0, anchor.index)}${labels}${cleaned.slice(anchor.index)}`
      : cleaned.replace('</c:ser>', `${labels}</c:ser>`);
  });
  if (!changed) throw new Error(`Chart has no series ${op.series ?? ''}`.trim());
  zip.file(chart.part, next);
  return { op: op.op, changed: true, slide: Number(op.slide), series: wanted || 'all' };
}
