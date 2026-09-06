// The pptx skill's kit must author cleanly through the runtime: every helper
// compiles, the package validates, and the measured review raises nothing
// against a deck composed the way the skill teaches — from the primitives,
// with no whole-slide function. Advisory readings (monotony, plan read-back)
// are information, not failures, so the tests filter them out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { executeOfficeTool } from './index.mjs';
import { isAdvisoryOfficeIssue } from './quality/quality-pipeline.mjs';

import { kitBlocks } from './authoring/pptx-kit.mjs';

const SKILL = fileURLToPath(new URL('../../defaults/skills/pptx/references/', import.meta.url));

const value = (result) => JSON.parse(result.content[0].text);
const measured = (qa) => (qa.issuesAfter || qa.issues || []).filter((issue) => !isAdvisoryOfficeIssue(issue)).map((issue) => `${issue.code} ${issue.path}: ${issue.message}`);

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
//   · 10 job: section · move: 요청으로 넘어간다 · composition: 고스트 숫자 · carriers: statement · rhythm: anchor
//   · 11 job: evidence · relationship: evidence · move: 비중을 본다 · composition: 게이지와 강조 문장 · carriers: gauge · rhythm: breathing
//   · 12 job: closing · move: 승인한다 · composition: 커버의 필드를 반향 · carriers: statement · rhythm: anchor
{ const s = quiet(); await gradientField(s, 0, 0, W, H, [[0, T.dark], [100, T.darkAlt]], 35); ghost(s, '04', 7.6, 1.0, 240, 5.2); kicker(s, '운영팀 · 3분기', M, 2.15, T.onDarkAccent); const b = title(s, '도크 4 증설,\\n예산 승인 요청', { y: 2.55, w: 8.2, size: TYPE.cover, color: 'FFFFFF' }); text(s, '야간 처리량이 주간을 넘어선 지금, 다음 도크는 야간 전용으로 설계한다', M, b + 0.25, 8.5, TYPE.lead, { color: T.onDark }); text(s, '2026년 9월 · 운영팀', M, H - 1.0, 8, TYPE.caption, { color: T.onDarkMuted, font: T.data }); }
{ const s = light(); rule(s, M, 1.6, 3.6, T.accent, 2); emphasis(s, [[['증설 석 달 만에 ', {}], ['처리량은 1.6배', { bold: true, color: T.accent }], [', 오류율은 0.3%가 됐다. 다음 병목은 도크가 아니라 야간 셔틀이다.', {}]]], M + 0.4, 1.6, 9.6, 2.6, 28, T.ink, { lh: 1.3 }); text(s, '— 운영 로그와 품질 시트, 2026년 6~8월', M + 0.4, 4.5, 8, TYPE.caption, { color: T.muted }); }
{ const s = light(); kicker(s, '처리량'); const top = title(s, '분기마다 처리량이 늘었고, 4분기가 가장 컸다') + GAP.between; const ty = H - M - 0.75; chart(s, M, top, 8.2, ty - top - GAP.between, { labels: ['1분기', '2분기', '3분기', '4분기'], series: [{ name: '처리량', values: [12, 18, 24, 31] }], accent: 3 }); const hb = hero(s, 9.4, top + 0.4, 3.3, '31', '4분기 처리량, 천 건'); const py = hb + GAP.within, room = ty - GAP.between - py; if (room >= 0.6) prose(s, '분류기 도입과 야간 셔틀 추가가 겹친 분기다.', 9.4, py, 3.3, room, TYPE.caption + 1, T.body); takeaway(s, '증설 효과는 4분기에 집중됐다.', ty); }
{ const s = light(); kicker(s, '규모'); const top = title(s, '네 숫자가 한 원인을 가리킨다') + GAP.between; const stats = [['1.6배', '처리량 증가', '야간 셔틀 두 대 추가'], ['0.3%', '오류율', '라벨 손상만 남았다'], ['4건', '근접 경보/주', '일방향 동선의 효과'], ['4,200', '건/시간 분류', '분류기 도입']]; const cols = spans(M, W - 2 * M, stats.map((v) => weightOf({ value: v[0], label: v[1], text: v[2] }))); let bottom = top; stats.forEach((v, i) => { const b = hero(s, cols[i].x, top, cols[i].w, v[0], v[1], { size: 48 }); bottom = Math.max(bottom, text(s, v[2], cols[i].x, b + GAP.within, cols[i].w, TYPE.caption + 1, { color: T.body })); }); hairline(s, M, bottom + GAP.between, W - 2 * M); takeaway(s, '증설이 아니라 야간 운영이 원인이다.'); }
{ const s = light(); kicker(s, '흐름'); const top = title(s, '입고에서 출고까지, 병목은 셔틀에 있다') + GAP.between; const stages = [{ label: '입고', detail: '두 도크가 새벽 입고를 나눠 받는다.' }, { label: '분류', detail: '분류기가 시간당 4,200건을 처리한다.' }, { label: '적재', detail: '야간 셔틀 두 대가 22시와 01시에 출발한다.', active: true }, { label: '출고', detail: '출고 오류는 라벨 손상뿐이다.' }]; const cols = spans(M, W - 2 * M - 1.15 * 0.25, stages.map((st) => weightOf({ label: st.label, detail: st.detail }, { active: st.active })), { gap: 0 }); chevrons(s, M, top, W - 2 * M, 1.15, stages.map((st) => st.label), { active: 2, widths: cols }); stages.forEach((st, i) => flow(s, cols[i].x + 0.2, top + 1.15 + GAP.between, cols[i].w - 0.4, [{ text: st.detail, size: TYPE.caption + 1, lh: 1.4 }], { bottom: H - M - 1.2 })); takeaway(s, '셔틀이 늘지 않으면 도크 4는 야간에 놀게 된다.'); }
{ const s = light(); kicker(s, '비교'); const top = title(s, '전과 후: 달라진 쪽이 더 넓다') + GAP.between; const seam = splitAt(M, W - 2 * M, 40, 70); const ph = H - M - 1.2 - top; field(s, seam.left.x, top, seam.left.w, ph); lift(s, seam.right.x, top, seam.right.w, ph, 'FFFFFF'); badge(s, seam.left.x + 0.3, top + 0.3, 1.2, 0.32, '전'); badge(s, seam.right.x + 0.3, top + 0.3, 1.2, 0.32, '후', { fill: T.accent, color: 'FFFFFF' }); bullets(s, seam.left.x + 0.3, top + 0.85, seam.left.w - 0.6, ph - 1.1, ['교차 동선, 근접 경보 주 31건', '수작업 분류', '주간 중심 출고']); bullets(s, seam.right.x + 0.3, top + 0.85, seam.right.w - 0.6, ph - 1.1, ['일방향 동선, 근접 경보 주 4건', '분류기 시간당 4,200건', '야간 출고가 기본'], TYPE.body, T.ink, { font: T.sans }); takeaway(s, '차이 표시는 바뀐 쪽 하나에만 둔다.'); }
{ const s = light(); kicker(s, '구조'); const top = title(s, '증설이 만든 변화는 세 갈래다') + GAP.between; let y = top; [['처리량', ['야간 셔틀 두 대 추가', '피크 시간대가 22시로 이동']], ['품질', ['분류기 도입', '라벨 손상만 남았다']], ['안전', ['일방향 동선', '근접 경보 주 4건']]].forEach(([name, items]) => { const h = fitH(items.join('\\n'), 6, TYPE.body - 2, T.light, { lh: 1.5 }); text(s, name, M, y, 1.7, TYPE.body, { color: T.accent, bold: true, align: 'right' }); brace(s, M + 1.85, y, h); s.addText(items.map((t, i) => ({ text: t, options: { breakLine: i < items.length - 1 } })), { ...box(M + 2.3, y, 6, h), fontFace: T.light, fontSize: TYPE.body - 2, color: T.body, valign: 'top', margin: 0, lineSpacingMultiple: 1.5 }); y += h + GAP.between; }); const rx = 9.4; rule(s, rx - 0.3, top, y - top - GAP.between, T.line); prose(s, '세 갈래 모두 야간 운영에서 나왔다. 도크 4를 야간 전용으로 설계하면 세 효과가 그대로 이어진다.', rx, top, W - M - rx, 2.4, TYPE.body, T.body); }
{ const s = light(); kicker(s, '순환'); const top = title(s, '점검 주기는 닫힌 고리로 돈다') + GAP.between; const cx = 4.2, cy = top + (H - M - top) / 2, r = 1.4, labels = ['계획', '실행', '점검', '조정']; labels.forEach((l, i) => { const span = 360 / labels.length, on = i === 2; arc(s, cx, cy, r, 270 + i * span + 3, 270 + (i + 1) * span - 3, { color: on ? T.accent : T.paperAlt }); const mid = (270 + (i + 0.5) * span) * Math.PI / 180; text(s, l, cx + (r + 0.7) * Math.cos(mid) - 1.0, cy + (r + 0.7) * Math.sin(mid) - 0.25, 2.0, DIAG.label, { color: on ? T.accent : T.ink, bold: on, align: 'center', h: 0.5, valign: 'middle' }); }); const inner = r * 0.72 * 2 - 0.12; s.addShape(S.ellipse, { ...box(cx - inner / 2, cy - inner / 2, inner, inner), fill: { color: T.paper }, line: { color: T.paper } }); text(s, '점검', cx - 0.8, cy - 0.3, 1.6, TYPE.lead, { color: T.ink, bold: true, align: 'center', h: 0.6, valign: 'middle' }); prose(s, '점검 단계가 고리를 닫는다. 주간 점검에서 나온 근접 경보가 다음 계획의 입력이 된다.', 8.4, top + 0.6, W - M - 8.4, 2.6, TYPE.body); }
{ const s = light(); kicker(s, '선택지'); const top = title(s, '세 안 중 야간 전용이 유일하게 조건을 모두 만족한다') + GAP.between; const b = table(s, M, top, W - 2 * M, ['안', '비용', '야간 대응', '판정'], [['주간 전용', '낮음', '불가', '보류'], ['혼합', '중간', '부분', '보류'], ['야간 전용', '중간', '가능', '채택']], { colW: [3.2, 2.6, 3.3, 3.03], verdict: 3 }); caption(s, '출처: 운영팀 비용 추정, 2026년 9월', M, b + GAP.between, 8); }
{ const s = quiet(); ghost(s, '02', 7.5, 1.2); text(s, '02', M, 2.0, 3, 72, { color: T.onDarkAccent, font: T.data, bold: true, h: 1.3 }); title(s, '요청 사항', { y: 3.5, w: 8, size: TYPE.title, color: 'FFFFFF' }); }
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
  const gutter = /const GUTTER = [\d.]+;/.exec(kit);
  assert.ok(gutter, 'the column gap is a named anchor (GUTTER)');
  const { spans, splitAt, weightOf } = new Function(`${gutter[0]}\n${source}\nreturn { spans, splitAt, weightOf };`)();
  const equal = spans(0.5, 12, [10, 10, 10]);
  assert.ok(equal.every((c) => Math.abs(c.w - equal[0].w) < 1e-9), 'equal weights → equal widths');
  assert.ok(Math.abs(equal[2].x + equal[2].w - 12.5) < 1e-9, 'the row ends at x + w');
  const unequal = spans(0.5, 12, [10, 30, 10]);
  assert.ok(unequal[1].w > unequal[0].w * 1.3, 'the heavy peer is visibly wider');
  assert.ok(unequal[0].w > 0.6 * (12 / 3), 'the light peer stays readable (clamped)');
  const seam = splitAt(0.5, 12, 40, 80);
  const free = 12 - Number(/[\d.]+/.exec(gutter[0].slice('const GUTTER = '.length))[0]);
  assert.ok(seam.left.w < seam.right.w && seam.left.w / free >= 0.38 - 1e-9, 'the seam follows weight within the 0.38–0.62 band');
  assert.equal(splitAt(0, 10, 1, 1).left.w, splitAt(0, 10, 1, 1).right.w, 'equal weights → the middle');
  assert.ok(weightOf({ label: 'a', detail: 'long detail text' }, { active: true }) > weightOf({ label: 'a', detail: 'long detail text' }), 'active counts more');
});

test('kit palette derives a contrast-safe ladder from one seed hue', async () => {
  const kit = await kitBlocks('kit.md');
  const source = ['hsl', 'contrast', 'darkenUntil', 'counterHue', 'palette'].map((name) => {
    const match = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}\\n`).exec(kit);
    assert.ok(match, `${name} is in the kit`);
    return match[0];
  }).join('\n');
  const { palette, counterHue } = new Function(`${source}\nreturn { palette, counterHue };`)();
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
    assert.ok(contrast(T.onDark, T.dark) >= 4.5, `${hue}: onDark on dark`);
    assert.ok(contrast(T.onDarkMuted, T.dark) >= 4.5, `${hue}: onDarkMuted on dark`);
    assert.ok(contrast(T.onDarkAccent, T.dark) >= 4.5, `${hue}: onDarkAccent on dark`);
    assert.ok(contrast('FFFFFF', T.accent) >= 4.5, `${hue}: white on accent`);
    assert.ok(contrast(T.accent, T.paper) >= 4.5, `${hue}: accent on paper`);
    assert.ok(contrast(T.ink, T.tint) >= 4.5, `${hue}: ink on tint`);
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
  const files = ['direction.md', 'composition.md', 'kit.md', 'charts.md', 'pictures.md'].map((file) => join(SKILL, file));
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

test('a deck composed from the kit primitives authors, validates, and passes the measured review', { timeout: 180_000 }, async (t) => {
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
  const validation = value(await executeOfficeTool({ action: 'validate', session: authored.session }, { cwd }));
  assert.equal(validation.schema?.ok, true, JSON.stringify(validation.schema?.errors?.slice(0, 3)));
  const qa = value(await executeOfficeTool({ action: 'qa', session: authored.session }, { cwd }));
  assert.deepEqual(measured(qa), []);
});

// The same deck at the presentation scale in the safe (system) pairing: the largest type must not
// overflow the measured boxes and Malgun Gothic must pass the font review as safe.
test('the kit deck holds at presentation scale with the safe Korean pairing', { timeout: 180_000 }, async (t) => {
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
{ const s = quiet(); await picture(s, ${P.wide}, 0, 0, W, H); await scrim(s, 0, 0, W, H, 'left'); kicker(s, '현장 보고', M, 2.15, T.onDarkAccent); const b = title(s, '물류 허브 증설,\\n첫 분기 결과', { y: 2.55, w: W / 2 - M - 0.3, size: TYPE.cover, color: 'FFFFFF' }); text(s, '처리량은 늘고 오류는 줄었다', M, b + 0.25, 6, TYPE.lead, { color: T.onDark }); }
{ const s = light(); await picture(s, ${P.tall}, W - 6.2, 0, 6.2, H); const cw = W - 6.2 - 0.6 - M; kicker(s, '현장'); const top = title(s, '야간 처리량이 주간을 넘어섰다', { w: cw }) + GAP.between; bullets(s, M, top, cw, 3.4, ['야간 셔틀 두 대 추가로 처리량 1.6배', '피크 시간대가 22시로 이동', '오류율 0.3%']); caption(s, '사진: 2026년 8월, 3번 도크', M, H - M - 0.4, cw); }
{ const s = light(); kicker(s, '비교'); const top = title(s, '같은 도크, 다른 시간대') + GAP.between; const pics = [[${P.wide}, '아침, 입고 피크', 3], [${P.square}, '오후, 분류', 2], [${P.tall}, '22시, 출고', 2]]; const cols = spans(M, W - 2 * M, pics.map((p) => p[2])); const ph = H - M - 1.5 - top; for (let i = 0; i < 3; i += 1) { await picture(s, pics[i][0], cols[i].x, top, cols[i].w, ph); caption(s, pics[i][1], cols[i].x, top + ph + GAP.within, cols[i].w); } text(s, '세 시간대의 병목은 각각 다르다: 입고는 도크, 분류는 라벨, 출고는 셔틀.', M, H - M - 0.45, W - 2 * M, TYPE.body, { h: 0.45 }); }
{ const s = light(); kicker(s, '주석'); const top = title(s, '도크 3의 병목 지점') + GAP.between; const pw = 8.6, ph = H - M - top, lx = M + pw + 0.5, lw = W - M - lx; await picture(s, ${P.wide}, M, top, pw, ph); [['입고 대기열이 도크 앞을 막는다', 0.2, 0.3], ['분류기 투입구, 라벨 손상 발생', 0.55, 0.5], ['셔틀 적재 지점', 0.8, 0.75]].forEach(([label, fx, fy], i) => { const nx = M + fx * pw, ny = top + fy * ph, rowH = Math.min(0.9, ph / 3), ly = top + i * rowH + rowH / 2; connector(s, nx + 0.25, ny, lx - 0.15, ly, { color: T.muted, width: 1, arrow: 'none' }); node(s, nx, ny, 0.5, i + 1); text(s, label, lx, ly - 0.2, lw, TYPE.caption + 1, { color: T.ink }); }); }
{ const s = quiet(); await picture(s, ${P.square}, 0, 0, W, H, { transparency: 60 }); await scrim(s, 0, 0, W, H, 'left'); title(s, '도크 4 증설 예산 승인', { y: 2.6, w: 9, size: TYPE.title, color: 'FFFFFF' }); text(s, '운영팀 · 2026년 9월', M, H - 1.0, 8, TYPE.caption, { color: T.onDarkMuted, font: T.data }); }
await pres.writeFile({ fileName: OUTPUT });
`;

test('pictures composed through the picture kit author without measured review warnings', { timeout: 240_000 }, async (t) => {
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
