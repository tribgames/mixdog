// The authoring brief is a comment block at the top of the script (pptx skill
// §3). The runtime reads it back as information: the slide plan (each slide's
// job, relationship, move, composition, and carriers), the three directions
// and the selected one, the style line, and the fact sheet (which numbers the
// deck may show, with their sources). The plan is the author's intent, never a
// layout the review enforces.

const PLAN_KEYS = ['job', 'relationship', 'move', 'composition', 'carriers', 'texture', 'rhythm'];

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
  // Continuation lines are joined as list items (` · `), so a facts or plan
  // line may wrap across comment lines without two entries fusing into one.
  return collected
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' · ')
    .replace(/(?:\s*·\s*){2,}/g, ' · ')
    .replace(/\s+/g, ' ')
    .trim();
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
    const fields = {};
    for (const token of entry.tokens) {
      const match = /^([a-z]+)\s*:\s*(.*)$/i.exec(token);
      if (match && PLAN_KEYS.includes(match[1].toLowerCase())) fields[match[1].toLowerCase()] = match[2].trim();
    }
    const head = `${entry.tokens[0]} ${fields.job || ''}`;
    const role = /\bcover\b/i.test(head) ? 'cover' : /\bclosing\b/i.test(head) ? 'closing' : /\bsection\b/i.test(head) ? 'section' : '';
    const carriers = String(fields.carriers || '').split(/\s*[,+/]\s*/).map((word) => word.trim().toLowerCase()).filter(Boolean);
    return { slide: entry.slide, role, ...fields, carriers, text: entry.tokens.join(' · ') };
  });
}

// `directions: A <…> · B <…> · C <…> · selected: B · why: <…>` → the candidates and the pick.
function parseDirections(text) {
  const candidates = [];
  let selected = '';
  for (const token of String(text || '').split(/\s*·\s*/)) {
    const pick = /^selected\s*:\s*([A-Za-z0-9]+)/i.exec(token.trim());
    if (pick) { selected = pick[1].toUpperCase(); continue; }
    const candidate = /^([A-Z]|\d)\b[\s:.)-]*(.+)$/.exec(token.trim());
    if (candidate && !/^why\s*:/i.test(token.trim())) candidates.push({ id: candidate[1].toUpperCase(), text: candidate[2].trim() });
  }
  return { candidates, selected };
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
  const style = /^\s*([a-z-]+)/i.exec(briefLine(script, 'style') || briefLine(script, 'family'))?.[1] || '';
  const directions = parseDirections(briefLine(script, 'directions'));
  const present = /\/\/\s*BRIEF\b/.test(String(script || ''));
  return { present, plan, facts, style, family: style, directions };
}

// What each named carrier promises on the saved slide. Read back as information
// only: the plan line says what the slide carries, the review says whether it
// can see it.
const PROMISES = {
  chart: { test: (s) => s.charts > 0, label: 'a native chart' },
  table: { test: (s) => s.tables > 0, label: 'a native table' },
  picture: { test: (s) => s.pictures > 0, label: 'a picture' },
  hero: { test: (s) => s.text.some((t) => t.size >= 40), label: 'a hero numeral (40 pt+)' },
  statement: { test: (s) => s.text.some((t) => t.size >= 22), label: 'a statement at 22 pt or larger' },
  quote: { test: (s) => s.text.some((t) => t.size >= 24), label: 'a quote at 24 pt or larger' },
  specimen: { test: (s) => new Set(s.text.map((t) => `${t.size}|${t.bold ? 1 : 0}`)).size >= 3, label: 'a specimen (three or more size/weight steps drawn)' },
  gauge: { test: (s) => s.geometry.has('blockArc'), label: 'a gauge (block arc)' },
  diagram: { test: (s) => s.drawn >= 2, label: 'a drawn construction (two or more shapes without text)' },
};

function slideFacts(slide) {
  const shapes = Array.isArray(slide?.shapes) ? slide.shapes : [];
  const geometry = new Set();
  let charts = 0;
  let tables = 0;
  let pictures = 0;
  let drawn = 0;
  const text = [];
  for (const shape of shapes) {
    if (shape.chart) charts += 1;
    if (shape.table) tables += 1;
    if (shape.type === 'p:pic' || Number(shape.type) === 13) pictures += 1;
    if (shape.geometry) geometry.add(shape.geometry);
    if (String(shape.text || '').trim() && !shape.placeholder) text.push({ size: Number(shape.font?.size) || 0, bold: shape.font?.bold === true, text: String(shape.text) });
    else if (!shape.chart && !shape.table && !shape.placeholder && shape.type !== 'p:pic' && Number(shape.type) !== 13) drawn += 1;
  }
  return { geometry, charts, tables, pictures, drawn, text };
}

function issue(code, path, message, severity = 'warning') {
  return { severity, code, path, message, source: 'design-review' };
}

// Plan lines whose named carriers the saved slide does not show. A
// geometry-based promise (gauge, diagram) is only checked when the snapshot
// carries shape geometry (the OOXML reader does; the Office COM snapshot
// reports shape kinds without preset geometry, and a check that cannot see
// the shapes stays silent). Shared by the advisory review and the receipt.
export function plannedCarrierGaps(document, brief) {
  const gaps = [];
  const slides = Array.isArray(document?.slides) ? document.slides : [];
  const geometryVisible = slides.some((slide) => (slide?.shapes || []).some((shape) => shape?.geometry));
  for (const entry of Array.isArray(brief?.plan) ? brief.plan : []) {
    const slide = slides.find((candidate) => Number(candidate.index) === entry.slide);
    if (!slide) continue;
    const facts = slideFacts(slide);
    for (const carrier of entry.carriers || []) {
      const promise = PROMISES[carrier];
      if (!promise) continue;
      if (['gauge', 'diagram'].includes(carrier) && !geometryVisible) continue;
      if (!promise.test(facts)) gaps.push({ slide: entry.slide, carrier, label: promise.label });
    }
  }
  return gaps;
}

// The plan is the author's stated intent, not a layout the review enforces:
// what it reports here is advisory (severity info).
export function reviewBriefPromises(document, brief) {
  const issues = [];
  const slides = Array.isArray(document?.slides) ? document.slides : [];
  const plan = Array.isArray(brief?.plan) ? brief.plan : [];
  if (!plan.length) return issues;
  const planned = Math.max(...plan.map((entry) => entry.slide));
  if (slides.length !== planned) {
    issues.push(issue('plan_count_mismatch', '/', `The brief plans ${planned} slides but the deck has ${slides.length}.`, 'info'));
  }
  for (const gap of plannedCarrierGaps(document, brief)) {
    issues.push(issue('plan_promise_missing', `/slide[${gap.slide}]`, `The plan names ${gap.carrier} among the slide's carriers but the slide does not seem to carry ${gap.label}.`, 'info'));
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
