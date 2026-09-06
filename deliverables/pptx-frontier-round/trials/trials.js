// BRIEF (direction trial: the V-E matrix page in two directions)
// subject/audience/action: 재영님과 Mixdog 팀에게 SlidesGen-Bench 결과를 브리핑하고 Mixdog PPT가 겨냥할 자리를 정한다
// reading mode: balanced · argument mode: pyramid
// directions: A editorial, hue 222, serif, 세로 룰과 보색 액센트 — 표와 도표가 논거인 브리핑 · B swiss-minimal, hue 215 단일 hue, concord, 왼쪽 삼분의 일 어두운 평면 — 주장 한 문장이 페이지를 구획 · selected: (trial) · why: 렌더 비교 후 결정
// style: editorial · palette: hue 222 · accent hue 12 · type: MODE balanced → body 18 · script: ko · pairing: serif · fonts: noto
// facts: F1 Skywork-Banana 27.28 Kimi-Banana 26.58 NotebookLM 22.82 Zhipu 22.06 Skywork 20.69 Kimi-Standard 19.25 Kimi-Smart 18.30 Gamma 17.09 Quark 16.86 PPTAgent 15.32 AutoPresent 12.63 — README.md line 207-217
//   · F5 PEI L5 PPTAgent L4 AutoPresent L3 Quark L2 Gamma Skywork Kimi-Standard Kimi-Smart Zhipu L1 Kimi-Banana Skywork-Banana L0 NotebookLM — README.md line 237-242
//   · F6 Q1 비어 있음 — README.md line 250 · F7 1,500 순위 11 시스템 189 과제 7 범주 — README.md line 271-281
// slide plan: 1 job: evidence · relationship: contrast · move: 빈 사분면을 본다 · composition: 두 축 필드, 11개 노드, Q1 틴트 (A) · carriers: diagram, prose · texture: prose · rhythm: dense
//   · 2 job: evidence · relationship: contrast · move: 빈 사분면을 본다 · composition: 왼쪽 어두운 평면에 주장, 오른쪽 두 축 필드 (B) · carriers: diagram, statement · texture: prose · rhythm: dense
deck({ hue: 222, mode: 'balanced', script: 'ko', pairing: 'serif', fonts: 'noto', titleLines: 2 });
const SYSTEMS = [['Skywork-Banana', 27.28, 1, 'b'], ['Kimi-Banana', 26.58, 1, 'a'], ['NotebookLM', 22.82, 0, 'r'], ['Zhipu', 22.06, 2, 'r'], ['Skywork', 20.69, 2, 'a'],
  ['Kimi-Standard', 19.25, 2, 'b'], ['Kimi-Smart', 18.30, 2, 'a'], ['Gamma', 17.09, 2, 'b'], ['Quark', 16.86, 3, 'r'], ['PPTAgent*', 15.32, 5, 'r'], ['AutoPresent*', 12.63, 4, 'r']];
function veField(s, F, { dark = false } = {}) {
  const ink = dark ? T.onDark : T.ink, mute = dark ? T.onDarkMuted : T.muted, line = dark ? T.darkAlt : T.line;
  const xAt = (v) => F.x + 0.5 + (v - 12) / 16 * (F.w - 1.0);
  const yAt = (L) => F.y + 0.2 + (F.h - 0.65) * (1 - L / 5);
  // Q1: the upper-right quadrant — the range midpoint (20) is this deck's divider, the source names the quadrant only.
  const qx = xAt(20), qy = yAt(5) - 0.18, qw = F.x + F.w - qx, qh = yAt(3) - qy + 0.18;
  field(s, qx, qy, qw, qh, dark ? T.darkAlt : T.tint);
  text(s, 'Q1 — 비어 있는 사분면', qx + 0.15, qy + 0.1, qw - 0.3, 'label', { color: T.accent });
  for (let L = 0; L <= 5; L += 1) { hairline(s, F.x + 0.5, yAt(L), F.w - 0.5, line); text(s, `L${L}`, F.x, yAt(L) - 0.15, 0.45, 'label', { color: mute, h: 0.3, valign: 'middle' }); }
  s.addShape(S.line, { x: qx, y: F.y + 0.05, w: 0, h: F.h - 0.45, line: { color: mute, width: 1, dashType: 'dash' } });
  for (const [name, aes, L, place] of SYSTEMS) {
    const cx = xAt(aes), cy = yAt(L), d = 0.2;
    s.addShape(S.ellipse, { ...box(cx - d / 2, cy - d / 2, d, d), fill: { color: L >= 3 ? T.accent : mute }, line: { color: L >= 3 ? T.accent : mute } });
    const lw = textW(name, DIAG.note, T.sans, true) + 0.1, lh = 0.24;
    const at = place === 'r' ? [cx + 0.16, cy - lh / 2, 'left'] : place === 'l' ? [cx - 0.16 - lw, cy - lh / 2, 'right'] : place === 'a' ? [cx - lw / 2, cy - 0.16 - lh, 'center'] : [cx - lw / 2, cy + 0.16, 'center'];
    text(s, name, at[0], at[1], lw, DIAG.note, { color: ink, font: T.sans, bold: true, h: lh, valign: 'middle', align: at[2] });
  }
  text(s, '미학 총점 →  12.63', F.x + 0.5, F.y + F.h - 0.3, 3, 'caption', { color: mute, h: 0.3 });
  text(s, '27.28', F.x + F.w - 1.0, F.y + F.h - 0.3, 1.0, 'caption', { color: mute, h: 0.3, align: 'right' });
  text(s, '편집성 PEI ↑', F.x, F.y - 0.1, 1.6, 'caption', { color: mute, h: 0.3 });
}
// A — editorial: field left, explanation hangs from a vertical rule on the right
{ const s = light(); const top = head(s, '미학 × 편집성', '미학 상위는 편집이 안 되고, 편집 가능한 쪽은 미학이 낮다');
  veField(s, { x: M, y: top + 0.35, w: 8.0, h: Z.body.bottom - top - 0.35 });
  const rx = 9.2; rule(s, rx - 0.35, top, Z.body.bottom - top, T.line);
  const hb = hero(s, rx, top, W - M - rx, '0', 'Q1에 든 시스템 (11개 중)');
  emphasis(s, [[['미학 1·2위는 그림 한 장짜리 L1, 편집 가능한 L4–L5는 학술 프레임워크뿐이다. ', {}], ['Mixdog의 목표는 L4 행의 오른쪽 절반.', { bold: true, color: T.accent }]]], rx, hb + GAP.between, W - M - rx, Z.body.bottom - hb - GAP.between, TYPE.body, T.body); }
// B — swiss-minimal: one dark plane on the left third carries the claim, the field takes the rest
{ Object.assign(T, palette({ hue: 215, accentHue: 215 })); const s = light(); const pw = 4.3;
  field(s, 0, 0, pw, H, T.dark);
  kicker(s, '미학 × 편집성', M, 1.0, T.onDarkAccent);
  const tb = title(s, '미학 상위는 편집이 안 되고, 편집 가능한 쪽은 미학이 낮다', { x: M, y: 1.45, w: pw - M - 0.3, size: TYPE.section + 4, color: T.onDark, maxLines: 4 });
  text(s, '두 축을 동시에 잡은 시스템은 열한 개 중 하나도 없다. Mixdog의 목표 위치는 L4 행의 오른쪽 절반이다.', M, tb + GAP.between, pw - M - 0.3, 'body', { color: T.onDarkMuted });
  veField(s, { x: pw + 0.5, y: 1.0, w: W - pw - 0.5 - M, h: H - 1.6 }); }
await pres.writeFile({ fileName: OUTPUT });
