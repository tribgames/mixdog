import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { JSDOM } from 'jsdom';
import { runPptxAuthoringScript } from './authoring/pptx-script-runner.mjs';

test('chart and table styles preserve editable data with explicit visual roles', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pptx-chart-style-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // The runner runs the whole kit (kit.md, charts.md, pictures.md) before the script, the way an authored deck runs:
  // the helpers share tokens and guards (table() checks the foot against Z), so a pasted subset drifts from the skill.
  const script = `deck({ hue: 205, mode: 'balanced', script: 'ko' });
chart(pres.addSlide(), 1, 1, 10, 5, {
  labels: ['Revenue'], series: [{name:'Prior',values:[10.125]},{name:'Current',values:[15.625]}],
  colors: ['445566','007A60'], legend:false
});
chart(pres.addSlide(), 1, 1, 10, 5, {
  type:'bar', labels:['Growth'], series:[{name:'A',values:[18.801]},{name:'B',values:[13.990]},{name:'C',values:[3.811]}],
  grouping:'stacked', categoryLabels:false, showValues:true, colors:['007A60','445566','CCDDEE'], legend:false
});
table(pres.addSlide(), 1, 1, 10, ['Business','Value'], [['Alpha','120.810'],['Beta','106.265']], {
  colW:[6,4], alignments:['left','right'], highlightRows:[1], emphasisCells:[[0,1]], headerFill:'102030', headerColor:'FFFFFF'
});
await pres.writeFile({fileName:OUTPUT});`;
  const path = join(root, 'styles.pptx');
  const written = await runPptxAuthoringScript(script, path);
  assert.equal(written.ok, true, JSON.stringify(written));
  const zip = await JSZip.loadAsync(await readFile(path));
  const [first, stacked, table] = await Promise.all([
    zip.file('ppt/charts/chart1.xml').async('string'),
    zip.file('ppt/charts/chart2.xml').async('string'),
    zip.file('ppt/slides/slide3.xml').async('string'),
  ]);
  assert.ok(zip.file('ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx'), 'native editable chart data is retained');
  for (const value of ['10.125', '15.625']) assert.ok(first.includes(`<c:v>${value}</c:v>`));
  assert.ok(first.includes('445566') && first.includes('007A60'));
  assert.doesNotMatch(first, /<c:legend>/);
  assert.match(stacked, /<c:grouping val="stacked"/);
  assert.match(stacked, /<c:dLblPos val="ctr"/);
  for (const value of ['18.801', '13.99', '3.811']) assert.ok(stacked.includes(`<c:v>${value}</c:v>`));
  assert.match(table, /<a:tbl>/);
  assert.ok(table.includes('120.810') && table.includes('106.265'));
  assert.match(table, /algn="r"/);
  // The balanced body is 15 pt (the reference IR tables run 10-16 pt type); a table cell reads at body, never at a caption.
  assert.match(table, /sz="1500"/, 'default table content uses the balanced body size, not tiny chart captions');
  assert.ok(table.includes('102030') && table.includes('FFFFFF'));
  const dom = new JSDOM(table, { contentType: 'application/xml' });
  const rows = [...dom.window.document.getElementsByTagName('a:tr')];
  const emphasized = rows[1].getElementsByTagName('a:tc')[1];
  const ordinary = rows[2].getElementsByTagName('a:tc')[1];
  assert.equal(emphasized.textContent.includes('120.810'), true);
  assert.equal(emphasized.getElementsByTagName('a:rPr')[0].getAttribute('b'), '1');
  assert.notEqual(ordinary.getElementsByTagName('a:rPr')[0].getAttribute('b'), '1');
  dom.window.close();
});

test('horizontal bars read top-down in the given order and a doughnut names its slices', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pptx-kit-bars-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = `deck({ hue: 225, mode: 'balanced', script: 'ko' });
chart(light(), 1, 1, 8, 4, { type: 'bar', labels: ['반도체', '모바일'], series: [{ name: '매출', values: [52, 40] }] });
chart(light(), 1, 1, 6, 4, { type: 'doughnut', labels: ['반도체', '모바일', '가전'], series: [{ name: '비중', values: [38, 35, 27] }] });
chart(light(), 1, 1, 8, 4, { type: 'bar', overlap: true, labels: ['반도체', '모바일'], series: [{ name: '목표', values: [50, 58] }, { name: '실적', values: [52.4, 54.5] }] });
await pres.writeFile({fileName:OUTPUT});`;
  const path = join(root, 'bars.pptx');
  const written = await runPptxAuthoringScript(script, path);
  assert.equal(written.ok, true, JSON.stringify(written));
  const zip = await JSZip.loadAsync(await readFile(path));
  const charts = await Promise.all(zip.file(/^ppt\/charts\/chart\d+\.xml$/).map((file) => file.async('string')));
  const bar = charts.find((xml) => xml.includes('<c:barChart>'));
  const ring = charts.find((xml) => xml.includes('<c:doughnutChart>'));
  assert.match(bar, /<c:catAx>[\s\S]*?<c:orientation val="maxMin"\/>/, 'the first category sits at the top');
  assert.match(bar, /<c:valAx>[\s\S]*?<c:crosses val="max"\/>/, 'the value axis stays under the bars');
  assert.match(ring, /<c:legend>/, 'the slices are named');
  // A bullet whose actual passes its target still shows the target: one tick per row over the bars.
  const bulletSlide = await zip.file('ppt/slides/slide3.xml').async('string');
  assert.equal((bulletSlide.match(/prst="line"/g) || []).length, 2, 'a target tick on each bar');
});

test('a bridge of small steps floors its axis and returns its bottom edge; a table right-aligns figures with units', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pptx-kit-bridge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = `deck({ style: 'swiss-minimal', hue: 210, mode: 'text', script: 'ko' });
const s = light();
const b = waterfall(s, 1, 1.5, 8, 4, [{ label: '2분기', value: 3060 }, { label: '대기', value: -150 }, { label: '연료', value: 40 }, { label: '3분기', total: true }]);
if (!(Math.abs(b - 5.5) < 0.001)) throw new Error('waterfall returned ' + b);
waterfall(light(), 1, 1.5, 8, 4, [{ label: '2024', value: 4200 }, { label: '대기', value: 380 }, { label: '연료', value: -1900 }, { label: '2026', total: true }]);
table(light(), 1, 1.5, 10, ['허브', '리드타임', '비용', '분기'], [['평택', '1.6시간', '2,840원', '1분기'], ['대전', '1.8시간', '2,910원', '2분기']]);
await pres.writeFile({fileName:OUTPUT});`;
  const path = join(root, 'bridge.pptx');
  const written = await runPptxAuthoringScript(script, path);
  assert.equal(written.ok, true, JSON.stringify(written));
  const zip = await JSZip.loadAsync(await readFile(path));
  const charts = await Promise.all(zip.file(/^ppt\/charts\/chart\d+\.xml$/).map((file) => file.async('string')));
  const minOf = (xml) => Number(/<c:valAx>[\s\S]*?<c:min val="([\d.]+)"\/>/.exec(xml)?.[1] ?? 0);
  const mins = charts.map(minOf).sort((a, b) => a - b);
  assert.deepEqual(mins, [0, 2600], 'the small bridge floors at 2,600; the one that falls to 2,680 of 4,580 keeps its zero axis');
  const table = await zip.file('ppt/slides/slide3.xml').async('string');
  const cell = (text) => new RegExp(`<a:pPr[^>]*algn="(\\w+)"[^>]*>(?:(?!</a:p>)[\\s\\S])*?<a:t>${text}</a:t>`).exec(table)?.[1] ?? 'l';
  assert.equal(cell('1.6시간'), 'r');
  assert.equal(cell('2,840원'), 'r');
  assert.equal(cell('1분기'), 'l', 'a period is a label');
});

test('lane units given in order share the track, and a two-word satellite label fits its disc', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pptx-kit-lanes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = `deck({ style: 'soft-rounded', hue: 160, mode: 'balanced', script: 'ko' });
await lanes(light(), M, 1.6, W - 2 * M, 4.6, [{ label: '주문', items: ['접수', '검증', '확정'] }, { name: '배차', items: ['경로 계산', '기사 배정'] }]);
const st = { x: 1, y: 1.4, w: 11, h: 4.6, cx: 6.5, cy: 3.7, r: 2.3, ground: T.paperAlt };
await hub(light(), st, { label: '플랫폼', icon: 'boxes' }, ['주문', '배차', '정산', { label: '고객 지원', icon: 'headphones' }, '데이터', '보안', '인프라']);
await pres.writeFile({fileName:OUTPUT});`;
  const path = join(root, 'lanes.pptx');
  const written = await runPptxAuthoringScript(script, path);
  assert.equal(written.ok, true, JSON.stringify(written));
  const zip = await JSZip.loadAsync(await readFile(path));
  const lanesSlide = await zip.file('ppt/slides/slide1.xml').async('string');
  const shapes = [...lanesSlide.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]);
  const leftOf = (text) => Number(/<a:off x="(\d+)"/.exec(shapes.find((sp) => sp.includes(`<a:t>${text}</a:t>`)))[1]);
  assert.ok(leftOf('접수') < leftOf('검증') && leftOf('검증') < leftOf('확정'), 'three units in order across the track');
  assert.ok(shapes.some((sp) => sp.includes('<a:t>주문</a:t>')), 'a lane named with label is labelled');
  const hubSlide = await zip.file('ppt/slides/slide2.xml').async('string');
  const support = [...hubSlide.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]).find((sp) => sp.includes('고객'));
  assert.doesNotMatch(support, /<a:br\b/, 'the two-word label sits on one line in its disc');
});

test('a quadrant item label keeps off the row the horizontal axis names sit on', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pptx-kit-quad-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = `deck({ style: 'swiss-minimal', hue: 210, mode: 'text', script: 'ko' });
await quadrants(light(), M, 1.6, 8.2, 4.8, { axes: { x: ['쉬움', '어려움'], y: ['영향 작음', '영향 큼'] }, items: [{ label: '야간 인력 증원', x: 0.25, y: 0.55 }, { label: '자동 분류기', x: 0.55, y: 0.85, active: true }] });
await pres.writeFile({fileName:OUTPUT});`;
  const path = join(root, 'quad.pptx');
  const written = await runPptxAuthoringScript(script, path);
  assert.equal(written.ok, true, JSON.stringify(written));
  const slide = await (await JSZip.loadAsync(await readFile(path))).file('ppt/slides/slide1.xml').async('string');
  const shapes = [...slide.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]);
  const top = (text) => Number(/<a:off x="\d+" y="(\d+)"/.exec(shapes.find((sp) => sp.includes(`<a:t>${text}</a:t>`)) || '')?.[1]);
  const row = top('쉬움');
  assert.ok(Number.isFinite(row) && Number.isFinite(top('야간 인력 증원')));
  assert.ok(Math.abs(top('야간 인력 증원') - row) > 0.3 * 914400 * 0.5, 'the label is not on the axis-name row');
});

test('peer figures with units of different lengths stand on one baseline in a stat band', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pptx-kit-band-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = `deck({ style: 'data-journalism', hue: 225, mode: 'balanced', script: 'ko' });
statBand(light(), 6.9, 1.8, 5.9, [{ value: '38.1', unit: '%', label: '반도체 비중' }, { value: '+4.3', unit: '%p', label: '전년 대비' }], { scale: 'hero' });
await pres.writeFile({fileName:OUTPUT});`;
  const path = join(root, 'band.pptx');
  const written = await runPptxAuthoringScript(script, path);
  assert.equal(written.ok, true, JSON.stringify(written));
  const slide = await (await JSZip.loadAsync(await readFile(path))).file('ppt/slides/slide1.xml').async('string');
  const shapes = [...slide.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]);
  const frame = (text) => {
    const sp = shapes.find((s) => s.includes(`<a:t>${text}</a:t>`));
    return { y: Number(/<a:off x="\d+" y="(\d+)"/.exec(sp)[1]), h: Number(/<a:ext cx="\d+" cy="(\d+)"/.exec(sp)[1]) };
  };
  assert.deepEqual(frame('+4.3'), frame('38.1'), 'both figures share one box height, so their bottom-anchored baselines meet');
});

test('a waterfall names its three bars and prints each figure over its bar', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pptx-kit-waterfall-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = `deck({ style: 'editorial', hue: 25, mode: 'text', script: 'ko' });
waterfall(light(), 3.2, 1.8, 6, 4.5, [{ label: '2024 물류비', value: 4200 }, { label: '대기', value: 380 }, { label: '연료 절감', value: -120 }, { label: '2026 물류비', total: true }]);
await pres.writeFile({fileName:OUTPUT});`;
  const path = join(root, 'waterfall.pptx');
  const written = await runPptxAuthoringScript(script, path);
  assert.equal(written.ok, true, JSON.stringify(written));
  const zip = await JSZip.loadAsync(await readFile(path));
  const slide = await zip.file('ppt/slides/slide1.xml').async('string');
  for (const words of ['합계', '증가', '감소', '4,200', '+380', '\u2212120', '4,460']) assert.ok(slide.includes(`>${words}<`), `${words} is on the page`);
  const chart = await zip.file(/^ppt\/charts\/chart\d+\.xml$/)[0].async('string');
  assert.match(chart, /<c:max val="\d+(\.\d+)?"\/>/, 'the plot is pinned to the scale the figures are placed on');
});

test('a dark deck lifts its accent mark off the page and a line chart accents its latest series', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pptx-kit-dark-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = `deck({ style: 'dark-tech', hue: 235, accentHue: 250, mode: 'balanced', script: 'ko' });
if (contrast(T.accentFill, T.paper) < 3) throw new Error('accent mark ' + T.accentFill + ' reads ' + contrast(T.accentFill, T.paper).toFixed(2) + ':1 on ' + T.paper);
if (contrast(T.accentLabel.color, T.accentLabel.fill) < 4.5) throw new Error('accent label unreadable');
chart(light(), 1, 1, 8, 4, { type: 'line', labels: ['1월', '2월'], series: [{ name: '전년', values: [11, 10] }, { name: '올해', values: [10, 6] }] });
let refused = '';
try { await steps(light(), M, 2, 7.9, 3.5, [{ label: '가져오기', detail: '이슈를 옮긴다' }, { label: '규칙', detail: '규칙을 만든다' }, { label: '병행', detail: '함께 쓴다' }, { label: '전환', detail: '읽기 전용' }]); } catch (error) { refused = error.message; }
if (!/floor/.test(refused)) throw new Error('four detailed steps in 7.9 in were drawn narrow: ' + refused);
light().addText('accent:' + T.accentFill, { x: 1, y: 1, w: 4, h: 0.5, fontSize: 12 });
await pres.writeFile({fileName:OUTPUT});`;
  const path = join(root, 'dark.pptx');
  const written = await runPptxAuthoringScript(script, path);
  assert.equal(written.ok, true, JSON.stringify(written));
  const zip = await JSZip.loadAsync(await readFile(path));
  const chart = await zip.file(/^ppt\/charts\/chart\d+\.xml$/)[0].async('string');
  const colors = [...chart.matchAll(/<c:ser>[\s\S]*?<a:srgbClr val="([0-9A-F]{6})"/gi)].map((match) => match[1].toUpperCase());
  assert.equal(colors.length, 2, chart.slice(0, 400));
  const slides = await Promise.all(Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).map((name) => zip.file(name).async('string')));
  const accent = slides.map((xml) => /accent:([0-9A-F]{6})/i.exec(xml)?.[1]).find(Boolean)?.toUpperCase();
  const series = [...chart.matchAll(/<c:ser>[\s\S]*?<\/c:ser>/g)].map((match) => match[0]);
  assert.ok(series[1].includes('올해'), 'the latest series is written second');
  assert.equal(colors[1], accent, 'the latest series takes the accent');
  assert.notEqual(colors[0], accent);
});

test('accent names the series the title is about, and display() on a dark page sets the on-dark pair', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pptx-kit-meaning-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = `deck({ style: 'editorial', hue: 30, accentHue: 355, mode: 'text', script: 'latin', pairing: 'serif' });
chart(light(), 1, 1, 8, 4, { type: 'line', accent: 0, labels: ['W1', 'W2'], series: [{ name: 'Pilot', values: [71, 64] }, { name: 'Other', values: [70, 70] }] });
display(quiet(), 'When the night changed, the day moved', { kicker: 'BRIEF', emph: 'the day moved', line: 'A report for the board.' });
light().addText('accent:' + T.accentFill + ' ondark:' + T.onDark, { x: 1, y: 1, w: 6, h: 0.5, fontSize: 12 });
await pres.writeFile({fileName:OUTPUT});`;
  const path = join(root, 'meaning.pptx');
  const written = await runPptxAuthoringScript(script, path);
  assert.equal(written.ok, true, JSON.stringify(written));
  const zip = await JSZip.loadAsync(await readFile(path));
  const chart = await zip.file(/^ppt\/charts\/chart\d+\.xml$/)[0].async('string');
  const note = await zip.file('ppt/slides/slide3.xml').async('string');
  const accent = /accent:([0-9A-F]{6})/i.exec(note)[1].toUpperCase();
  const onDark = /ondark:([0-9A-F]{6})/i.exec(note)[1].toUpperCase();
  const colors = [...chart.matchAll(/<c:ser>[\s\S]*?<a:srgbClr val="([0-9A-F]{6})"/gi)].map((match) => match[1].toUpperCase());
  assert.equal(colors[0], accent, 'the pilot series, named by accent: 0, takes the accent');
  assert.notEqual(colors[1], accent);
  const cover = await zip.file('ppt/slides/slide2.xml').async('string');
  const headline = [...cover.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]).find((sp) => sp.includes('When the night changed'));
  assert.ok(headline.includes(`val="${onDark}"`), 'the headline on the quiet page is set in the on-dark colour');
});

test('a Japanese contrast phrase starts its own line, and the corner meta shares the kicker row', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pptx-kit-ja-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = `deck({ hue: 220, mode: 'balanced', script: 'ja', chrome: 'bare' });
const s = light();
display(s, '夜が変わると、昼の道路が空いた', { kicker: '都市物流レポート', emph: '昼の道路が空いた' });
dateline(s, '2026年9月');
await pres.writeFile({fileName:OUTPUT});`;
  const path = join(root, 'ja.pptx');
  const written = await runPptxAuthoringScript(script, path);
  assert.equal(written.ok, true, JSON.stringify(written));
  const slide = await (await JSZip.loadAsync(await readFile(path))).file('ppt/slides/slide1.xml').async('string');
  const shapes = [...slide.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]);
  const headline = shapes.find((sp) => sp.includes('夜が変わると'));
  assert.match(headline, /夜が変わると、<\/a:t><\/a:r><a:br\b[\s\S]*?昼の道路が空いた/, 'the break sits before the phrase');
  const top = (sp) => Number(/<a:off x="\d+" y="(\d+)"/.exec(sp)[1]);
  const mark = shapes.find((sp) => sp.includes('都市物流レポート'));
  const meta = shapes.find((sp) => sp.includes('2026年9月'));
  assert.equal(top(meta), top(mark), 'the meta hangs on the kicker row');
});

test('a plane head keeps eight ems a line, and a poster deck line wraps balanced', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pptx-kit-plane-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = `deck({ style: 'photo-editorial', hue: 200, mode: 'presentation', script: 'ko' });
head(light(), '일정', '요세미티에서 사흘, 걷는 속도로 본다');
poster(quiet(), '가을, 호수 위에서', { x: M, y: 2.3, w: 6.2, size: TYPE.cover, line: '캐나다 로키 · 요세미티 · 시카고 11박 12일' });
await pres.writeFile({fileName:OUTPUT});`;
  const path = join(root, 'plane.pptx');
  const written = await runPptxAuthoringScript(script, path);
  assert.equal(written.ok, true, JSON.stringify(written));
  const zip = await JSZip.loadAsync(await readFile(path));
  const shapes = async (n) => [...(await zip.file(`ppt/slides/slide${n}.xml`).async('string')).matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]);
  const headline = (await shapes(1)).find((sp) => sp.includes('요세미티'));
  const width = Number(/<a:ext cx="(\d+)"/.exec(headline)[1]) / 12700;
  const size = Number(/sz="(\d+)"/.exec(headline)[1]) / 100;
  assert.ok(width / size >= 8, `${width.toFixed(0)} pt for ${size} pt type is ${(width / size).toFixed(1)} ems`);
  const deckLine = (await shapes(2)).find((sp) => sp.includes('캐나다'));
  assert.ok(!/<a:t>12일<\/a:t>/.test(deckLine), 'no one-word last line');
});

test('kit labels a loss column, keeps a narrow unit label whole, and keeps the contrast phrase on one line', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pptx-kit-words-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = `deck({ hue: 215, mode: 'balanced', script: 'ko' });
chart(pres.addSlide(), 1, 1, 6, 4, { labels: ['1Q', '2Q', '3Q'], series: [{ name: '영업이익', values: [-182, -41, 86] }] });
const st = { x: 1, y: 1, w: 6, h: 4.6, cx: 4, cy: 3.3, r: 2.3, ground: T.paperAlt };
await hub(pres.addSlide(), st, { label: '송금' }, [{ label: '결제' }, { label: '신용관리' }, { label: '대출' }, { label: '투자' }, { label: '보험' }]);
display(pres.addSlide(), '월 거래자 1,420만 명, 첫 분기 흑자', { emph: '첫 분기 흑자' });
await pres.writeFile({fileName:OUTPUT});`;
  const path = join(root, 'words.pptx');
  const written = await runPptxAuthoringScript(script, path);
  assert.equal(written.ok, true, JSON.stringify(written));
  const zip = await JSZip.loadAsync(await readFile(path));
  const [chart, hubSlide, claim] = await Promise.all([
    zip.file(/^ppt\/charts\/chart\d+\.xml$/)[0].async('string'),
    zip.file('ppt/slides/slide2.xml').async('string'),
    zip.file('ppt/slides/slide3.xml').async('string'),
  ]);
  // A format of #,##0;; hid every negative label; the zero section alone stays empty.
  assert.match(chart, /formatCode="#,##0;-#,##0;"/);
  // The satellites share one size, the one at which 신용관리 fits its disc whole.
  const sizes = [...hubSlide.matchAll(/<a:t>(결제|신용관리|대출|투자|보험)<\/a:t>/g)].map((match) => {
    const before = hubSlide.slice(0, match.index);
    return /sz="(\d+)"[^>]*>(?:(?!<a:r>)[\s\S])*$/.exec(before)?.[1];
  });
  assert.ok(hubSlide.includes('<a:t>신용관리</a:t>'), 'the label is one run, never split across lines');
  assert.ok(sizes.length === 5 && sizes.every(Boolean), JSON.stringify(sizes));
  assert.equal(new Set(sizes).size, 1, JSON.stringify(sizes));
  // The emphasis run carries the whole phrase on one line.
  assert.match(claim, /<a:t>첫 분기 흑자<\/a:t>/);
});
