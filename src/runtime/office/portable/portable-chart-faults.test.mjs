import test from 'node:test';
import assert from 'node:assert/strict';
import { chartFaultsInXml } from './portable-chart-faults.mjs';

const axes = (catId, valId) => `<c:catAx><c:axId val="${catId}"/><c:crossAx val="${valId}"/></c:catAx><c:valAx><c:axId val="${valId}"/><c:crossAx val="${catId}"/></c:valAx>`;
const bar = ({ grouping = 'clustered', label = 'outEnd', ids = ['1', '2'] } = {}) => `<c:barChart><c:barDir val="col"/><c:grouping val="${grouping}"/>`
  + `<c:ser><c:idx val="0"/><c:dLbls><c:dLblPos val="${label}"/><c:showVal val="1"/></c:dLbls></c:ser>`
  + ids.map((id) => `<c:axId val="${id}"/>`).join('') + '</c:barChart>';
const chart = (body) => `<c:chartSpace><c:chart><c:plotArea>${body}</c:plotArea></c:chart></c:chartSpace>`;

test('clustered charts with declared axes and outEnd labels pass', () => {
  assert.deepEqual(chartFaultsInXml('ppt/charts/chart1.xml', chart(bar() + axes('1', '2'))), []);
});

test('outEnd labels on a stacked bar are reported as a PowerPoint-refused fault', () => {
  const issues = chartFaultsInXml('ppt/charts/chart1.xml', chart(bar({ grouping: 'stacked' }) + axes('1', '2')));
  assert.deepEqual(issues.map((issue) => [issue.code, issue.severity, issue.path]), [['chart_stacked_label_position', 'error', '/ppt/charts/chart1.xml']]);
  assert.match(issues[0].message, /ctr, inEnd, inBase/);
  assert.deepEqual(chartFaultsInXml('ppt/charts/chart2.xml', chart(bar({ grouping: 'percentStacked', label: 'ctr' }) + axes('1', '2'))), []);
});

test('a plot group pointing at axes the part never declares is reported', () => {
  const combo = chart(bar() + `<c:lineChart><c:grouping val="standard"/><c:axId val="3"/><c:axId val="4"/></c:lineChart>` + axes('1', '2'));
  const issues = chartFaultsInXml('ppt/charts/chart3.xml', combo);
  assert.deepEqual(issues.map((issue) => issue.code), ['chart_axis_undeclared']);
  assert.match(issues[0].message, /axId 3, 4, of which 3, 4 name no axis/);
  assert.match(issues[0].message, /valAxes and catAxes/);
});

test('ids inside extLst never count and pie charts have no axis contract', () => {
  const noisy = chart('<c:pieChart><c:varyColors val="1"/></c:pieChart>'
    + bar({ grouping: 'stacked', label: 'ctr' })
    + '<c:extLst><c:ext><c:barChart><c:grouping val="stacked"/><c:dLblPos val="outEnd"/><c:axId val="9"/></c:barChart></c:ext></c:extLst>'
    + axes('1', '2'));
  assert.deepEqual(chartFaultsInXml('ppt/charts/chart4.xml', noisy), []);
});
