// BRIEF
// subject/audience/action: 재영님과 Mixdog 팀에게 SlidesGen-Bench(EMNLP 2026) 결과를 브리핑하고, Mixdog PPT가 겨냥할 자리(편집 가능한 L4에서 미학을 올린다)를 합의한다
// reading mode: balanced · argument mode: pyramid
// directions: A editorial, hue 222, serif, 세로 룰에 걸린 설명과 보색 액센트 — 표와 도표가 논거인 브리핑 · B swiss-minimal 구도, hue 222, serif, 왼쪽 삼분의 일 어두운 평면이 주장을 들고 도표가 나머지를 채운다 · selected: B · why: 트라이얼 렌더에서 도표 존재감 0.36 대 0.20, 평면 위 주장이 썸네일에서도 읽힌다; 팔레트는 표지 사진의 코랄 마크와 같은 보색 액센트를 유지
// style: swiss-minimal · palette: hue 222 · accent hue 12 · accent: (palette) · type: MODE balanced → body 18 · script: ko · pairing: serif · fonts: noto
// motif: 왼쪽 삼분의 일의 어두운 평면 또는 사진 — 표지(사진과 스크림), V-E 페이지(어두운 평면), 클로징(그라디언트 필드와 물러난 사진) · rhythm: anchor, breathing, dense, dense, dense, dense, dense, dense, anchor
// sources: refs/slidesgen-bench/README.md
// facts: F1 미학 총점 Skywork-Banana 27.28 Kimi-Banana 26.58 NotebookLM 22.82 Zhipu 22.06 Skywork 20.69 Kimi-Standard 19.25 Kimi-Smart 18.30 Gamma 17.09 Quark 16.86 PPTAgent 15.32 AutoPresent 12.63 — README.md line 207-217
//   · F2 Zhipu 내용 정답률 전체 평균 88.29% — README.md line 201
//   · F3 내용 정답률 High Low Zhipu 84.07 92.00 Kimi-Banana 83.33 91.58 Skywork 80.00 82.58 Skywork-Banana 79.67 88.00 NotebookLM 69.81 86.00 Gamma 67.26 75.56 PPTAgent 58.94 66.76 — README.md line 188-198
//   · F4 사람 일치 스피어만 평균 SlidesGen-Bench 0.71 LLM Rating 0.57 LLM Arena 0.52 PPTAgent PPT-Eval 0.53 Humans 0.85 — README.md line 225-229
//   · F5 PEI L5 PPTAgent L4 AutoPresent L3 Quark L2 Gamma Skywork Kimi-Standard Kimi-Smart Zhipu L1 Kimi-Banana Skywork-Banana L0 NotebookLM — README.md line 237-242
//   · F6 Q1 상단 오른쪽 사분면 비어 있음 — README.md line 250
//   · F7 Slides-Align1.5k 사람 순위 1,500 시스템 11 과제 189 범주 7 — README.md line 271-281
//   · F8 미학 지표 4 Harmony Engagement Usability Visual Rhythm — README.md line 129-132
//   · F9 EMNLP 2026 Main Conference — README.md line 10
//   · F10 스피어만 표준편차 SlidesGen-Bench 0.16 LLM Rating 0.23 — README.md line 225-226
//   · F11 본문 대비 4.5:1 WCAG AA — direction.md §5 (Mixdog 킷 규칙, user brief)
//   · F12 QuizBank 문서당 10 문항 — README.md line 98
//   · F13 Mixdog Office 덱은 마스터와 네이티브 차트, 표를 쓰므로 L3–L4로 본다 (자체 판단, 벤치 미측정) — pptx 스킬 kit.md §1 (masters), charts.md §1 (native charts)
// slide plan: 1 job: cover · relationship: none · move: 벤치가 무엇을 재는지 한 줄로 받는다 · composition: 생성 사진 전면, 왼쪽 스크림 위에 세로 룰과 제목 · carriers: picture, statement · texture: keywords · rhythm: anchor
//   · 2 job: claim · relationship: none · move: 결론을 먼저 받는다 · composition: 세로 룰에 걸린 한 문장, 강조 런 하나, 아래는 비움 · carriers: statement · texture: prose · rhythm: breathing
//   · 3 job: evidence · relationship: contrast · move: 빈 사분면(Q1)을 본다 · composition: 왼쪽 어두운 평면에 주장과 히어로 0, 오른쪽 두 축 필드에 11개 노드와 Q1 틴트 · carriers: diagram, hero, statement · texture: prose · rhythm: dense
//   · 4 job: evidence · relationship: contrast · move: 미학 순위와 그 대가(편집성 L1)를 본다 · composition: 가로 막대 11개가 왼쪽 척추, 1위만 액센트, 오른쪽 룰에 히어로와 설명 · carriers: chart, hero · texture: prose · rhythm: dense
//   · 5 job: evidence · relationship: contrast · move: 어려운 자료에서 내용이 빠지는 폭을 본다 · composition: 덤벨 7행이 왼쪽, 오른쪽 룰에 히어로 88.29%와 설명 · carriers: diagram, hero · texture: prose · rhythm: dense
//   · 6 job: comparison · relationship: membership · move: 편집성 사다리에서 상용 도구의 위치를 본다 · composition: 네이티브 표 6행, L2 행 강조, 아래 테이크어웨이에 Mixdog의 자체 판단 · carriers: table · texture: keywords · rhythm: dense
//   · 7 job: evidence · relationship: contrast · move: 계산 지표를 믿어도 되는 이유를 본다 · composition: 세로 막대 5개, 첫 막대 액센트, 사람 막대에 리더 주석, 오른쪽 룰에 설명 · carriers: chart, prose · texture: prose · rhythm: dense
//   · 8 job: structure · relationship: membership · move: 네 미학 지표에 Mixdog의 지렛대를 하나씩 붙인다 · composition: 아이콘 행 4칸, 아래 테이크어웨이 · carriers: icon, list · texture: list · rhythm: dense
//   · 9 job: closing · relationship: none · move: 다음 측정을 우리 덱으로 하자는 요청을 받는다 · composition: 그라디언트 필드, 오른쪽에 물러난 표지 사진, 왼쪽 세로 룰과 요청 한 줄 · carriers: statement, picture · texture: keywords · rhythm: anchor
deck({ hue: 222, mode: 'balanced', script: 'ko', pairing: 'serif', fonts: 'noto' });
const COVER = 'C:/Project/mixdog/deliverables/pptx-frontier-round/cover.png';
const AES = [['Skywork-Banana', 27.28], ['Kimi-Banana', 26.58], ['NotebookLM', 22.82], ['Zhipu', 22.06], ['Skywork', 20.69], ['Kimi-Standard', 19.25], ['Kimi-Smart', 18.30], ['Gamma', 17.09], ['Quark', 16.86], ['PPTAgent*', 15.32], ['AutoPresent*', 12.63]];
const PEI = { 'Skywork-Banana': 1, 'Kimi-Banana': 1, 'NotebookLM': 0, 'Zhipu': 2, 'Skywork': 2, 'Kimi-Standard': 2, 'Kimi-Smart': 2, 'Gamma': 2, 'Quark': 3, 'PPTAgent*': 5, 'AutoPresent*': 4 };
const PLACE = { 'Skywork-Banana': 'b', 'Kimi-Banana': 'a', 'NotebookLM': 'r', 'Zhipu': 'r', 'Skywork': 'ar', 'Kimi-Standard': 'b', 'Kimi-Smart': 'a', 'Gamma': 'b', 'Quark': 'l', 'PPTAgent*': 'r', 'AutoPresent*': 'r' };   // ar: above, left-registered — clears the dashed divider just left of the node
const CONTENT = [['Zhipu', 84.07, 92.00], ['Kimi-Banana', 83.33, 91.58], ['Skywork', 80.00, 82.58], ['Skywork-Banana', 79.67, 88.00], ['NotebookLM', 69.81, 86.00], ['Gamma', 67.26, 75.56], ['PPTAgent*', 58.94, 66.76]];
const SOURCE = '출처: SlidesGen-Bench README (refs/slidesgen-bench), 결과 표';
// The V-E field: aesthetics total on x, PEI level on y, one node per system; Q1 (upper right) tinted and empty.
function veField(s, F) {
  const xAt = (v) => F.x + 0.5 + (v - 12) / 16 * (F.w - 1.0);
  const yAt = (L) => F.y + 0.2 + (F.h - 0.65) * (1 - L / 5);
  const qx = xAt(20), qy = yAt(5) - 0.18, qw = F.x + F.w - qx, qh = yAt(3) - qy + 0.18;
  field(s, qx, qy, qw, qh, T.tint);
  text(s, 'Q1 — 비어 있는 사분면', qx + 0.15, qy + 0.1, qw - 0.3, 'label', { color: T.accent });
  for (let L = 0; L <= 5; L += 1) { hairline(s, F.x + 0.5, yAt(L), F.w - 0.5, T.line); text(s, `L${L}`, F.x, yAt(L) - 0.15, 0.45, 'label', { color: T.muted, h: 0.3, valign: 'middle' }); }
  s.addShape(S.line, { x: qx, y: F.y + 0.05, w: 0, h: F.h - 0.45, line: { color: T.muted, width: 1, dashType: 'dash' } });
  for (const [name, aes] of AES) {
    const L = PEI[name], place = PLACE[name], cx = xAt(aes), cy = yAt(L), d = 0.2, on = L >= 3;
    s.addShape(S.ellipse, { ...box(cx - d / 2, cy - d / 2, d, d), fill: { color: on ? T.accent : T.muted }, line: { color: on ? T.accent : T.muted } });
    const lw = textW(name, DIAG.note, T.sans, true) + 0.1, lh = 0.24;
    const at = place === 'r' ? [cx + 0.16, cy - lh / 2, 'left'] : place === 'l' ? [cx - 0.16 - lw, cy - lh / 2, 'right'] : place === 'a' ? [cx - lw / 2, cy - 0.16 - lh, 'center'] : place === 'ar' ? [cx - 0.06, cy - 0.16 - lh, 'left'] : [cx - lw / 2, cy + 0.16, 'center'];
    text(s, name, at[0], at[1], lw, DIAG.note, { color: T.ink, font: T.sans, bold: true, h: lh, valign: 'middle', align: at[2] });
  }
  text(s, '편집성 PEI ↑', F.x, F.y - 0.42, 2.0, 'caption', { color: T.muted, h: 0.3 });
  text(s, '미학 총점 →  12.63', F.x + 0.5, F.y + F.h - 0.3, 3, 'caption', { color: T.muted, h: 0.3 });
  text(s, '27.28', F.x + F.w - 1.0, F.y + F.h - 0.3, 1.0, 'caption', { color: T.muted, h: 0.3, align: 'right' });
}
// A content page's right column: hangs from a hairline rule, holds a hero and a measured paragraph.
function column(s, top, bottom, value, label, runs) {
  const rx = 9.3, rw = W - M - rx;
  rule(s, rx - 0.4, top, bottom - top, T.line);
  const hb = hero(s, rx, top, rw, value, label);
  emphasis(s, [runs], rx, hb + GAP.between, rw, bottom - hb - GAP.between, TYPE.body, T.body);
  return rx;
}

// 1 cover — the subject under a scrim, the claim on the dark third
{ const s = quiet();
  await picture(s, COVER, 0, 0, W, H);
  scrim(s, 0, 0, W * 0.62, H, 'left');
  kicker(s, 'SlidesGen-Bench 브리핑 · EMNLP 2026', M + 0.3, 1.95, T.onDarkAccent, 6);
  const tb = title(s, '좋은 슬라이드는\n이제 측정된다', { x: M + 0.3, y: 2.35, w: 5.9, size: TYPE.cover, color: T.onDark, maxLines: 2 });
  rule(s, M, 2.4, tb - 2.4 - 0.1, T.accent, 3);
  text(s, 'AI 프레젠테이션 11개 시스템을 내용, 미학, 편집성 세 축으로 채점한 결과와 Mixdog가 겨냥할 자리', M + 0.3, tb + GAP.between, 5.4, 'lead', { color: T.onDarkMuted });
  text(s, '재영님 · Mixdog Office · 2026년 9월', M + 0.3, H - 1.0, 6, 'caption', { color: T.onDarkMuted, font: T.data });
  s.addNotes('표지 사진은 생성 이미지입니다 — 레인 openai-oauth, 모델 gpt-5.6-sol. 프롬프트 요지: 어두운 편집 스튜디오 탁자 위 부채꼴로 펼친 빈 프레젠테이션 카드(흰색과 남색), 창빛에 든 맨 위 카드에 코랄 사각 마크 하나, 왼쪽 삼분의 일은 비워 둠, 글자 없음.'); }

// 2 claim — one sentence on a rule, air around it; the rule is exactly the sentence's height, the break is the author's
{ const s = light();
  const claim = '미학 상위는 편집이 안 되고, 편집 가능한 쪽은 미학이 낮다.\n두 축을 동시에 잡은 시스템은 열한 개 중 하나도 없다.';
  const ch = fitH(claim, 9.6, TYPE.section, T.sans, { lh: 1.3 }), top = (H - ch) / 2 - 0.25;
  kicker(s, '결론', M, top - 0.5);
  rule(s, M, top, ch, T.accent, 3);
  emphasis(s, [[['미학 상위는 편집이 안 되고, ', {}], ['편집 가능한 쪽은 미학이 낮다', { bold: true, color: T.accent }], ['.\n두 축을 동시에 잡은 시스템은 열한 개 중 하나도 없다.', {}]]], M + 0.45, top, 9.6, ch + 0.2, TYPE.section, T.ink, { lh: 1.3 });
  caption(s, '— SlidesGen-Bench V-E 매트릭스: 상단 오른쪽 사분면(Q1)이 비어 있다', M + 0.45, top + ch + GAP.between, 9); }

// 3 evidence — the V-E matrix: dark plane holds the claim, the field holds the systems
{ const s = light(); const pw = 4.3, cw = pw - M - 0.3;
  field(s, 0, 0, pw, H, T.dark);
  kicker(s, '미학 × 편집성', M, 1.0, T.onDarkAccent, cw);
  const tb = title(s, '미학 상위는\n편집이 안 되고,\n편집 가능한 쪽은\n미학이 낮다', { x: M, y: 1.45, w: cw, size: TYPE.section, color: T.onDark, maxLines: 4 });   // a four-line stanza: one clause per line in the narrow plane
  const hb = hero(s, M, tb + GAP.between, cw, '0', 'Q1에 든 시스템 (11개 중)', { color: T.onDarkAccent, labelColor: T.onDarkMuted });
  text(s, 'Mixdog의 목표 위치는 L4 행의 오른쪽 절반이다.', M, hb + GAP.between, cw, 'strong', { color: T.onDark });
  veField(s, { x: pw + 0.5, y: 1.2, w: W - pw - 0.5 - M, h: H - 1.8 });
  s.addNotes('세로 점선(총점 20)은 이 덱이 그은 구분선이다. 원문은 상단 오른쪽 사분면(Q1)이 비어 있다고만 말한다. 좌표는 README의 Aesthetics 표와 PEI 표에서 옮겼다.'); }

// 4 evidence — aesthetics totals, one accent bar, the cost on the right
{ const s = light(); const top = head(s, '미학', '미학 점수는 이미지 생성형이 앞선다'), bottom = Z.foot.source - 0.35;
  const order = [...AES].reverse();   // a horizontal bar chart lists its first category at the bottom
  chart(s, M, top, 8.2, bottom - top, { type: 'bar', labels: order.map((r) => r[0]), series: [{ name: '미학 총점', values: order.map((r) => r[1]) }], accent: order.length - 1, format: '0.00', max: 30 });
  column(s, top, bottom, '27.28', 'Skywork-Banana 미학 총점 (네 지표 합)', [['1위와 2위는 모두 이미지 생성형(Banana) — 슬라이드가 그림 한 장이라 편집성은 ', {}], ['L1', { bold: true, color: T.accent }], ['이다. 템플릿형 Gamma와 Quark는 하위권.', {}]]);
  source(s, SOURCE + ', Aesthetics (Usability, Engagement, Harmony, Rhythm 합)'); }

// 5 evidence — content retention on hard vs easy material, one dumbbell per system
{ const s = light(); const top = head(s, '내용', '내용 보존은 Zhipu가 가장 높다'), bottom = Z.foot.source - 0.35;
  const dot = (x, y, color) => s.addShape(S.ellipse, { ...box(x, y, 0.18, 0.18), fill: { color }, line: { color } });
  dot(M, top + 0.06, T.muted); text(s, '어려운 자료 (High)', M + 0.28, top, 2.2, 'caption', { h: 0.3, valign: 'middle' });
  dot(M + 2.5, top + 0.06, T.accent); text(s, '쉬운 자료 (Low)', M + 2.78, top, 2.2, 'caption', { h: 0.3, valign: 'middle' });
  dumbbell(s, M, top + 0.55, 8.2, CONTENT.map(([label, a, b]) => ({ label, a, b })), { min: 50, max: 95, labelW: 1.9, rowH: 0.52, format: (v) => v.toFixed(2) });
  column(s, top, bottom, '88.29%', 'Zhipu 전체 평균 정답률', [['원문에서 낸 QuizBank 10 문항으로 슬라이드만 보고 답한 정답률. 코드 생성형 ', {}], ['Zhipu', { bold: true, color: T.accent }], ['가 가장 높고, 모든 시스템이 어려운 자료에서 더 잃는다.', {}]]);
  source(s, SOURCE + ', QuizBank Accuracy (High, Low 열)'); }

// 6 comparison — the PEI ladder as a native table, our own position under it
{ const s = light(); const top = head(s, '편집성', '상용 도구 대부분은 L2에서 멈춘다');
  const b = table(s, M, top, W - 2 * M, ['레벨', '이름', '기술 특징', '시스템'], [
    ['L5', 'Cinematic', '애니메이션 논리, 네이티브 미디어 임베드', 'PPTAgent*'],
    ['L4', 'Parametric', '네이티브 데이터 객체 (차트, SmartArt)', 'AutoPresent*'],
    ['L3', 'Structural', '전역 마스터, 논리적 그룹', 'Quark'],
    ['L2', 'Vector', 'SVG 경로, 벡터 도형', 'Gamma, Skywork, Kimi Standard, Kimi Smart, Zhipu'],
    ['L1', 'Patchwork', '편집 가능한 텍스트, 래스터 배경', 'Kimi Banana, Skywork Banana'],
    ['L0', 'Static', '픽셀로 평탄화', 'NotebookLM'],
  ], { colW: [1.0, 1.7, 4.4, 5.03], rowH: 0.44, size: DIAG.label, highlightRows: [3], alignments: ['center', 'left', 'left', 'left'] });
  caption(s, SOURCE + ', PEI Levels 표. 별표(*)는 학술 프레임워크', M, b + GAP.within, 11);
  takeaway(s, 'Mixdog Office 덱은 마스터와 네이티브 차트, 표를 쓴다 — L3–L4로 본다 (자체 판단, 벤치 미측정).');
  s.addNotes('Mixdog의 L3–L4는 자체 판단이다: 마스터(L3)와 네이티브 차트와 표(L4)를 쓰지만 SlidesGen-Bench로 측정하지는 않았다.'); }

// 7 evidence — human alignment: computed metrics vs LLM judges, the human ceiling annotated
{ const s = light(); const top = head(s, '평가 신뢰도', '계산 지표가 LLM 심사보다 사람에 가깝다'), bottom = Z.foot.source - 0.35;
  chart(s, M, top, 8.2, bottom - top, { type: 'col', labels: ['SlidesGen-Bench', 'LLM 채점', 'LLM 아레나', 'PPTAgent (PPT-Eval)', '사람'], series: [{ name: '스피어만 평균', values: [0.71, 0.57, 0.52, 0.53, 0.85] }], accent: 0, format: '0.00', note: { at: 4, text: '사람 간 일치 — 상한' } });
  const rx = 9.3, rw = W - M - rx; rule(s, rx - 0.4, top, bottom - top, T.line);
  emphasis(s, [[['Slides-Align1.5k — 사람이 매긴 순위 1,500개, 시스템 11개, 과제 189개, 범주 7개.', {}]], [['스피어만 평균 ', {}], ['0.71', { bold: true, color: T.accent }], ['은 LLM 채점 0.57보다 높고, 표준편차 0.16으로 가장 안정적이다. 네 미학 지표는 사람이 고른 순위를 따라간다.', {}]]], rx, top, rw, bottom - top, TYPE.body, T.body);
  source(s, SOURCE + ', Human Alignment 표'); }

// 8 structure — the four aesthetics metrics, each with the lever this round put in the kit
{ const s = light(); const top = head(s, 'Mixdog가 겨냥할 자리', '편집 가능한 L4에서 미학을 올린다');
  await iconRow(s, M, top + 0.5, W - 2 * M, [   // the kit wraps Hangul by the eojeol: no loanword split, no one-syllable last line
    { icon: 'palette', label: '조화 Harmony', detail: '한 hue의 중립 사다리에 보색 액센트 하나, 채도는 액센트에만 둔다' },
    { icon: 'sparkles', label: '참여 Engagement', detail: '사진과 그라디언트 필드, 캔버스 사분의 일 이상을 차지하는 주 캐리어' },
    { icon: 'eye', label: '가독성 Usability', detail: '본문 대비 4.5:1을 저장 전에 재고, 렌더로 다시 읽는다' },
    { icon: 'waves', label: '리듬 Visual Rhythm', detail: 'anchor, dense, breathing 순서로 페이지의 밀도를 바꾼다' },
  ], { d: 0.9, label: 'strong', detail: 'body' });
  takeaway(s, '네 지표 모두 이번 라운드의 킷 변경(프렐류드, 보색 팔레트, 그라디언트, 사진 기본값)이 직접 닿는다.'); }

// 9 closing — the field echoes the cover; the picture recedes on the right
{ const s = quiet();
  gradient(s, 0, 0, W, H, [[0, T.dark], [100, T.darkAlt]], 35);
  await picture(s, COVER, 8.6, 0, W - 8.6, H, { transparency: 45 });
  scrim(s, 8.6, 0, 2.6, H, 'left');
  kicker(s, '요청', M + 0.3, 2.0, T.onDarkAccent, 6);
  const tb = title(s, '다음 측정은\n우리 덱으로', { x: M + 0.3, y: 2.4, w: 7, size: TYPE.cover, color: T.onDark, maxLines: 2 });
  rule(s, M, 2.45, tb - 2.45 - 0.1, T.accent, 3);
  text(s, 'SlidesGen-Bench의\naesthetics_metrics.py에 Mixdog 덱을 넣어\n조화, 참여, 가독성, 리듬 네 지표를 받는다.', M + 0.3, tb + GAP.between, 7.2, 'lead', { color: T.onDarkAccent, font: T.sans, bold: true });   // three balanced lines; the file name owns the second
  text(s, '재영님 · Mixdog Office · 2026년 9월', M + 0.3, H - 1.0, 6, 'caption', { color: T.onDarkMuted, font: T.data }); }
await pres.writeFile({ fileName: OUTPUT });
