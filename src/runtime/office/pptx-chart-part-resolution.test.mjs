import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { executeOfficeTool } from './index.mjs';
import { chartXml } from './portable/portable-chart.mjs';
import { parts, value, workspace } from './office-test-support.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

// pptxgenjs writes the chart relationship as an absolute part name
// ("/ppt/charts/chart1.xml"), where a hand-built deck writes "../charts/chart1.xml".
const DECK = `
// BRIEF
// facts: sample — test fixture, illustrative figures
const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
const slide = pres.addSlide();
slide.addChart(pres.ChartType.bar, [{ name: 'Retention', labels: ['Self-serve', 'Guided'], values: [38, 52] }], { x: 1, y: 1, w: 11, h: 5 });
await pres.writeFile({ fileName: OUTPUT });
`;

test('set_chart_data edits a pptxgenjs chart through its absolute relationship target, and a duplicated slide owns its copy', async (t) => {
  const cwd = await workspace(t);
  const deck = join(cwd, 'chart.pptx');
  const authored = value(
    await executeOfficeTool({ action: 'author', path: deck, script: DECK, mode: 'portable', render: false }, { cwd })
  );
  value(await executeOfficeTool({ action: 'close', session: authored.session }, { cwd }));
  const source = await parts(deck);
  assert.match(await source.text('ppt/slides/_rels/slide1.xml.rels'), /Target="\/ppt\/charts\/chart1\.xml"/);

  const output = join(cwd, 'chart-edited.pptx');
  const opened = value(
    await executeOfficeTool(
      {
        action: 'open',
        path: deck,
        mode: 'portable',
        output,
        snapshotAfter: false,
        operations: [{ op: 'duplicate_slide', slide: 1 }],
      },
      { cwd }
    )
  );
  const edited = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: opened.session,
        operations: [
          {
            op: 'set_chart_data',
            slide: 2,
            shape: 1,
            categories: ['Self-serve', 'Guided'],
            series: [{ name: 'Retention', values: [7, 9] }],
          },
        ],
      },
      { cwd }
    )
  );
  assert.equal(edited.results[0].chart, 'ppt/charts/chart2.xml');
  value(await executeOfficeTool({ action: 'close', session: opened.session }, { cwd }));

  const result = await parts(output);
  assert.equal(
    result.has('ppt/charts/chart2.xml'),
    true,
    'the copy owns its chart part instead of editing the source page'
  );
  assert.match(await result.text('ppt/slides/_rels/slide1.xml.rels'), /Target="\/ppt\/charts\/chart1\.xml"/);
  assert.match(await result.text('ppt/slides/_rels/slide2.xml.rels'), /Target="\/ppt\/charts\/chart2\.xml"/);
  const source1 = await result.text('ppt/charts/chart1.xml');
  assert.match(source1, /<c:v>38<\/c:v>/, 'the page that was not edited keeps the numbers it was approved with');
  const copy = await result.text('ppt/charts/chart2.xml');
  assert.match(copy, /<c:v>7<\/c:v>/);
  assert.match(copy, /<c:v>9<\/c:v>/);
  assert.doesNotMatch(copy, /<c:v>38<\/c:v>/);
});

test('a column starts its axis at zero unless the caller zooms in, a line keeps its range', () => {
  const bars = { chartType: 'column', categories: ['1월', '2월'], series: [{ name: '처리량', values: [4610, 4720] }] };
  assert.match(chartXml(bars), /<c:min val="0"\/>/);
  assert.doesNotMatch(chartXml({ ...bars, zeroBaseline: false }), /<c:min val="0"\/>/);
  assert.doesNotMatch(chartXml({ ...bars, chartType: 'line' }), /<c:min val="0"\/>/);
  assert.match(chartXml({ ...bars, chartType: 'line', zeroBaseline: true }), /<c:min val="0"\/>/);
});

test('new numbers keep the chart the deck was approved with', async (t) => {
  const cwd = await workspace(t);
  const deck = join(cwd, 'monthly.pptx');
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: deck,
        mode: 'portable',
        operations: [
          { op: 'add_slide' },
          {
            op: 'add_chart',
            slide: 1,
            chartType: 'column',
            title: '분기 처리량',
            categories: ['10월', '11월', '12월'],
            series: [{ name: '처리량', values: [4120, 4480, 4390], color: 'B04A2F' }],
            showValues: true,
            dataLabelPosition: 'outside_end',
            valueNumberFormat: '#,##0',
            zeroBaseline: true,
            left: 60,
            top: 110,
            width: 700,
            height: 330,
          },
        ],
      },
      { cwd }
    )
  );
  const refreshed = value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          {
            op: 'set_chart_data',
            slide: 1,
            shape: 1,
            categories: ['1월', '2월', '3월'],
            series: [{ name: '처리량', values: [4610, 4720, 5010] }],
          },
        ],
      },
      { cwd }
    )
  );
  assert.deepEqual(refreshed.results[0].preserved, ['dataLabels', 'numberFormat', 'zeroBaseline', 'seriesColors']);
  const packaged = await parts(deck);
  const chart = await packaged.text('ppt/charts/chart1.xml');
  assert.match(chart, /<c:v>5010<\/c:v>/);
  assert.match(chart, /<c:showVal val="1"\/>/);
  assert.match(chart, /<c:dLblPos val="outEnd"\/>/);
  assert.match(chart, /<c:min val="0"\/>/);
  assert.match(chart, /formatCode="#,##0"/);
  assert.match(chart, /<a:srgbClr val="B04A2F"\/>/);
  assert.match(chart, /<a:t>분기 처리량<\/a:t>/);

  // An explicit field still overrides what the chart carried.
  value(
    await executeOfficeTool(
      {
        action: 'batch',
        session: created.session,
        operations: [
          {
            op: 'set_chart_data',
            slide: 1,
            shape: 1,
            series: [{ name: '처리량', values: [4610, 4720, 5010] }],
            showValues: false,
          },
        ],
      },
      { cwd }
    )
  );
  const plain = await (await parts(deck)).text('ppt/charts/chart1.xml');
  assert.doesNotMatch(plain, /<c:dLbls>/);
  assert.match(plain, /<a:srgbClr val="B04A2F"\/>/);
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});
