import { dirname, join, posix } from 'node:path';
import { chartWorkbookRows, chartXml } from './portable-chart.mjs';
import { addPackageRelationship, partRelationshipPath, relationshipMap, zipText } from './portable-opc.mjs';
import { OFFICE_RELATIONSHIP_BASE, containerInner, tagPattern, topLevelElements, upsertOrderedChild, xmlEncode } from './portable-xml.mjs';
import { CHART_AXIS_ORDER, LABEL_POSITION_CODES, chartCategories, chartFrameXml, chartTitleText, detectChartType, resolveSlideChart, writePresentationChart } from './portable-pptx-chart.mjs';
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
      zeroBaseline: op.zeroBaseline === true,
      externalDataId: 'rId1',
    }),
    rows: chartWorkbookRows(categories, series),
  });
  const relationshipId = await addPackageRelationship(
    zip,
    partRelationshipPath(path),
    `${OFFICE_RELATIONSHIP_BASE}/chart`,
    posix.relative('ppt/slides', chartPart),
  );
  const id = nextShapeId(current);
  zip.file(path, appendSlideShape(current, chartFrameXml({
    id,
    relationshipId,
    left: op.left ?? 72,
    top: op.top ?? 72,
    width: op.width ?? 480,
    height: op.height ?? 280,
  })));
  return { op: op.op, changed: true, shapeId: id, chart: chartPart };
}


export async function handleSetChartData(context, op) {
  const { zip } = context;
  const slides = context.slides;
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
  const chartPart = posix.normalize(posix.join('ppt/slides', target));
  const existing = await zipText(zip, chartPart);
  if (!existing) throw new Error(`PPTX chart part is missing: ${chartPart}`);
  const series = Array.isArray(op.series) ? op.series : [];
  if (!series.length) throw new Error('set_chart_data requires series');
  const categories = Array.isArray(op.categories) ? op.categories : chartCategories(existing);
  const chartRelationships = await zipText(zip, partRelationshipPath(chartPart));
  const embedded = /<Relationship\b[^>]*\bType="[^"]*\/package"[^>]*\bTarget="([^"]+)"/.exec(chartRelationships)?.[1];
  const embeddingPart = embedded
    ? posix.normalize(posix.join(posix.dirname(chartPart), embedded))
    : `ppt/embeddings/chartData${Number(/chart(\d+)\.xml$/.exec(chartPart)?.[1]) || 1}.xlsx`;
  await writePresentationChart(zip, {
    chartPart,
    embeddingPart,
    chart: chartXml({
      chartType: op.chartType || detectChartType(existing),
      title: op.title ?? chartTitleText(existing),
      categories,
      series,
      showValues: op.showValues === true,
      dataLabelPosition: op.dataLabelPosition,
      dataLabelColor: op.dataLabelColor,
      valueNumberFormat: op.valueNumberFormat,
      showLegend: op.showLegend,
      zeroBaseline: op.zeroBaseline === true,
      externalDataId: 'rId1',
    }),
    rows: chartWorkbookRows(categories, series),
  });
  return { op: op.op, changed: true, slide: Number(op.slide), chart: chartPart };
}


export async function handleSetChartAxis(context, op) {
  const { zip } = context;
  const slides = context.slides;
  const axis = String(op.axis || '').toLowerCase();
  const tag = axis === 'category' ? 'c:catAx' : axis === 'value' ? 'c:valAx' : '';
  if (!tag) throw new Error('set_chart_axis axis must be category or value');
  const chart = await resolveSlideChart(zip, slides, op);
  const pattern = new RegExp(`<${tagPattern(tag)}>[\\s\\S]*?<\\/${tagPattern(tag)}>`);
  const block = pattern.exec(chart.xml);
  if (!block) throw new Error(`Chart has no ${axis} axis`);
  let updated = block[0];
  if (op.minimum != null || op.maximum != null) {
    updated = updated.replace(/<c:scaling>[\s\S]*?<\/c:scaling>/, (scaling) => {
      const cleaned = scaling.replace(/<c:min\b[^>]*\/>/, '').replace(/<c:max\b[^>]*\/>/, '');
      const bounds = `${op.maximum != null ? `<c:max val="${Number(op.maximum)}"/>` : ''}`
        + `${op.minimum != null ? `<c:min val="${Number(op.minimum)}"/>` : ''}`;
      return cleaned.replace('</c:scaling>', `${bounds}</c:scaling>`);
    });
  }
  if (op.numberFormat != null) {
    updated = upsertOrderedChild(
      updated,
      CHART_AXIS_ORDER,
      'c:numFmt',
      op.numberFormat ? `<c:numFmt formatCode="${xmlEncode(op.numberFormat)}" sourceLinked="0"/>` : '',
    );
  }
  if (op.majorUnit != null) {
    updated = upsertOrderedChild(
      updated,
      CHART_AXIS_ORDER,
      'c:majorUnit',
      Number(op.majorUnit) > 0 ? `<c:majorUnit val="${Number(op.majorUnit)}"/>` : '',
    );
  }
  if (op.title != null) {
    const title = String(op.title);
    updated = upsertOrderedChild(
      updated,
      CHART_AXIS_ORDER,
      'c:title',
      title
        ? '<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r>'
          + `<a:rPr lang="en-US" sz="900"/><a:t>${xmlEncode(title)}</a:t>`
          + '</a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>'
        : '',
    );
  }
  zip.file(chart.part, `${chart.xml.slice(0, block.index)}${updated}${chart.xml.slice(block.index + block[0].length)}`);
  return { op: op.op, changed: updated !== block[0], slide: Number(op.slide), axis };
}


export async function handleSetChartSeries(context, op) {
  const { zip } = context;
  const slides = context.slides;
  if (op.chartType != null || op.secondaryAxis != null) {
    throw new Error('Portable set_chart_series cannot change the series type or axis; rebuild the chart with add_chart');
  }
  const chart = await resolveSlideChart(zip, slides, op);
  const wanted = Math.max(1, Number(op.series) || 1);
  let index = 0;
  let changed = false;
  const next = chart.xml.replace(/<c:ser>[\s\S]*?<\/c:ser>/g, (series) => {
    index += 1;
    if (index !== wanted) return series;
    changed = true;
    let updated = series;
    if (op.name != null) {
      updated = updated.replace(
        /(<c:tx>[\s\S]*?<c:strCache>[\s\S]*?<c:pt idx="0"><c:v>)[\s\S]*?(<\/c:v>)/,
        `$1${xmlEncode(String(op.name))}$2`,
      );
    }
    if (Array.isArray(op.categories) && op.categories.length) {
      const points = op.categories
        .map((entry, position) => `<c:pt idx="${position}"><c:v>${xmlEncode(entry ?? '')}</c:v></c:pt>`)
        .join('');
      updated = updated.replace(/<c:cat>[\s\S]*?<\/c:cat>/, (block) => block
        .replace(/<c:strCache>[\s\S]*?<\/c:strCache>/, `<c:strCache><c:ptCount val="${op.categories.length}"/>${points}</c:strCache>`)
        .replace(/(<c:f>[^<]*\$[A-Z]+\$\d+:\$[A-Z]+\$)\d+(<\/c:f>)/, `$1${op.categories.length + 1}$2`));
    }
    if (Array.isArray(op.values) && op.values.length) {
      const points = op.values
        .map((entry, position) => {
          const numeric = Number(entry);
          return Number.isFinite(numeric) ? `<c:pt idx="${position}"><c:v>${numeric}</c:v></c:pt>` : '';
        })
        .join('');
      updated = updated.replace(/<c:val>[\s\S]*?<\/c:val>/, (block) => block
        .replace(
          /<c:numCache>[\s\S]*?<\/c:numCache>/,
          (cache) => cache
            .replace(/<c:ptCount val="\d+"\/>[\s\S]*?(?=<\/c:numCache>)/, `<c:ptCount val="${op.values.length}"/>${points}`),
        )
        .replace(/(<c:f>[^<]*\$[A-Z]+\$\d+:\$[A-Z]+\$)\d+(<\/c:f>)/, `$1${op.values.length + 1}$2`));
    }
    return updated;
  });
  if (!changed) throw new Error(`Chart has no series ${wanted}`);
  zip.file(chart.part, next);
  return { op: op.op, changed: true, slide: Number(op.slide), series: wanted };
}


export async function handleSetChartTrendlineOrSetChartErrorBars(context, op) {
  const { zip } = context;
  const slides = context.slides;
  const chart = await resolveSlideChart(zip, slides, op);
  const wanted = Number(op.series);
  let index = 0;
  let changed = false;
  const element = op.op === 'set_chart_trendline'
    ? (() => {
      const types = ['linear', 'poly', 'exp', 'log', 'movingAvg', 'power'];
      const type = String(op.type || 'linear').trim();
      if (!types.includes(type)) {
        throw new Error(`set_chart_trendline type must be one of: ${types.join(', ')}`);
      }
      return `<c:trendline><c:trendlineType val="${type}"/>`
        + `<c:dispRSqr val="${op.displayRSquared === true ? 1 : 0}"/>`
        + `<c:dispEq val="${op.displayEquation === true ? 1 : 0}"/></c:trendline>`;
    })()
    : (() => {
      const directions = { y: 'y', x: 'x', vertical: 'y', horizontal: 'x' };
      const direction = directions[String(op.direction || 'y').toLowerCase()];
      if (!direction) throw new Error('set_chart_error_bars direction must be x or y');
      const style = String(op.endStyle || 'both').toLowerCase();
      const barType = ['both', 'minus', 'plus'].includes(style) ? style : 'both';
      const amount = Number(op.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('set_chart_error_bars requires a positive amount');
      }
      return `<c:errBars><c:errDir val="${direction}"/><c:errBarType val="${barType}"/>`
        + `<c:errValType val="fixedVal"/><c:noEndCap val="0"/><c:val val="${amount}"/></c:errBars>`;
    })();
  const tag = op.op === 'set_chart_trendline' ? 'c:trendline' : 'c:errBars';
  const next = chart.xml.replace(/<c:ser>[\s\S]*?<\/c:ser>/g, (series) => {
    index += 1;
    if (Number.isInteger(wanted) && wanted > 0 && wanted !== index) return series;
    changed = true;
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
  const labels = op.showValue === false && op.showCategoryName !== true
    ? ''
    : '<c:dLbls>'
      + (op.numberFormat ? `<c:numFmt formatCode="${xmlEncode(op.numberFormat)}" sourceLinked="0"/>` : '')
      + '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>'
      + (usable && !pie ? `<c:dLblPos val="${usable}"/>` : '')
      + '<c:showLegendKey val="0"/>'
      + `<c:showVal val="${op.showValue === false ? 0 : 1}"/>`
      + `<c:showCatName val="${op.showCategoryName === true ? 1 : 0}"/>`
      + '<c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/>'
      + '</c:dLbls>';
  const wanted = Number(op.series);
  let index = 0;
  let changed = false;
  const next = chart.xml.replace(/<c:ser>[\s\S]*?<\/c:ser>/g, (series) => {
    index += 1;
    if (Number.isInteger(wanted) && wanted > 0 && wanted !== index) return series;
    changed = true;
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
