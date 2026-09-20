import { createHash } from 'node:crypto';
import { clone, plainObject, stableValue } from '../shared/values.mjs';

// A content id names a figure inside this package — nothing in the file format
// reads it — so it takes letters of any script: a Korean deck should identify
// 정시_출고율 by its own name instead of inventing an ASCII key for it. The
// message names the entry it came from, since a list of facts all fail alike.
function safeId(value, label, where = '') {
  const at = where ? ` (${where})` : '';
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) throw new Error(`Office content ${label} is required${at}`);
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u.test(normalized)) {
    throw new Error(
      `Office content ${label} "${normalized}" must use 1-64 letters, digits, dots, underscores, or hyphens${at}`
    );
  }
  return normalized;
}

function normalizeSource(value) {
  if (typeof value === 'string') return value.trim();
  if (!plainObject(value)) return null;
  const document = String(value.document || '').trim();
  if (!document) return null;
  return {
    document,
    ...(value.target ? { target: String(value.target) } : {}),
    ...(value.label ? { label: String(value.label) } : {}),
  };
}

// What a fact may carry. The keys are checked because an unread one is worse
// than a rejected one: the figure ships in the wrong notation and nothing says so.
const FACT_KEYS = new Set(['id', 'label', 'value', 'unit', 'detail', 'numberFormat', 'format', 'source']);

// A caller writes the format the way they say it out loud. Named formats reach
// the spreadsheet notation the composers already apply; an explicit pattern is
// taken as written.
const NAMED_NUMBER_FORMATS = Object.freeze({
  percent: '0.0%',
  percentage: '0.0%',
  number: '#,##0',
  integer: '#,##0',
  decimal: '#,##0.0',
  currency: '#,##0',
  money: '#,##0',
});

// One resolution for every figure the composers print — a bound fact and a
// preset's metric are written the same way, so `format: 'percent'` reaches the
// notation whichever entry carries it.
export function officeNumberFormat(entry = {}) {
  const written = String(entry?.numberFormat || entry?.format || '').trim();
  if (!written) return '';
  return NAMED_NUMBER_FORMATS[written.toLowerCase()] || written;
}

function sourceText(value) {
  if (typeof value === 'string') return value;
  if (!plainObject(value)) return '';
  const document = String(value.document || '');
  const target = String(value.target || '');
  const label = String(value.label || '');
  return `${document}${target ? `#${target}` : ''}${label ? ` (${label})` : ''}`;
}

export function normalizeOfficeContentModel(value) {
  if (value == null) return null;
  if (!plainObject(value)) throw new Error('Office design.content must be an object');
  const rawFacts = Array.isArray(value.facts) ? value.facts : [];
  const rawClaims = Array.isArray(value.claims) ? value.claims : [];
  if (rawFacts.length > 1_000 || rawClaims.length > 500) {
    throw new Error('Office content model exceeds the supported fact or claim count');
  }
  const factIds = new Set();
  const facts = rawFacts.map((fact, index) => {
    if (!plainObject(fact)) throw new Error('Office content facts must be objects');
    const id = safeId(fact.id, 'fact id', `fact ${index + 1}${fact?.label ? `: ${fact.label}` : ''}`);
    if (factIds.has(id)) throw new Error(`Office content model has duplicate fact id ${id}`);
    factIds.add(id);
    // A key the model does not read is dropped, and the figure then ships in
    // the wrong notation: a fact written with format:'percent' printed 0.928
    // beside "92.8%" in the prose. The natural spellings reach numberFormat,
    // and anything else is named rather than ignored.
    const numberFormat = officeNumberFormat(fact);
    const unknown = Object.keys(fact).filter((key) => !FACT_KEYS.has(key));
    if (unknown.length) {
      throw new Error(
        `Office content fact ${id} has unknown key(s): ${unknown.join(', ')}.` +
          ` A fact takes: ${[...FACT_KEYS].join(', ')}.`
      );
    }
    return {
      id,
      label: String(fact.label || id),
      value: clone(fact.value),
      ...(fact.unit ? { unit: String(fact.unit) } : {}),
      ...(fact.detail ? { detail: String(fact.detail) } : {}),
      ...(numberFormat ? { numberFormat } : {}),
      ...(normalizeSource(fact.source) ? { source: normalizeSource(fact.source) } : {}),
    };
  });
  const claimIds = new Set();
  const claims = rawClaims.map((claim, index) => {
    if (!plainObject(claim)) throw new Error('Office content claims must be objects');
    const id = safeId(claim.id, 'claim id', `claim ${index + 1}${claim?.text ? `: ${claim.text}` : ''}`);
    if (claimIds.has(id)) throw new Error(`Office content model has duplicate claim id ${id}`);
    claimIds.add(id);
    // The references are the point of a claim: naming them "facts" instead of
    // factIds used to bind the claim to nothing at all, and the deck then
    // reported the figure it carried as unsourced.
    let references = [];
    if (Array.isArray(claim.factIds)) references = claim.factIds;
    else if (Array.isArray(claim.facts)) references = claim.facts;
    const factRefs = [...new Set(references.map((entry) => safeId(entry, `claim ${id} fact reference`)))];
    for (const factId of factRefs) {
      if (!factIds.has(factId)) throw new Error(`Office content claim ${id} references unknown fact ${factId}`);
    }
    return {
      id,
      text: String(claim.text || '').trim(),
      factIds: factRefs,
      ...(claim.implication ? { implication: String(claim.implication) } : {}),
    };
  });
  const normalized = {
    packageId: value.packageId ? safeId(value.packageId, 'package id') : '',
    audience: String(value.audience || ''),
    objective: String(value.objective || ''),
    decision: String(value.decision || ''),
    period: String(value.period || ''),
    facts,
    claims,
  };
  normalized.fingerprint = createHash('sha256')
    .update(JSON.stringify(stableValue(normalized)))
    .digest('hex');
  return normalized;
}

export function summarizeOfficeContentModel(model) {
  if (!model) return null;
  return {
    packageId: model.packageId,
    fingerprint: model.fingerprint,
    audience: model.audience,
    objective: model.objective,
    decision: model.decision,
    period: model.period,
    factCount: model.facts.length,
    claimCount: model.claims.length,
    sourcedFactCount: model.facts.filter((fact) => fact.source).length,
  };
}

export function bindOfficeContent(operation, model) {
  if (!model || !plainObject(operation)) return { operation, binding: null };
  const facts = new Map(model.facts.map((fact) => [fact.id, fact]));
  const claims = new Map(model.claims.map((claim) => [claim.id, claim]));
  const used = new Set();
  const fact = (id) => {
    const normalized = safeId(id, 'fact reference');
    const resolved = facts.get(normalized);
    if (!resolved) throw new Error(`Office semantic operation references unknown fact ${normalized}`);
    used.add(normalized);
    return resolved;
  };
  const resolveValue = (entry) => {
    if (Array.isArray(entry)) return entry.map(resolveValue);
    if (!plainObject(entry)) return entry;
    if (entry.factId) {
      const resolved = fact(entry.factId);
      const field = String(entry.field || 'value');
      if (!Object.hasOwn(resolved, field)) throw new Error(`Office fact ${resolved.id} has no field ${field}`);
      return clone(resolved[field]);
    }
    return Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, resolveValue(child)]));
  };
  const bound = clone(operation);
  if (bound.claimId) {
    const claimId = safeId(bound.claimId, 'claim reference');
    const claim = claims.get(claimId);
    if (!claim) throw new Error(`Office semantic operation references unknown claim ${claimId}`);
    for (const factId of claim.factIds) used.add(factId);
    if (!bound.title) bound.title = claim.text;
    if (!bound.takeaway) bound.takeaway = claim.implication || claim.text;
    // The claim is the sentence the document exists to make. When the caller
    // also titled the operation, binding it to the title alone dropped it: the
    // memo shipped with its metrics and its evidence but no recommendation.
    if (bound.op === 'compose_document' && !bound.summary && bound.title !== claim.text) {
      bound.summary = claim.implication || claim.text;
    }
  }
  if (Array.isArray(bound.metrics)) {
    bound.metrics = bound.metrics.map((metric) => {
      if (!plainObject(metric) || !metric.factId) return resolveValue(metric);
      const resolved = fact(metric.factId);
      // The unit stays a unit: it closes on the figure the composers print
      // ("47,210 orders"), where parking it in `detail` left an orphan word on
      // a row of otherwise empty cells and a value with no unit above it.
      return {
        ...metric,
        value: metric.value ?? clone(resolved.value),
        label: metric.label || resolved.label,
        ...(metric.unit || resolved.unit ? { unit: String(metric.unit || resolved.unit) } : {}),
        detail: metric.detail || resolved.detail || '',
        numberFormat: metric.numberFormat || resolved.numberFormat || '',
      };
    });
  }
  for (const key of ['rows', 'table', 'chart', 'columns', 'steps', 'allocations', 'annotations', 'gates', 'actions']) {
    if (bound[key] != null) bound[key] = resolveValue(bound[key]);
  }
  const sources = [...used]
    .map((id) => facts.get(id)?.source)
    .filter(Boolean)
    .map(sourceText)
    .filter((entry, index, values) => values.indexOf(entry) === index);
  if (!bound.source && sources.length) bound.source = sources.join('; ');
  return {
    operation: bound,
    binding: {
      packageId: model.packageId,
      contentFingerprint: model.fingerprint,
      claimId: bound.claimId ? String(bound.claimId).toLowerCase() : '',
      factIds: [...used].sort(),
      sources,
    },
  };
}
