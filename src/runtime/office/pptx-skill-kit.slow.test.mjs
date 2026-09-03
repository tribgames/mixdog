// The pptx skill's device kit and skeleton catalog must author cleanly through
// the runtime: every helper compiles, the package validates, and the design
// review raises no warning against a deck built the way the skill teaches.
// Each round of skill work so far surfaced kit↔review misalignments only when
// a real deck was authored; this test authors one deck per skeleton family.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeOfficeTool } from './index.mjs';

const SKILL = fileURLToPath(new URL('../../defaults/skills/pptx/references/', import.meta.url));

async function kitBlocks(file) {
  const text = await readFile(join(SKILL, file), 'utf8');
  return [...text.matchAll(/```js\n([\s\S]*?)```/g)].map((match) => match[1]).join('\n');
}

const value = (result) => JSON.parse(result.content[0].text);

// One content slide per skeleton id, each through its archetype with content only.
const ARCHETYPES = `
cover({ kicker: 'Kit regression', title: 'Every archetype\\nthrough the runtime', subtitle: 'Content in, measured geometry out', meta: 'Mixdog · regression', ghost: '01' });
S1({ kicker: 'S1', claim: [[['A single claim with ', {}], ['one emphasised figure', { bold: true, color: T.accent }], [' and enough air around it to read as a statement.', {}]]], attribution: '— attribution line' });
S2({ kicker: 'S2', value: '42', unit: '%', label: 'percent of decks reviewed', explanation: 'The explanation sits beside the number at sixteen points and stays under four lines of measured text.' });
S3({ quote: 'A pull quote crossing the column at thirty points, measured so it never overflows.', attribution: 'Attribution, fourteen points' });
S5({ number: '02', kicker: 'S5', claim: 'Chapter mark behind the claim' });
E1({ kicker: 'E1', title: 'Chart as spine', chart: { labels: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'Revenue', values: [12, 18, 24, 31] }], accent: 3 }, hero: { value: '31', label: 'Q4 revenue, mm' }, note: 'The note under the hero explains what moved.', takeaway: 'The takeaway closes the page under the chart.' });
E2({ kicker: 'E2', title: 'Chart with side rail', chart: { type: 'line', labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May'], series: [{ name: 'Active', values: [3, 5, 4, 8, 9] }, { name: 'Churned', values: [1, 1, 2, 1, 1] }] }, rail: { lead: 'Lead sentence in bold', bullets: ['First supporting point for the chart', 'Second supporting point', 'Third point'] } });
E3({ kicker: 'E3', title: 'Small multiples', panels: [{ title: 'North', labels: ['a', 'b', 'c'], series: [{ name: 'n', values: [4, 6, 9] }] }, { title: 'South', labels: ['a', 'b', 'c'], series: [{ name: 's', values: [3, 3, 4] }] }, { title: 'West', labels: ['a', 'b', 'c'], series: [{ name: 'w', values: [8, 7, 9] }], accent: 2 }], comparison: 'Same shape, different size: West leads on every step.' });
E4({ kicker: 'E4', title: 'Stat band', stats: [{ value: '12', label: 'label one', context: 'Context under the first number.' }, { value: '48', label: 'label two', context: 'Context under the second.' }, { value: '3.5', label: 'label three', context: 'Context under the third.' }, { value: '97', unit: '%', label: 'label four', context: 'Context under the fourth.' }], takeaway: 'Four numbers, one cause.' });
E5({ kicker: 'E5', title: 'Table with verdict', columns: ['Option', 'Cost', 'Verdict'], rows: [['Build', 'High', 'Defer'], ['Buy', 'Medium', 'Go'], ['Partner', 'Low', 'Pilot']], highlight: 'Go', source: 'Source: internal estimate' });
E7({ kicker: 'E7', title: 'Gauge', share: 0.72, value: '72%', label: 'share', meaning: [[['Nearly ', {}], ['three in four', { bold: true, color: T.accent }], [' decks pass the gate on the first render.', {}]]] });
E8({ title: 'Specimen: the subject drawn', rows: [{ text: 'Weight ladder light', font: T.light, size: 28, label: 'light' }, { text: 'Weight ladder regular', font: T.sans, size: 28, label: 'regular' }, { text: 'Weight ladder bold', font: T.sans, size: 28, bold: true, label: 'bold' }, { text: 'Fifteen point body line', size: 15, label: '15 pt' }, { text: 'Twenty-four point body line', size: 24, label: '24 pt' }], claim: 'The specimen is the content; the claim beside it says what to see, not what the specimen is.' });
R1({ kicker: 'R1', title: 'Chevron run', stages: [{ label: 'Brief', detail: 'Write the plan with the relationship atom named.' }, { label: 'Script', detail: 'One script built on the kit.' }, { label: 'Render', detail: 'Every slide rendered.' }, { label: 'Review', detail: 'Fix in the script, never the file.' }, { label: 'Finalize', detail: 'Validate the package.' }], active: 3, takeaway: 'The active stage is the one this deck is about.' });
R2({ kicker: 'R2', title: 'Timeline', events: [{ x: 1.5, label: 'Kickoff', detail: 'Detail for this milestone.' }, { x: 4.2, label: 'Alpha', detail: 'What changed here.' }, { x: 8.9, label: 'Beta', detail: 'What changed here.' }, { x: 11.8, label: 'Launch', detail: 'The present.' }], note: 'Milestones sit at their real dates; the present is the accent node.' });
R3({ kicker: 'R3', title: 'Stepped process', lead: 'Four steps rising to the accent.', items: [['Collect', 'inputs'], ['Shape', 'the brief'], ['Author', 'the script'], ['Review', 'renders']] });
R5({ kicker: 'R5', title: 'Cycle', labels: ['Plan', 'Do', 'Check', 'Act'], active: 2, center: { lead: 'Check', note: 'closes the loop' } });
R6({ kicker: 'R6', title: 'Hub and spokes', hub: { label: 'Hub', note: 'entry' }, spokes: [{ label: 'A', deg: -150, note: 'first spoke' }, { label: 'B', deg: -30, note: 'second spoke' }, { label: 'C', deg: 30, note: 'third spoke' }, { label: 'D', deg: 150, note: 'fourth spoke' }, { label: 'rt', deg: 90, note: 'runtime, dashed', dashed: true }], note: 'Dashed satellite is not a document.' });
R7({ kicker: 'R7', title: 'Merge', sources: ['Source 1', 'Source 2', 'Source 3'], target: 'Target' });
R11({ kicker: 'R11', title: 'Brace groups', groups: [{ name: 'craft', file: 'design.md', items: ['Judgement rules', 'Palette and type'] }, { name: 'contract', file: 'SKILL.md', items: ['Brief format', 'QA gate'] }, { name: 'tool doc', items: ['Skeleton geometry', 'Helper code', 'Picture modifiers'] }], aside: { value: '3', label: 'kinds of document', note: 'One rule, one home; a rule in two files is the failure.' } });
R12({ kicker: 'R12', title: 'Two planes', left: { label: 'Before', bullets: ['Manual review of every render', 'Fixes in the file'] }, right: { label: 'After', bullets: ['Runtime review with role inference', 'Fixes in the script'] }, takeaway: 'One difference marker only, on the side that changed.' });
R13({ kicker: 'R13', title: '2×2 field', axes: { x: 'effort', y: 'impact' }, items: [{ label: 'Quick win', x: M + 0.4, y: 2.4 }, { label: 'Strategic', x: M + 5.0, y: 2.4 }, { label: 'Fill-in', x: M + 0.4, y: 5.0 }, { label: 'Avoid', x: M + 5.0, y: 5.0 }] });
R14({ kicker: 'R14', title: 'Tiered stack', tiers: ['Vision', 'Strategy', 'Programs', 'Tasks'], aside: { lead: 'Upper tiers decide before lower tiers act.', bullets: ['Vision names the end state', 'Strategy chooses the path', 'Programs and tasks execute'] } });
R15({ kicker: 'R15', title: 'Overlapping sets', labels: ['Design', 'Runtime'], shared: 'review', note: 'The shared region is where both own the rule.' });
closing({ title: 'The ask, in one line', ask: 'Approve the next round.', meta: 'Mixdog · regression', ghost: '02' });
await pres.writeFile({ fileName: OUTPUT });
`;

// Free-form kit calls that no archetype covers (kept as the kit's own smoke).
const SKELETONS = `
{ const s = anchor(); ghost(s, '01', 7.6, 1.0, 240, 5.2); kicker(s, 'Kit regression', M, 2.15, T.onDarkAccent); title(s, 'Every skeleton\\nthrough the runtime', { y: 2.55, w: 8.2, size: 44, color: 'FFFFFF' }); }
{ const s = content(); kicker(s, 'S1'); emphasis(s, [[['A single claim with ', {}], ['one emphasised figure', { bold: true, color: T.accent }], [' and enough air around it to read as a statement.', {}]]], M, 2.4, 10, 2.2, 28, T.ink); s.addText('— attribution line', { ...box(M, 5.0, 6, 0.4), fontFace: T.sans, fontSize: 13, color: T.muted, margin: 0 }); }
{ const s = content(); kicker(s, 'S2'); hero(s, M, 2.2, 5, '42', 'percent of decks reviewed', { size: 96, unit: '%' }); prose(s, 'The explanation sits beside the number at eighteen points and stays under three lines.', 7.2, 2.6, 5.5, 1.6, 18); }
{ const s = breathing(); s.addText('“', { ...box(M - 0.1, 1.0, 1.6, 2.1), fontFace: T.data, fontSize: 120, bold: true, color: T.onDarkAccent, margin: 0 }); s.addText('A pull quote crossing the column at thirty points.', { ...box(M + 0.9, 2.6, 10.6, 1.6), fontFace: T.display, fontSize: 30, bold: true, color: 'FFFFFF', margin: 0 }); s.addText('Attribution, thirteen points', { ...box(M + 0.9, 4.4, 8, 0.4), fontFace: T.sans, fontSize: 13, color: T.onDarkMuted, margin: 0 }); }
{ const s = anchor(); ghost(s, '02', 7.5, 1.2); kicker(s, 'S5', M, 2.15, T.onDarkAccent); title(s, 'Chapter mark behind the claim', { y: 2.6, w: 7, size: 28, color: 'FFFFFF' }); }
{ const s = content(); kicker(s, 'E1'); title(s, 'Chart as spine'); chart(s, M, 1.8, 8.2, 4.4, { labels: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'Revenue', values: [12, 18, 24, 31] }], accent: 3 }); hero(s, 9.4, 2.4, 3.3, '31', 'Q4 revenue, mm'); takeaway(s, 'The takeaway closes the page under the chart.', 6.2); }
{ const s = content(); kicker(s, 'E2'); title(s, 'Chart with side rail'); chart(s, M, 1.8, 7.6, 4.8, { type: 'line', labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May'], series: [{ name: 'Active', values: [3, 5, 4, 8, 9] }, { name: 'Churned', values: [1, 1, 2, 1, 1] }] }); field(s, 8.6, 1.8, 4.1, 4.8); s.addText('Lead sentence in bold', { ...box(8.9, 2.1, 3.5, 0.5), fontFace: T.sans, fontSize: 16, bold: true, color: T.ink, margin: 0 }); body(s, 8.9, 2.8, 3.5, 3.4, ['First supporting point for the chart', 'Second supporting point', 'Third point']); }
{ const s = content(); kicker(s, 'E3'); title(s, 'Small multiples'); smallMultiples(s, M, 2.4, W - 2 * M, 3.8, [{ title: 'North', labels: ['a', 'b', 'c'], series: [{ name: 'n', values: [4, 6, 9] }] }, { title: 'South', labels: ['a', 'b', 'c'], series: [{ name: 's', values: [3, 3, 4] }] }, { title: 'West', labels: ['a', 'b', 'c'], series: [{ name: 'w', values: [8, 7, 9] }], accent: 2 }]); s.addText('Same shape, different size: West leads on every step.', { ...box(M, 6.4, 10, 0.4), fontFace: T.sans, fontSize: 14, color: T.body, margin: 0 }); }
{ const s = content(); kicker(s, 'E4'); title(s, 'Stat band'); const step = (W - 2 * M) / 4; ['12', '48', '3.5', '97%'].forEach((v, i) => hero(s, M + i * step, 2.4, step - 0.3, v, 'label ' + (i + 1))); hairline(s, M, 4.25, W - 2 * M); ['Context under the first number.', 'Context under the second.', 'Context under the third.', 'Context under the fourth.'].forEach((t, i) => s.addText(t, { ...box(M + i * step, 4.5, step - 0.35, 1.2), fontFace: T.sans, fontSize: 13, color: T.body, margin: 0, valign: 'top' })); }
{ const s = content(); kicker(s, 'E5'); title(s, 'Table with verdict'); const head = (t) => ({ text: t, options: { bold: true, color: 'FFFFFF', fill: { color: T.accent }, fontFace: T.sans, fontSize: 13 } }); const cell = (t, i, o = {}) => ({ text: t, options: { fontFace: T.sans, fontSize: 13, color: T.body, fill: { color: i % 2 ? T.paperAlt : T.paper }, ...o } }); s.addTable([[head('Option'), head('Cost'), head('Verdict')], ...[['Build', 'High', 'Defer'], ['Buy', 'Medium', 'Go'], ['Partner', 'Low', 'Pilot']].map((r, i) => [cell(r[0], i, { bold: true, color: T.ink }), cell(r[1], i), cell(r[2], i, { bold: true, fill: { color: T.tint } })])], { x: M, y: 1.9, w: W - 2 * M, colW: [4, 4, 4.13], rowH: 0.6, border: { type: 'solid', color: T.line, pt: 0.75 }, margin: [0.06, 0.12, 0.06, 0.12], valign: 'middle' }); s.addText('Source: internal estimate', { ...box(M, 6.5, 6, 0.3), fontFace: T.sans, fontSize: 11, color: T.muted, margin: 0 }); }
{ const s = content(); kicker(s, 'E7'); title(s, 'Gauge'); gauge(s, 3.4, 4.3, 1.6, 0.72, '72%', 'share'); emphasis(s, [[['Nearly ', {}], ['three in four', { bold: true, color: T.accent }], [' decks pass the gate on the first render.', {}]]], 6.6, 3.4, 6, 1.8, 18); }
{ const s = content(); kicker(s, 'R1'); title(s, 'Chevron run'); chevrons(s, M, 2.0, W - 2 * M, 1.15, ['Brief', 'Script', 'Render', 'Review', 'Finalize'], { active: 3 }); const cw = (W - 2 * M) / 5; ['Write the plan', 'One script', 'Every slide', 'Fix in script', 'Validate'].forEach((t, i) => { s.addText(String(i + 1), { ...box(M + i * cw + 0.15, 3.4, cw - 0.45, 0.6), fontFace: T.data, fontSize: 28, bold: true, color: T.accent, margin: 0 }); s.addText(t + ' — the detail line under each stage explains what happens there and who owns it.', { ...box(M + i * cw + 0.15, 4.1, cw - 0.45, 1.8), fontFace: T.sans, fontSize: 12.5, color: T.body, margin: 0, valign: 'top' }); }); takeaway(s, 'The active stage is the one this deck is about.', 6.0); }
{ const s = content(); kicker(s, 'R2'); title(s, 'Timeline'); hairline(s, M, 3.9, W - 2 * M); [[1.5, 'Kickoff'], [4.2, 'Alpha'], [8.9, 'Beta'], [11.8, 'Launch']].forEach(([x, t], i) => { node(s, x, 3.9, 0.55, i + 1, { fill: i === 3 ? T.accent : T.muted }); s.addText(t, { ...box(x - 1, 4.4, 2, 0.4), fontFace: T.sans, fontSize: 15, bold: true, color: T.ink, align: 'center', margin: 0 }); s.addText('Detail for this milestone and what changed.', { ...box(x - 1, 4.85, 2, 1.0), fontFace: T.sans, fontSize: 12, color: T.muted, align: 'center', margin: 0, valign: 'top' }); }); s.addText('Milestones sit at their real dates; the present is the accent node.', { ...box(M, 6.2, 10, 0.4), fontFace: T.sans, fontSize: 14, color: T.body, margin: 0 }); }
{ const s = content(); kicker(s, 'R3'); title(s, 'Stepped process'); steps(s, [['Collect', 'inputs'], ['Shape', 'the brief'], ['Author', 'the script'], ['Review', 'renders']]); }
{ const s = content(); kicker(s, 'R5'); title(s, 'Cycle'); cycle(s, W / 2, 4.25, 1.9, ['Plan', 'Do', 'Check', 'Act'], { active: 2 }); }
{ const s = content(); kicker(s, 'R6'); title(s, 'Hub and spokes'); const hx = W / 2 + 0.2, hy = 4.2, hd = 1.9, sd = 1.2, r = 2.1; [['A', -150], ['B', -30], ['C', 30], ['D', 150]].forEach(([n, deg]) => { const a = deg * Math.PI / 180, cx = hx + r * Math.cos(a), cy = hy + r * Math.sin(a); connector(s, cx - Math.cos(a) * sd / 2, cy - Math.sin(a) * sd / 2, hx + Math.cos(a) * hd / 2, hy + Math.sin(a) * hd / 2, { color: T.line, arrow: 'none' }); s.addShape(S.ellipse, { ...box(cx - sd / 2, cy - sd / 2, sd, sd), fill: { color: T.paper }, line: { color: T.accent, width: 1.5 } }); s.addText(n, { ...box(cx - sd / 2, cy - sd / 2, sd, sd), fontFace: T.data, fontSize: 14, bold: true, color: T.ink, align: 'center', valign: 'middle', margin: 0 }); }); s.addShape(S.ellipse, { ...box(hx - hd / 2, hy - hd / 2, hd, hd), fill: { color: T.accent }, line: { color: T.accent } }); s.addText('Hub', { ...box(hx - hd / 2, hy - hd / 2, hd, hd), fontFace: T.data, fontSize: 16, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', margin: 0 }); }
{ const s = content(); kicker(s, 'R7'); title(s, 'Merge'); [0, 1, 2].forEach((i) => { const y = 2.2 + i * 1.2; s.addShape(S.roundRect, { ...box(M, y, 2.8, 0.9), rectRadius: 0.08, fill: { color: T.paperAlt }, line: { color: T.paperAlt } }); s.addText('Source ' + (i + 1), { ...box(M + 0.2, y, 2.4, 0.9), fontFace: T.sans, fontSize: 14, color: T.ink, valign: 'middle', margin: 0 }); connector(s, M + 2.8, y + 0.45, 8.5, 3.85, { color: T.muted }); }); s.addShape(S.roundRect, { ...box(8.5, 3.4, 3, 0.9), rectRadius: 0.08, fill: { color: T.accent }, line: { color: T.accent } }); s.addText('Target', { ...box(8.7, 3.4, 2.6, 0.9), fontFace: T.sans, fontSize: 15, bold: true, color: 'FFFFFF', valign: 'middle', margin: 0 }); }
{ const s = content(); kicker(s, 'R11'); title(s, 'Brace groups'); let y = 1.95; [['craft', ['Judgement rules', 'Palette and type']], ['contract', ['Brief format', 'QA gate']], ['tool doc', ['Skeleton geometry', 'Helper code', 'Picture modifiers']]].forEach(([name, items]) => { const h = items.length * 0.45 + 0.1; s.addText(name, { ...box(M, y, 1.7, 0.4), fontFace: T.data, fontSize: 16, bold: true, color: T.accent, align: 'right', margin: 0 }); brace(s, M + 1.85, y, h); s.addText(items.map((t, i) => ({ text: t, options: { breakLine: i < items.length - 1 } })), { ...box(M + 2.3, y, 5, h), fontFace: T.sans, fontSize: 14, color: T.body, valign: 'top', margin: 0, lineSpacingMultiple: 1.6 }); y += h + 0.5; }); }
{ const s = content(); kicker(s, 'R12'); title(s, 'Two planes'); const pw = W / 2 - M - 0.15; field(s, M, 1.9, pw, 3.5); lift(s, W / 2 + 0.15, 1.9, pw, 3.5, 'FFFFFF'); s.addText('Before', { ...box(M + 0.35, 2.1, pw - 0.7, 0.4), fontFace: T.data, fontSize: 12, bold: true, color: T.body, margin: 0 }); s.addText('After', { ...box(W / 2 + 0.5, 2.1, pw - 0.7, 0.4), fontFace: T.data, fontSize: 12, bold: true, color: T.accent, margin: 0 }); body(s, M + 0.35, 2.75, pw - 0.7, 2.4, ['Manual review of every render', 'Fixes in the file']); body(s, W / 2 + 0.5, 2.75, pw - 0.7, 2.4, ['Runtime review with role inference', 'Fixes in the script'], 14, T.ink); takeaway(s, 'One difference marker only, on the side that changed.', 5.85); }
{ const s = content(); kicker(s, 'R13'); title(s, '2×2 field'); field(s, M, 1.8, W - 2 * M, 4.8); hairline(s, M + 4.5, 1.8, 0, T.line); s.addShape(S.line, { ...box(M + 4.5, 1.8, 0, 4.8), line: { color: T.line, width: 1 } }); hairline(s, M, 4.6, W - 2 * M); [['Quick win', M + 0.4, 2.2], ['Strategic', M + 5.0, 2.2], ['Fill-in', M + 0.4, 5.0], ['Avoid', M + 5.0, 5.0]].forEach(([t, x, y]) => s.addText(t, { ...box(x, y, 3, 0.5), fontFace: T.sans, fontSize: 16, bold: true, color: T.ink, margin: 0 })); s.addText('effort →', { ...box(W - M - 2, 6.2, 1.8, 0.3), fontFace: T.sans, fontSize: 12, color: T.muted, align: 'right', margin: 0 }); }
{ const s = content(); kicker(s, 'R14'); title(s, 'Tiered stack'); tiers(s, W / 2, 2.2, ['Vision', 'Strategy', 'Programs', 'Tasks']); }
{ const s = content(); kicker(s, 'R15'); title(s, 'Overlapping sets'); sets(s, W / 2, 4.2, 3.0, ['Design', 'Runtime'], { shared: 'review' }); }
{ const s = anchor(); ghost(s, '02', 9.4, 2.4, 180, 3.4); kicker(s, 'Closing', M, 2.15, T.onDarkAccent); title(s, 'The ask, in one line', { y: 2.55, w: 9, size: 36, color: 'FFFFFF' }); s.addText('Approve the next round.', { ...box(M, 4.6, 8, 0.5), fontFace: T.sans, fontSize: 18, bold: true, color: T.onDarkAccent, margin: 0 }); }
await pres.writeFile({ fileName: OUTPUT });
`;

test('kit layout by weight: equal weights divide equally, unequal weights do not, and the seam never sits in the middle by default', async () => {
  const kit = await kitBlocks('device-kit.md');
  const source = ['weightOf', 'spans', 'splitAt'].map((name) => {
    const match = new RegExp(`(?:const ${name} = [\\s\\S]*?;\\n|function ${name}\\([\\s\\S]*?\\n\\}\\n)`).exec(kit);
    assert.ok(match, `${name} is in the kit`);
    return match[0];
  }).join('\n');
  const { spans, splitAt, weightOf } = new Function(`${source}\nreturn { spans, splitAt, weightOf };`)();
  const equal = spans(0.5, 12, [10, 10, 10]);
  assert.ok(equal.every((c) => Math.abs(c.w - equal[0].w) < 1e-9), 'equal weights → equal widths');
  assert.ok(Math.abs(equal[2].x + equal[2].w - 12.5) < 1e-9, 'the row ends at x + w');
  const unequal = spans(0.5, 12, [10, 30, 10]);
  assert.ok(unequal[1].w > unequal[0].w * 1.3, 'the heavy peer is visibly wider');
  assert.ok(unequal[0].w > 0.6 * (12 / 3), 'the light peer stays readable (clamped)');
  const seam = splitAt(0.5, 12, 40, 80);
  assert.ok(seam.left.w < seam.right.w && seam.left.w / 11.7 >= 0.38, 'the seam follows weight within the 0.38–0.62 band');
  assert.equal(splitAt(0, 10, 1, 1).left.w, splitAt(0, 10, 1, 1).right.w, 'equal weights → the middle');
  assert.ok(weightOf({ label: 'a', detail: 'long detail text' }, { active: true }) > weightOf({ label: 'a', detail: 'long detail text' }), 'active counts more');
});

test('every hard rule in the skill names a runtime code that exists, or is marked manual', async () => {
  const files = ['design.md', 'layouts.md', 'archetypes.md', 'device-kit.md', 'pictures.md'].map((file) => join(SKILL, file));
  files.push(join(SKILL, '..', 'SKILL.md'));
  const runtime = await Promise.all(['quality', 'authoring', 'portable', 'core'].map(async (dir) => {
    const base = fileURLToPath(new URL(`./${dir}/`, import.meta.url));
    const { readdir } = await import('node:fs/promises');
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
      if (!runtimeMarked && !manual && !/design\.md|SKILL\.md/.test(line)) unchecked.push(line.slice(0, 80));
      if (runtimeMarked) for (const code of codes) if (!source.includes(`'${code}'`)) unknown.push(code);
    }
  }
  assert.deepEqual(unknown, [], 'hard rules reference review codes the runtime never raises');
  assert.deepEqual(unchecked, [], 'hard rules without a runtime code or a manual mark');
});

test('pptx skill archetypes author every skeleton from content alone without review warnings', { timeout: 180_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-pptx-archetypes-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const script = `${await kitBlocks('device-kit.md')}\n${await kitBlocks('archetypes.md')}\n${ARCHETYPES}`;
  const path = join(cwd, 'archetypes.pptx');
  const authored = value(await executeOfficeTool({ action: 'author', path, script, mode: 'portable', overwrite: true, render: true }, { cwd }));
  assert.equal(authored.ok, true, `${authored.error?.message}\n${authored.error?.excerpt || ''}`);
  assert.equal(authored.render?.pageCount, 24);
  const validation = value(await executeOfficeTool({ action: 'validate', session: authored.session }, { cwd }));
  assert.equal(validation.schema?.ok, true, JSON.stringify(validation.schema?.errors?.slice(0, 3)));
  const qa = value(await executeOfficeTool({ action: 'qa', session: authored.session }, { cwd }));
  const issues = (qa.issuesAfter || qa.issues || []).map((issue) => `${issue.code} ${issue.path}: ${issue.message}`);
  assert.deepEqual(issues, []);
});

// The same archetypes at the presentation scale, in the Korean safe pairing, with the signature
// mark on every content slide: the type scale must not overflow at its largest anchor and the
// Korean faces (Malgun Gothic Semilight, Batang) must pass the font review as safe.
test('pptx skill archetypes hold at presentation scale with the Korean safe pairing', { timeout: 180_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-pptx-korean-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const kit = (await kitBlocks('device-kit.md'))
    .replace("const MODE = 'balanced';", "const MODE = 'presentation';")
    .replace("family('editorial', { korean: false })", "family('editorial', { korean: 'safe' })");
  const archetypes = (await kitBlocks('archetypes.md')).replace("let MARK = '';", "let MARK = '02 · 진단';");
  assert.match(kit, /presentation/);
  assert.match(archetypes, /진단/);
  const script = `${kit}\n${archetypes}\n${ARCHETYPES}`;
  const path = join(cwd, 'korean.pptx');
  const authored = value(await executeOfficeTool({ action: 'author', path, script, mode: 'portable', overwrite: true, render: true }, { cwd }));
  assert.equal(authored.ok, true, `${authored.error?.message}\n${authored.error?.excerpt || ''}`);
  assert.equal(authored.render?.pageCount, 24);
  const qa = value(await executeOfficeTool({ action: 'qa', session: authored.session }, { cwd }));
  const issues = (qa.issuesAfter || qa.issues || []).map((issue) => `${issue.code} ${issue.path}: ${issue.message}`);
  assert.deepEqual(issues, []);
});

test('pptx skill kit authors every skeleton without review warnings', { timeout: 180_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-pptx-kit-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const script = `${await kitBlocks('device-kit.md')}\n${SKELETONS}`;
  const path = join(cwd, 'skeletons.pptx');
  const authored = value(await executeOfficeTool({ action: 'author', path, script, mode: 'portable', overwrite: true, render: true }, { cwd }));
  assert.equal(authored.ok, true, authored.error?.message);
  assert.equal(authored.render?.pageCount, 23);
  const validation = value(await executeOfficeTool({ action: 'validate', session: authored.session }, { cwd }));
  assert.equal(validation.schema?.ok, true, JSON.stringify(validation.schema?.errors?.slice(0, 3)));
  const qa = value(await executeOfficeTool({ action: 'qa', session: authored.session }, { cwd }));
  const issues = (qa.issuesAfter || qa.issues || []).map((issue) => `${issue.code} ${issue.path}: ${issue.message}`);
  assert.deepEqual(issues, []);
});
