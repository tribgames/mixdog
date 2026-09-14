// The pptx skill's kit must author cleanly through the runtime: every helper
// compiles, the package validates, and the measured review raises nothing
// against a deck composed the way the skill teaches — from the primitives,
// with no whole-slide function. Advisory readings (monotony, plan read-back)
// are information, not failures, so the tests filter them out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { GlobalFonts } from '@napi-rs/canvas';
import { executeOfficeTool } from './index.mjs';
import { isAdvisoryOfficeIssue } from './quality/quality-pipeline.mjs';
import { libreOfficeAvailable } from './portable/portable-soffice.mjs';
import { saturatedHueFamilies } from './design/design-discipline.mjs';

import { kitBlocks, kitPrelude } from './authoring/pptx-kit.mjs';

const SKILL = fileURLToPath(new URL('../../defaults/skills/pptx/references/', import.meta.url));

const value = (result) => JSON.parse(result.content[0].text);
const measured = (qa) => (qa.issuesAfter || qa.issues || []).filter((issue) => !isAdvisoryOfficeIssue(issue)).map((issue) => `${issue.code} ${issue.path}: ${issue.message}`);
// The authored decks are rendered (render: true), which portable mode does through LibreOffice.
const RENDERED = { skip: !(await libreOfficeAvailable()) && 'LibreOffice is not installed' };
// The safe pairing is the Windows Office faces; the font review can only pass Malgun Gothic
// as safe on a host that has it (Linux runners report it unavailable, which is also correct).
const MALGUN = {
  skip: !(GlobalFonts.families || []).some((entry) => /^malgun gothic$/i.test(String(entry?.family || '')))
    && 'Malgun Gothic is not installed',
};

// A twelve-slide deck composed slide by slide from the kit primitives: a cover on a gradient field, a
// statement hanging from a rule, a chart as spine, a stat band by weight, a chevron run with measured
// details, two planes seamed by weight, brace groups, a cycle from arcs, a table with a verdict, a
// section, a gauge, a closing.
const DECK = `
// BRIEF
// subject/audience/action: 운영팀 · 도크 4 증설 예산 승인
// reading mode: balanced · argument mode: pyramid
// directions: A editorial · hue 205 · serif · 세로 룰 — 근거 표와 차트가 많은 문서형 · B swiss-minimal · hue 225 · concord · 오버사이즈 평면 — 숫자 중심 · C dark-tech · hue 215 · weight · 글로우 — 발표형 · selected: A · why: 표와 차트가 논거다
// style: editorial · palette: hue 205 · accent: 1F6F8B · type: MODE balanced → body 18 · script: ko · pairing: serif · fonts: noto
// facts: F1 1.6배 — 운영 로그 · F2 0.3% — 품질 시트 B4 · F3 4건 — 안전 보고 · F4 4,200건 — 분류기 로그 · F5 31건 — 안전 보고 · F6 12 18 24 31 — 재무 시트 B2:E2 · F7 22시 — 운행표 · F8 60% — 운영 로그
// slide plan: 1 job: cover · move: 결정할 것이 무엇인지 안다 · composition: 어두운 그라데이션 필드, 고스트 숫자 · carriers: statement
//   · 2 job: claim · relationship: none · move: 결론을 먼저 받는다 · composition: 세로 룰에 걸린 한 문장 · carriers: statement · rhythm: breathing
//   · 3 job: evidence · relationship: evidence · move: 추세를 믿는다 · composition: 차트가 척추, 오른쪽에 히어로 · carriers: chart, hero · rhythm: dense
//   · 4 job: evidence · relationship: contrast · move: 한 원인을 본다 · composition: 무게로 나눈 스탯 밴드 · carriers: hero · rhythm: dense
//   · 5 job: process · relationship: order · move: 병목 위치를 본다 · composition: 무게로 나눈 쉐브론과 측정된 설명 · carriers: diagram · rhythm: dense
//   · 6 job: comparison · relationship: contrast · move: 바뀐 쪽을 본다 · composition: 무게로 나눈 두 평면, 한쪽만 들어올림 · carriers: list · rhythm: dense
//   · 7 job: structure · relationship: parent · move: 세 갈래를 본다 · composition: 브레이스 그룹과 세로 룰 · carriers: diagram · rhythm: dense
//   · 8 job: process · relationship: order · move: 고리를 본다 · composition: 아크로 만든 순환과 옆 설명 · carriers: diagram · rhythm: dense
//   · 9 job: comparison · relationship: contrast · move: 채택안을 본다 · composition: 판정 열이 있는 표 · carriers: table · rhythm: dense
//   · 10 job: section · move: 요청으로 넘어간다 · composition: 어두운 필드의 진행형 목차, 현재 절만 밝게 · carriers: statement · rhythm: anchor
//   · 11 job: evidence · relationship: evidence · move: 비중을 본다 · composition: 게이지와 강조 문장 · carriers: gauge · rhythm: breathing
//   · 12 job: closing · move: 승인한다 · composition: 커버의 필드를 반향 · carriers: statement · rhythm: anchor
{ const s = quiet(); await gradientField(s, 0, 0, W, H, [[0, T.dark], [100, T.darkAlt]], 35); ghost(s, '04', 7.6, 1.0, 240, 5.2); kicker(s, '운영팀 · 3분기', M, 2.15, T.onDarkAccent); const b = title(s, '도크 4 증설,\\n예산 승인 요청', { y: 2.55, w: 8.2, size: TYPE.cover, color: 'FFFFFF' }); text(s, '야간 처리량이 주간을 넘어선 지금, 다음 도크는 야간 전용으로 설계한다', M, b + 0.25, 8.5, TYPE.lead, { color: T.onDark }); text(s, '2026년 9월 · 운영팀', M, H - 1.0, 8, TYPE.caption, { color: T.onDarkMuted, font: T.data }); }
{ const s = light(); rule(s, M, 1.6, 3.6, T.accent, 2); emphasis(s, [[['증설 석 달 만에 ', {}], ['처리량은 1.6배', { bold: true, color: T.accent }], [', 오류율은 0.3%가 됐다. 다음 병목은 도크가 아니라 야간 셔틀이다.', {}]]], M + 0.4, 1.6, 9.6, 2.6, 28, T.ink, { lh: 1.3 }); text(s, '— 운영 로그와 품질 시트, 2026년 6~8월', M + 0.4, 4.5, 8, TYPE.caption, { color: T.muted }); }
{ const s = light(); kicker(s, '처리량'); const top = title(s, '분기마다 처리량이 늘었고, 4분기가 가장 컸다') + GAP.between; const ty = H - M - 0.75; chart(s, M, top, 8.2, ty - top - GAP.between, { labels: ['1분기', '2분기', '3분기', '4분기'], series: [{ name: '처리량', values: [12, 18, 24, 31] }], accent: 3 }); const hb = hero(s, 9.4, top + 0.4, 3.3, '31', '4분기 처리량, 천 건'); const py = hb + GAP.within, room = ty - GAP.between - py; if (room >= 0.6) prose(s, '분류기 도입과 야간 셔틀 추가가 겹친 분기다.', 9.4, py, 3.3, room, TYPE.caption + 1, T.body); takeaway(s, '증설 효과는 4분기에 집중됐다.', ty); }
{ const s = light(); kicker(s, '규모'); const top = title(s, '네 숫자가 한 원인을 가리킨다') + GAP.between; const stats = [{ value: '1.6배', label: '처리량 증가', detail: '야간 셔틀 두 대 추가', trend: [10, 12, 14, 16] }, { value: '0.3%', label: '오류율', detail: '라벨 손상만 남았다', trend: [1.2, 0.9, 0.5, 0.3] }, { value: '4건', label: '근접 경보/주', detail: '일방향 동선의 효과', trend: [31, 18, 9, 4] }, { value: '4,200', label: '건/시간 분류', detail: '분류기 도입', trend: [2100, 2600, 3400, 4200] }]; const sb = statBand(s, M, top, W - 2 * M, stats); const cols = spans(M, W - 2 * M, stats.map((st) => weightOf(st))); const cy = sb + GAP.between, ch = Z.body.bottom - cy; stats.forEach((st, i) => chart(s, cols[i].x, cy, cols[i].w, ch, { labels: ['1분기', '2분기', '3분기', '4분기'], series: [{ name: st.label, values: st.trend }], size: DIAG.note, format: '#,##0.#' })); }
{ const s = light(); kicker(s, '흐름'); const top = title(s, '입고에서 출고까지, 병목은 셔틀에 있다') + GAP.between; const stages = [{ label: '입고', metric: '2 도크', detail: '두 도크가 새벽 입고를 나눠 받는다. 대기열은 도크 앞에서 끝난다.' }, { label: '분류', metric: '4,200건/시', detail: '분류기가 시간당 4,200건을 처리한다. 라벨 손상만 수작업으로 남는다.' }, { label: '적재', metric: '셔틀 2대', detail: '야간 셔틀 두 대가 22시와 01시에 출발한다. 셋째 셔틀이 없으면 여기서 멈춘다.', active: true }, { label: '출고', metric: '0.3%', detail: '출고 오류는 라벨 손상뿐이다. 야간 출고가 기본값이 됐다.' }]; const cols = spans(M, W - 2 * M - 1.4 * 0.25, stages.map((st) => weightOf({ label: st.label, detail: st.detail }, { active: st.active })), { gap: 0 }); chevrons(s, M, top, W - 2 * M, 1.4, stages.map((st) => st.label), { active: 2, widths: cols }); const cy = top + 1.4 + GAP.between, cb = Z.body.bottom; stages.forEach((st, i) => { field(s, cols[i].x, cy, cols[i].w - 0.12, cb - cy, T.paperAlt); const b = flow(s, cols[i].x + PAD, cy + PAD, cols[i].w - 0.12 - PAD * 2, [{ text: st.metric, role: 'strong', font: T.data, color: st.active ? T.accent : T.ink }], { bottom: cb }); prose(s, st.detail, cols[i].x + PAD, b, cols[i].w - 0.12 - PAD * 2, cb - PAD - b, Math.min(TYPE.body, 15)); }); }
{ const s = light(); kicker(s, '비교'); const top = title(s, '전과 후: 달라진 쪽이 더 넓다') + GAP.between; const seam = splitAt(M, W - 2 * M, 40, 70); const ph = H - M - 1.2 - top; field(s, seam.left.x, top, seam.left.w, ph); lift(s, seam.right.x, top, seam.right.w, ph, 'FFFFFF'); badge(s, seam.left.x + 0.3, top + 0.3, 1.2, 0.32, '전'); badge(s, seam.right.x + 0.3, top + 0.3, 1.2, 0.32, '후', { tone: 'accent' }); bullets(s, seam.left.x + 0.3, top + 0.85, seam.left.w - 0.6, ph - 1.1, ['교차 동선, 근접 경보 주 31건', '수작업 분류', '주간 중심 출고']); bullets(s, seam.right.x + 0.3, top + 0.85, seam.right.w - 0.6, ph - 1.1, ['일방향 동선, 근접 경보 주 4건', '분류기 시간당 4,200건', '야간 출고가 기본'], TYPE.body, T.ink, { font: T.sans }); takeaway(s, '차이 표시는 바뀐 쪽 하나에만 둔다.'); }
{ const s = light(); kicker(s, '구조'); const top = title(s, '증설이 만든 변화는 세 갈래다') + GAP.between; let y = top; [['처리량', ['야간 셔틀 두 대 추가', '피크 시간대가 22시로 이동', '분기 처리량 1.6배']], ['품질', ['분류기 도입', '라벨 손상만 남았다', '오류율 0.3%']], ['안전', ['일방향 동선', '근접 경보 주 4건', '교차 동선 사고 0건']]].forEach(([name, items]) => { const sz = Math.min(TYPE.body, 15), h = fitH(items.join('\\n'), 6, sz, T.light, { lh: 1.5 }); text(s, name, M, y, 1.7, Math.min(TYPE.lead, 18), { color: T.accent, bold: true, align: 'right' }); brace(s, M + 1.85, y, h); s.addText(items.map((t, i) => ({ text: t, options: { breakLine: i < items.length - 1 } })), { ...box(M + 2.3, y, 6, h), fontFace: T.light, fontSize: sz, color: T.body, valign: 'top', margin: 0, lineSpacingMultiple: 1.5 }); y += h + GAP.between; }); const rx = 9.4; rule(s, rx - 0.3, top, y - top - GAP.between, T.line); prose(s, '세 갈래 모두 야간 운영에서 나왔다. 도크 4를 야간 전용으로 설계하면 세 효과가 그대로 이어진다.', rx, top, W - M - rx, y - top - GAP.between, TYPE.body, T.body); }
{ const s = light(); kicker(s, '순환'); const top = title(s, '점검 주기는 닫힌 고리로 돈다') + GAP.between; const cx = 4.2, cy = top + (H - M - top) / 2, r = 1.4, labels = ['계획', '실행', '점검', '조정']; labels.forEach((l, i) => { const span = 360 / labels.length, on = i === 2; arc(s, cx, cy, r, 270 + i * span + 3, 270 + (i + 1) * span - 3, { color: on ? T.accent : T.paperAlt }); const mid = (270 + (i + 0.5) * span) * Math.PI / 180; text(s, l, cx + (r + 0.7) * Math.cos(mid) - 1.0, cy + (r + 0.7) * Math.sin(mid) - 0.25, 2.0, DIAG.label, { color: on ? T.accent : T.ink, bold: on, align: 'center', h: 0.5, valign: 'middle' }); }); const inner = r * 0.72 * 2 - 0.12; s.addShape(S.ellipse, { ...box(cx - inner / 2, cy - inner / 2, inner, inner), fill: { color: T.paper }, line: { color: T.paper } }); text(s, '점검', cx - 0.8, cy - 0.3, 1.6, TYPE.lead, { color: T.ink, bold: true, align: 'center', h: 0.6, valign: 'middle' }); prose(s, '점검 단계가 고리를 닫는다. 주간 점검에서 나온 근접 경보가 다음 계획의 입력이 된다.', 8.4, top + 0.6, W - M - 8.4, 2.6, TYPE.body); }
{ const s = light(); kicker(s, '선택지'); const top = title(s, '세 안 중 야간 전용이 유일하게 조건을 모두 만족한다') + GAP.between; const b = table(s, M, top, W - 2 * M, ['안', '비용', '야간 대응', '판정'], [['주간 전용', '낮음', '불가', '보류'], ['혼합', '중간', '부분', '보류'], ['야간 전용', '중간', '가능', '채택']], { colW: [3.2, 2.6, 3.3, 3.03], verdict: 3, tones: ['warning', 'warning', 'positive'] }); caption(s, '출처: 운영팀 비용 추정, 2026년 9월', M, b + GAP.between, 8); }
{ const s = quiet(); kicker(s, '02 · 요청', M + 0.4, 1.0, T.onDarkAccent); agenda(s, ['증설 결과', '요청 사항', '부록'], 1); }
{ const s = light(); kicker(s, '비율'); const top = title(s, '야간이 전체 처리량의 열 중 여섯을 차지한다') + GAP.between; const avail = H - M - top, r = Math.min(1.6, avail / 2 - 0.3); gauge(s, 3.4, top + avail / 2, r, 0.6, '60%', '야간 비중'); emphasis(s, [[['야간 처리량이 ', {}], ['60%', { bold: true, color: T.accent }], ['를 넘었다. 도크 4를 야간 전용으로 설계할 근거다.', {}]]], 6.6, top + 0.6, 6, avail - 0.8, TYPE.lead); }
{ const s = quiet(); await gradientField(s, 0, 0, W, H, [[0, T.darkAlt], [100, T.dark]], 215); ghost(s, '04', 9.4, 2.4, 180, 3.4); kicker(s, '요청', M, 2.15, T.onDarkAccent); const b = title(s, '도크 4 증설 예산을 승인해 주십시오', { y: 2.55, w: 9, size: TYPE.title, color: 'FFFFFF' }); text(s, '야간 전용 설계안은 10월 운영 회의에 올린다.', M, Math.max(b + 0.4, 4.6), 8, TYPE.lead, { color: T.onDarkAccent, bold: true, font: T.sans }); text(s, '운영팀 · 2026년 9월', M, H - 1.0, 8, TYPE.caption, { color: T.onDarkMuted, font: T.data }); }
await pres.writeFile({ fileName: OUTPUT });
`;

test('kit layout by weight: equal weights divide equally, unequal weights do not, and the seam never sits in the middle by default', async () => {
  const kit = await kitBlocks('kit.md');
  const source = ['weightOf', 'spans', 'splitAt'].map((name) => {
    const match = new RegExp(`(?:const ${name} = [\\s\\S]*?;\\n|function ${name}\\([\\s\\S]*?\\n\\}\\n)`).exec(kit);
    assert.ok(match, `${name} is in the kit`);
    return match[0];
  }).join('\n');
  const ladder = /const SPACE = \{[^}]*\};/.exec(kit);
  assert.ok(ladder, 'the spacing ladder is a named set (SPACE)');
  const gutter = /const GUTTER = [^;\n]+;/.exec(kit);
  assert.ok(gutter, 'the column gap is a relation named on the ladder (GUTTER)');
  const { spans, splitAt, weightOf, GUTTER } = new Function(`${ladder[0]}\n${gutter[0]}\n${source}\nreturn { spans, splitAt, weightOf, GUTTER };`)();
  assert.ok(GUTTER > 0, 'GUTTER resolves to a rung of the ladder');
  const equal = spans(0.5, 12, [10, 10, 10]);
  assert.ok(equal.every((c) => Math.abs(c.w - equal[0].w) < 1e-9), 'equal weights → equal widths');
  assert.ok(Math.abs(equal[2].x + equal[2].w - 12.5) < 1e-9, 'the row ends at x + w');
  const unequal = spans(0.5, 12, [10, 30, 10]);
  assert.ok(unequal[1].w > unequal[0].w * 1.3, 'the heavy peer is visibly wider');
  assert.ok(unequal[0].w > 0.6 * (12 / 3), 'the light peer stays readable (clamped)');
  const seam = splitAt(0.5, 12, 40, 80);
  const free = 12 - GUTTER;
  assert.ok(seam.left.w < seam.right.w && seam.left.w / free >= 0.38 - 1e-9, 'the seam follows weight within the 0.38–0.62 band');
  assert.equal(splitAt(0, 10, 1, 1).left.w, splitAt(0, 10, 1, 1).right.w, 'equal weights → the middle');
  assert.ok(weightOf({ label: 'a', detail: 'long detail text' }, { active: true }) > weightOf({ label: 'a', detail: 'long detail text' }), 'active counts more');
});

// A page that closes with a takeaway and cites its source carries both kit
// defaults at once, and they overlapped: the band sat on the source line, which
// the runtime's own audit then reported as a collision on a script that had
// written no coordinates at all.
test('kit foot defaults stack: the takeaway band clears the source line', async () => {
  const MEASURE = (text, { size = 18, lineHeight = 1 } = {}) => ({
    lines: 1,
    height: (size / 72) * 1.2 * lineHeight,
    width: String(text).length * (size / 72) * 0.6,
  });
  const kit = new Function('require', 'MEASURE', 'ICON', `${kitPrelude().source}\nreturn { zones, deck };`)(
    createRequire(import.meta.url),
    MEASURE,
    { names: [], svg: () => '' },
  );
  kit.deck({ hue: 210, mode: 'present', script: 'ko' });
  const foot = kit.zones('present').foot;
  const bandBottom = foot.takeaway + 0.7;
  assert.ok(bandBottom <= foot.source, `the band ends above the source line (${bandBottom} vs ${foot.source})`);
  // A hair of daylight reads as a collision to the spacing check, which wants
  // at least 6 pt (0.0833 in) between blocks.
  assert.ok(foot.source - bandBottom >= 6 / 72, `at least 6 pt of daylight (${(foot.source - bandBottom) * 72} pt)`);
});

// A structure over a reading row used to take a guessed stage height (2.2 in, 2.5 in)
// that the render then reported as a hollow field or an overflow. shareDown measures
// the row first and gives the stage the rest, and refuses a stage under the quarter
// of the canvas at which a structure stops reading as the carrier.
test('kit shareDown sizes the stage from the measured row under it, never from a guess', async () => {
  const MEASURE = (text, { size = 18, lineHeight = 1 } = {}) => ({
    lines: 1,
    height: (size / 72) * 1.2 * lineHeight,
    width: String(text).length * (size / 72) * 0.6,
  });
  const kit = new Function('require', 'MEASURE', 'ICON', `${kitPrelude().source}\nreturn { shareDown, columnsH, timeline, deck, zones, GAP, M, W, Z: () => Z };`)(
    createRequire(import.meta.url),
    MEASURE,
    { names: [], svg: () => '' },
  );
  kit.deck({ hue: 210, mode: 'present', script: 'ko' });
  const Z = kit.Z();
  const cols = [{ title: '서울', text: '9월부터 자동 배차.' }, { title: '대전', text: '11월 가동이 첫 검증.' }, { title: '부산', text: '1월 시운전, 3월 통합.' }];
  const rowH = kit.columnsH(kit.M, kit.W - 2 * kit.M, cols, { size: 14 });
  assert.ok(rowH > 0.5 && rowH < 1.5, `a titled three-column row measures a plausible height (${rowH.toFixed(2)} in)`);
  const top = 2.0;
  const sh = kit.shareDown(top, rowH);
  assert.equal(sh.stage.y, top, 'the stage starts at the body top');
  assert.ok(Math.abs(sh.stage.y + sh.stage.h + kit.GAP.between - sh.under.y) < 1e-9, 'the row sits a between step under the stage');
  assert.ok(Math.abs(sh.under.y + sh.under.h - Z.body.bottom) < 1e-9, 'the row ends on the body bottom: nothing is left over');
  assert.equal(sh.slack, 0, 'no cap, no slack');
  const capped = kit.shareDown(top, rowH, { maxStage: 2.4 });
  assert.equal(capped.stage.h, 2.4, 'a cap holds the stage at its natural height');
  assert.ok(capped.slack > 0, 'the cap reports what it left');
  assert.throws(() => kit.shareDown(top, Z.body.bottom - top - 1.0), /floor 2\.2/, 'a row that leaves the stage under the floor is refused with the floor named');
  // A timeline given the stage's height centres its spine in it instead of pinning it to the top.
  const spineAt = (opts) => {
    let y = null;
    const slide = { addShape: (type, o) => { if (o.h === 0 && y === null) y = o.y; }, addText: () => {} };
    kit.timeline(slide, 1, 2, 10, ['계획', '실행', '점검'], { alternate: false, ...opts });
    return y;
  };
  const pinned = spineAt({}), centred = spineAt({ h: 4 });
  assert.ok(centred > pinned + 0.5, `the spine moves down into a 4 in stage (${pinned.toFixed(2)} → ${centred.toFixed(2)})`);
});

// A loop or a hub beside a rail took three hand-typed radii (r, d, hubD) tuned by
// eye until the ring filled its stage; the stage form takes them from the stage.
test('kit loop and hub in stage form fill the stage they are given', async () => {
  const MEASURE = (text, { size = 18, lineHeight = 1 } = {}) => ({
    lines: 1,
    height: (size / 72) * 1.2 * lineHeight,
    width: String(text).length * (size / 72) * 0.6,
  });
  const kit = new Function('require', 'MEASURE', 'ICON', `${kitPrelude().source}\nreturn { stage, loop, hub, deck };`)(
    createRequire(import.meta.url),
    MEASURE,
    { names: [], svg: () => '' },
  );
  kit.deck({ hue: 210, mode: 'present', script: 'ko' });
  const shapes = [];
  const slide = { addShape: (_type, o) => shapes.push(o), addText: () => {}, addImage: () => {} };
  const st = kit.stage(slide, 0.5, 2.0, 6.3, 4.2);
  shapes.length = 0;
  const bottom = kit.loop(slide, st, ['계획', '실행', { label: '점검', active: true }, '조정'], { center: '점검' });
  assert.ok(Math.abs(bottom - (st.cy + st.r)) < 1e-9, `the loop's lower label ends on the stage's inner radius (${bottom.toFixed(2)} vs ${(st.cy + st.r).toFixed(2)})`);
  shapes.length = 0;
  await kit.hub(slide, st, { label: '센터' }, ['배차', '적재', { label: '출고', active: true }, '안전', '정비']);
  const discs = shapes.filter((o) => o.w === o.h && o.w > 0.5);
  assert.ok(discs.length === 6, `five satellites and the hub are discs (${discs.length})`);
  const reach = Math.max(...discs.map((o) => Math.hypot(o.x + o.w / 2 - st.cx, o.y + o.h / 2 - st.cy) + o.w / 2));
  assert.ok(Math.abs(reach - st.r) < 0.02, `the farthest satellite's edge sits on the stage's inner radius (${reach.toFixed(2)} vs ${st.r.toFixed(2)})`);
  const hubDisc = discs.reduce((a, b) => (b.w > a.w ? b : a));
  assert.ok(hubDisc.w > discs.filter((o) => o !== hubDisc)[0].w, 'the hub is a band larger than a satellite');
});

// A structure under a quarter of the canvas reads as a mark on paper, not the carrier;
// the helpers refuse the box before the draw instead of the render reporting underfill.
test('kit stage, quadrants, and lanes refuse a box under their floors and name the fix', async () => {
  const MEASURE = (text, { size = 18, lineHeight = 1 } = {}) => ({
    lines: 1,
    height: (size / 72) * 1.2 * lineHeight,
    width: String(text).length * (size / 72) * 0.6,
  });
  const kit = new Function('require', 'MEASURE', 'ICON', `${kitPrelude().source}\nreturn { stage, quadrants, lanes, steps, loop, hub, dumbbell, deck, W, H };`)(
    createRequire(import.meta.url),
    MEASURE,
    { names: [], svg: () => '' },
  );
  kit.deck({ hue: 210, mode: 'present', script: 'ko' });
  const slide = { addShape: () => {}, addText: () => {}, addImage: () => {} };
  assert.throws(() => kit.stage(slide, 0.5, 2, 6, 2), /quarter/, 'a 6 × 2 in stage (0.12 of the canvas) is refused');
  assert.ok(kit.stage(slide, 0.5, 2, 8, 4).share >= 0.22, 'an 8 × 4 in stage stands');
  await assert.rejects(() => kit.quadrants(slide, 0.5, 2, 5, 2.5, { items: [] }), /quarter/, 'a 5 × 2.5 in 2×2 is refused');
  await assert.rejects(() => kit.lanes(slide, 0.5, 2, 12, 2.0, [{ name: 'a', items: [] }, { name: 'b', items: [] }, { name: 'c', items: [] }]), /0\.8 in is the floor/, 'three lanes in 2 in are refused');
  assert.equal(await kit.lanes(slide, 0.5, 2, 12, 2.7, [{ name: 'a', items: [] }, { name: 'b', items: [] }, { name: 'c', items: [] }]), 4.7, 'three lanes in 2.7 in draw and return the bottom edge');
  await assert.rejects(() => kit.steps(slide, 0.5, 2, 12, 0.6, ['a', 'b', 'c']), /0\.7 in floor/, 'a 0.6 in step run is refused');
  const short = kit.stage(slide, 0.5, 2, 12, 2.4);   // wide and short: 0.29 of the canvas, but r = 1.02
  assert.throws(() => kit.loop(slide, short, ['a', 'b', 'c']), /0\.6 in floor/, 'a loop on a short stage is refused for its radius');
  await assert.rejects(() => kit.hub(slide, short, 'c', ['a', 'b', 'c']), /1\.6 in floor/, 'a hub on a short stage is refused for its radius');
  assert.throws(() => kit.dumbbell(slide, 0.5, 2, 8, [{ label: 'a', a: 1, b: 2 }, { label: 'b', a: 2, b: 3 }], { rowH: 0.4 }), /0\.5 in floor/, 'a 0.4 in dumbbell row is refused');
});

// A product render comes from the model on a solid background; cutout() clears
// only what touches the frame, so a white highlight inside the product stays.
test('kit cutout clears the background from the border and keeps an enclosed highlight', async () => {
  const MEASURE = (text, { size = 18, lineHeight = 1 } = {}) => ({
    lines: 1,
    height: (size / 72) * 1.2 * lineHeight,
    width: String(text).length * (size / 72) * 0.6,
  });
  const kit = new Function('require', 'MEASURE', 'ICON', `${kitPrelude().source}\nreturn { cutout, render, deck };`)(
    createRequire(import.meta.url),
    MEASURE,
    { names: [], svg: () => '' },
  );
  kit.deck({ hue: 210, mode: 'present', script: 'ko' });
  // 60×60 white frame, a dark 30×30 product in the middle with a 6×6 white highlight inside it.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" fill="#fff"/><rect x="15" y="15" width="30" height="30" fill="#222"/><rect x="27" y="27" width="6" height="6" fill="#fff"/></svg>';
  const source = await sharp(Buffer.from(svg)).png().toBuffer();
  const out = await kit.cutout(source, { bg: 'white' });
  const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  const alpha = (x, y) => data[(y * info.width + x) * 4 + 3];
  assert.equal(alpha(2, 2), 0, 'the frame background is clear');
  assert.equal(alpha(20, 20), 255, 'the product is opaque');
  assert.equal(alpha(30, 30), 255, 'the enclosed white highlight is kept');
  const images = [];
  const slide = { addImage: (o) => images.push(o), addShape: () => {}, addText: () => {} };
  await kit.render(slide, out, 8, 2, 4, 3, { alt: 'a product' });
  assert.equal(images.length, 2, 'the glow and the product');
  assert.ok(images[0].objectName === 'mixdog-device:glow' && images[1].objectName === 'mixdog-device:render', 'both are named as devices');
});

// A gauge is a value drawn as geometry: the reader measures the swept angle, not
// the label. The angles wrap at 360, so a full turn used to land on its own start
// (0% drew a closed ring, 100% depended on the renderer) and a share past 1 kept
// only the remainder (112% drew 12%).
test('kit gauge sweeps the share it is given, and a full or empty gauge is not a wrapped angle', async () => {
  const MEASURE = (text, { size = 18, lineHeight = 1 } = {}) => ({
    lines: 1,
    height: (size / 72) * 1.2 * lineHeight,
    width: String(text).length * (size / 72) * 0.6,
  });
  const kit = new Function('require', 'MEASURE', 'ICON', `${kitPrelude().source}\nreturn { gauge, deck };`)(
    createRequire(import.meta.url),
    MEASURE,
    { names: [], svg: () => '' },
  );
  kit.deck({ hue: 210, mode: 'present', script: 'ko' });
  // The track is drawn first and the value arc second; a sweep is the turn from
  // the first angle to the second, clockwise.
  const sweptBy = (share) => {
    const arcs = [];
    const slide = { addShape: (_type, options) => { if (options.angleRange) arcs.push(options.angleRange); }, addText: () => {} };
    kit.gauge(slide, 3, 3, 1.2, share, `${Math.round(share * 100)}%`, 'share');
    assert.ok(arcs.length >= 1, 'the track is always drawn');
    const value = arcs[1];
    if (!value) return 0;
    return ((value[1] - value[0]) % 360 + 360) % 360;
  };
  assert.ok(Math.abs(sweptBy(0.25) - 90) < 1, `a quarter sweeps a quarter turn (${sweptBy(0.25)}°)`);
  assert.ok(Math.abs(sweptBy(0.6) - 216) < 1, `0.6 sweeps 216° (${sweptBy(0.6)}°)`);
  assert.equal(sweptBy(0), 0, 'an empty gauge draws no value arc at all');
  assert.ok(sweptBy(1) >= 359, `a full gauge closes the ring (${sweptBy(1)}°)`);
  assert.ok(sweptBy(1.12) >= 359, `past full stays full instead of keeping the remainder (${sweptBy(1.12)}°)`);
  assert.ok(sweptBy(Number.NaN) === 0, 'a non-number reads as empty, never as a full ring');
});

// The writer stores the image's file name when nobody described the picture, so
// every kit icon shipped as "preencoded.png" — a description that satisfied the
// accessibility rule and told a reader who cannot see it nothing.
test('kit icons describe what they mark, not the file the writer wrote', async () => {
  const MEASURE = (text, { size = 18, lineHeight = 1 } = {}) => ({
    lines: 1,
    height: (size / 72) * 1.2 * lineHeight,
    width: String(text).length * (size / 72) * 0.6,
  });
  const kit = new Function('require', 'MEASURE', 'ICON', `${kitPrelude().source}\nreturn { icon, iconRow, deck };`)(
    createRequire(import.meta.url),
    MEASURE,
    { names: ['truck'], svg: () => '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>' },
  );
  kit.deck({ hue: 210, mode: 'present', script: 'ko' });
  const images = [];
  const slide = { addImage: (options) => images.push(options), addShape: () => {}, addText: () => {} };
  await kit.icon(slide, 1, 1, 'marker', 'truck');
  await kit.iconRow(slide, 1, 2, 10, [{ icon: 'truck', label: '출고 지연', detail: '야간 출고가 밀립니다.' }]);
  assert.deepEqual(images.map((image) => image.altText), ['truck icon', '출고 지연']);
});

// A dumbbell plots values on a declared scale. A value outside it used to be
// drawn outside the track — off the canvas, its label lost — and the author only
// heard about a shape past the slide edge, never about the value that put it there.
test('kit dumbbell refuses a value outside the declared range instead of drawing it off the track', async () => {
  const MEASURE = (text, { size = 18, lineHeight = 1 } = {}) => ({
    lines: 1,
    height: (size / 72) * 1.2 * lineHeight,
    width: String(text).length * (size / 72) * 0.6,
  });
  const kit = new Function('require', 'MEASURE', 'ICON', `${kitPrelude().source}\nreturn { dumbbell, deck };`)(
    createRequire(import.meta.url),
    MEASURE,
    { names: [], svg: () => '' },
  );
  kit.deck({ hue: 210, mode: 'present', script: 'ko' });
  const slide = { addShape: () => {}, addText: () => {} };
  const rows = [{ label: '허브 A', a: 20, b: 60 }, { label: '허브 C', a: 10, b: 180 }];
  assert.throws(
    () => kit.dumbbell(slide, 0.5, 1, 12, rows, { min: 0, max: 100 }),
    (error) => /허브 C/.test(error.message) && /0–100/.test(error.message) && !/허브 A/.test(error.message),
    'the message names the row that left the scale and the scale it left',
  );
  assert.doesNotThrow(() => kit.dumbbell(slide, 0.5, 1, 12, rows), 'a range read from the data always contains it');
  assert.doesNotThrow(() => kit.dumbbell(slide, 0.5, 1, 12, rows, { min: 0, max: 180 }), 'a range that contains the values is drawn');
});

// A grouped table's merged label cells made the generator fall back to a one-inch
// frame under rows that reached two inches; the audit then read a hollow band
// where the lower rows stood. The frame is declared from the rows it holds.
test('kit grouped table declares a frame as tall as its flattened rows', async () => {
  const MEASURE = (text, { size = 18, lineHeight = 1 } = {}) => ({
    lines: 1,
    height: (size / 72) * 1.2 * lineHeight,
    width: String(text).length * (size / 72) * 0.6,
  });
  const kit = new Function('require', 'MEASURE', 'ICON', `${kitPrelude().source}\nreturn { table, deck };`)(
    createRequire(import.meta.url),
    MEASURE,
    { names: [], svg: () => '' },
  );
  kit.deck({ hue: 25, mode: 'text', script: 'ko' });
  const tables = [];
  const slide = { addTable: (rows, options) => tables.push({ rows, options }), addShape: () => {}, addText: () => {} };
  const groups = [
    { name: '셔틀', sub: '지연', rows: [['10분 이내', '대기'], ['10분 초과', '재배차']] },
    { name: '라벨', sub: '손상', rows: [['1건', '재라벨'], ['연속 3건', '분류 정지']] },
  ];
  const bottom = kit.table(slide, 0.6, 2, 12, ['상황군', '상황', '첫 조치'], [], { groups, dense: true });
  assert.equal(tables.length, 1);
  const { rows, options } = tables[0];
  assert.equal(rows.length, 5, 'a header row plus the four grouped body rows');
  assert.ok(Math.abs(options.h - options.rowH * rows.length) < 1e-9, `the frame height is the rows' (${options.h} vs ${options.rowH * rows.length})`);
  assert.ok(Math.abs(bottom - (2 + options.h)) < 1e-9, 'the returned bottom edge is the frame bottom');
  const plain = [];
  kit.table({ addTable: (r, o) => plain.push(o), addShape: () => {}, addText: () => {} }, 0.6, 2, 12, ['안', '판정'], [['a', '채택'], ['b', '보류']], {});
  assert.ok(Math.abs(plain[0].h - plain[0].rowH * 3) < 1e-9, 'a plain table declares its frame the same way');
});

// The editorial text page measured from 26 rendered mock pages: a headline at cover size on two lines over 60% of
// the width, the deck line at body size (a lead-size deck under a cover-size title pushed the strip off the page
// in presentation mode), the running meta closing the top-right corner, and a table whose row count comes from the
// height it has instead of the three rows the author happened to write.
test('kit display, dateline, and tableRows follow the measured text page', async () => {
  const MEASURE = (text, { size = 18, lineHeight = 1 } = {}) => ({
    lines: 1,
    height: (size / 72) * 1.2 * lineHeight,
    width: String(text).length * (size / 72) * 0.6,
  });
  const kit = new Function('require', 'MEASURE', 'ICON', `${kitPrelude().source}\nreturn { display, dateline, head, orb, table, tableRows, tablePitch, avail, deck, TYPE: () => TYPE, W, M };`)(
    createRequire(import.meta.url),
    MEASURE,
    { names: [], svg: () => '' },
  );
  kit.deck({ hue: 215, theme: 'dark', mode: 'presentation', script: 'ko' });
  const TYPE = kit.TYPE();
  const texts = [], images = [];
  const slide = { addShape: () => {}, addImage: (options) => images.push(options), addText: (text, options) => texts.push({ text, options }) };
  // orb: the beat's hero object is one raster — the halo and the lit sphere in one PNG, no vector source, so PowerPoint
  // (whose SVG renderer flattened the radial gradient) and LibreOffice show the same sphere — whose returned box is the
  // sphere's, the halo reaching 0.4 d beyond it.
  const placed = await kit.orb(slide, 10, 3.75, 4.2);
  assert.deepEqual(placed, { x: 7.9, y: 1.65, w: 4.2, h: 4.2 });
  assert.equal(images.length, 1, 'one image carries the halo and the sphere');
  assert.ok(String(images[0].data).startsWith('image/png;base64,'), 'placed as the PNG');
  assert.equal(images[0].objectName, 'mixdog-device:orb', 'named as a device, no SVG source attached: the receipt keeps the beat a beat');
  assert.equal(images[0].altText, 'sphere');
  assert.ok(Math.abs(images[0].w - 4.2 * 1.8) < 1e-9 && Math.abs(images[0].x - (10 - 4.2 * 0.9)) < 1e-9, 'the image spans the halo, centred on the sphere');
  const bottom = kit.display(slide, '1단계 석 달 만에 대기 시간이 38% 줄었다', { kicker: '결론', emph: '38% 줄었다', line: '자동 배차가 대기 시간을 12분에서 5.4분으로 줄였다.' });
  const of = (needle) => texts.find((entry) => (Array.isArray(entry.text) ? entry.text.map((run) => run.text).join('') : String(entry.text)).includes(needle));
  const headline = of('석 달'), deck = of('12분에서');
  assert.ok(headline && deck, 'the headline and the deck line are both drawn');
  assert.equal(headline.options.fontSize, TYPE.cover, 'the headline is set at the cover size on paper');
  // The contrast phrase is one run in the accent; the rest of the headline keeps the box colour, and the wrap survives.
  const accentRuns = headline.text.filter((run) => run.options?.color && run.options.color !== headline.options.color);
  assert.equal(accentRuns.map((run) => run.text).join(' ').replace(/\s+/g, ' '), '38% 줄었다', 'the phrase is the accent run');
  assert.ok(headline.text.some((run) => run.options?.softBreakBefore), 'the two-line wrap is kept as a soft break');
  // A phrase the eojeol wrap split across the break stays one emphasis: two accent runs, the second opening the line.
  texts.length = 0;
  kit.display(slide, '1단계 석 달 만에 대기 시간이 38% 줄었다', { emph: '대기 시간이' });
  const split = of('석 달'), splitRuns = split.text.filter((run) => run.options?.color && run.options.color !== split.options.color);
  assert.deepEqual(splitRuns.map((run) => run.text.trim()), ['대기', '시간이'], 'the phrase is carried across the break');
  assert.equal(splitRuns[1].options.softBreakBefore, true, 'its second half opens the next line');
  // head() and title() take the same phrase; the run's colour is the kicker's on that chrome.
  kit.head(slide, '결론', '재구매율은 첫 주 경험이 정한다', { emph: '첫 주 경험' });
  const content = of('재구매율은');
  assert.deepEqual(content.text.filter((run) => run.options?.color).map((run) => run.text), ['첫 주 경험'], 'the content title carries the phrase as its one accent run');
  assert.ok(headline.options.w <= (kit.W - 2 * kit.M) * 0.6 + 1e-9, `the measure is 60% of the canvas (${headline.options.w} in)`);
  assert.equal(deck.options.fontSize, TYPE.body, 'the deck line reads at body size, not lead');
  assert.ok(bottom > headline.options.y + headline.options.h, 'the returned bottom is under the deck line');
  kit.dateline(slide, '2026년 9월 · 운영 보고');
  const meta = of('운영 보고');
  assert.ok(meta, 'the dateline is drawn');
  assert.equal(meta.options.align, 'right');
  assert.ok(Math.abs(meta.options.x + meta.options.w - (kit.W - kit.M)) < 1e-9, 'the dateline ends on the right margin');
  assert.equal(meta.options.fontSize, TYPE.kicker, 'the dateline reads at kicker size');
  // tableRows: the rows that fit are the rows table() then draws inside that height, and one more would not.
  for (const dense of [false, true]) {
    const h = 3.7, n = kit.tableRows(h, { dense });
    assert.ok(n >= 3, `a 3.7 in column holds at least three body rows (${n}, dense ${dense})`);
    const drawn = [];
    const rows = Array.from({ length: n }, (_, i) => [`row ${i}`, '1']);
    kit.table({ addTable: (r, o) => drawn.push(o), addShape: () => {}, addText: () => {} }, 0.6, 2, 12, ['안', '값'], rows, { dense });
    assert.ok(drawn[0].h <= h + 1e-9, `${n} rows fit the height at the ${dense ? 'dense' : 'default'} pitch (${drawn[0].h} in)`);
    assert.ok(drawn[0].h + drawn[0].rowH > h, 'one more row would cross it');
    assert.equal(drawn[0].rowH, kit.tablePitch(dense).rowH, 'table() and tableRows() share one pitch');
  }
  // R105 foot guard: two rows more than avail(top) holds (one may land inside the 0.07 in tolerance) is refused before
  // the table is drawn, the fitting count named.
  const top = 2, fits = kit.tableRows(kit.avail(top)), drawnLate = [];
  const tooMany = Array.from({ length: fits + 2 }, (_, i) => [`row ${i}`, '1']);
  assert.throws(() => kit.table({ addTable: (r, o) => drawnLate.push(o), addShape: () => {}, addText: () => {} }, 0.6, top, 12, ['안', '값'], tooMany),
    new RegExp(`table: .*past the foot .*${fits} rows fit from this top`), 'a table past the foot is refused with the fitting row count');
  assert.equal(drawnLate.length, 0, 'nothing was drawn before the refusal');
});

// The KPI / bento row (kit §4 cards()): equal fields with one gap, every cell filled (a short last row widens), one
// accent card at most, the value at the band scale.
test('kit cards fill the grid, widen a short last row, and carry one accent', async () => {
  const MEASURE = (text, { size = 18, lineHeight = 1 } = {}) => ({ lines: 1, height: (size / 72) * 1.2 * lineHeight, width: String(text).length * (size / 72) * 0.6 });
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect width="24" height="24" fill="#000"/></svg>';
  const kit = new Function('require', 'MEASURE', 'ICON', `${kitPrelude().source}\nreturn { cards, deck, TYPE: () => TYPE, T: () => T, W, M };`)(
    createRequire(import.meta.url),
    MEASURE,
    { names: ['truck'], svg: () => SVG },
  );
  kit.deck({ hue: 215, theme: 'light', mode: 'presentation', script: 'ko', pairing: 'weight', fonts: 'safe' });
  const TYPE = kit.TYPE(), T = kit.T();
  const shapes = [], texts = [], images = [];
  const slide = { addShape: (kind, o) => shapes.push(o), addText: (t, o) => texts.push({ text: t, options: o }), addImage: (o) => images.push(o) };
  const w = kit.W - 2 * kit.M, h = 2.0;
  const items = [
    { value: '47', unit: '%', label: '재구매율', detail: '첫 주 경험이 정한다', badge: '핵심', accent: true },
    { value: '12', unit: '분', label: '평균 대기', icon: 'truck' },
    { value: '3.2', label: '주문/주' },
    { value: '86', unit: '%', label: '정시 배송' },
    { value: '1,204', label: '리뷰' },
  ];
  // R105 foot guard: two 2.2 in rows from y 2 would end 0.25 in under the body foot — refused before drawing, fix named.
  await assert.rejects(kit.cards(slide, kit.M, 2, w, items, { columns: 4, h: 2.2 }), /cards: .*past the foot .*h 2\.0\d fits 2 rows/, 'a grid past the foot is refused with the fitting h');
  assert.equal(shapes.length, 0, 'nothing was drawn before the refusal');
  const bottom = await kit.cards(slide, kit.M, 2, w, items, { columns: 4, h });
  const fields = shapes.filter((o) => o.objectName && String(o.objectName).startsWith('mixdog-spec:cards'));
  assert.equal(fields.length, 5, 'one field per card');
  assert.ok(Math.abs(bottom - (2 + 2 * h + 0.12)) < 1e-9, 'the bottom is two rows and one gap down');
  assert.equal(fields.filter((o) => o.objectName.endsWith(':accent')).length, 1, 'one accent card');
  assert.equal(fields[0].fill.color, T.accentLabel.fill, 'the accent card takes the mark form of the accent');
  const last = fields[4];
  assert.ok(Math.abs(last.w - w) < 1e-9 && Math.abs(last.y - (2 + h + 0.12)) < 1e-9, 'a short last row widens its card to the row edge (no empty cell)');
  const value = texts.find((t) => Array.isArray(t.text) && t.text[0]?.text === '47');
  assert.equal(value.text[0].options.fontSize, TYPE.stat, 'the value reads at the band scale');
  assert.equal(value.options.color, T.accentLabel.color, 'the accent card\'s figure reads in the type that sits on the accent');
  assert.equal(images.length, 1, 'the icon opens its card');
  assert.ok(texts.some((t) => (Array.isArray(t.text) ? t.text.map((r) => r.text).join('') : t.text) === '핵심'), 'the badge opens its card');
  await assert.rejects(() => kit.cards(slide, kit.M, 2, w, [{ value: '1', label: 'a', accent: true }, { value: '2', label: 'b', accent: true }]), /one accent card at most/);
});

// A structure's unit carries what a frontier node carries (kit §6): the icon over or before the label, the detail
// under it when the unit is at least an inch tall, and depth on the active unit alone.
test('kit hub, steps, and merge units carry an icon, a detail, and one shadow', async () => {
  const MEASURE = (text, { size = 18, lineHeight = 1 } = {}) => ({ lines: 1, height: (size / 72) * 1.2 * lineHeight, width: String(text).length * (size / 72) * 0.6 });
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect width="24" height="24" fill="#000"/></svg>';
  const kit = new Function('require', 'MEASURE', 'ICON', `${kitPrelude().source}\nreturn { hub, steps, merge, deck };`)(
    createRequire(import.meta.url),
    MEASURE,
    { names: ['truck', 'shield'], svg: () => SVG },
  );
  kit.deck({ hue: 215, theme: 'dark', mode: 'presentation', script: 'ko' });
  const made = () => { const shapes = [], images = [], texts = []; return { shapes, images, texts, slide: { addShape: (kind, o) => shapes.push(o), addImage: (o) => images.push(o), addText: (t, o) => texts.push({ text: t, options: o }) } }; };
  const runOf = (page, str) => page.texts.find((t) => Array.isArray(t.text) && t.text.some((r) => r.text === str));
  const h = made();
  const bottom = await kit.hub(h.slide, 4, 3.2, { label: '센터', icon: 'shield' }, [{ label: '출고', icon: 'truck', active: true }, '안전', '정비'], { r: 1.7, d: 1.1, hubD: 1.6 });
  assert.ok(Math.abs(bottom - (3.2 + 1.7 + 0.55)) < 1e-9, 'the awaited value is the bottom edge');
  assert.deepEqual(h.images.map((i) => i.altText), ['출고', '센터'], 'the icons are drawn with the unit label as their alt');
  assert.equal(h.shapes.filter((o) => o.shadow).length, 1, 'the active satellite alone carries the shadow');
  const unit = runOf(h, '출고');
  assert.ok(unit && unit.options.margin[3] / 72 > 0.55 && unit.options.margin[0] === 0 && unit.options.valign === 'top', 'the label hangs from the unit\'s centre axis inside the unit\'s box (pptxgenjs: the top inset is the fourth entry)');
  assert.ok(h.images[1].h > h.images[0].h, 'the centre\'s icon is a band up from the satellites\'');
  assert.ok(Math.abs(unit.options.y - (3.2 - 1.7 - 0.55)) < 1e-9, 'the box top is the unit top (a shared axis, not a measured line)');
  assert.ok(Math.abs(h.images[0].y + h.images[0].h - (3.2 - 1.7)) < 1e-9, 'the icon\'s bottom edge is the satellite\'s centre axis');
  const s = made();
  await kit.steps(s.slide, 0.6, 2, 12, 3.4, [{ label: '입고', icon: 'truck', detail: '도크가 받는다' }, { label: '출고', active: true, detail: '셔틀이 나간다' }]);
  const detail = runOf(s, '도크가 받는다');
  assert.ok(detail, 'a 1.3 in block carries the detail');
  assert.ok(detail.text.find((r) => r.text === '도크가 받는다').options.fontSize < detail.options.fontSize, 'the detail reads at note size under the label');
  assert.ok(s.images[0].x < detail.options.x, 'the icon sits before the label in a block');
  assert.equal(s.shapes.filter((o) => o.shadow).length, 1, 'the active block alone carries the shadow');
  const short = made();
  await kit.steps(short.slide, 0.6, 2, 12, 0.8, [{ label: '입고', detail: '도크가 받는다' }, '출고']);
  assert.ok(!runOf(short, '도크가 받는다'), 'a block under an inch keeps the label alone');
  const m = made();
  await kit.merge(m.slide, 0.6, 2, 12, 4, [{ label: '입고 예고', icon: 'truck' }, { label: '셔틀', active: true }], '배차표');
  assert.equal(m.images.length, 1, 'the many carry their icons');
  assert.equal(m.shapes.filter((o) => o.shadow).length, 1, 'the active source alone carries the shadow');
});

// A structure on the open paper measured a tenth of the page however large its radius; the stage is the
// context field it stands on, sized to the column, and the geometry the structure takes comes back from it.
// A column row that would cross the foot is refused with its shortfall, like a reading, instead of being drawn
// over the source line for the audit to find; and a chart with more categories than a label per bar can carry
// takes the gridline reading by default while a short single series keeps its labels.
test('kit stage, avail, columns, and chart axis defaults follow the measured page', async () => {
  const MEASURE = (text, { size = 18, lineHeight = 1 } = {}) => ({
    lines: Math.max(1, Math.ceil(String(text).length / 40)),
    height: Math.max(1, Math.ceil(String(text).length / 40)) * (size / 72) * 1.2 * lineHeight,
    width: String(text).length * (size / 72) * 0.6,
  });
  const kit = new Function('require', 'MEASURE', 'ICON', `${kitPrelude().source}\nreturn { stage, avail, columns, chart, head, deck, Z, W, H, T };`)(
    createRequire(import.meta.url),
    MEASURE,
    { names: [], svg: () => '' },
  );
  kit.deck({ hue: 25, mode: 'text', script: 'ko' });
  const shapes = [], charts = [];
  const slide = { addShape: (type, options) => shapes.push({ type, options }), addText: () => {}, addChart: (type, data, options) => charts.push({ type, data, options }) };
  const top = 2.0;
  const st = kit.stage(slide, kit.Z.seam.left.x, top, kit.Z.seam.left.w, kit.avail(top));
  assert.ok(st.share >= 0.3, `the stage on the seam's wide side claims about a third of the canvas (${st.share})`);
  assert.ok(st.r >= 0.8 && st.cx > 0.6 && st.cy > top, 'the stage returns a centre and a radius inside itself');
  assert.equal(st.ground, kit.T.paperAlt, 'the ground is the stage tint, for the structure to stand on');
  assert.ok(Math.abs(kit.avail(top) - (kit.Z.body.bottom - top)) < 1e-9, 'avail is the height left above the foot');
  const cols = [{ title: '배차 담당', text: '교대 시작에 배차표를 확정하고, 셔틀 대기가 두 대째가 되면 재배차한다.' }, { title: '셔틀 기사', text: '배차표 순서대로 적재·출발.' }];
  assert.throws(
    () => kit.columns(slide, 0.6, kit.Z.body.bottom - 0.3, 12, cols),
    (error) => /columns: column 1/.test(error.message) && /needs [\d.]+ in more/.test(error.message),
    'a row that would cross the foot names the column and the shortfall',
  );
  assert.doesNotThrow(() => kit.columns(slide, 0.6, top, 12, cols), 'the same row fits from the body top');
  const series = [{ name: '건수', values: [4, 6, 9, 14, 11, 8, 7, 5] }];
  kit.chart(slide, 0.6, top, 8, 4, { labels: ['1', '2', '3', '4', '5', '6', '7', '8'], series });
  kit.chart(slide, 0.6, top, 8, 4, { labels: ['1', '2', '3', '4'], series: [{ name: '건수', values: [4, 6, 9, 14] }] });
  const [many, few] = charts.map((entry) => entry.options);
  assert.equal(many.valAxisHidden, false, 'eight categories read from a value axis');
  assert.equal(many.showValue, false, 'and carry no label on every bar');
  assert.equal(many.valGridLine?.style, 'solid', 'with thin gridlines');
  assert.equal(few.valAxisHidden, true, 'four categories keep their labels');
  assert.equal(few.showValue, true);
});

// A quadrant item's label sat in a fixed 2.2 in strip beside its dot; a dot near
// the top rule on the right half reached across the vertical rule into the axis
// note's box, which the structure audit read as two text shapes overlapping.
test('kit quadrant labels take the width of their own text, not a fixed strip', async () => {
  const MEASURE = (text, { size = 18, lineHeight = 1 } = {}) => ({
    lines: 1,
    height: (size / 72) * 1.2 * lineHeight,
    width: String(text).length * (size / 72) * 0.6,
  });
  const kit = new Function('require', 'MEASURE', 'ICON', `${kitPrelude().source}\nreturn { quadrants, deck };`)(
    createRequire(import.meta.url),
    MEASURE,
    { names: [], svg: () => '' },
  );
  kit.deck({ hue: 215, theme: 'dark', mode: 'presentation', script: 'ko' });
  const texts = [];
  const slide = { addShape: () => {}, addText: (text, options) => texts.push({ text, options }) };
  await kit.quadrants(slide, 0.6, 2.2, 7.8, 4.0, {
    axes: { x: ['비용 낮음', '비용 높음'], y: ['효과 낮음', '효과 높음'] },
    names: ['', '우선 투자', '', ''],
    items: [{ label: '대전', x: 0.7, y: 0.85, active: true }, { label: '부산', x: 0.8, y: 0.35 }],
  });
  const byText = (needle) => texts.find((entry) => (Array.isArray(entry.text) ? entry.text.map((run) => run.text).join('') : String(entry.text)).includes(needle));
  const daejeon = byText('대전'), note = byText('효과 높음');
  assert.ok(daejeon && note, 'the item label and the axis note are both drawn');
  assert.ok(daejeon.options.w < 1.2, `a two-syllable label's box is its measured width (${daejeon.options.w} in)`);
  const overlapX = Math.min(daejeon.options.x + daejeon.options.w, note.options.x + note.options.w) - Math.max(daejeon.options.x, note.options.x);
  const overlapY = Math.min(daejeon.options.y + daejeon.options.h, note.options.y + note.options.h) - Math.max(daejeon.options.y, note.options.y);
  const shared = Math.max(0, overlapX) * Math.max(0, overlapY);
  assert.ok(shared < 0.25 * note.options.w * note.options.h, `the label leaves the axis note's box (${shared.toFixed(3)} in² shared)`);
});

// An item on the threshold ("혼합" at 0.55/0.45) had its label and detail written straight across the horizontal axis
// rule: the label's free spots avoided notes, markers, and placed labels, but not the rules. A label now prefers a
// free spot that crosses neither rule, and when every free spot crosses one it stands on a knockout of the field so
// the rule breaks around the words (R60).
test('kit quadrants labels keep off the axis rules, and a label that must cross one stands on a field knockout', async () => {
  const MEASURE = (text, { size = 18, lineHeight = 1 } = {}) => ({ lines: 1, height: (size / 72) * 1.2 * lineHeight, width: String(text).length * (size / 72) * 0.6 });
  const kit = new Function('require', 'MEASURE', 'ICON', `${kitPrelude().source}\nreturn { quadrants, deck, T };`)(createRequire(import.meta.url), MEASURE, { names: [], svg: () => '' });
  const T = kit.deck({ hue: 205, mode: 'balanced', script: 'ko' });
  const ops = [];
  const slide = { addShape: (type, options) => ops.push({ kind: 'shape', options }), addText: (text, options) => ops.push({ kind: 'text', text, options }) };
  await kit.quadrants(slide, 0.6, 2.2, 7.6, 4.2, {
    axes: { x: ['비용 낮음', '비용 높음'], y: ['야간 대응 낮음', '야간 대응 높음'] },
    items: [{ label: '주간 전용', x: 0.2, y: 0.2, detail: '현 체제 유지' }, { label: '혼합', x: 0.55, y: 0.45, detail: '주간 인력의 야간 순환' }, { label: '야간 전용', x: 0.7, y: 0.85, active: true, detail: '도크 4를 야간에만 연다' }, { label: '외주', x: 0.9, y: 0.3, detail: '3PL 야간 위탁' }],
  });
  const rules = ops.filter((op) => op.kind === 'shape' && (op.options.w === 0 || op.options.h === 0)).map((op) => op.options);
  const horizontal = rules.find((r) => r.h === 0), vertical = rules.find((r) => r.w === 0);
  assert.ok(horizontal && vertical, 'both axis rules are drawn');
  const labelOf = (needle) => ops.findIndex((op) => op.kind === 'text' && (Array.isArray(op.text) ? op.text.map((run) => run.text).join('') : String(op.text)).includes(needle));
  const crossesH = (b) => b.y < horizontal.y && b.y + b.h > horizontal.y && b.x < horizontal.x + horizontal.w && b.x + b.w > horizontal.x;
  const crossesV = (b) => b.x < vertical.x && b.x + b.w > vertical.x && b.y < vertical.y + vertical.h && b.y + b.h > vertical.y;
  for (const needle of ['주간 전용', '혼합', '야간 전용', '외주']) {
    const at = labelOf(needle);
    assert.ok(at >= 0, `${needle} is drawn`);
    const b = ops[at].options;
    if (!crossesH(b) && !crossesV(b)) continue;
    const knockout = ops[at - 1];
    assert.ok(knockout?.kind === 'shape' && knockout.options.fill?.color === T.paperAlt, `${needle} crosses a rule only on a knockout of the field`);
    assert.ok(knockout.options.x <= b.x && knockout.options.y <= b.y && knockout.options.x + knockout.options.w >= b.x + b.w && knockout.options.y + knockout.options.h >= b.y + b.h, `${needle}'s knockout covers its label box`);
  }
  const mixed = ops[labelOf('혼합')].options;
  assert.ok(!crossesH(mixed), 'the threshold item takes the spot under its marker instead of writing across the horizontal rule');
});

// An icon name beginning with m ("moon", "map-pin") was read as a 24-unit fill path — the custom-path branch tested
// only the first letter — so the picture was an empty SVG and the unit's glyph vanished in both readers (C3, R58).
test('kit icon names starting with m are drawn from the set, not as a fill path', async () => {
  const MEASURE = (text, { size = 18, lineHeight = 1 } = {}) => ({ lines: 1, height: (size / 72) * 1.2 * lineHeight, width: String(text).length * (size / 72) * 0.6 });
  const asked = [];
  const ICON = { names: ['moon'], svg: (name, { size }) => { asked.push(name); return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="#000"/></svg>`; } };
  const kit = new Function('require', 'MEASURE', 'ICON', `${kitPrelude().source}\nreturn { icon, deck };`)(createRequire(import.meta.url), MEASURE, ICON);
  kit.deck({ hue: 215, theme: 'dark', mode: 'presentation', script: 'ko' });
  const images = [];
  const slide = { addShape: () => {}, addText: () => {}, addImage: (options) => images.push(options) };
  await kit.icon(slide, 1, 1, 0.3, 'moon', { disc: false });
  assert.deepEqual(asked, ['moon'], 'the set draws "moon"');
  await kit.icon(slide, 1, 1, 0.3, 'M12 2 L22 22 L2 22 Z', { disc: false });
  assert.equal(asked.length, 1, 'a path stays a path');
  assert.equal(images.length, 2, 'both pictures are placed');
  assert.ok(images.every((image) => image.data && image.data.length > 200), 'neither picture is empty');
});

// The same family as the dumbbell: a declared value axis that does not contain
// the data clips the bar at the plot edge, so a 240 column stands as tall as a 95
// one while both labels are printed.
test('kit chart refuses a value axis that cannot carry its own data', async () => {
  const MEASURE = (text, { size = 18, lineHeight = 1 } = {}) => ({
    lines: 1,
    height: (size / 72) * 1.2 * lineHeight,
    width: String(text).length * (size / 72) * 0.6,
  });
  const charts = [];
  const kit = new Function('require', 'MEASURE', 'ICON', `${kitPrelude().source}\nreturn { chart, deck };`)(
    createRequire(import.meta.url),
    MEASURE,
    { names: [], svg: () => '' },
  );
  kit.deck({ hue: 210, mode: 'present', script: 'ko' });
  const slide = { addChart: (type, series, options) => charts.push({ type, series, options }), addShape: () => {}, addText: () => {} };
  const labels = ['1분기', '2분기', '3분기', '4분기'];
  const series = [{ name: '처리량', values: [40, 60, 95, 240] }];
  assert.throws(
    () => kit.chart(slide, 1, 1, 8, 4, { labels, series, max: 100 }),
    (error) => /240/.test(error.message) && /4분기/.test(error.message) && /0–100/.test(error.message),
    'the message names the value, its category, and the axis that cannot carry it',
  );
  charts.length = 0;
  kit.chart(slide, 1, 1, 8, 4, { labels, series, max: 260 });
  assert.equal(charts.length, 1, 'an axis that contains the data is drawn');
  assert.equal(charts[0].options.valAxisMaxVal, 260, 'the declared maximum reaches the chart');
  charts.length = 0;
  kit.chart(slide, 1, 1, 8, 4, { labels, series: [{ name: '수지', values: [-20, 15] }], labels: ['상', '하'] });
  assert.equal(charts.length, 1, 'without declared limits a negative value still plots');
});

test('kit palette derives a contrast-safe ladder from one seed hue', async () => {
  const kit = await kitBlocks('kit.md');
  const source = ['hsl', 'contrast', 'darkenUntil', 'chroma', 'neutral', 'counterHue', 'palette'].map((name) => {
    const match = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}\\n`).exec(kit);
    assert.ok(match, `${name} is in the kit`);
    return match[0];
  }).join('\n');
  const { palette, counterHue, chroma } = new Function(`${source}\nreturn { palette, counterHue, chroma };`)();
  // The hue a reader assigns a color, so a stroke can be checked against the accent's own family.
  const hueAngle = (hex) => {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max === min) return null;
    const d = max - min;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return ((h * 60) % 360 + 360) % 360;
  };
  // The default accent sits on the counter hue — warm beside cool, cool beside warm — and differs from the single-hue accent.
  assert.equal(counterHue(225), 15);
  assert.equal(counterHue(125), 25);
  assert.equal(counterHue(335), 40);
  assert.equal(counterHue(8), 198);
  assert.notEqual(palette({ hue: 205 }).accent, palette({ hue: 205, accentHue: 205 }).accent);
  const luminance = (hex) => {
    const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  for (const [hue, accentHue] of [8, 60, 125, 185, 205, 260, 335].flatMap((h) => [[h, undefined], [h, h]])) {
    const T = palette({ hue, accentHue });
    assert.match(T.accent, /^[0-9A-F]{6}$/);
    assert.ok(contrast(T.body, T.paperAlt) >= 4.5, `${hue}: body on paperAlt`);
    assert.ok(contrast(T.muted, T.paperAlt) >= 4.5, `${hue}: muted on paperAlt`);
    // The mark form of the accent is a bright fill that still reads as a shape on paper, and the type on it is legible small.
    assert.ok(contrast(T.accentFill, T.paper) >= 2, `${hue}: accentFill on paper`);
    assert.ok(contrast(T.accentLabel.color, T.accentLabel.fill) >= 4.5, `${hue}: the type on a labelled mark`);
    assert.ok(contrast(T.onDark, T.dark) >= 4.5, `${hue}: onDark on dark`);
    assert.ok(contrast(T.onDarkMuted, T.dark) >= 4.5, `${hue}: onDarkMuted on dark`);
    assert.ok(contrast(T.onDarkAccent, T.dark) >= 4.5, `${hue}: onDarkAccent on dark`);
    assert.ok(contrast('FFFFFF', T.accent) >= 4.5, `${hue}: white on accent`);
    assert.ok(contrast(T.accent, T.paper) >= 4.5, `${hue}: accent on paper`);
    assert.ok(contrast(T.ink, T.tint) >= 4.5, `${hue}: ink on tint`);
    // The four states: the word reads on paper, paperAlt, and its own weak field; the mark is seen on paper.
    assert.deepEqual(Object.keys(T.state), ['positive', 'warning', 'critical', 'informative']);
    for (const [name, s] of Object.entries(T.state)) {
      for (const bg of [T.paper, T.paperAlt, s.weak]) assert.ok(contrast(s.text, bg) >= 4.5, `${hue}: ${name} text on ${bg}`);
      assert.ok(contrast(s.solid, T.paper) >= 3, `${hue}: ${name} solid mark on paper`);
    }
    // State words and fields add no saturated hue family beside the accent: a verdict column never trips accent_hue_overuse.
    const states = Object.values(T.state);
    assert.equal(saturatedHueFamilies([T.accent, ...states.flatMap((s) => [s.text, s.weak])]).length, saturatedHueFamilies([T.accent]).length, `${hue}: state text and fields stay under the saturated band`);
    assert.ok(luminance(T.lineSubtle) > luminance(T.line) && luminance(T.line) > luminance(T.lineStrong), `${hue}: subtle, section, and strong lines in order`);
    // One neutral ladder, and it is the seed's: the type neutrals and the object neutrals (rules, braces, tracks, a bar
    // the accent does not own) share a hue family, so a page never shows two tinted grays beside one accent. A filled
    // area reads more chromatic than type, so the object neutrals stay well under the muted step's chroma.
    const mutedAngle = hueAngle(T.muted);
    for (const role of ['lineSubtle', 'line', 'lineStrong', 'markSoft', 'mark']) {
      const angle = hueAngle(T[role]);
      assert.ok(chroma(T[role]) < chroma(T.accent) / 3, `${hue}: ${role} stays a neutral beside the accent`);
      assert.ok(chroma(T[role]) <= chroma(T.muted) * 0.6, `${hue}: ${role} reads as gray, not as a tint (${chroma(T[role]).toFixed(1)} vs muted ${chroma(T.muted).toFixed(1)})`);
      assert.ok(angle === null || Math.abs(((angle - mutedAngle + 540) % 360) - 180) <= 30, `${hue}: ${role} sits in the deck's one neutral ladder`);
    }
    assert.ok(contrast(T.mark, T.paper) >= 4.5, `${hue}: an unemphasized object is seen on paper`);
  }
});

// The carriers read their anatomy from SPEC and the state ladder, against a recording slide (no file written): a toned
// badge takes the state's weak field and text, a verdict cell and a callout the same pair, the table's row rules the
// subtle line, an outline the strong line, a chevron run's active stage the spec's active fill, a band-scale numeral the
// stat step, and an unknown tone or spec throws with the choices.
test('kit carriers read their anatomy from SPEC and a state reads the same in a badge, a callout, and a verdict cell', () => {
  const MEASURE = (text, { size = 18, lineHeight = 1 } = {}) => ({ lines: 1, height: size / 72 * 1.2 * lineHeight, width: String(text).length * size / 72 * 0.6 });
  const kit = new Function('require', 'MEASURE', 'ICON', `${kitPrelude().source}\nreturn { T, get TYPE() { return TYPE; }, spec, tone, badge, callout, chevrons, hero, statBand, table, outline, deck, agenda };`)(createRequire(import.meta.url), MEASURE, { names: [], svg: () => '' });
  const slide = { shapes: [], texts: [], tables: [], addShape(type, o) { this.shapes.push({ type, ...o }); }, addText(runs, o) { this.texts.push({ runs, ...o }); }, addTable(rows, o) { this.tables.push({ rows, ...o }); }, addImage() {} };
  const T = kit.deck({ hue: 205, mode: 'balanced' });
  kit.badge(slide, 1, 1, 1.2, null, '채택', { tone: 'positive' });
  assert.equal(slide.shapes.at(-1).fill.color, T.state.positive.weak, 'a positive badge sits on the state\'s weak field');
  assert.equal(slide.texts.at(-1).color, T.state.positive.text, 'the badge word is the state text');
  assert.equal(slide.texts.at(-1).objectName, 'mixdog-spec:badge:positive', 'the carrier signs its shape for the receipt');
  assert.equal(slide.shapes.at(-1).h, kit.spec('badge').h, 'h null takes the spec height');
  kit.badge(slide, 1, 1, 1.2, 0.32, '후', { tone: 'accent' });
  assert.deepEqual([slide.shapes.at(-1).fill.color, slide.texts.at(-1).color], [T.accentLabel.fill, T.accentLabel.color], 'the accent chip takes the labelled mark pair');
  kit.callout(slide, 1, 1, 3, 0.6, '주의', { tone: 'warning', form: 'plain' });
  assert.deepEqual([slide.shapes.at(-1).fill.color, slide.texts.at(-1).color], [T.state.warning.weak, T.state.warning.text], 'a callout reads the same state pair');
  kit.callout(slide, 1, 1, 3, 0.6, '메모');
  assert.equal(slide.shapes.at(-1).line.color, T.lineStrong, 'a neutral callout is outlined in the strong line');
  kit.outline(slide, 1, 1, 3, 3);
  assert.equal(slide.shapes.at(-1).line.color, T.lineStrong, 'an outline owns its region with the strong line');
  kit.table(slide, 0.6, 1, 12, ['안', '판정'], [['A', '보류'], ['B', '채택']], { verdict: 1, tones: ['warning', 'positive'] });
  const [head, first, second] = slide.tables.at(-1).rows;
  assert.equal(slide.tables.at(-1).border.color, T.lineSubtle, 'row rules are the subtle line');
  assert.equal(head[0].options.fill.color, T.paperAlt, 'the header sits on the basement surface');
  assert.deepEqual([first[1].options.fill.color, first[1].options.color, first[1].options.bold], [T.state.warning.weak, T.state.warning.text, true]);
  assert.deepEqual([second[1].options.fill.color, second[1].options.color], [T.state.positive.weak, T.state.positive.text]);
  assert.equal(first[0].options.fill.color, T.paper, 'a cell outside the verdict column stays on paper');
  // The IR table devices: figures align right with their header, a group row is bold on the basement, a sub row is
  // muted, and the current-period column is outlined in the mark form of the accent.
  kit.table(slide, 0.6, 1, 12, ['항목', '2Q24', '2Q25'], [['매출', '2,005', '2,028'], ['플랫폼', '955', '1,055'], ['영업이익률', '6.7%', '9.2%']], { highlightCol: 2, groupRows: [0], subRows: [1, 2] });
  const ir = slide.tables.at(-1).rows;
  assert.deepEqual([ir[0][1].options.align, ir[1][2].options.align, ir[1][0].options.align], ['right', 'right', 'left'], 'figures and their header align right, names left');
  assert.deepEqual([ir[1][0].options.bold, ir[1][0].options.fill.color], [true, T.paperAlt], 'a group row is bold on the basement surface');
  assert.deepEqual([ir[2][0].options.color, ir[2][0].options.bold], [T.muted, false], 'a sub row is muted and regular');
  assert.deepEqual(slide.shapes.slice(-4).map((s) => [s.line.color, s.line.width, s.fill]), Array(4).fill([T.accentFill, 1.5, undefined]), 'the current-period column is framed by four accent rules and no fill');
  assert.ok(Math.abs(kit.spec('table').rowH - Math.round(kit.TYPE.body * 2.2 / 72 * 100) / 100) < 0.001, 'the row pitch follows the body size');
  kit.chevrons(slide, 0.6, 2, 12, 1.15, ['입고', '분류', '적재'], { active: 1 });
  assert.deepEqual(slide.shapes.slice(-3).map((s) => s.fill.color), [T.paperAlt, T.accentLabel.fill, T.paperAlt], 'only the active stage takes the labelled mark fill');
  const before = slide.texts.length;
  kit.hero(slide, 0.6, 2, 3, '31', '4분기', { scale: 'band' });
  assert.equal(slide.texts[before].runs[0].options.fontSize, kit.TYPE.stat, 'a band-scale numeral is the stat step');
  assert.ok(kit.TYPE.stat < kit.TYPE.hero, 'the stat step sits under the hero');
  const bottom = kit.statBand(slide, 0.6, 2, 12, [{ value: '1.6배', label: '처리량' }, { value: '0.3%', label: '오류율', detail: '라벨 손상만' }, { value: '4건', label: '경보/주' }]);
  assert.equal(slide.texts.filter((t) => t.runs?.[0]?.options?.fontSize === kit.TYPE.stat).length, 4, 'three band numerals join the earlier one');
  assert.equal(slide.shapes.at(-1).line.color, T.line, 'the band closes on a section rule');
  assert.ok(bottom > 2 + 1.12, 'the band returns its bottom under the rule');
  // The progressive agenda: the current section lit in onDark with a rule in the on-dark accent, the others muted.
  const agendaTexts = slide.texts.length;
  kit.agenda(slide, ['현황', '요청', '부록'], 1);
  const agendaRows = slide.texts.slice(agendaTexts);
  assert.deepEqual(agendaRows.map((t) => [t.color, t.bold]), [[T.onDarkMuted, false], [T.onDark, true], [T.onDarkMuted, false]], 'only the current section is lit');
  assert.ok(slide.shapes.some((s) => s.line?.color === T.onDarkAccent && s.line?.width === 2.5), 'the lit section carries the accent rule');
  assert.throws(() => kit.tone('danger'), /one of neutral, accent, positive, warning, critical, informative/);
  assert.throws(() => kit.spec('card'), /one of badge, callout, chevrons, stat, table/);
});

// One chart carries one data-label colour, and a ring writes that label inside the
// slice it belongs to. Every fill a ring can take therefore has to read under the
// same colour, or the figure on the smaller slice becomes a guess.
test('a chart labels its filled carriers in a colour that reads on every fill it uses', () => {
  const MEASURE = (text, { size = 18, lineHeight = 1 } = {}) => ({ lines: 1, height: size / 72 * 1.2 * lineHeight, width: String(text).length * size / 72 * 0.6 });
  const kit = new Function('require', 'MEASURE', 'ICON', `${kitPrelude().source}\nreturn { deck, chart };`)(createRequire(import.meta.url), MEASURE, { names: [], svg: () => '' });
  const luminance = (hex) => {
    const channels = [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
      .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  const slide = { charts: [], addChart(type, data, options) { this.charts.push({ type, data, ...options }); }, addShape() {}, addText() {}, addImage() {} };
  for (const hue of [30, 205, 250]) {
    kit.deck({ hue, mode: 'balanced' });
    kit.chart(slide, 0.6, 1.5, 5, 3, { type: 'doughnut', labels: ['야간', '주간', '정비'], series: [{ name: '비중', values: [60, 30, 10] }] });
    kit.chart(slide, 0.6, 1.5, 5, 3, { type: 'col', labels: ['1분기', '2분기'], series: [{ name: '처리량', values: [12, 31] }], accent: 1 });
    for (const drawn of slide.charts.slice(-2)) {
      // A label inside its carrier reads against the fills; a label above the bar (outEnd) reads against the paper.
      const surfaces = drawn.dataLabelPosition === 'outEnd' ? [kit.deck({ hue, mode: 'balanced' }).paper] : drawn.chartColors;
      for (const fill of surfaces) {
        assert.ok(
          contrast(drawn.dataLabelColor, fill) >= 3,
          `hue ${hue}: label ${drawn.dataLabelColor} on ${fill} is ${contrast(drawn.dataLabelColor, fill).toFixed(2)}:1`,
        );
      }
    }
  }
});

// The measured-text block of the kit, run against a stand-in MEASURE (Hangul 1 em, Latin 0.55 em, a space 0.3 em)
// so the wrapping and shrinking logic is tested without fonts: a Hangul line never splits an eojeol, an author's
// break survives, Latin passes through, a closing mark never opens a line, inline runs keep their paragraph options
// on the piece that carried them, and a shrinking box lands on a scale step.
test('kit wraps Hangul by the eojeol and shrinks type along the scale', async () => {
  const kit = await kitBlocks('kit.md');
  const start = kit.indexOf('const HANGUL');
  const end = kit.indexOf('\n}\n', kit.indexOf('function fitSize(', start)) + 3;
  assert.ok(start > 0 && end > start, 'the measured-text block is in the kit');
  const em = (ch) => (/[\uAC00-\uD7A3]/.test(ch) ? 1 : ch === ' ' ? 0.3 : 0.55);
  const widthOf = (text, size) => [...text].reduce((sum, ch) => sum + em(ch) * size / 72, 0);
  const MEASURE = (text, { size = 18, width = 0, lineHeight = 1 } = {}) => {
    const lines = String(text).split('\n').flatMap((para) => {
      if (!width) return [para];
      const out = []; let current = '';
      for (const ch of para) { if (current && widthOf(current + ch, size) > width) { out.push(current); current = ch; } else current += ch; }
      out.push(current);
      return out;
    });
    return { lines: lines.length, height: lines.length * size / 72 * 1.2 * lineHeight, width: Math.max(...lines.map((line) => widthOf(line, size))) };
  };
  const T = { sans: 'Noto Sans KR', light: 'Noto Sans KR' };
  const TYPE = { body: 18, lead: 22, caption: 13, kicker: 11, section: 27, title: 36, cover: 47, hero: 65, poster: 99 };
  const DIAG = { label: 14, note: 11.5 };
  const fitH = (text, w, size, font, { bold = false, lh = 1 } = {}) => MEASURE(text, { font, size, bold, width: w, lineHeight: lh }).height + 0.06;
  const { wrapKo, runsOf, wrapRuns, fitSize } = new Function('MEASURE', 'T', 'TYPE', 'DIAG', 'fitH', `${kit.slice(start, end)}\nreturn { wrapKo, runsOf, wrapRuns, fitSize };`)(MEASURE, T, TYPE, DIAG, fitH);

  const sentence = '원문에서 낸 QuizBank 10 문항으로 슬라이드만 보고 답한 정답률';
  const wrapped = wrapKo(sentence, 3.4, 18, T.sans);
  const lines = wrapped.split('\n');
  assert.ok(lines.length >= 2, `a 3.4 in column wraps the sentence: ${wrapped}`);
  assert.ok(lines.every((line) => widthOf(line, 18) <= 3.4 * 0.98 + 1e-9), 'every line fits the zone with the margin');
  assert.equal(lines.join(' '), sentence, 'the break falls only at a space — no eojeol is split');
  assert.deepEqual(wrapKo('좋은 슬라이드는\n이제 측정된다', 10, 47, T.sans).split('\n'), ['좋은 슬라이드는', '이제 측정된다'], 'an author\'s break stays');
  assert.equal(wrapKo('The quick brown fox jumps', 1, 18, T.sans), 'The quick brown fox jumps', 'Latin passes through untouched');
  assert.equal(wrapKo('미학 .', 0.3, 18, T.sans), '미학 .', 'a closing mark never opens a line');
  assert.equal(runsOf('한 줄'), '한 줄', 'a single line stays a string');
  assert.deepEqual(runsOf('a\nb'), [{ text: 'a' }, { text: 'b', options: { softBreakBefore: true } }], 'a broken string becomes one paragraph with a soft break');

  const runs = [
    { text: '미학 상위는 편집이 안 되고, ', options: { paraSpaceAfter: 17 } },
    { text: '편집 가능한 쪽은 미학이 낮다', options: { bold: true, color: 'AF3A1D', fontFace: T.sans } },
    { text: '. 두 축을 동시에 잡은 시스템은 하나도 없다.', options: { breakLine: true } },
  ];
  const pieces = wrapRuns(runs, 3.6, 27, T.light);
  assert.ok(pieces.some((piece) => piece.options.softBreakBefore), 'the paragraph is broken with soft breaks');
  assert.equal(pieces.filter((piece) => piece.options.paraSpaceAfter).length, 1, 'paragraph spacing stays on the one piece that carried it');
  assert.equal(pieces[0].options.paraSpaceAfter, 17);
  assert.equal(pieces.at(-1).options.breakLine, true, 'the paragraph still ends where the author ended it');
  assert.ok(pieces.filter((piece) => piece.options.bold).every((piece) => piece.options.color === 'AF3A1D'), 'a run\'s later pieces keep its type');
  assert.equal(pieces.map((piece) => piece.text).join('').replace(/ /g, ''), runs.map((run) => run.text).join('').replace(/ /g, ''), 'no character is lost or duplicated');
  assert.ok(!pieces.some((piece) => /^\./.test(piece.text) && piece.options.softBreakBefore), 'a line never opens with a full stop');

  const short = '짧은 문장';
  assert.equal(fitSize(short, 8, 1, 22, T.sans, { min: 13 }), 22, 'text that fits keeps its size');
  const long = '이 문장은 한 줄에 들어가지 않을 만큼 길어서 작은 크기로 내려가야 한다 그리고 계속 이어진다';
  const shrunk = fitSize(long, 6, fitH(long, 6, 18, T.sans) , 22, T.sans, { min: 13 });
  assert.equal(shrunk, 18, 'a box sized for the body step lands on 18, never on 21 or 19');
  assert.ok([22, 18, 14, 13].includes(fitSize(long, 4, 0.5, 22, T.sans, { min: 13 })), 'nothing off the scale');
});

test('every hard rule in the skill names a runtime code that exists, or is marked manual', async () => {
  const files = ['direction.md', 'composition.md', 'kit.md', 'charts.md', 'pictures.md', 'writing.md'].map((file) => join(SKILL, file));
  files.push(join(SKILL, '..', 'SKILL.md'));
  const runtime = await Promise.all(['quality', 'authoring', 'portable', 'core'].map(async (dir) => {
    const base = fileURLToPath(new URL(`./${dir}/`, import.meta.url));
    const names = (await readdir(base)).filter((name) => name.endsWith('.mjs') && !name.includes('.test.'));
    return Promise.all(names.map((name) => readFile(join(base, name), 'utf8')));
  }));
  const source = runtime.flat().join('\n');
  const unchecked = [];
  const unknown = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!/\*\*Hard rule/.test(line)) continue;
      const codes = [...line.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]).filter((code) => /_/.test(code));
      const runtimeMarked = /→ runtime/.test(line);
      const manual = /→ manual/.test(line);
      if (!runtimeMarked && !manual) unchecked.push(line.slice(0, 80));
      if (runtimeMarked) for (const code of codes) if (!source.includes(`'${code}'`)) unknown.push(code);
    }
  }
  assert.deepEqual(unknown, [], 'hard rules reference review codes the runtime never raises');
  assert.deepEqual(unchecked, [], 'hard rules without a runtime code or a manual mark');
});

test('the skill never ships a whole-slide function: no reference defines an archetype', async () => {
  for (const file of ['direction.md', 'composition.md', 'kit.md', 'charts.md', 'pictures.md']) {
    const kit = await kitBlocks(file);
    assert.doesNotMatch(kit, /function (?:S|E|R|P)\d+\(/, `${file} defines a skeleton function`);
    assert.doesNotMatch(kit, /function (?:cover|section|closing|archNode|phaseRoadmap|benchmarkBarChart|statWell|pairRow)\(/, `${file} defines a whole-slide or card-grid generator`);
  }
});

test('a deck composed from the kit primitives authors, validates, and passes the measured review', { timeout: 180_000, ...RENDERED }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-pptx-kit-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  // The runner adds the kit: the script is the brief and the slides alone.
  const path = join(cwd, 'kit.pptx');
  const authored = value(await executeOfficeTool({ action: 'author', path, script: DECK, mode: 'portable', overwrite: true, render: true }, { cwd }));
  assert.equal(authored.ok, true, `${authored.error?.message}\n${authored.error?.excerpt || ''}`);
  assert.equal(authored.kit, 'runtime');
  assert.ok(authored.nativeGradients >= 2, `the cover and closing fields are native gradients: ${authored.nativeGradients}`);
  assert.equal(authored.render?.pageCount, 12);
  assert.equal(authored.receipt?.slides?.length, 12, 'the author result carries a composition receipt per slide');
  assert.ok(authored.receipt.slides[2].charts >= 1, 'the receipt sees the native chart on slide 3');
  assert.ok(authored.receipt.deck.charts >= 1 && authored.receipt.deck.presets >= 1, 'the deck totals count charts and preset contours');
  // The spec carriers' signatures survive the save: the stat band's four numerals, the toned verdict table, the chevron run.
  assert.equal(authored.receipt.slides[3].specs?.stat?.count, 4, `slide 4 carries four stat numerals: ${JSON.stringify(authored.receipt.slides[3].specs)}`);
  assert.deepEqual(authored.receipt.slides[8].specs?.table?.variants, ['toned']);
  assert.equal(authored.receipt.deck.specs?.chevrons?.anatomies?.length, 1, 'every chevron stage shares one anatomy');
  assert.deepEqual(authored.receipt.deck.specs?.badge?.variants, ['neutral', 'accent']);
  const validation = value(await executeOfficeTool({ action: 'validate', session: authored.session }, { cwd }));
  assert.equal(validation.schema?.ok, true, JSON.stringify(validation.schema?.errors?.slice(0, 3)));
  const qa = value(await executeOfficeTool({ action: 'qa', session: authored.session }, { cwd }));
  assert.deepEqual(measured(qa), []);
});

// The same deck at the presentation scale in the safe (system) pairing: the largest type must not
// overflow the measured boxes and Malgun Gothic must pass the font review as safe.
test('the kit deck holds at presentation scale with the safe Korean pairing', { timeout: 180_000, ...RENDERED, ...(RENDERED.skip ? {} : MALGUN) }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-pptx-presentation-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const script = `deck({ hue: 205, accentHue: 205, mode: 'presentation', script: 'ko', pairing: 'serif', fonts: 'safe' });\n${DECK}`;
  const path = join(cwd, 'presentation.pptx');
  const authored = value(await executeOfficeTool({ action: 'author', path, script, mode: 'portable', overwrite: true, render: true }, { cwd }));
  assert.equal(authored.ok, true, `${authored.error?.message}\n${authored.error?.excerpt || ''}`);
  assert.equal(authored.render?.pageCount, 12);
  const qa = value(await executeOfficeTool({ action: 'qa', session: authored.session }, { cwd }));
  assert.deepEqual(measured(qa), []);
});

// Pictures through the picture kit over locally generated samples in three ratios: a full-bleed
// cover under a scrim, a side picture, a triptych by weight, an annotated picture, a receded closing.
const SAMPLE_PICTURES = {
  wide: [1920, 1080, '1f3b4d', '6aa2b8', '<circle cx="1400" cy="400" r="260" fill="#f2c94c" opacity="0.8"/>'],
  tall: [1080, 1920, '3a2a5d', 'c98bb9', '<circle cx="540" cy="700" r="300" fill="#ffffff" opacity="0.35"/>'],
  square: [1200, 1200, '2d5f2d', '97bc62', '<rect x="250" y="250" width="700" height="700" rx="80" fill="#ffffff" opacity="0.3"/>'],
};
async function writeSamplePictures(cwd) {
  const paths = {};
  for (const [name, [w, h, a, b, shapes]] of Object.entries(SAMPLE_PICTURES)) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#${a}"/><stop offset="1" stop-color="#${b}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/>${shapes}</svg>`;
    paths[name] = join(cwd, `${name}.png`);
    await sharp(Buffer.from(svg)).png().toFile(paths[name]);
  }
  return paths;
}
const pictureDeck = (P) => `
// BRIEF
// subject/audience/action: 운영팀 · 현장 보고
// reading mode: balanced · argument mode: briefing
// style: photo-editorial · palette: hue 205 · accent: 1F6F8B · type: MODE balanced → body 18 · script: ko · pairing: weight · fonts: noto
// facts: F1 1.6배 — 운영 로그 · F2 0.3% — 품질 시트 B4 · F3 22시 — 운행표
// slide plan: 1 job: cover · move: 현장을 본다 · composition: 전면 사진, 왼쪽 스크림 · carriers: picture, statement
//   · 2 job: picture · move: 야간이 기본이 됐음을 본다 · composition: 오른쪽 세로 사진, 왼쪽 목록 · carriers: picture, list
//   · 3 job: picture · relationship: contrast · move: 병목이 다름을 본다 · composition: 무게로 나눈 세 폭 · carriers: picture
//   · 4 job: picture · relationship: link · move: 병목 지점을 짚는다 · composition: 주석 사진, 오른쪽 레이블 열 · carriers: picture, diagram
//   · 5 job: closing · move: 요청을 받는다 · composition: 물러난 사진 위 한 줄 · carriers: picture, statement
{ const s = quiet(); await picture(s, ${P.wide}, 0, 0, W, H, { alt: '야간 조명 아래 물류 허브 도크 전경' }); await scrim(s, 0, 0, W, H, 'left'); kicker(s, '현장 보고', M, 2.15, T.onDarkAccent); const b = title(s, '물류 허브 증설,\\n첫 분기 결과', { y: 2.55, w: W / 2 - M - 0.3, size: TYPE.cover, color: 'FFFFFF' }); text(s, '처리량은 늘고 오류는 줄었다', M, b + 0.25, 6, TYPE.lead, { color: T.onDark }); }
{ const s = light(); await picture(s, ${P.tall}, W - 6.2, 0, 6.2, H, { alt: '22시 3번 도크에서 출고를 기다리는 셔틀' }); const cw = W - 6.2 - 0.6 - M; kicker(s, '현장'); const top = title(s, '야간 처리량이 주간을 넘어섰다', { w: cw }) + GAP.between; bullets(s, M, top, cw, 3.4, ['야간 셔틀 두 대 추가로 처리량 1.6배', '피크 시간대가 22시로 이동', '오류율 0.3%']); caption(s, '사진: 2026년 8월, 3번 도크', M, H - M - 0.4, cw); }
{ const s = light(); kicker(s, '비교'); const top = title(s, '같은 도크, 다른 시간대') + GAP.between; const pics = [[${P.wide}, '아침, 입고 피크', 3], [${P.square}, '오후, 분류', 2], [${P.tall}, '22시, 출고', 2]]; const cols = spans(M, W - 2 * M, pics.map((p) => p[2])); const ph = H - M - 1.5 - top; for (let i = 0; i < 3; i += 1) { await picture(s, pics[i][0], cols[i].x, top, cols[i].w, ph, { alt: pics[i][1] }); caption(s, pics[i][1], cols[i].x, top + ph + GAP.within, cols[i].w); } text(s, '세 시간대의 병목은 각각 다르다: 입고는 도크, 분류는 라벨, 출고는 셔틀.', M, H - M - 0.45, W - 2 * M, TYPE.body, { h: 0.45 }); }
{ const s = light(); kicker(s, '주석'); const top = title(s, '도크 3의 병목 지점') + GAP.between; const pw = 8.6, ph = H - M - top, lx = M + pw + 0.5, lw = W - M - lx; await picture(s, ${P.wide}, M, top, pw, ph, { alt: '도크 3 전경, 병목 지점 세 곳이 보인다' }); [['입고 대기열이 도크 앞을 막는다', 0.2, 0.3], ['분류기 투입구, 라벨 손상 발생', 0.55, 0.5], ['셔틀 적재 지점', 0.8, 0.75]].forEach(([label, fx, fy], i) => { const nx = M + fx * pw, ny = top + fy * ph, rowH = Math.min(0.9, ph / 3), ly = top + i * rowH + rowH / 2; connector(s, nx + 0.25, ny, lx - 0.15, ly, { color: T.muted, width: 1, arrow: 'none' }); node(s, nx, ny, 0.5, i + 1); text(s, label, lx, ly - 0.2, lw, TYPE.caption + 1, { color: T.ink }); }); }
{ const s = quiet(); await picture(s, ${P.square}, 0, 0, W, H, { transparency: 60, alt: '분류 구역 전경, 배경으로 물러난 사진' }); await scrim(s, 0, 0, W, H, 'left'); title(s, '도크 4 증설 예산 승인', { y: 2.6, w: 9, size: TYPE.title, color: 'FFFFFF' }); text(s, '운영팀 · 2026년 9월', M, H - 1.0, 8, TYPE.caption, { color: T.onDarkMuted, font: T.data }); }
await pres.writeFile({ fileName: OUTPUT });
`;

test('pictures composed through the picture kit author without measured review warnings', { timeout: 240_000, ...RENDERED }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-pptx-pictures-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const paths = await writeSamplePictures(cwd);
  const P = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, JSON.stringify(path)]));
  const path = join(cwd, 'pictures.pptx');
  const authored = value(await executeOfficeTool({ action: 'author', path, script: pictureDeck(P), mode: 'portable', overwrite: true, render: true }, { cwd }));
  assert.equal(authored.ok, true, `${authored.error?.message}\n${authored.error?.excerpt || ''}`);
  assert.equal(authored.render?.pageCount, 5);
  assert.ok(authored.nativeGradients >= 2, `scrims are native gradients over the pictures: ${authored.nativeGradients}`);
  assert.ok(authored.receipt?.slides?.every((slide) => slide.pictures >= 1), 'every slide of the picture deck carries a picture in the receipt');
  const qa = value(await executeOfficeTool({ action: 'qa', session: authored.session }, { cwd }));
  assert.deepEqual(measured(qa), []);
});

// The relationship structures (kit.md §6), one per page, each inside a region the page chose and beside the
// copy that reads it: a timeline, steps, a hub, a loop, a merge, tiers, lanes, quadrants, a venn, a quote,
// brace groups. Every page passes the measured review, and the receipt reads each structure's kind back.
export const STRUCTURES_DECK = `
// BRIEF
// subject/audience/action: 운영팀 · 도크 4 증설 계획의 구조를 본다
// reading mode: balanced · argument mode: briefing
// directions: A swiss-minimal · hue 205 · weight · 다이어그램 중심 · B editorial · hue 25 · serif · 문서형 · C dark-tech · hue 215 · weight · 발표형 · selected: A · why: 관계 구조가 논거다
// style: swiss-minimal · palette: hue 205 · accent: auto · type: MODE balanced → body 18 · script: ko · pairing: weight · fonts: noto
// facts: sample — 구조 예시, 수치 없음
// slide plan: 1 job: cover · move: 무엇을 볼지 안다 · composition: 어두운 필드, 왼쪽 제목 · carriers: statement · rhythm: anchor
//   · 2 job: process · relationship: order · move: 순서를 본다 · composition: 척추 위 타임라인, 아래 설명 · carriers: diagram · rhythm: dense
//   · 3 job: process · relationship: order · move: 상승 순서를 본다 · composition: 대각선 계단 · carriers: diagram · rhythm: dense
//   · 4 job: structure · relationship: link · move: 중심과 위성을 본다 · composition: 왼쪽 허브, 오른쪽 설명 · carriers: diagram, prose · rhythm: dense
//   · 5 job: process · relationship: order · move: 고리를 본다 · composition: 왼쪽 순환, 오른쪽 설명 · carriers: diagram, prose · rhythm: dense
//   · 6 job: structure · relationship: link · move: 합류를 본다 · composition: 왼쪽 열이 오른쪽 하나로 · carriers: diagram · rhythm: dense
//   · 7 job: structure · relationship: parent · move: 층위를 본다 · composition: 왼쪽 계층, 오른쪽 설명 · carriers: diagram, prose · rhythm: dense
//   · 8 job: structure · relationship: membership · move: 누가 언제 하는지 본다 · composition: 세 레인 · carriers: diagram · rhythm: dense
//   · 9 job: comparison · relationship: contrast · move: 두 축 위 위치를 본다 · composition: 왼쪽 사분면, 오른쪽 설명 · carriers: diagram, prose · rhythm: dense
//   · 10 job: structure · relationship: overlap · move: 겹치는 책임을 본다 · composition: 왼쪽 세 원, 오른쪽 설명 · carriers: diagram, prose · rhythm: dense
//   · 11 job: claim · relationship: none · move: 현장의 말을 듣는다 · composition: 큰 따옴표와 인용 · carriers: quote · rhythm: breathing
//   · 12 job: structure · relationship: parent · move: 세 갈래를 본다 · composition: 브레이스 그룹, 오른쪽 설명 · carriers: diagram, prose · rhythm: dense
//   · 13 job: closing · move: 요청을 받는다 · composition: 커버의 필드를 반향 · carriers: statement · rhythm: anchor
{ const s = quiet(); kicker(s, '운영팀', M, 2.15, T.onDarkAccent); const b = title(s, '도크 4 증설,\\n계획의 구조', { y: 2.55, w: 8, size: TYPE.cover, color: T.onDark }); text(s, '운영팀 · 구조 검토', M, b + 0.25, 8, TYPE.caption, { color: T.onDarkMuted, font: T.data }); }
{ const s = light(); kicker(s, '순서'); const top = title(s, '설계에서 야간 가동까지 다섯 단계') + GAP.between; const b = timeline(s, M, top, W - 2 * M, [{ label: '설계', detail: '야간 전용 동선을 먼저 그린다' }, { label: '승인', detail: '운영 회의에서 예산을 받는다' }, { label: '공사', detail: '도크 3을 막지 않는 순서로', active: true }, { label: '시운전', detail: '셔틀 두 대로 야간 한 주' }, { label: '야간 가동', detail: '출고 기본값을 야간으로' }]); const ty = Z.foot.takeaway; prose(s, '공사 단계가 가장 길고, 도크 3의 야간 출고를 멈추지 않는 순서로 잡는다. 시운전 한 주 동안 셔틀 배차를 조정한다.', M, b + GAP.between, W - 2 * M, ty - GAP.between - b - GAP.between, TYPE.body); takeaway(s, '공사 순서가 야간 출고를 지킨다.'); }
{ const s = light(); kicker(s, '상승'); const top = title(s, '처리 단계는 위로 올라간다') + GAP.between; await steps(s, M, top, W - 2 * M, Z.foot.takeaway - GAP.between - top, [{ label: '입고', icon: 'package', detail: '도크가 받는다' }, { label: '분류', icon: 'layers', detail: '분류기가 라벨을 붙인다' }, { label: '적재', icon: 'boxes', detail: '셔틀 지점에 쌓는다' }, { label: '출고', icon: 'truck', detail: '야간 셔틀이 나간다', active: true }]); takeaway(s, '출고가 마지막이자 가장 높은 단계다.'); }
{ const s = light(); kicker(s, '허브'); const top = title(s, '야간 운영 센터가 여섯 기능을 잇는다') + GAP.between; await hub(s, 4.4, top + 2.3, { label: '야간 운영 센터', icon: 'radio' }, [{ label: '입고', icon: 'package' }, { label: '분류', icon: 'layers' }, { label: '적재', icon: 'boxes' }, { label: '출고', icon: 'truck', active: true }, { label: '안전', icon: 'shield' }, { label: '정비', icon: 'wrench' }], { r: 1.7, d: 1.0, hubD: 1.7 }); prose(s, '여섯 기능이 한 센터에서 배차와 인력을 받는다. 출고가 가장 잦은 요청을 내므로 센터 옆에 둔다.', 7.6, top + 0.4, W - M - 7.6, 3.6, TYPE.body); }
{ const s = light(); kicker(s, '순환'); const top = title(s, '점검 주기는 닫힌 고리로 돈다') + GAP.between; loop(s, 4.2, top + 2.3, 1.3, ['계획', '실행', { label: '점검', active: true }, '조정'], { center: '점검' }); prose(s, '점검 단계가 고리를 닫는다. 주간 점검에서 나온 근접 경보가 다음 계획의 입력이 된다.', 8.2, top + 0.6, W - M - 8.2, 2.8, TYPE.body); }
{ const s = light(); kicker(s, '합류'); const top = title(s, '네 입력이 하나의 야간 배차표로 모인다') + GAP.between; await merge(s, M, top, W - 2 * M, H - M - top, [{ label: '입고 예고', icon: 'calendar' }, { label: '분류기 처리량', icon: 'gauge' }, { label: '셔틀 가용 대수', icon: 'truck', active: true }, { label: '안전 점검 결과', icon: 'shield' }], { label: '야간 배차표', icon: 'list-checks' }); }
{ const s = light(); kicker(s, '층위'); const top = title(s, '결정은 네 층위를 내려간다') + GAP.between; tiers(s, M + 0.5, top, 6.5, H - M - top, ['경영진 승인', '운영 회의', { label: '현장 배차', active: true }, '작업자']); prose(s, '현장 배차가 매일 바뀌는 층위다. 위 두 층은 분기에 한 번, 아래 층은 교대마다 결정한다.', 8.2, top + 0.6, W - M - 8.2, 3.2, TYPE.body); }
{ const s = light(); kicker(s, '레인'); const top = title(s, '누가 언제 무엇을 하는가') + GAP.between; await lanes(s, M, top, W - 2 * M, H - M - top, [{ name: '운영팀', items: [{ label: '설계', at: 0, span: 0.22, icon: 'clipboard-check' }, { label: '시운전', at: 0.66, span: 0.18, icon: 'gauge' }] }, { name: '시설팀', items: [{ label: '공사', at: 0.24, span: 0.4, active: true, icon: 'hammer' }] }, { name: '현장', items: [{ label: '야간 가동', at: 0.84, span: 0.16, icon: 'moon' }] }]); }
{ const s = light(); kicker(s, '위치'); const top = title(s, '네 안을 두 축 위에 놓으면 하나만 오른쪽 위다') + GAP.between; await quadrants(s, M, top, 7.6, H - M - top, { axes: { x: ['비용 낮음', '비용 높음'], y: ['야간 대응 낮음', '야간 대응 높음'] }, names: ['', '유일한 후보', '', ''], items: [{ label: '주간 전용', x: 0.2, y: 0.2, icon: 'sun', detail: '현 체제 유지' }, { label: '혼합', x: 0.55, y: 0.45, icon: 'route', detail: '주간 인력의 야간 순환' }, { label: '야간 전용', x: 0.7, y: 0.85, active: true, icon: 'moon', detail: '도크 4를 야간에만 연다' }, { label: '외주', x: 0.9, y: 0.3, icon: 'truck', detail: '3PL 야간 위탁' }] }); prose(s, '야간 전용만이 비용과 야간 대응을 함께 만족한다. 혼합안은 경계에 걸린다.', 8.7, top + 0.6, W - M - 8.7, 3.2, TYPE.body); }
{ const s = light(); kicker(s, '겹침'); const top = title(s, '세 팀이 나누는 책임과 겹치는 책임') + GAP.between; venn(s, 4.6, top + 2.5, ['운영', '시설', '안전'], { d: 2.9, overlap: 1.1, shared: '야간 배차' }); prose(s, '야간 배차는 세 팀이 함께 결정한다. 나머지는 각 팀의 단독 책임이다.', 8.6, top + 0.6, W - M - 8.6, 3.2, TYPE.body); }
{ const s = light(); quote(s, M, 1.6, 11, '야간에 도크가 하나 더 있었다면 셔틀을 기다리며 서 있는 시간이 없었을 겁니다.', '3번 도크 야간 조장, 8월 현장 인터뷰'); }
{ const s = light(); kicker(s, '갈래'); const top = title(s, '증설이 만든 변화는 세 갈래다') + GAP.between; braceGroups(s, M, top, 8, [{ name: '처리량', items: ['야간 셔틀 두 대 추가', '피크 시간대가 밤으로 이동'] }, { name: '품질', items: ['분류기 도입', '라벨 손상만 남았다'] }, { name: '안전', items: ['일방향 동선', '근접 경보 감소'] }]); rule(s, 9.1, top, Z.foot.takeaway - GAP.between - top, T.line); prose(s, '세 갈래 모두 야간 운영에서 나왔다. 도크 4를 야간 전용으로 설계하면 세 효과가 그대로 이어진다.', 9.4, top, W - M - 9.4, Z.foot.takeaway - GAP.between - top, TYPE.body); takeaway(s, '세 갈래의 원인은 하나, 야간 운영이다.'); }
{ const s = quiet(); kicker(s, '요청', M, 2.15, T.onDarkAccent); title(s, '도크 4 증설 예산을 승인해 주십시오', { y: 2.55, w: 9, size: TYPE.title, color: T.onDark }); text(s, '운영팀 · 구조 검토', M, H - 1.0, 8, TYPE.caption, { color: T.onDarkMuted, font: T.data }); }
await pres.writeFile({ fileName: OUTPUT });
`;

test('the kit structures author inside their regions and pass the measured review, and the receipt reads each kind back', { timeout: 240_000, ...RENDERED }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-pptx-structures-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, 'structures.pptx');
  const authored = value(await executeOfficeTool({ action: 'author', path, script: STRUCTURES_DECK, mode: 'portable', overwrite: true, render: true }, { cwd }));
  assert.equal(authored.ok, true, `${authored.error?.message}\n${authored.error?.excerpt || ''}`);
  assert.equal(authored.render?.pageCount, 13);
  const kinds = authored.receipt?.deck?.specs?.structure?.variants || [];
  for (const kind of ['timeline', 'steps', 'hub', 'loop', 'merge', 'tiers', 'lanes', 'quadrants', 'venn', 'quote', 'braceGroups']) {
    assert.ok(kinds.includes(kind), `the receipt reads the ${kind} structure back: ${kinds.join(', ')}`);
  }
  const qa = value(await executeOfficeTool({ action: 'qa', session: authored.session }, { cwd }));
  assert.deepEqual(measured(qa), []);
});

// The picture row and the collage were never rendered by a scenario until R99: a tiles() row at h 3.6 under a sub
// line stacked its captions over the source line, and clippings() laid cards at free sizes whose edges landed a few
// points off each other's axes (axis_drift). The row is measured before the draw; the collage sits on a 0.1 in grid.
test('kit tiles refuses a row whose captions would cross the foot, and clippings keep every edge on the grid', async () => {
  const MEASURE = (text, { size = 18, lineHeight = 1 } = {}) => {
    const parts = String(text).split('\n');
    return { lines: parts.length, height: (size / 72) * 1.2 * lineHeight * parts.length, width: Math.max(...parts.map((p) => p.length)) * (size / 72) * 0.55 };
  };
  const kit = new Function('require', 'MEASURE', 'ICON', `${kitPrelude().source}\nreturn { deck, head, avail, tiles, clippings, Z: () => Z, W, M };`)(
    createRequire(import.meta.url),
    MEASURE,
    { names: [], svg: () => '' },
  );
  kit.deck({ hue: 205, theme: 'light', mode: 'balanced', script: 'ko' });
  const made = () => { const shapes = []; return { shapes, slide: { addShape: (kind, o) => shapes.push({ kind, ...o }), addImage: (o) => shapes.push({ image: true, ...o }), addText: (t, o) => shapes.push({ text: true, ...o }) } }; };
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const items = ['입고 대시보드', '분류 모니터', '셔틀 배차표'].map((label) => ({ data: png, label, caption: '대기열이 도크 앞을 막는다.' }));
  const row = made();
  const top = kit.head(row.slide, '캡처', '세 화면이 세 병목을 보인다', { sub: '브라우저 캡처 세 장을 한 기준선에 놓는다.' });
  await assert.rejects(
    () => kit.tiles(row.slide, kit.M, top, kit.W - 2 * kit.M, items, { h: 3.6, frame: 'browser' }),
    (error) => /tiles: .*past the foot/.test(error.message) && /h [\d.]+ fits from this top/.test(error.message),
    'the row that would cross the foot is refused with the height that fits named',
  );
  const bottom = await kit.tiles(row.slide, kit.M, top, kit.W - 2 * kit.M, items, { h: 3.0, frame: 'browser' });
  assert.ok(bottom <= kit.Z().body.bottom + 0.07, `the fitting row ends above the foot (${bottom.toFixed(2)})`);
  assert.equal(row.shapes.filter((o) => o.kind === 'ellipse').length, 9, 'each browser frame carries its three dots');

  const collage = made();
  await kit.clippings(collage.slide, kit.M, top, 8.2, kit.avail(top), [{ data: png, w: 4.2, h: 2.4 }, { data: png, w: 2.8, h: 2.8 }, { data: png, w: 2.2, h: 3.0 }, { data: png, w: 4.0, h: 2.2 }]);
  const boxes = collage.shapes.filter((o) => !o.text).map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h }));
  assert.equal(boxes.length, 12, 'four cards, each a shadow plane, a picture, and an outline');
  const onGrid = (v) => Math.abs(v / 0.1 - Math.round(v / 0.1)) < 1e-6;
  for (const b of boxes) assert.ok(onGrid(b.x) && onGrid(b.y) && onGrid(b.w / 2) && onGrid(b.h / 2), `a card's corner and centre sit on the 0.1 in grid (${JSON.stringify(b)})`);
  const kinds = { left: (b) => b.x, right: (b) => b.x + b.w, cx: (b) => b.x + b.w / 2, top: (b) => b.y, bottom: (b) => b.y + b.h, cy: (b) => b.y + b.h / 2 };
  for (const [name, edge] of Object.entries(kinds)) {
    const values = boxes.map(edge).sort((a, b) => a - b);
    for (let i = 1; i < values.length; i += 1) {
      const gap = (values[i] - values[i - 1]) * 72;
      assert.ok(gap < 1 || gap > 6, `${name} edges either coincide or sit clear of the 6 pt drift window (${gap.toFixed(1)} pt)`);
    }
  }
});

// A ruled columns() row drawn from the body top directly under head() put its hairline 0.45 in under the title, which
// the design review reads as the title's underline (decorative_stripe, R103). The rule is dropped there and kept when
// a sub line sits between, or in text mode whose 23 pt title is under the review's 24 pt.
test('kit columns drops its top rule directly under a title and keeps it under a sub line', () => {
  const MEASURE = (text, { size = 18, lineHeight = 1 } = {}) => ({ lines: 1, height: (size / 72) * 1.2 * lineHeight, width: String(text).length * (size / 72) * 0.6 });
  const kit = new Function('require', 'MEASURE', 'ICON', `${kitPrelude().source}\nreturn { deck, head, columns, columnsH, W, M };`)(createRequire(import.meta.url), MEASURE, { names: [], svg: () => '' });
  const cols = [{ title: '배차', text: '교대 시작에 배차표를 확정한다.' }, { title: '도크', text: '대기가 두 대째면 재배차한다.' }];
  const rules = (mode, sub) => {
    kit.deck({ hue: 205, theme: 'light', mode, script: 'ko' });
    const shapes = [];
    const slide = { addShape: (kind, o) => shapes.push({ kind, ...o }), addText() {}, addImage() {} };
    const top = kit.head(slide, '역할', '세 역할이 한 교대를 나눈다', sub ? { sub } : {});
    const bottom = kit.columns(slide, kit.M, top, kit.W - 2 * kit.M, cols);
    const lines = shapes.filter((o) => o.kind === 'line' && o.h === 0 && Math.abs(o.y - top) < 1e-9).length;
    return { lines, height: bottom - top, measured: kit.columnsH(kit.M, kit.W - 2 * kit.M, cols) };
  };
  const bare = rules('balanced');
  assert.equal(bare.lines, 0, 'directly under the title the row draws no rule');
  assert.ok(Math.abs(bare.height - bare.measured) < 1e-9, 'the row keeps its inset, so columnsH still agrees with the drawn height');
  assert.equal(rules('balanced', '한 줄 부제').lines, 1, 'under a sub line the rule is a separator and stays');
  assert.equal(rules('presentation').lines, 0, 'presentation mode: no rule under the title');
  assert.equal(rules('text').lines, 1, 'text mode: the 23 pt title is under the review size, the rule stays');
});

// A hero-scale stat band under a two-line display() headline in presentation mode reached the foot (labels on the
// source line, edge_margin — R104). The band is refused past the foot with the fix named; the same band fits in
// balanced mode and at the band scale.
test('kit statBand refuses a band that would end past the foot', () => {
  const MEASURE = (text, { size = 18, lineHeight = 1 } = {}) => { const parts = String(text).split('\n'); return { lines: parts.length, height: (size / 72) * 1.2 * lineHeight * parts.length, width: Math.max(...parts.map((p) => p.length)) * (size / 72) * 0.6 }; };
  const kit = new Function('require', 'MEASURE', 'ICON', `${kitPrelude().source}\nreturn { deck, statBand, Z: () => Z, W, M, GAP };`)(createRequire(import.meta.url), MEASURE, { names: [], svg: () => '' });
  const slide = { addText() {}, addShape() {}, addImage() {} };
  const stats = [{ value: '1.6', unit: '배', label: '처리량' }, { value: '0.3', unit: '%', label: '오류율' }, { value: '22', unit: '시', label: '피크' }];
  kit.deck({ hue: 205, theme: 'light', mode: 'presentation', script: 'ko' });
  const low = kit.Z().body.bottom - 1.0;
  assert.throws(() => kit.statBand(slide, kit.M, low, (kit.W - 2 * kit.M) * 0.6, stats, { scale: 'hero' }), /statBand: .*past the foot .*at the hero scale/, 'a hero band an inch above the foot is refused');
  assert.doesNotThrow(() => kit.statBand(slide, kit.M, low - 1.0, (kit.W - 2 * kit.M) * 0.6, stats, { scale: 'band' }), 'the band scale two inches above the foot fits');
});

// specimen() returned the gap after its last row as if it were content (R100): the block registered under it sat a
// between step too low and the audit read an empty band over the foot. The bottom edge is the last row's.
test('kit specimen returns the last row\'s bottom edge, not the gap after it', () => {
  const MEASURE = (text, { size = 18, lineHeight = 1 } = {}) => ({ lines: 1, height: (size / 72) * 1.2 * lineHeight, width: String(text).length * (size / 72) * 0.6 });
  const kit = new Function('require', 'MEASURE', 'ICON', `${kitPrelude().source}\nreturn { deck, specimen, GAP, T: () => T, TYPE: () => TYPE };`)(createRequire(import.meta.url), MEASURE, { names: [], svg: () => '' });
  kit.deck({ hue: 205, theme: 'light', mode: 'balanced', script: 'ko' });
  const boxes = [];
  const slide = { addText: (t, o) => boxes.push(o), addShape() {}, addImage() {} };
  const bottom = kit.specimen(slide, 0.6, 2, 12, [{ text: '야간 배차 자동화', font: kit.T().display, size: kit.TYPE().title, bold: true, label: '제목' }, { text: '1,204', font: kit.T().data, size: kit.TYPE().stat, bold: true, label: '숫자' }]);
  const last = Math.max(...boxes.map((o) => o.y + o.h));
  assert.ok(Math.abs(bottom - last) < 1e-9, `the awaited value is the last row's bottom edge (${bottom.toFixed(2)} vs ${last.toFixed(2)})`);
  assert.equal(kit.specimen(slide, 0.6, 2, 12, []), 2, 'no rows: the top is the bottom');
});

// The structure-beside-its-rail recipe as composition.md §4 and §6 write it — head() → avail(top) → stage on the
// seam's wide side → hub / loop from the stage, lanes and quadrants on avail(top), shareDown(top, columnsH(…)) →
// steps — draws without a hand-tuned number under every head the kit offers (a floor raised past the recipe once
// refused a page that rendered clean: steps at 0.9 in against the 0.8 in label-only block).
test('kit recipe: the documented structure-and-rail calls pass every head mode without hand tuning', async () => {
  const MEASURE = (text, { size = 18, lineHeight = 1 } = {}) => {
    const parts = String(text).split('\n');
    return { lines: parts.length, height: (size / 72) * 1.2 * lineHeight * parts.length, width: Math.max(...parts.map((p) => p.length)) * (size / 72) * 0.55 };
  };
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect width="24" height="24" fill="#000"/></svg>';
  const kit = new Function('require', 'MEASURE', 'ICON', `${kitPrelude().source}\nreturn { deck, head, avail, stage, hub, loop, lanes, quadrants, shareDown, columnsH, steps, Z: () => Z, W, M };`)(
    createRequire(import.meta.url),
    MEASURE,
    { names: ['truck'], svg: () => SVG },
  );
  const slide = { addShape() {}, addText() {}, addImage() {}, addChart() {} };
  const cols = [{ title: '배차', text: '교대 시작에 배차표를 확정한다.' }, { title: '도크', text: '대기가 두 대째면 재배차한다.' }, { title: '셔틀', text: '순서대로 적재·출발.' }];
  for (const [mode, sub] of [['presentation', undefined], ['presentation', '야간 셔틀 두 대를 더한 뒤의 8월 운영 로그다.'], ['text', '야간 셔틀 두 대를 더한 뒤의 8월 운영 로그다.'], ['balanced', '한 줄 부제']]) {
    kit.deck({ hue: 215, theme: 'light', mode, script: 'ko' });
    const Z = kit.Z(), tag = `${mode}${sub ? '+sub' : ''}`;
    const top = kit.head(slide, '구조', '허브와 위성이 한 도크를 나누고 셔틀 두 대가 같은 도크를 쓴다', sub ? { sub } : {});
    const room = kit.avail(top);
    const st = kit.stage(slide, Z.seam.left.x, top, Z.seam.left.w, room);
    assert.ok(st.share >= 0.22 && st.r >= 1.6, `${tag}: the stage on avail(top) clears the hub floor (share ${st.share.toFixed(2)}, r ${st.r.toFixed(2)})`);
    await assert.doesNotReject(async () => kit.hub(slide, st, { label: '센터', icon: 'truck' }, ['출고', '안전', '정비', '배차']), `${tag}: hub from the stage`);
    await assert.doesNotReject(async () => kit.loop(slide, st, ['입고', '분류', '적재', '출고']), `${tag}: loop from the stage`);
    await assert.doesNotReject(async () => kit.lanes(slide, Z.seam.left.x, top, Z.seam.left.w, room, [{ label: '배차', items: ['a', 'b'] }, { label: '도크', items: ['c'] }, { label: '셔틀', items: ['d', 'e'] }]), `${tag}: three lanes on avail(top)`);
    await assert.doesNotReject(async () => kit.quadrants(slide, Z.seam.left.x, top, Z.seam.left.w, room, { x: ['낮음', '높음'], y: ['낮음', '높음'], items: [{ label: '쿠폰', x: 0.3, y: 0.7 }] }), `${tag}: quadrants on avail(top)`);
    if (mode === 'presentation' && sub) {
      // A sub line in presentation mode costs the body 0.4 in: a three-column reading under a stage leaves the stage
      // under its floor, and the refusal names the row as the cause — the author cuts the row, not the stage.
      assert.throws(() => kit.shareDown(top, kit.columnsH(kit.M, kit.W - 2 * kit.M, cols)), /shareDown: .*floor 2\.2.*because the row under it measures/, `${tag}: shareDown refuses with the row named`);
    } else {
      const sh = kit.shareDown(top, kit.columnsH(kit.M, kit.W - 2 * kit.M, cols));
      const bottom = await kit.steps(slide, kit.M, sh.stage.y, kit.W - 2 * kit.M, sh.stage.h, ['입고', '분류', '출고']);
      assert.ok(Math.abs(bottom - (sh.stage.y + sh.stage.h)) < 1e-9 && sh.under.y + sh.under.h <= Z.body.bottom + 1e-9, `${tag}: the step run fills its share and the row stays above the foot`);
    }
  }
});
