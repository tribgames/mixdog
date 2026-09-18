import test from 'node:test';
import assert from 'node:assert/strict';
import { chartDataLinkFaults, chartFaultsInXml } from './portable-chart-faults.mjs';

const axes = (catId, valId) =>
  `<c:catAx><c:axId val="${catId}"/><c:crossAx val="${valId}"/></c:catAx><c:valAx><c:axId val="${valId}"/><c:crossAx val="${catId}"/></c:valAx>`;
const bar = ({ grouping = 'clustered', label = 'outEnd', ids = ['1', '2'] } = {}) =>
  `<c:barChart><c:barDir val="col"/><c:grouping val="${grouping}"/>` +
  `<c:ser><c:idx val="0"/><c:dLbls><c:dLblPos val="${label}"/><c:showVal val="1"/></c:dLbls></c:ser>` +
  ids.map((id) => `<c:axId val="${id}"/>`).join('') +
  '</c:barChart>';
const chart = (body, tail = '') =>
  `<c:chartSpace><c:chart><c:plotArea>${body}</c:plotArea></c:chart>${tail}</c:chartSpace>`;
const external = (id) => `<c:externalData r:id="${id}"><c:autoUpdate val="0"/></c:externalData>`;

test('clustered charts with declared axes and outEnd labels pass', () => {
  assert.deepEqual(chartFaultsInXml('ppt/charts/chart1.xml', chart(bar() + axes('1', '2'))), []);
});

test('outEnd labels on a stacked bar are reported as a PowerPoint-refused fault', () => {
  const issues = chartFaultsInXml('ppt/charts/chart1.xml', chart(bar({ grouping: 'stacked' }) + axes('1', '2')));
  assert.deepEqual(
    issues.map((issue) => [issue.code, issue.severity, issue.path]),
    [['chart_stacked_label_position', 'error', '/ppt/charts/chart1.xml']]
  );
  assert.match(issues[0].message, /ctr, inEnd, inBase/);
  assert.deepEqual(
    chartFaultsInXml(
      'ppt/charts/chart2.xml',
      chart(bar({ grouping: 'percentStacked', label: 'ctr' }) + axes('1', '2'))
    ),
    []
  );
});

test('a plot group pointing at axes the part never declares is reported', () => {
  const combo = chart(
    bar() + `<c:lineChart><c:grouping val="standard"/><c:axId val="3"/><c:axId val="4"/></c:lineChart>` + axes('1', '2')
  );
  const issues = chartFaultsInXml('ppt/charts/chart3.xml', combo);
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ['chart_axis_undeclared']
  );
  assert.match(issues[0].message, /axId 3, 4, of which 3, 4 name no axis/);
  assert.match(issues[0].message, /valAxes and catAxes/);
});

test('ids inside extLst never count and pie charts have no axis contract', () => {
  const noisy = chart(
    '<c:pieChart><c:varyColors val="1"/></c:pieChart>' +
      bar({ grouping: 'stacked', label: 'ctr' }) +
      '<c:extLst><c:ext><c:barChart><c:grouping val="stacked"/><c:dLblPos val="outEnd"/><c:axId val="9"/></c:barChart></c:ext></c:extLst>' +
      axes('1', '2')
  );
  assert.deepEqual(chartFaultsInXml('ppt/charts/chart4.xml', noisy), []);
});

test('a chart whose embedded workbook is in the package keeps its data link', () => {
  assert.deepEqual(
    chartDataLinkFaults('ppt/charts/chart1.xml', chart(bar() + axes('1', '2'), external('rId1')), {
      relationships: new Map([['rId1', '../embeddings/chartData1.xlsx']]),
      hasPart: (name) => name === 'ppt/embeddings/chartData1.xlsx',
    }),
    []
  );
});

test('a chart with series but no workbook behind them is reported as unlinked data', () => {
  const missing = chartDataLinkFaults('ppt/charts/chart2.xml', chart(bar() + axes('1', '2')));
  assert.deepEqual(
    missing.map((issue) => [issue.code, issue.severity, issue.path]),
    [['chart_data_unlinked', 'warning', '/ppt/charts/chart2.xml']]
  );
  assert.match(missing[0].message, /declares no <c:externalData>/);
  const dangling = chartDataLinkFaults('ppt/charts/chart3.xml', chart(bar() + axes('1', '2'), external('rId1')), {
    relationships: new Map([['rId1', '../embeddings/chartData7.xlsx']]),
  });
  assert.match(dangling[0].message, /points at ppt\/embeddings\/chartData7\.xlsx/);
  const unknownId = chartDataLinkFaults('ppt/charts/chart4.xml', chart(bar() + axes('1', '2'), external('rId9')));
  assert.match(unknownId[0].message, /names relationship rId9/);
});

test('a chart part with no series is a template, not a broken data link', () => {
  assert.deepEqual(chartDataLinkFaults('ppt/charts/chart5.xml', chart('<c:pieChart><c:varyColors val="1"/></c:pieChart>')), []);
});
