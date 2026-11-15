#!/usr/bin/env node
// Golden of the office authoring brief (crate mixdog-office-author, module brief): what Node's
// `runtime/office/authoring/pptx-brief.mjs` and `htmlBriefScript` (pptx-html-runner.mjs) answer to the brief headers of
// the office suites (pptx-brief.test.mjs, office-facts-gate.test.mjs, pptx-skill-kit.slow.test.mjs,
// pptx-html-build.test.mjs) and to a corpus of edge headers: the parsed brief (plan lines, directions, facts, sources,
// style, modes), the script a brief HTML comment reads as, and, per parsed brief and a set of deck snapshots built from
// its own plan, the carrier review, the plan gate, the fact coverage review, the facts gate, the source grounding
// review and the showcase reading. Writes native/core/fixtures/office-brief/golden.json and the set's manifest.
//
//   node benchmarks/rust-core/recorders/record-office-brief.mjs --tree <product tree>
//
// Every section is a list of cases { input, output }; every input is plain JSON (the replay reads it back) and keys
// are written in the order the module produces them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-brief.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const finalDir = join(FIXTURES_ROOT, 'office-brief');
const stage = stageSet(finalDir);

const brief = await importFrom(tree, 'src/runtime/office/authoring/pptx-brief.mjs');
const runner = await importFrom(tree, 'src/runtime/office/authoring/pptx-html-runner.mjs');

const plain = (value) => JSON.parse(JSON.stringify(value));
const attempt = (run) => {
  try {
    return { output: plain(run()) };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};

// ---- scripts: the brief blocks of the suites, read from their source, and the edge headers ---------------------------
const read = (rel) => readFileSync(join(tree, 'src/runtime/office', rel), 'utf8');
const SUITES = ['authoring/pptx-brief.test.mjs', 'office-facts-gate.test.mjs', 'pptx-skill-kit.slow.test.mjs', 'authoring/pptx-html-build.test.mjs'];
const scripts = [];
const htmls = [];
for (const rel of SUITES) {
  const text = read(rel);
  for (const match of text.matchAll(/\/\/ BRIEF\n(?:\/\/[^\n]*\n)*/g)) scripts.push(match[0]);
  for (const match of text.matchAll(/'(\/\/ BRIEF[^']*)'/g)) scripts.push(match[1].replace(/\\n/g, '\n'));
  for (const match of text.matchAll(/<!--\s*BRIEF[\s\S]*?-->/g)) htmls.push(`<!doctype html>${match[0]}\n<section class="slide"></section>`);
}

const BASE_FACTS = '// facts: F1 38건 — 1차 리뷰 로그 · F2 0.72 — 3차 미학 점수 · F3 97% — QA 통과율 · F4 1,250 — 시트 B4';
const BASE_PLAN = [
  '// slide plan: 1 job: cover · move: ask · carriers: statement',
  '//   · 2 job: evidence · carriers: chart, hero · rhythm: dense',
  '//   · 3 job: process · carriers: diagram · composition: steps',
  '//   · 4 job: comparison · carriers: table + picture · texture: grain',
  '//   · 5 job: section · carriers: gauge, specimen, quote',
  '//   · 6 job: closing · carriers: statement',
].join('\n');
scripts.push(
  '',
  'const deckWithoutBrief = 1;',
  '// BRIEF',
  '// BRIEF\n',
  '//BRIEF\n//facts:F1 5 — x',
  `// BRIEF\n${BASE_FACTS}\n${BASE_PLAN}\n`,
  '// BRIEF\r\n// facts: F1 47% — user brief\r\n// slide plan: 1 job: cover · carriers: statement\r\n//   · 2 job: closing · carriers: hero\r\n',
  '// BRIEF\n// FACTS: F1 47% — upper-case key\n// Slide Plan: 1 Job: Cover · CARRIERS: Statement, HERO\n// STYLE: Editorial · palette: hue 40\n',
  '// BRIEF\n// facts: illustrative — numbers are examples\n',
  '// BRIEF\n// facts: example: nothing measured\n',
  '// BRIEF\n// facts: Sample\n',
  '// BRIEF\n// facts: samples are not facts\n',
  '// BRIEF\n// facts: F1 47% - hyphen source · F2 12% – en dash source · F3 9% — em dash source\n',
  '// BRIEF\n// facts: F1 no dash here · F2 12% — slide 3 · F3 8 — sheet 2 · F4 7 — Fig. 4 · F5 6 — table 1 · F6 5 — line 40 · F7 4 — 12:30 · F8 3 — 12쪽 · F9 2 — 7 페이지 · F10 1 — Sheet1!B4 · F11 0 — §3 · F12 9 — http://x.y/z\n',
  '// BRIEF\n// sources: a.pdf ·  · b.xlsx · \n// facts: F1 5 — a.pdf p.1\n',
  '// BRIEF\n// sources: only one source\n// facts: F1 5 — somewhere · F2 6 — elsewhere\n',
  '// BRIEF\n// style: swiss-minimal · palette: hue 225\n// family: ignored\n',
  '// BRIEF\n// family: editorial\n',
  '// BRIEF\n// style: 1F7A4D\n',
  '// BRIEF\n// style:\n// family: dark-tech\n',
  '// BRIEF\n// style: custom · MODE presentation → body 24\n',
  '// BRIEF\n// reading mode: Presentation · argument mode: Pyramid\n',
  '// BRIEF\n// reading mode: · argument mode: story\n',
  '// BRIEF\n// reading mode: showcase\n// argument mode: briefing · more\n',
  '// BRIEF\n// argument mode: keynote\n',
  '// BRIEF\n// palette: · ignored\n// style: custom · palette: teal\n',
  '// BRIEF\n// palette: ivory · ink · brass\n',
  '// BRIEF\n// concept: field-led — the colour carries the brand\n//   still the concept\n// facts: F1 5 — x\n',
  '// BRIEF\n// directions: 1 editorial · 2 swiss · selected: 2 · why: clear\n',
  '// BRIEF\n// directions: Axis not a candidate · a lower · A. upper dot · B) paren · C: colon · D - dash · selected: c\n',
  '// BRIEF\n// directions: A one · why: because · selected: a ·  · why: again\n',
  `// BRIEF\n${BASE_FACTS}\n${BASE_PLAN.replace('1 job: cover', '01 job: cover').replace('2 job: evidence', '2 job: evidence · job: replaced')}\n`,
  '// BRIEF\n// slide plan: stray · 1 job: cover · carriers: statement · loose · 2 job: closing\n',
  '// BRIEF\n// slide plan: 3 job: closing section · carriers: ,, hero ,,+ ,quote/\n',
  '// BRIEF\n// slide plan: 1 cover · move: m\n//   · 2 job: Closing Remarks · carriers: statement\n//   · 3 section opener · carriers: statement\n',
  '// BRIEF\n// slide plan: 1 job: cover · bogus: x · carriers: statement\n',
  '// BRIEF\n// slide plan: 99999999999999999999999 job: cover · carriers: statement\n',
  '// BRIEF\n// slide plan: 1 job: cover · carriers: statement\nconst x = 1;\n// slide plan: 2 job: later\n',
  '// BRIEF\n// facts: F1 38건 — a\n//\n// slide plan: 1 job: cover\n',
  '// BRIEF\n// facts: F1 38건 — a\n// not a key line\n// facts: F2 5 — b\n'
);
// The suites' inputs with a variant each: the same header without its facts line, and with a sample declaration.
for (const script of [...scripts]) {
  if (/\/\/ facts:/.test(script)) {
    scripts.push(script.replace(/\/\/ facts:[^\n]*\n(?:\/\/ {2,}[^\n]*\n)*/, ''));
    scripts.push(script.replace(/\/\/ facts:[^\n]*\n/, '// facts: sample — illustrative\n'));
  }
}
htmls.push(
  '',
  '<section class="slide"></section>',
  '<!-- BRIEF -->',
  '<!--BRIEF\nfacts: F1 5 — x\n-->',
  '<!-- BRIEFING: not a brief -->',
  '<!-- note --><!-- BRIEF\n// facts: F1 5 — x\n  // style: editorial\n\n   \nslide plan: 1 job: cover · carriers: statement\n-->',
  '<!-- BRIEF\r\nfacts: sample — x\r\n  · 2 job: evidence\r\n-->',
  '<!-- BRIEF\n\tfacts: F1 5 — tab\n-->',
  '<!-- BRIEF facts: inline -->'
);

const unique = (list) => [...new Set(list)];
const parseCases = unique(scripts).map((script) => ({ input: script, ...attempt(() => brief.parseAuthoringBrief(script)) }));
const htmlCases = unique(htmls).map((html) => ({ input: html, ...attempt(() => runner.htmlBriefScript(html)) }));

// ---- decks: snapshots built from a brief's own plan ----------------------------------------------------------------
let seed = 20260115;
const next = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = (list) => list[Math.floor(next() * list.length)];

const FIGURES = ['38건', '0.72', '97%', '1,250', '12%', '2026-09-03', '2026.09', '2026.5', '84,200', '96', '42', 'Q3', '7', '−4', '+15%'];
const shapesFor = (entry, geometry) => {
  const shapes = [{ text: `Headline ${entry.slide}`, font: { size: 32, bold: true } }];
  for (const carrier of entry.carriers || []) {
    if (carrier === 'chart') shapes.push({ chart: { type: 'bar' } });
    if (carrier === 'table') shapes.push({ table: { rows: 2 } });
    if (carrier === 'picture') shapes.push({ type: 13 }, { type: 'p:pic', name: 'Picture 2' });
    if (carrier === 'hero') shapes.push({ text: '96', font: { size: 96 } });
    if (carrier === 'statement') shapes.push({ text: 'A statement', font: { size: 24 } });
    if (carrier === 'quote') shapes.push({ text: 'A quote', font: { size: 26 } });
    if (carrier === 'specimen') shapes.push({ text: 'a', font: { size: 12 } }, { text: 'b', font: { size: 18, bold: true } }, { text: 'c', font: { size: 40 } });
    if (carrier === 'gauge' && geometry) shapes.push({ geometry: 'blockArc' });
    if (carrier === 'diagram') shapes.push(geometry ? { geometry: 'round1Rect' } : { type: 1 }, geometry ? { geometry: 'line' } : { type: 1 });
  }
  shapes.push({ text: `${pick(FIGURES)} · ${pick(FIGURES)}`, font: { size: 14 } });
  if (next() < 0.4) shapes.push({ text: '99 placeholder', placeholder: true });
  return shapes;
};
const decksFor = (parsed) => {
  const plan = parsed.plan || [];
  const finite = plan.map((entry) => entry.slide).filter(Number.isFinite);
  const count = finite.length ? Math.min(Math.max(...finite), 8) : 3;
  const slide = (index, geometry) => {
    const entry = plan.find((candidate) => candidate.slide === index);
    return { index, shapes: entry ? shapesFor(entry, geometry) : [{ text: `Page ${index} ${pick(FIGURES)}`, font: { size: 20 } }] };
  };
  const full = Array.from({ length: count }, (_, i) => slide(i + 1, true));
  return [
    { slides: full },
    { slides: Array.from({ length: count }, (_, i) => slide(i + 1, false)) },
    { slides: full.slice(0, Math.max(1, count - 1)) },
    { slides: [...full, { index: count + 1, shapes: [{ text: 'Extra 31 pages' }] }] },
    { slides: full.slice(0, 1) },
    { slides: [{ index: 1, shapes: [{ text: '2026-09-03 · 38건 → 0' }, { text: '3', placeholder: true }] }, { index: 2, shapes: [{ text: '품질 0.72, 통과율 97%, 비용 1,250만원' }] }] },
    { slides: [{ shapes: [{ text: 'no index 55%' }] }, { index: '2', shapes: [{ text: 'string index 66%' }] }] },
    {},
    { slides: [] },
  ];
};

const extraBriefs = [
  { present: true, facts: [] },
  { present: true },
  { present: false, facts: [], plan: [] },
  { facts: [{ id: 'F1', value: '47%' }] },
  { present: true, factsMode: 'sample' },
  { present: true, plan: [{ slide: 1, job: 'cover', carriers: ['statement'] }, { slide: 7, job: '', carriers: [] }], facts: [{ id: 'F9', value: 12, source: 's', locator: false }], sources: ['a'] },
  { readingMode: 'presentation' },
  { argumentMode: 'showcase' },
  { readingMode: 'text', argumentMode: 'Keynote' },
  { readingMode: 5 },
];
const reviewInputs = [...parseCases.filter((c) => c.output).map((c) => c.output), ...extraBriefs];
const reviewCases = [];
for (const parsed of reviewInputs) {
  const documents = parsed.plan || parsed.facts ? decksFor(parsed) : [{ slides: [{ index: 1, shapes: [{ text: 'ok 47%' }] }] }];
  for (const document of documents) {
    const input = { brief: plain(parsed), document: plain(document) };
    reviewCases.push({
      input,
      ...attempt(() => ({
        gaps: brief.plannedCarrierGaps(input.document, input.brief),
        promises: brief.reviewBriefPromises(input.document, input.brief),
        planGate: brief.planGate(input.document, input.brief),
        coverage: brief.reviewFactCoverage(input.document, input.brief),
        factsGate: brief.factsGate(input.document, input.brief),
        grounding: brief.reviewSourceGrounding(input.brief),
        showcase: brief.isShowcaseBrief(input.brief),
      })),
    });
  }
}

const golden = {
  note: 'Recorded from the Node authoring brief (pptx-brief.mjs, htmlBriefScript); tests/twin_brief.rs replays it.',
  disclosure: brief.FACTS_SAMPLE_DISCLOSURE,
  parse: parseCases,
  html: htmlCases,
  review: reviewCases,
};
writeJson(join(stage, 'golden.json'), golden);
writeSetManifest(stage, { set: 'office-brief', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
console.log(`golden.json: parse ${parseCases.length}, html ${htmlCases.length}, review ${reviewCases.length}`);
