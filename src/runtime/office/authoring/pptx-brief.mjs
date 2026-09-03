// The authoring brief is a comment block at the top of the script (pptx skill
// §3). The runtime reads two of its lines back so the review can hold the deck
// to what the brief promised: the slide plan (which skeleton each slide uses)
// and the fact sheet (which numbers the deck may show, with their sources).

const SKELETON_ID = /^[SERP]\d{1,2}$/;

function briefLine(script, key) {
  const lines = String(script || '').split('\n');
  const start = lines.findIndex((line) => new RegExp(`^\\s*//\\s*${key}\\s*:`, 'i').test(line));
  if (start < 0) return '';
  const collected = [lines[start].replace(new RegExp(`^\\s*//\\s*${key}\\s*:`, 'i'), '')];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^\s*\/\//.test(line)) break;
    if (/^\s*\/\/\s*[a-z][a-z /-]*:/i.test(line)) break;   // the next brief key
    collected.push(line.replace(/^\s*\/\/\s*/, ''));
  }
  return collected.join(' ').replace(/\s+/g, ' ').trim();
}

function parseSlidePlan(text) {
  const entries = [];
  for (const token of String(text || '').split(/\s*·\s*/)) {
    const started = /^(\d+)\s+(.*)$/.exec(token.trim());
    if (started) {
      entries.push({ slide: Number(started[1]), tokens: [started[2].trim()] });
    } else if (entries.length && token.trim()) {
      entries[entries.length - 1].tokens.push(token.trim());
    }
  }
  return entries.map((entry) => {
    const words = entry.tokens.join(' ').split(/\s+/);
    const skeleton = words.find((word) => SKELETON_ID.test(word)) || '';
    const role = /\bcover\b/i.test(entry.tokens[0]) ? 'cover' : /\bclosing\b/i.test(entry.tokens[0]) ? 'closing' : /\bsection\b/i.test(entry.tokens[0]) ? 'section' : '';
    return { slide: entry.slide, skeleton, role, text: entry.tokens.join(' · ') };
  });
}

function parseFacts(text) {
  const facts = [];
  for (const token of String(text || '').split(/\s*·\s*/)) {
    const match = /^(F\d+)\s+(.+?)\s+[—–-]\s+(.+)$/.exec(token.trim());
    if (match) facts.push({ id: match[1], value: match[2].trim(), source: match[3].trim() });
  }
  return facts;
}

export function parseAuthoringBrief(script) {
  const plan = parseSlidePlan(briefLine(script, 'slide plan'));
  const facts = parseFacts(briefLine(script, 'facts'));
  const family = /^\s*([a-z-]+)/i.exec(briefLine(script, 'family'))?.[1] || '';
  const present = /\/\/\s*BRIEF\b/.test(String(script || ''));
  return { present, plan, facts, family };
}

// What each skeleton promises on the saved slide (design.md §4, layouts.md).
const PROMISES = {
  S1: { test: (s) => s.text.some((t) => t.size >= 22), label: 'a statement at 22 pt or larger' },
  S2: { test: (s) => s.text.some((t) => t.size >= 54), label: 'a hero numeral (54 pt+)' },
  S3: { test: (s) => s.text.some((t) => t.size >= 26), label: 'a quote at 26 pt or larger' },
  S5: { test: (s) => s.text.some((t) => t.size >= 150), label: 'a ghost numeral' },
  E1: { test: (s) => s.charts > 0, label: 'a native chart' },
  E2: { test: (s) => s.charts > 0, label: 'a native chart' },
  E3: { test: (s) => s.charts >= 2, label: 'two or more native charts' },
  E4: { test: (s) => s.text.filter((t) => t.size >= 40).length >= 3, label: 'three or more hero numerals' },
  E5: { test: (s) => s.tables > 0, label: 'a native table' },
  E7: { test: (s) => s.geometry.has('blockArc'), label: 'a gauge (block arc)' },
  E8: { test: (s) => new Set(s.text.map((t) => `${t.size}|${t.bold ? 1 : 0}`)).size >= 3, label: 'a specimen (three or more size/weight steps drawn)' },
  R1: { test: (s) => s.geometry.has('chevron') || s.geometry.has('homePlate'), label: 'a chevron run' },
  R2: { test: (s) => s.geometry.has('ellipse') && s.geometry.has('line'), label: 'timeline nodes on a rule' },
  R3: { test: (s) => s.geometry.has('round1Rect') || s.geometry.has('roundRect'), label: 'stepped blocks' },
  R5: { test: (s) => s.geometry.has('blockArc'), label: 'cycle segments (block arcs)' },
  R6: { test: (s) => s.counts.ellipse >= 3, label: 'a hub with satellites' },
  R7: { test: (s) => s.geometry.has('roundRect') && s.geometry.has('line'), label: 'sources, a target, and connectors' },
  R11: { test: (s) => s.geometry.has('leftBrace') || s.geometry.has('rightBrace'), label: 'brace groups' },
  R12: { test: (s) => s.counts.rect + s.counts.roundRect >= 2, label: 'two planes' },
  R13: { test: (s) => s.counts.line >= 2, label: 'a 2×2 field with two rules' },
  R14: { test: (s) => s.geometry.has('trapezoid') || s.geometry.has('triangle'), label: 'tiers' },
  R15: { test: (s) => s.counts.ellipse >= 2, label: 'overlapping sets' },
};

function slideFacts(slide) {
  const shapes = Array.isArray(slide?.shapes) ? slide.shapes : [];
  const geometry = new Set();
  const counts = { ellipse: 0, rect: 0, roundRect: 0, line: 0 };
  let charts = 0;
  let tables = 0;
  let pictures = 0;
  const text = [];
  for (const shape of shapes) {
    if (shape.chart) charts += 1;
    if (shape.table) tables += 1;
    if (shape.type === 'p:pic' || Number(shape.type) === 13) pictures += 1;
    if (shape.geometry) {
      geometry.add(shape.geometry);
      if (shape.geometry in counts) counts[shape.geometry] += 1;
    }
    if (String(shape.text || '').trim() && !shape.placeholder) text.push({ size: Number(shape.font?.size) || 0, bold: shape.font?.bold === true, text: String(shape.text) });
  }
  return { geometry, counts, charts, tables, pictures, text };
}

function issue(code, path, message) {
  return { severity: 'warning', code, path, message, source: 'design-review' };
}

export function reviewBriefPromises(document, brief) {
  const issues = [];
  const slides = Array.isArray(document?.slides) ? document.slides : [];
  const plan = Array.isArray(brief?.plan) ? brief.plan : [];
  if (!plan.length) return issues;
  const planned = Math.max(...plan.map((entry) => entry.slide));
  if (slides.length !== planned) {
    issues.push(issue('plan_count_mismatch', '/', `The brief plans ${planned} slides but the deck has ${slides.length}.`));
  }
  for (const entry of plan) {
    const slide = slides.find((candidate) => Number(candidate.index) === entry.slide);
    if (!slide) continue;
    const facts = slideFacts(slide);
    if (/^P\d/.test(entry.skeleton) && facts.pictures === 0) {
      issues.push(issue('plan_promise_missing', `/slide[${entry.slide}]`, `The plan names ${entry.skeleton} (a picture skeleton) but the slide carries no picture.`));
      continue;
    }
    const promise = PROMISES[entry.skeleton];
    if (promise && !promise.test(facts)) {
      issues.push(issue('plan_promise_missing', `/slide[${entry.slide}]`, `The plan names ${entry.skeleton} but the slide has no ${promise.label}.`));
    }
  }
  return issues;
}

// Numbers a deck shows must come from the fact sheet. Dates, page numbers,
// and single digits are not claims; anything else is a figure a reader may
// quote, so it needs a fact with a source behind it.
const NUMBER = /(?<![\w.])[+\-−]?\d[\d,]*(?:\.\d+)?\s?%?(?![\w.])/g;
const DATE = /^\d{4}$|^\d{4}-\d{2}(?:-\d{2})?$/;

function normalizedNumber(token) {
  return String(token).replace(/[,\s]/g, '').replace('−', '-');
}

export function reviewFactCoverage(document, brief) {
  const issues = [];
  const slides = Array.isArray(document?.slides) ? document.slides : [];
  const facts = Array.isArray(brief?.facts) ? brief.facts : [];
  const known = facts.map((fact) => normalizedNumber(fact.value));
  let anyNumber = false;
  for (const slide of slides) {
    const missing = new Set();
    for (const shape of slide.shapes || []) {
      if (shape.placeholder) continue;
      for (const raw of String(shape.text || '').match(NUMBER) || []) {
        const token = raw.trim();
        const value = normalizedNumber(token);
        const digits = value.replace(/[^\d]/g, '');
        if (DATE.test(token) || digits.length < 2 || (digits.length === 2 && /^\d{1,2}$/.test(value) && Number(value) <= 12)) continue;
        anyNumber = true;
        const bare = value.replace('%', '');
        if (!known.some((fact) => fact.includes(bare) || bare.includes(fact.replace('%', '')))) missing.add(token);
      }
    }
    if (missing.size && facts.length) {
      issues.push(issue('number_without_fact', `/slide[${slide.index}]`, `Figures with no fact behind them: ${[...missing].join(', ')}. Add them to the brief's facts line with a source, or remove them.`));
    }
  }
  if (anyNumber && !facts.length && brief?.present) {
    issues.push(issue('facts_missing', '/', 'The deck shows figures but the brief has no facts line; list each figure with its source (F1 <value> — <source>).'));
  }
  return issues;
}
