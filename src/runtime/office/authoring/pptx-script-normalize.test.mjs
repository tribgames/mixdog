import test from 'node:test';
import assert from 'node:assert/strict';
import { gradientFillXml, mergeAccentSeries, nativeGradients, normalizeChartFonts } from './pptx-script-normalize.mjs';

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

test('existing chart script faces survive normalization without duplicate or out-of-order font elements', () => {
  for (const existing of [
    '\n  <a:cs    typeface="Traditional Arabic"/>',
    '\n  <a:ea typeface="Noto Serif KR"/>\n  <a:cs typeface="Traditional Arabic"/>',
    '<a:ea typeface="Noto Serif KR"/><a:cs typeface="Traditional Arabic"/><a:cs typeface="Traditional Arabic"/>',
  ]) {
    const input = chart(`<a:defRPr><a:latin typeface="Noto Sans KR"/>${existing}</a:defRPr>`);
    const normalized = normalizeChartFonts(input);
    const properties = normalized.xml.match(/<a:defRPr>([\s\S]*?)<\/a:defRPr>/)[1];
    assert.equal((properties.match(/<a:ea\b/g) || []).length, 1);
    assert.equal((properties.match(/<a:cs\b/g) || []).length, 1);
    assert.match(properties, /<a:ea\b[^>]*\/>\s*<a:cs\b[^>]*typeface="Traditional Arabic"/);
    if (existing.includes('Noto Serif KR')) assert.match(properties, /typeface="Noto Serif KR"/);
    assert.equal(normalizeChartFonts(normalized.xml).changed, 0);
  }
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

test('a gradient-marked shape is saved as a native gradFill without an outline, and the marker is cleared', () => {
  const spec = encodeURIComponent(JSON.stringify({ stops: [[0, '0B1B2B', 1], [100, '1F3A5F', 0.4]], angle: 90 }));
  const shape = (name, fill) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill}<a:ln w="12700"><a:solidFill><a:srgbClr val="0B1B2B"/></a:solidFill></a:ln></p:spPr><p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp>`;
  const xml = `<p:spTree>${shape(`mixdog-gradient:${spec}`, '<a:solidFill><a:srgbClr val="0B1B2B"/></a:solidFill>')}${shape('Plain', '<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>')}</p:spTree>`;
  const { xml: out, changed } = nativeGradients(xml);
  assert.equal(changed, 1);
  assert.match(out, /name="Gradient"/);
  assert.doesNotMatch(out, /mixdog-gradient:/);
  assert.match(out, /<\/a:prstGeom><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="0B1B2B"\/><\/a:gs><a:gs pos="100000"><a:srgbClr val="1F3A5F"><a:alpha val="40000"\/><\/a:srgbClr><\/a:gs><\/a:gsLst><a:lin ang="5400000" scaled="0"\/><\/a:gradFill><a:ln><a:noFill\/><\/a:ln><\/p:spPr>/);
  assert.match(out, /name="Plain"[\s\S]*?<a:solidFill><a:srgbClr val="FFFFFF"\/><\/a:solidFill><a:ln w="12700">/, 'an unmarked shape keeps its fill and outline');
  assert.equal(nativeGradients(out).changed, 0, 'idempotent');
  const radial = gradientFillXml({ stops: [[0, 'FFAA00', 0.35], [100, 'FFAA00', 0]], radial: { fx: 0.25, fy: 0.5 } });
  assert.match(radial, /<a:path path="circle"><a:fillToRect l="25000" t="50000" r="75000" b="50000"\/><\/a:path>/);
  assert.match(radial, /<a:gs pos="100000"><a:srgbClr val="FFAA00"><a:alpha val="0"\/>/);
});
