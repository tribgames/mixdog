import { createHash } from 'node:crypto';

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function safeId(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized)) {
    throw new Error(`Office content ${label} must use 1-64 lowercase letters, digits, dots, underscores, or hyphens`);
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
  const facts = rawFacts.map((fact) => {
    if (!plainObject(fact)) throw new Error('Office content facts must be objects');
    const id = safeId(fact.id, 'fact id');
    if (factIds.has(id)) throw new Error(`Office content model has duplicate fact id ${id}`);
    factIds.add(id);
    return {
      id,
      label: String(fact.label || id),
      value: clone(fact.value),
      ...(fact.unit ? { unit: String(fact.unit) } : {}),
      ...(fact.detail ? { detail: String(fact.detail) } : {}),
      ...(fact.numberFormat ? { numberFormat: String(fact.numberFormat) } : {}),
      ...(normalizeSource(fact.source) ? { source: normalizeSource(fact.source) } : {}),
    };
  });
  const claimIds = new Set();
  const claims = rawClaims.map((claim) => {
    if (!plainObject(claim)) throw new Error('Office content claims must be objects');
    const id = safeId(claim.id, 'claim id');
    if (claimIds.has(id)) throw new Error(`Office content model has duplicate claim id ${id}`);
    claimIds.add(id);
    const factRefs = [...new Set((Array.isArray(claim.factIds) ? claim.factIds : [])
      .map((entry) => safeId(entry, `claim ${id} fact reference`)))];
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
  }
  if (Array.isArray(bound.metrics)) {
    bound.metrics = bound.metrics.map((metric) => {
      if (!plainObject(metric) || !metric.factId) return resolveValue(metric);
      const resolved = fact(metric.factId);
      return {
        ...metric,
        value: metric.value ?? clone(resolved.value),
        label: metric.label || resolved.label,
        detail: metric.detail || resolved.detail || resolved.unit || '',
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
