import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAccentSeries, normalizeChartFonts } from './pptx-script-normalize.mjs';

const run = (face) => `<a:defRPr sz="1100"><a:solidFill><a:srgbClr val="5A6B7B"/></a:solidFill><a:latin typeface="${face}" pitchFamily="34" charset="0"/></a:defRPr>`;
const chart = (body) => `<c:chartSpace><c:chart><c:plotArea><c:barChart><c:catAx><c:txPr><a:p><a:pPr>${body}</a:pPr></a:p></c:txPr></c:catAx></c:barChart></c:plotArea></c:chart><c:spPr><a:noFill/></c:spPr><c:externalData r:id="rId1"/></c:chartSpace>`;

test('chart runs get East Asian and complex-script faces matching their latin face', () => {
  const { xml, changed, face } = normalizeChartFonts(chart(run('Noto Sans KR')));
  assert.equal(face, 'Noto Sans KR');
  assert.ok(changed >= 2, 'the run and the chart-level default both changed');
  assert.match(xml, /<a:latin typeface="Noto Sans KR"[^>]*\/><a:ea typeface="Noto Sans KR"[^>]*\/><a:cs typeface="Noto Sans KR"[^>]*\/>/);
  assert.match(xml, /<\/c:spPr><c:txPr>[\s\S]*<a:latin typeface="Noto Sans KR"\/><a:ea typeface="Noto Sans KR"\/>[\s\S]*<\/c:txPr><c:externalData/, 'the chart default sits after c:spPr and before c:externalData');
  const again = normalizeChartFonts(xml);
  assert.equal(again.changed, 0, 'idempotent: a run that already carries a:ea is left alone');
});

test('a chart without any explicit face is left untouched', () => {
  const plain = '<c:chartSpace><c:chart><c:plotArea/></c:chart></c:chartSpace>';
  assert.deepEqual(normalizeChartFonts(plain), { xml: plain, changed: 0, face: '' });
});

test('the accent overlay series merges into one series with a per-point fill', () => {
  const ser = (name, values, color) => `<c:ser><c:idx val="0"/><c:tx><c:strRef><c:f>x</c:f><c:strCache><c:pt idx="0"><c:v>${name}</c:v></c:pt></c:strCache></c:strRef></c:tx><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/><c:val><c:numRef><c:numCache>${values.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('')}</c:numCache></c:numRef></c:val></c:ser>`;
  const xml = `<c:barChart><c:barDir val="col"/><c:grouping val="stacked"/>${ser('처리량', [12, 18, 0], 'E7EBEE')}${ser('처리량 ·', [0, 0, 31], 'B81E38')}<c:overlap val="100"/></c:barChart>`;
  const merged = mergeAccentSeries(xml);
  assert.equal(merged.changed, true);
  assert.deepEqual(merged.accent, [2]);
  assert.equal((merged.xml.match(/<c:ser>/g) || []).length, 1);
  assert.match(merged.xml, /<c:dPt><c:idx val="2"\/>[\s\S]*B81E38/);
  assert.match(merged.xml, /<c:pt idx="2"><c:v>31<\/c:v>/);
  assert.match(merged.xml, /<c:grouping val="clustered"\/>/);
});
