#!/usr/bin/env node
// Equivalence gate for mixdog-graph extraction rewrites.
// Node built-ins only. Compares two binaries (or captured JSONL) per FileRecord.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const USAGE = `usage: node scripts/graph-parity.mjs --old <binary> --new <binary> [--root <dir>] [--files <rel>...] [--json <out>] [--kind-map <path.json>] [--tokens] [--allow-new-languages <ids>] [--max-symbol-loss N] [--max-import-diff N] [--max-token-loss N] [--max-time-ratio 1.10] [--runs 3]
       node scripts/graph-parity.mjs --old-jsonl <file> --new-jsonl <file> [thresholds...]`;

const EXAMPLE_CAP = 5;
const SPAWN_TIMEOUT_MS = Math.max(5_000, Number(process.env.MIXDOG_GRAPH_PARITY_TIMEOUT_MS) || 180_000);
const FORCE_SETTLE_MS = Math.max(500, Number(process.env.MIXDOG_GRAPH_PARITY_FORCE_SETTLE_MS) || 5_000);

export function normalizeRel(rel) {
  return String(rel || '').replace(/\\/g, '/');
}

export function parseArgs(argv) {
  const out = {
    old: null,
    new: null,
    root: '.',
    files: [],
    json: null,
    maxSymbolLoss: 0,
    maxImportDiff: 0,
    maxTokenLoss: 0,
    maxTimeRatio: 1.1,
    runs: 3,
    oldJsonl: null,
    newJsonl: null,
    kindMap: null,
    tokens: false,
    allowNewLanguages: [],
  };
  const take = (args, i, flag) => {
    const v = args[i + 1];
    if (v == null || v.startsWith('--')) throw new Error(`missing value for ${flag}`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--old':
        out.old = take(argv, i, a);
        i += 1;
        break;
      case '--new':
        out.new = take(argv, i, a);
        i += 1;
        break;
      case '--root':
        out.root = take(argv, i, a);
        i += 1;
        break;
      case '--json':
        out.json = take(argv, i, a);
        i += 1;
        break;
      case '--old-jsonl':
        out.oldJsonl = take(argv, i, a);
        i += 1;
        break;
      case '--new-jsonl':
        out.newJsonl = take(argv, i, a);
        i += 1;
        break;
      case '--max-symbol-loss':
        out.maxSymbolLoss = Number(take(argv, i, a));
        i += 1;
        break;
      case '--max-import-diff':
        out.maxImportDiff = Number(take(argv, i, a));
        i += 1;
        break;
      case '--max-token-loss':
        out.maxTokenLoss = Number(take(argv, i, a));
        i += 1;
        break;
      case '--max-time-ratio':
        out.maxTimeRatio = Number(take(argv, i, a));
        i += 1;
        break;
      case '--runs':
        out.runs = Number(take(argv, i, a));
        i += 1;
        break;
      case '--kind-map':
        out.kindMap = take(argv, i, a);
        i += 1;
        break;
      case '--tokens':
        out.tokens = true;
        break;
      case '--allow-new-languages': {
        const first = take(argv, i, a);
        i += 1;
        out.allowNewLanguages.push(...splitLangIds(first));
        while (i + 1 < argv.length && !String(argv[i + 1]).startsWith('--')) {
          out.allowNewLanguages.push(...splitLangIds(argv[i + 1]));
          i += 1;
        }
        break;
      }
      case '--files':
        while (i + 1 < argv.length && !String(argv[i + 1]).startsWith('--')) {
          out.files.push(argv[i + 1]);
          i += 1;
        }
        break;
      case '--help':
      case '-h':
        throw new Error('help');
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  const jsonlMode = Boolean(out.oldJsonl || out.newJsonl);
  if (jsonlMode && (!out.oldJsonl || !out.newJsonl)) {
    throw new Error('both --old-jsonl and --new-jsonl are required');
  }
  if (!jsonlMode && (!out.old || !out.new)) {
    throw new Error('--old and --new binaries are required (or --old-jsonl/--new-jsonl)');
  }
  if (!Number.isFinite(out.maxSymbolLoss) || out.maxSymbolLoss < 0) throw new Error('invalid --max-symbol-loss');
  if (!Number.isFinite(out.maxImportDiff) || out.maxImportDiff < 0) throw new Error('invalid --max-import-diff');
  if (!Number.isFinite(out.maxTokenLoss) || out.maxTokenLoss < 0) throw new Error('invalid --max-token-loss');
  if (!Number.isFinite(out.maxTimeRatio) || out.maxTimeRatio <= 0) throw new Error('invalid --max-time-ratio');
  if (!Number.isFinite(out.runs) || out.runs < 1 || !Number.isInteger(out.runs)) throw new Error('invalid --runs');
  out.allowNewLanguages = [...new Set(out.allowNewLanguages)];
  return out;
}

export function splitLangIds(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function takeKindsObject(out, lang, kinds) {
  if (!lang || !kinds || typeof kinds !== 'object' || Array.isArray(kinds)) return;
  const map = out[lang] ? { ...out[lang] } : {};
  for (const [oldKind, newKind] of Object.entries(kinds)) {
    if (typeof newKind === 'string') map[oldKind] = newKind;
  }
  if (Object.keys(map).length) out[lang] = map;
}

/** Per-language old→new kind map from `--kind-map` JSON or `--langs` stdout. */
export function parseKindMap(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  if (Array.isArray(input.languages)) {
    for (const row of input.languages) {
      if (!row || typeof row !== 'object') continue;
      takeKindsObject(out, row.id || row.lang, row.kinds);
    }
  }
  for (const [key, value] of Object.entries(input)) {
    if (key === 'languages' || key === 'callsFormat' || key === 'ruleErrors' || key === 'kinds') continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (value.kinds && typeof value.kinds === 'object' && !Array.isArray(value.kinds)) {
      takeKindsObject(out, key, value.kinds);
      continue;
    }
    const values = Object.values(value);
    if (values.length && values.every((v) => typeof v === 'string')) takeKindsObject(out, key, value);
  }
  return out;
}

export function parseLangsStdout(text) {
  const src = String(text || '').trim();
  if (!src) return {};
  const tryParse = (raw) => {
    try {
      return parseKindMap(JSON.parse(raw));
    } catch {
      return null;
    }
  };
  const whole = tryParse(src);
  if (whole) return whole;
  for (const line of src.split(/\n/)) {
    const parsed = tryParse(line.trim());
    if (parsed) return parsed;
  }
  return {};
}

export function kindMapActive(kindMap) {
  if (!kindMap) return false;
  return Object.values(kindMap).some((map) => map && Object.keys(map).length > 0);
}

export function parseJsonl(text) {
  const src = Buffer.isBuffer(text) ? text.toString('utf8') : String(text || '');
  const records = [];
  let lineNumber = 0;
  for (const line of src.split(/\n/)) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`invalid JSONL at line ${lineNumber}: ${error?.message || error}`);
    }
    if (!rec || typeof rec.rel !== 'string') {
      throw new Error(`invalid JSONL at line ${lineNumber}: record is missing string rel`);
    }
    rec.rel = normalizeRel(rec.rel);
    records.push(rec);
  }
  return records;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function asStr(v) {
  return typeof v === 'string' ? v : '';
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function normalizeSymbol(s) {
  return {
    name: String(s?.name ?? ''),
    kind: String(s?.kind ?? ''),
    startLine: Number(s?.startLine ?? s?.line) || 0,
    startCol: Number(s?.startCol ?? s?.col) || 0,
    endCol: Number(s?.endCol) || 0,
  };
}

function keyNameKindLine(s) {
  return `${s.name}\0${s.kind}\0${s.startLine}`;
}

function keyNameLine(s) {
  return `${s.name}\0${s.startLine}`;
}

function indexSymbolKeys(list, keyFn) {
  const map = new Map();
  for (let i = 0; i < list.length; i += 1) {
    const k = keyFn(list[i]);
    const bucket = map.get(k);
    if (bucket) bucket.push(i);
    else map.set(k, [i]);
  }
  return map;
}

function takeUnused(bucket, used) {
  if (!bucket) return -1;
  while (bucket.length) {
    const j = bucket.shift();
    if (!used[j]) return j;
  }
  return -1;
}

function noteColDrift(colDrift, oldSym, newSym) {
  if (oldSym.startCol !== newSym.startCol || oldSym.endCol !== newSym.endCol) {
    colDrift.push({ old: oldSym, new: newSym });
  }
}

export function matchSymbols(oldList, newList, kindMap = null) {
  const olds = asArray(oldList).map(normalizeSymbol);
  const news = asArray(newList).map(normalizeSymbol);
  const usedO = new Array(olds.length).fill(false);
  const usedN = new Array(news.length).fill(false);
  const colDrift = [];
  const kindChange = [];
  const kindMapped = [];
  const loss = [];
  const addition = [];
  const byNameKindLine = indexSymbolKeys(news, keyNameKindLine);

  for (let i = 0; i < olds.length; i += 1) {
    const j = takeUnused(byNameKindLine.get(keyNameKindLine(olds[i])), usedN);
    if (j < 0) continue;
    usedO[i] = true;
    usedN[j] = true;
    noteColDrift(colDrift, olds[i], news[j]);
  }

  // Prefer declared kind-map pairs at the same (name,line) so two symbols that
  // share a line still map independently (order of `new` must not swap them
  // into KIND_CHANGE).
  if (kindMap) {
    const byMapped = indexSymbolKeys(news, keyNameKindLine);
    for (let i = 0; i < olds.length; i += 1) {
      if (usedO[i]) continue;
      const mapped = kindMap[olds[i].kind];
      if (mapped == null || mapped === olds[i].kind) continue;
      const j = takeUnused(byMapped.get(`${olds[i].name}\0${mapped}\0${olds[i].startLine}`), usedN);
      if (j < 0) continue;
      usedO[i] = true;
      usedN[j] = true;
      kindMapped.push({ old: olds[i], new: news[j] });
      noteColDrift(colDrift, olds[i], news[j]);
    }
  }

  const byNameLine = indexSymbolKeys(news, keyNameLine);
  for (let i = 0; i < olds.length; i += 1) {
    if (usedO[i]) continue;
    const j = takeUnused(byNameLine.get(keyNameLine(olds[i])), usedN);
    if (j < 0) continue;
    usedO[i] = true;
    usedN[j] = true;
    const mapped = kindMap?.[olds[i].kind];
    if (mapped != null && mapped === news[j].kind) {
      kindMapped.push({ old: olds[i], new: news[j] });
    } else {
      kindChange.push({ old: olds[i], new: news[j] });
    }
    noteColDrift(colDrift, olds[i], news[j]);
  }
  for (let i = 0; i < olds.length; i += 1) if (!usedO[i]) loss.push(olds[i]);
  for (let j = 0; j < news.length; j += 1) if (!usedN[j]) addition.push(news[j]);
  return { colDrift, kindChange, kindMapped, loss, addition };
}

function setDiff(oldList, newList) {
  const oldSet = new Set(asArray(oldList).map((v) => String(v)));
  const newSet = new Set(asArray(newList).map((v) => String(v)));
  const missing = [...oldSet].filter((v) => !newSet.has(v)).sort();
  const extra = [...newSet].filter((v) => !oldSet.has(v)).sort();
  return { missing, extra };
}

function emptyLangBucket() {
  return {
    LOSS: { count: 0, examples: [] },
    ADDITION: { count: 0, examples: [] },
    KIND_CHANGE: { count: 0, examples: [] },
    KIND_MAPPED: { count: 0, examples: [] },
    COL_DRIFT: { count: 0, examples: [] },
    IMPORT: { count: 0, examples: [] },
    SCALAR: { count: 0, examples: [] },
    PARSE_ERROR: { count: 0, examples: [] },
    TOKEN_LOSS: { count: 0, examples: [] },
    TOKEN_ADD: { count: 0, examples: [] },
    FILE_ONLY_OLD: { count: 0, examples: [] },
    FILE_ONLY_NEW: { count: 0, examples: [] },
  };
}

function emptyAdditive() {
  return { symbols: 0, exported: 0, sig: 0, parent: 0, calls: 0 };
}

function addAdditive(into, rec) {
  for (const s of asArray(rec?.symbols)) {
    into.symbols += 1;
    if (s?.exported === true || s?.isExported === true) into.exported += 1;
    if (typeof s?.sig === 'string' && s.sig) into.sig += 1;
    if (typeof s?.parent === 'string' && s.parent) into.parent += 1;
  }
  if (Array.isArray(rec?.calls)) into.calls += rec.calls.length;
}

function collectDeclaredSymbolNames(oldRecords, newRecords) {
  const names = new Set();
  for (const rec of [...asArray(oldRecords), ...asArray(newRecords)]) {
    for (const s of asArray(rec?.symbols)) {
      const name = String(s?.name ?? '');
      if (name) names.add(name);
    }
  }
  return names;
}

function tokenSet(rec, declaredNames) {
  // Absent / null tokens are unknown (skip loss). `[]` is a known empty set.
  if (!rec || !Object.hasOwn(rec, 'tokens') || rec.tokens == null) {
    return null;
  }
  const out = new Set();
  for (const tok of asArray(rec.tokens)) {
    const name = String(tok);
    if (declaredNames.has(name)) out.add(name);
  }
  return out;
}

function pushExample(bucket, example) {
  bucket.count += 1;
  if (bucket.examples.length < EXAMPLE_CAP) bucket.examples.push(example);
}

function langOf(rec) {
  return asStr(rec?.lang) || '(unknown)';
}

function indexByRel(records) {
  const map = new Map();
  for (const rec of records) map.set(normalizeRel(rec.rel), rec);
  return map;
}

function createWalkComparisonState(oldRecords, newRecords, options) {
  const kindMap = options.kindMap || {};
  const compareTokens = Boolean(options.tokens);
  const oldMap = indexByRel(oldRecords);
  const newMap = indexByRel(newRecords);
  const rels = [...new Set([...oldMap.keys(), ...newMap.keys()])].sort();
  const byLanguage = {};
  const additive = {};
  const fileLangs = {};
  const filesOnlyOld = [];
  const filesOnlyNew = [];
  const totals = {
    loss: 0,
    addition: 0,
    kindChange: 0,
    kindMapped: 0,
    colDrift: 0,
    importDiff: 0,
    scalar: 0,
    parseError: 0,
    tokenLost: 0,
    tokenAdded: 0,
  };
  const declaredNames = compareTokens ? collectDeclaredSymbolNames(oldRecords, newRecords) : null;
  return {
    kindMap,
    compareTokens,
    oldMap,
    newMap,
    rels,
    byLanguage,
    additive,
    fileLangs,
    filesOnlyOld,
    filesOnlyNew,
    unmappedKinds: [],
    lineMoves: [],
    totals,
    declaredNames,
  };
}

function languageBucket(state, lang) {
  if (!state.byLanguage[lang]) state.byLanguage[lang] = emptyLangBucket();
  return state.byLanguage[lang];
}

function additiveForLanguage(state, lang) {
  if (!state.additive[lang]) state.additive[lang] = emptyAdditive();
  return state.additive[lang];
}

function collectUnmappedKinds(records, kindMap) {
  const oldKindsByLang = {};
  for (const rec of asArray(records)) {
    const lang = langOf(rec);
    if (!oldKindsByLang[lang]) oldKindsByLang[lang] = new Set();
    for (const s of asArray(rec.symbols)) {
      const kind = String(s?.kind ?? '');
      if (kind) oldKindsByLang[lang].add(kind);
    }
  }
  const unmappedKinds = [];
  for (const [lang, kinds] of Object.entries(oldKindsByLang)) {
    const map = kindMap[lang];
    if (!map || !Object.keys(map).length) continue;
    for (const kind of [...kinds].sort()) {
      if (!Object.hasOwn(map, kind)) unmappedKinds.push({ lang, kind });
    }
  }
  return unmappedKinds;
}

function recordFileOnlyOld(state, rel, rec) {
  const lang = langOf(rec);
  state.fileLangs[rel] = lang;
  state.filesOnlyOld.push(rel);
  pushExample(languageBucket(state, lang).FILE_ONLY_OLD, { rel, lang });
}

function recordFileOnlyNew(state, rel, rec) {
  const lang = langOf(rec);
  state.fileLangs[rel] = lang;
  state.filesOnlyNew.push(rel);
  pushExample(languageBucket(state, lang).FILE_ONLY_NEW, { rel, lang });
  addAdditive(additiveForLanguage(state, lang), rec);
}

function recordLossesAndAdditions(state, rel, bucket, matched) {
  for (const s of matched.loss) {
    state.totals.loss += 1;
    pushExample(bucket.LOSS, { rel, name: s.name, kind: s.kind, startLine: s.startLine });
  }
  for (const s of matched.addition) {
    state.totals.addition += 1;
    pushExample(bucket.ADDITION, { rel, name: s.name, kind: s.kind, startLine: s.startLine });
  }
}

function recordLineMoves(state, rel, lang, matched) {
  if (!matched.loss.length || !matched.addition.length) return;
  const lostNames = new Set(matched.loss.map((s) => s.name));
  const seenMove = new Set();
  for (const s of matched.addition) {
    if (!lostNames.has(s.name) || seenMove.has(s.name)) continue;
    seenMove.add(s.name);
    state.lineMoves.push({ rel, name: s.name, lang });
  }
}

function recordKindDifferences(state, rel, bucket, matched) {
  for (const item of matched.kindMapped) {
    state.totals.kindMapped += 1;
    pushExample(bucket.KIND_MAPPED, {
      rel,
      name: item.old.name,
      startLine: item.old.startLine,
      oldKind: item.old.kind,
      newKind: item.new.kind,
    });
  }
  for (const item of matched.kindChange) {
    state.totals.kindChange += 1;
    pushExample(bucket.KIND_CHANGE, {
      rel,
      name: item.old.name,
      startLine: item.old.startLine,
      oldKind: item.old.kind,
      newKind: item.new.kind,
    });
  }
}

function recordColumnDrifts(state, rel, bucket, matched) {
  for (const item of matched.colDrift) {
    state.totals.colDrift += 1;
    pushExample(bucket.COL_DRIFT, {
      rel,
      name: item.old.name,
      kind: item.old.kind,
      startLine: item.old.startLine,
      oldCols: [item.old.startCol, item.old.endCol],
      newCols: [item.new.startCol, item.new.endCol],
    });
  }
}

function recordSymbolComparison(state, rel, lang, bucket, matched) {
  recordLossesAndAdditions(state, rel, bucket, matched);
  recordLineMoves(state, rel, lang, matched);
  recordKindDifferences(state, rel, bucket, matched);
  recordColumnDrifts(state, rel, bucket, matched);
}

function recordImportDiff(state, rel, bucket, oldRec, newRec) {
  const raw = setDiff(oldRec.rawImports, newRec.rawImports);
  const resolved = setDiff(oldRec.resolvedImports, newRec.resolvedImports);
  const importCount = raw.missing.length + raw.extra.length + resolved.missing.length + resolved.extra.length;
  if (!importCount) return;
  state.totals.importDiff += importCount;
  pushExample(bucket.IMPORT, { rel, raw, resolved, count: importCount });
}

function recordScalarDiff(state, rel, bucket, oldRec, newRec) {
  const scalarFields = ['lang', 'packageName', 'namespaceName', 'goPackageName'];
  const scalarChanges = [];
  for (const field of scalarFields) {
    if (asStr(oldRec[field]) !== asStr(newRec[field])) {
      scalarChanges.push({ field, old: asStr(oldRec[field]), new: asStr(newRec[field]) });
    }
  }
  if (JSON.stringify(asArray(oldRec.topLevelTypes)) !== JSON.stringify(asArray(newRec.topLevelTypes))) {
    scalarChanges.push({
      field: 'topLevelTypes',
      old: asArray(oldRec.topLevelTypes),
      new: asArray(newRec.topLevelTypes),
    });
  }
  if (!scalarChanges.length) return;
  state.totals.scalar += scalarChanges.length;
  pushExample(bucket.SCALAR, { rel, changes: scalarChanges });
}

function recordParseErrorDiff(state, rel, bucket, oldRec, newRec) {
  if (asStr(oldRec.parseError) === asStr(newRec.parseError)) return;
  state.totals.parseError += 1;
  pushExample(bucket.PARSE_ERROR, {
    rel,
    old: asStr(oldRec.parseError),
    new: asStr(newRec.parseError),
  });
}

function recordTokenDiff(state, rel, bucket, oldRec, newRec) {
  const oldTokens = tokenSet(oldRec, state.declaredNames);
  const newTokens = tokenSet(newRec, state.declaredNames);
  if (oldTokens == null || newTokens == null) return;
  for (const token of [...oldTokens].sort()) {
    if (newTokens.has(token)) continue;
    state.totals.tokenLost += 1;
    pushExample(bucket.TOKEN_LOSS, { rel, token });
  }
  for (const token of [...newTokens].sort()) {
    if (oldTokens.has(token)) continue;
    state.totals.tokenAdded += 1;
    pushExample(bucket.TOKEN_ADD, { rel, token });
  }
}

function compareRecord(state, rel, oldRec, newRec) {
  const lang = langOf(newRec) || langOf(oldRec);
  state.fileLangs[rel] = lang;
  const bucket = languageBucket(state, lang);
  addAdditive(additiveForLanguage(state, lang), newRec);
  const matched = matchSymbols(oldRec.symbols, newRec.symbols, state.kindMap[lang] || null);
  recordSymbolComparison(state, rel, lang, bucket, matched);
  recordImportDiff(state, rel, bucket, oldRec, newRec);
  recordScalarDiff(state, rel, bucket, oldRec, newRec);
  recordParseErrorDiff(state, rel, bucket, oldRec, newRec);
  if (state.compareTokens) recordTokenDiff(state, rel, bucket, oldRec, newRec);
}

export function compareWalks(oldRecords, newRecords, options = {}) {
  const state = createWalkComparisonState(oldRecords, newRecords, options);
  state.unmappedKinds = collectUnmappedKinds(oldRecords, state.kindMap);
  for (const rel of state.rels) {
    const oldRec = state.oldMap.get(rel);
    const newRec = state.newMap.get(rel);
    if (oldRec && !newRec) {
      recordFileOnlyOld(state, rel, oldRec);
      continue;
    }
    if (newRec && !oldRec) {
      recordFileOnlyNew(state, rel, newRec);
      continue;
    }
    compareRecord(state, rel, oldRec, newRec);
  }
  return {
    filesCompared: state.rels.length - state.filesOnlyOld.length - state.filesOnlyNew.length,
    filesOnlyOld: state.filesOnlyOld,
    filesOnlyNew: state.filesOnlyNew,
    fileLangs: state.fileLangs,
    totals: state.totals,
    byLanguage: state.byLanguage,
    additive: state.additive,
    unmappedKinds: state.unmappedKinds,
    lineMoves: state.lineMoves,
    kindMapActive: kindMapActive(state.kindMap),
  };
}

function allowedLangSet(thresholds) {
  const raw = thresholds?.allowNewLanguages;
  if (raw instanceof Set) return raw;
  return new Set(Array.isArray(raw) ? raw : []);
}

export function evaluateGate(report, thresholds) {
  const reasons = [];
  const maxLoss = thresholds.maxSymbolLoss ?? 0;
  const maxImport = thresholds.maxImportDiff ?? 0;
  const maxRatio = thresholds.maxTimeRatio ?? 1.1;
  const maxTokenLoss = thresholds.maxTokenLoss ?? 0;
  const allowed = allowedLangSet(thresholds);
  if (report.totals.loss > maxLoss) {
    reasons.push(`LOSS ${report.totals.loss} > --max-symbol-loss ${maxLoss}`);
  }
  if (report.totals.importDiff > maxImport) {
    reasons.push(`import diffs ${report.totals.importDiff} > --max-import-diff ${maxImport}`);
  }
  if (report.timing && Number.isFinite(report.timing.ratio) && report.timing.ratio > maxRatio) {
    reasons.push(`time ratio ${report.timing.ratio.toFixed(3)} > --max-time-ratio ${maxRatio}`);
  }
  if (report.manifestIdentical === false) {
    reasons.push('manifest output is not byte-identical');
  }
  const failingNew = (report.filesOnlyNew || []).filter((rel) => {
    const lang = report.fileLangs?.[rel];
    return !allowed.has(lang);
  });
  if ((report.filesOnlyOld?.length || 0) + failingNew.length > 0) {
    reasons.push(`files only on one side: old=${report.filesOnlyOld.length} new=${failingNew.length}`);
  }
  if (report.unmappedKinds?.length) {
    const listed = report.unmappedKinds.map((item) => `${item.lang}:${item.kind}`).join(', ');
    reasons.push(`unmapped kind: ${listed}`);
  }
  if (report.kindMapActive && (report.totals.kindChange || 0) > 0) {
    reasons.push(`KIND_CHANGE ${report.totals.kindChange} (not in kind map)`);
  }
  if (thresholds.tokens && (report.totals.tokenLost || 0) > maxTokenLoss) {
    reasons.push(`token loss ${report.totals.tokenLost} > --max-token-loss ${maxTokenLoss}`);
  }
  return reasons;
}

function parseManifestRows(buf) {
  const src = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
  const rows = [];
  for (const line of src.split(/\n/)) {
    if (!line.trim()) continue;
    let rec = null;
    try {
      rec = JSON.parse(line);
    } catch {
      rec = null;
    }
    rows.push({
      line,
      rel: rec && typeof rec.rel === 'string' ? normalizeRel(rec.rel) : line,
      lang: rec && typeof rec.lang === 'string' ? rec.lang : '',
    });
  }
  return rows;
}

/** Remaining (non-allowed-lang) manifest rows must match by rel and raw JSON line. */
export function compareManifests(oldBuf, newBuf, allowedLangs = new Set()) {
  const allowed = allowedLangs instanceof Set ? allowedLangs : new Set(allowedLangs || []);
  const split = (buf) => {
    const kept = [];
    const dropped = [];
    for (const row of parseManifestRows(buf)) {
      if (row.lang && allowed.has(row.lang)) dropped.push(row);
      else kept.push(row);
    }
    return { kept, dropped };
  };
  const oldSide = split(oldBuf);
  const newSide = split(newBuf);
  const oldMap = new Map(oldSide.kept.map((row) => [row.rel, row.line]));
  const newMap = new Map(newSide.kept.map((row) => [row.rel, row.line]));
  let identical = oldMap.size === newMap.size;
  if (identical) {
    for (const [rel, line] of oldMap) {
      if (newMap.get(rel) !== line) {
        identical = false;
        break;
      }
    }
  }
  return {
    identical,
    oldDropped: oldSide.dropped.map((row) => ({ rel: row.rel, lang: row.lang })),
    newDropped: newSide.dropped.map((row) => ({ rel: row.rel, lang: row.lang })),
  };
}

function formatExamples(examples) {
  if (!examples.length) return '';
  return examples.map((ex) => `    - ${JSON.stringify(ex)}`).join('\n');
}

export function formatMarkdown(report) {
  const lines = ['# mixdog-graph extraction parity', ''];
  if (report.old) lines.push(`- old: \`${report.old}\``);
  if (report.new) lines.push(`- new: \`${report.new}\``);
  if (report.root) lines.push(`- root: \`${report.root}\``);
  lines.push(`- files compared: ${report.filesCompared}`);
  lines.push(`- files only on old: ${report.filesOnlyOld.length}`);
  lines.push(`- files only on new: ${report.filesOnlyNew.length}`);
  if (report.allowNewLanguages?.length) {
    const allowed = new Set(report.allowNewLanguages);
    const excludedFiles = (report.filesOnlyNew || []).filter((rel) => allowed.has(report.fileLangs?.[rel])).length;
    const excludedManifest = (report.manifestDroppedNew?.length || 0) + (report.manifestDroppedOld?.length || 0);
    lines.push(`- allow-new-languages: ${report.allowNewLanguages.join(', ')}`);
    lines.push(`- excluded files-only-new: ${excludedFiles}`);
    lines.push(`- excluded manifest rows: ${excludedManifest}`);
  }
  if (report.kindMapPath) {
    lines.push(`- kind-map: \`${report.kindMapPath}\`${report.kindMapActive ? '' : ' (inactive)'}`);
  } else if (report.kindMapSource === 'langs-failed') {
    lines.push('- kind-map: inactive (--langs failed)');
  } else if (report.kindMapSource === 'langs') {
    lines.push(
      report.kindMapActive ? '- kind-map: auto (--langs)' : '- kind-map: inactive (--langs produced no kinds)'
    );
  } else if (report.kindMapSource === 'none' || report.kindMapInactive) {
    lines.push('- kind-map: inactive');
  }
  if (report.tokens) lines.push('- tokens: on');
  if (report.manifestIdentical == null) lines.push('- manifest: (skipped)');
  else if (report.manifestIdentical) {
    lines.push(
      report.manifestRawIdentical === false
        ? '- manifest: identical after --allow-new-languages'
        : '- manifest: identical'
    );
  } else {
    lines.push('- manifest: DIFFERS');
  }
  if (report.timing) {
    lines.push(
      `- timing: old ${report.timing.oldMs.toFixed(1)}ms / new ${report.timing.newMs.toFixed(1)}ms (ratio ${report.timing.ratio.toFixed(3)}, runs=${report.timing.runs})`
    );
  } else {
    lines.push('- timing: (skipped)');
  }
  if (report.reasons?.length) {
    lines.push('- result: **FAIL**');
    for (const reason of report.reasons) lines.push(`  - ${reason}`);
  } else {
    lines.push('- result: **PASS**');
  }
  lines.push('', '## Totals', '');
  lines.push('| category | count |');
  lines.push('|---|---|');
  lines.push(`| LOSS | ${report.totals.loss} |`);
  lines.push(`| ADDITION | ${report.totals.addition} |`);
  lines.push(`| KIND_CHANGE | ${report.totals.kindChange} |`);
  lines.push(`| KIND_MAPPED | ${report.totals.kindMapped || 0} |`);
  lines.push(`| COL_DRIFT | ${report.totals.colDrift} |`);
  lines.push(`| IMPORT | ${report.totals.importDiff} |`);
  lines.push(`| SCALAR | ${report.totals.scalar} |`);
  lines.push(`| PARSE_ERROR | ${report.totals.parseError} |`);
  if (report.tokens) {
    lines.push(`| TOKEN_LOSS | ${report.totals.tokenLost || 0} |`);
    lines.push(`| TOKEN_ADD | ${report.totals.tokenAdded || 0} |`);
  }
  if (report.unmappedKinds?.length) {
    lines.push('', '## Unmapped kinds', '');
    for (const item of report.unmappedKinds) {
      lines.push(`- ${item.lang}: \`${item.kind}\``);
    }
  }
  const additiveLangs = Object.keys(report.additive || {}).sort();
  if (additiveLangs.length) {
    lines.push('', '## Additive fields', '');
    lines.push('| language | symbols | exported | sig | parent | calls |');
    lines.push('|---|---|---|---|---|---|');
    for (const lang of additiveLangs) {
      const a = report.additive[lang];
      lines.push(`| ${lang} | ${a.symbols} | ${a.exported} | ${a.sig} | ${a.parent} | ${a.calls || 0} |`);
    }
  }
  if (report.lineMoves?.length) {
    lines.push('', '## Likely line moves', '');
    lines.push(
      `${report.lineMoves.length} symbol(s) appear as both LOSS and ADDITION on the same file (likely a line move between walks). Still counted as LOSS.`
    );
    for (const item of report.lineMoves.slice(0, EXAMPLE_CAP)) {
      lines.push(`- ${item.rel}: \`${item.name}\``);
    }
  }

  const langs = Object.keys(report.byLanguage).sort();
  for (const lang of langs) {
    const b = report.byLanguage[lang];
    const cats = Object.keys(b);
    const nonempty = cats.filter((c) => b[c].count);
    lines.push('', `## ${lang}`, '');
    if (!nonempty.length) {
      lines.push('- (no diffs)');
      continue;
    }
    for (const cat of cats) {
      const bucket = b[cat];
      if (!bucket.count) continue;
      lines.push(`- ${cat}: ${bucket.count}`);
      const formatted = formatExamples(bucket.examples);
      if (formatted) lines.push(formatted);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function reusedMetaLine(rec) {
  return JSON.stringify({
    rel: rec.rel,
    lang: rec.lang,
    parseError: rec.parseError || '',
    rawImports: asArray(rec.rawImports),
    packageName: rec.packageName || '',
    namespaceName: rec.namespaceName || '',
    goPackageName: rec.goPackageName || '',
    topLevelTypes: asArray(rec.topLevelTypes),
  });
}

function killProcessTree(proc) {
  try {
    proc.kill();
  } catch {
    /* ignore */
  }
  if (process.platform === 'win32' && proc.pid) {
    spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  }
}

export function runProcess(bin, args, { stdinText = null, timeoutMs = SPAWN_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, reject) => {
    const started = performance.now();
    const proc = spawn(bin, args, {
      stdio: [stdinText != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const chunks = [];
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer = null;
    let forceTimer = null;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      fn();
    };
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => {
      if (stderr.length >= 8 * 1024) return;
      const piece = c.toString('utf8');
      stderr += piece.slice(0, 8 * 1024 - stderr.length);
    });
    proc.on('error', (err) => {
      finish(() => reject(err));
    });
    if (stdinText != null && proc.stdin) {
      proc.stdin.on('error', () => {
        /* child may close stdin early */
      });
      try {
        proc.stdin.end(stdinText);
      } catch {
        /* spawn failed before stdin was writable */
      }
    }
    proc.on('close', (code) => {
      finish(() => {
        const ms = performance.now() - started;
        const stdout = Buffer.concat(chunks);
        if (timedOut) {
          reject(new Error(`timed out after ${timeoutMs}ms: ${bin} ${args.join(' ')}`));
          return;
        }
        if (code !== 0) {
          reject(new Error(`${bin} exited ${code}: ${stderr.trim().slice(0, 400)}`));
          return;
        }
        resolvePromise({ stdout, stderr, ms, code });
      });
    });
    timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(proc);
      forceTimer = setTimeout(() => {
        killProcessTree(proc);
        finish(() => {
          reject(new Error(`timed out after ${timeoutMs}ms: ${bin} ${args.join(' ')}`));
        });
      }, FORCE_SETTLE_MS);
    }, timeoutMs);
    if (timer.unref) timer.unref();
  });
}

async function runTimedWalks(bin, root, runs) {
  const times = [];
  let last = null;
  for (let i = 0; i < runs; i += 1) {
    const result = await runProcess(bin, [root]);
    times.push(result.ms);
    last = result;
  }
  return { times, medianMs: median(times), stdout: last.stdout };
}

function kindMapError(message) {
  const err = new Error(message);
  err.exitCode = 2;
  return err;
}

export async function loadKindMap(opts, root, runner = runProcess) {
  if (opts.kindMap) {
    let raw;
    try {
      raw = JSON.parse(readFileSync(opts.kindMap, 'utf8'));
    } catch (err) {
      throw kindMapError(`malformed kind map: ${err?.message || err}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw kindMapError('malformed kind map: expected a JSON object');
    }
    return { map: parseKindMap(raw), source: 'file', path: opts.kindMap };
  }
  if (!opts.new || opts.oldJsonl) {
    return { map: {}, source: null, path: null };
  }
  try {
    const result = await runner(opts.new, [root, '--langs']);
    const map = parseLangsStdout(result.stdout.toString('utf8'));
    return { map, source: 'langs', path: null };
  } catch {
    return { map: {}, source: 'langs-failed', path: null };
  }
}

export async function runParity(opts) {
  const root = resolve(opts.root || '.');
  const jsonlMode = Boolean(opts.oldJsonl && opts.newJsonl);
  const allowNewLanguages = [...new Set(opts.allowNewLanguages || [])];
  const allowedSet = new Set(allowNewLanguages);
  let oldRecords;
  let newRecords;
  let timing = null;
  let manifestIdentical = null;
  let manifestRawIdentical = null;
  let oldManifest = null;
  let newManifest = null;
  let manifestDroppedNew = [];
  let manifestDroppedOld = [];
  const loadedKinds = await loadKindMap(opts, root);

  if (jsonlMode) {
    oldRecords = parseJsonl(readFileSync(opts.oldJsonl));
    newRecords = parseJsonl(readFileSync(opts.newJsonl));
  } else {
    const oldWalk = await runTimedWalks(opts.old, root, opts.runs);
    const newWalk = await runTimedWalks(opts.new, root, opts.runs);
    let ratio = 1;
    if (oldWalk.medianMs > 0) ratio = newWalk.medianMs / oldWalk.medianMs;
    else if (newWalk.medianMs > 0) ratio = Infinity;
    timing = {
      oldMs: oldWalk.medianMs,
      newMs: newWalk.medianMs,
      ratio,
      runs: opts.runs,
      oldTimes: oldWalk.times,
      newTimes: newWalk.times,
    };
    oldRecords = parseJsonl(oldWalk.stdout);
    newRecords = parseJsonl(newWalk.stdout);

    const oldMan = await runProcess(opts.old, [root, '--manifest']);
    const newMan = await runProcess(opts.new, [root, '--manifest']);
    oldManifest = oldMan.stdout;
    newManifest = newMan.stdout;
    manifestRawIdentical = Buffer.compare(oldMan.stdout, newMan.stdout) === 0;
    if (manifestRawIdentical) {
      manifestIdentical = true;
    } else {
      const filtered = compareManifests(oldMan.stdout, newMan.stdout, allowedSet);
      manifestIdentical = filtered.identical;
      manifestDroppedNew = filtered.newDropped;
      manifestDroppedOld = filtered.oldDropped;
    }

    if (opts.files?.length) {
      const files = opts.files.map(normalizeRel);
      const fileSet = new Set(files);
      const reused = oldRecords.filter((rec) => !fileSet.has(normalizeRel(rec.rel))).map(reusedMetaLine);
      const stdinText = reused.length ? `${reused.join('\n')}\n` : '';
      const oldFiles = await runProcess(opts.old, [root, '--files', ...files], { stdinText });
      const newFiles = await runProcess(opts.new, [root, '--files', ...files], { stdinText });
      oldRecords = parseJsonl(oldFiles.stdout);
      newRecords = parseJsonl(newFiles.stdout);
    }
  }

  const compared = compareWalks(oldRecords, newRecords, {
    kindMap: loadedKinds.map,
    tokens: Boolean(opts.tokens),
  });
  const report = {
    old: opts.old || opts.oldJsonl,
    new: opts.new || opts.newJsonl,
    root: jsonlMode ? null : root,
    files: opts.files || [],
    allowNewLanguages,
    tokens: Boolean(opts.tokens),
    kindMapPath: loadedKinds.path,
    kindMapSource: loadedKinds.source,
    kindMap: loadedKinds.map,
    manifestIdentical,
    manifestRawIdentical,
    manifestDroppedNew,
    manifestDroppedOld,
    timing,
    ...compared,
  };
  report.kindMapActive = compared.kindMapActive;
  report.reasons = evaluateGate(report, opts);
  report.ok = report.reasons.length === 0;
  if (oldManifest) report.oldManifestBytes = oldManifest.length;
  if (newManifest) report.newManifestBytes = newManifest.length;
  const markdown = formatMarkdown(report);
  return { report, markdown, exitCode: report.ok ? 0 : 1 };
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg === 'help') {
      process.stdout.write(`${USAGE}\n`);
      process.exitCode = 0;
      return 0;
    }
    process.stderr.write(`graph-parity: ${msg}\n${USAGE}\n`);
    process.exitCode = 2;
    return 2;
  }
  try {
    const { markdown, exitCode, report } = await runParity(opts);
    process.stdout.write(markdown.endsWith('\n') ? markdown : `${markdown}\n`);
    if (opts.json) {
      writeFileSync(opts.json, `${JSON.stringify(report, null, 2)}\n`);
    }
    process.exitCode = exitCode;
    return exitCode;
  } catch (err) {
    const code = err?.exitCode === 2 ? 2 : 1;
    process.stderr.write(
      code === 2 ? `graph-parity: ${err.message}\n${USAGE}\n` : `graph-parity: ${err?.stack || err?.message || err}\n`
    );
    process.exitCode = code;
    return code;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
