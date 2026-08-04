#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function usage() {
  console.error('usage: node harness/score-grep-terminal.mjs [--json] [--manifest path] <run-dir> [run-dir...]');
  process.exit(2);
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const jsonMode = process.argv.includes('--json');
const manifestPath = resolve(argValue('--manifest', join(HERE, 'grep-terminal-corpus.json')));
const consumed = new Set(['--json']);
const manifestIndex = process.argv.indexOf('--manifest');
if (manifestIndex >= 0) {
  consumed.add('--manifest');
  consumed.add(process.argv[manifestIndex + 1]);
}
const runDirs = process.argv.slice(2)
  .filter((value) => !consumed.has(value))
  .map((value) => resolve(value));
if (!runDirs.length || !existsSync(manifestPath)) usage();

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.tasks)) {
  throw new Error(`unsupported grep-terminal manifest: ${manifestPath}`);
}
const expected = new Map(manifest.tasks.map((task) => [
  task.name,
  { ...task, attempts: Number(task.attempts) > 0 ? Number(task.attempts) : 1 },
]));

function taskName(value) {
  return String(value || '').replace(/^terminal-bench\//, '');
}

function toolCalls(transcript) {
  const calls = [];
  const byId = new Map();
  for (let messageIndex = 0; messageIndex < (transcript.messages || []).length; messageIndex += 1) {
    const message = transcript.messages[messageIndex];
    for (const call of message.toolCalls || []) {
      const entry = {
        messageIndex,
        id: call.id,
        name: call.name,
        args: call.arguments || {},
        result: '',
        kind: null,
      };
      calls.push(entry);
      byId.set(call.id, entry);
    }
    if (message.role === 'tool' && byId.has(message.toolCallId)) {
      const entry = byId.get(message.toolCallId);
      entry.result = String(message.content || '');
      entry.kind = message.toolKind || null;
    }
  }
  return calls;
}

function contentGrep(call) {
  const mode = String(call.args?.output_mode || call.args?.mode || 'content_with_context');
  return call.name === 'grep'
    && call.kind !== 'error'
    && !['files_with_matches', 'count'].includes(mode)
    && call.result.trim().length > 0
    && !call.result.startsWith('Error:');
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').toLowerCase();
}

function contextHeader(line) {
  const match = /^# (.+):(\d+) \[lines (\d+)-(\d+)\]$/.exec(String(line || ''));
  if (!match) return null;
  const start = Number(match[3]);
  const end = Number(match[4]);
  return Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start
    ? { path: normalizePath(match[1]), start, end, sourceLineCount: end - start + 1 }
    : null;
}

function grepCoverage(call) {
  const coverage = new Map();
  const rawPath = call.args?.path;
  const argumentPaths = (Array.isArray(rawPath) ? rawPath : [rawPath])
    .filter((value) => typeof value === 'string')
    .map(normalizePath);
  const alignPath = (value) => {
    const normalized = normalizePath(value);
    const candidates = new Set();
    for (const argumentPath of argumentPaths) {
      const base = argumentPath.split('/').at(-1);
      const parent = argumentPath.slice(0, Math.max(0, argumentPath.length - base.length)).replace(/\/+$/, '');
      if (normalized === argumentPath || argumentPath.endsWith(`/${normalized}`)) candidates.add(argumentPath);
      else if (normalized === base || normalized.startsWith(`${base}/`)) {
        candidates.add(`${parent}/${normalized}`.replace(/\/+/g, '/'));
      }
    }
    return candidates.size === 1 ? [...candidates][0] : normalized;
  };
  let sectionPath = null;
  let rawSourceLinesRemaining = 0;
  const add = (path, start, end = start) => {
    const normalized = alignPath(path);
    if (!normalized || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return;
    if (!coverage.has(normalized)) coverage.set(normalized, []);
    coverage.get(normalized).push({ start, end });
  };
  for (const line of call.result.split(/\r?\n/)) {
    if (rawSourceLinesRemaining > 0) {
      rawSourceLinesRemaining -= 1;
      continue;
    }
    const header = contextHeader(line);
    if (header) {
      add(header.path, header.start, header.end);
      rawSourceLinesRemaining = header.sourceLineCount;
      continue;
    }
    const section = /^# grep (.+)$/.exec(line);
    if (section) {
      if (!section[1].startsWith('pattern:')) sectionPath = normalizePath(section[1]);
      continue;
    }
    const anchored = /^(.+?)(?::(\d+):|-(\d+)-)/.exec(line);
    if (anchored) add(anchored[1], Number(anchored[2] || anchored[3]));
    else {
      const omitted = /^(\d+)(?::|-)/.exec(line);
      if (omitted) {
        const paths = sectionPath ? [sectionPath] : argumentPaths;
        for (const path of paths) add(path, Number(omitted[1]));
      }
    }
  }
  return coverage;
}

function readRanges(call) {
  const raw = call.args?.path;
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map((value) => {
    const path = typeof value === 'string' ? value : value && typeof value.path === 'string' ? value.path : null;
    if (!path) return null;
    const rawOffset = typeof value === 'object' && value ? value.offset : call.args?.offset;
    const rawLimit = typeof value === 'object' && value ? value.limit : call.args?.limit;
    const offset = Number.isFinite(Number(rawOffset)) && Number(rawOffset) >= 0 ? Math.floor(Number(rawOffset)) : 0;
    const limit = Number.isFinite(Number(rawLimit)) && Number(rawLimit) > 0 ? Math.floor(Number(rawLimit)) : Infinity;
    const start = offset + 1;
    return { path: normalizePath(path), start, end: limit === Infinity ? Infinity : start + limit - 1 };
  }).filter(Boolean);
}

function readCoveredByCoverage(call, coverage) {
  return readRanges(call).some((read) => {
    if (read.end === Infinity) return false;
    const ranges = [...(coverage.get(read.path) || [])]
      .sort((left, right) => left.start - right.start || left.end - right.end);
    let nextLine = read.start;
    for (const seen of ranges) {
      if (seen.end < nextLine) continue;
      if (seen.start > nextLine) return false;
      nextLine = Math.max(nextLine, seen.end + 1);
      if (nextLine > read.end) return true;
    }
    return false;
  });
}

function mergeCoverage(target, source) {
  for (const [path, ranges] of source) {
    if (!target.has(path)) target.set(path, []);
    target.get(path).push(...ranges);
  }
}

function scoreTrial(dir) {
  const resultPath = join(dir, 'result.json');
  const transcriptPath = join(dir, 'agent', 'session-transcript.json');
  if (!existsSync(resultPath) || !existsSync(transcriptPath)) return null;
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  const name = taskName(result.task_name);
  if (!expected.has(name)) return null;
  const transcript = JSON.parse(readFileSync(transcriptPath, 'utf8'));
  const calls = toolCalls(transcript);
  const retrievalNames = new Set(['grep', 'read', 'code_graph']);
  const retrievals = calls.filter((call) => retrievalNames.has(call.name));
  const successfulContextGreps = calls.filter(contentGrep);
  let coveredContextReads = 0;
  let activeCoverage = new Map();
  for (const call of calls) {
    if (['apply_patch', 'edit', 'edit_many', 'write'].includes(call.name)) {
      activeCoverage = new Map();
      continue;
    }
    if (contentGrep(call)) {
      mergeCoverage(activeCoverage, grepCoverage(call));
      continue;
    }
    if (call.name === 'read' && call.kind !== 'error') {
      if (readCoveredByCoverage(call, activeCoverage)) coveredContextReads += 1;
    }
  }
  const firstRetrieval = retrievals[0] || null;
  const lastRetrieval = retrievals.at(-1) || null;
  const grepTerminal = Boolean(lastRetrieval && contentGrep(lastRetrieval));
  const firstPatchIndex = calls.findIndex((call) => call.name === 'apply_patch');
  const prePatchRetrievals = firstPatchIndex < 0
    ? []
    : calls.slice(0, firstPatchIndex).filter((call) => retrievalNames.has(call.name));
  const grepToPatch = firstPatchIndex >= 0 && contentGrep(prePatchRetrievals.at(-1) || {});
  const verifierPass = Number(result.verifier_result?.rewards?.reward) === 1;
  const spec = expected.get(name);
  const kind = spec.kind;
  const retrievalOutputChars = retrievals.reduce((sum, call) => sum + call.result.length, 0);
  const retrievalOutputCharBudget = Number(
    spec.maxRetrievalOutputChars ?? manifest.maxRetrievalOutputChars ?? Infinity,
  );
  const retrievalBudgetPass = retrievalOutputChars <= retrievalOutputCharBudget;
  const contractPass = kind === 'control'
    ? verifierPass && successfulContextGreps.length === 0 && retrievalBudgetPass
    : verifierPass && firstRetrieval?.name === 'grep' && coveredContextReads === 0 && retrievalBudgetPass;
  return {
    trial: dir.split(/[\\/]/).at(-1),
    task: name,
    kind,
    verifierPass,
    contractPass,
    grepFirst: firstRetrieval?.name === 'grep',
    grepTerminal,
    grepToPatch,
    coveredContextReads,
    retrievalOutputChars,
    retrievalOutputCharBudget,
    retrievalBudgetPass,
    grepCalls: calls.filter((call) => call.name === 'grep').length,
    readCalls: calls.filter((call) => call.name === 'read').length,
    toolCalls: calls.length,
  };
}

const trials = [];
for (const runDir of runDirs) {
  if (!existsSync(runDir) || !statSync(runDir).isDirectory()) {
    throw new Error(`run directory not found: ${runDir}`);
  }
  for (const entry of readdirSync(runDir)) {
    const trialDir = join(runDir, entry);
    if (!statSync(trialDir).isDirectory()) continue;
    const scored = scoreTrial(trialDir);
    if (scored) trials.push(scored);
  }
}

const byTask = new Map();
for (const trial of trials) {
  if (!byTask.has(trial.task)) byTask.set(trial.task, []);
  byTask.get(trial.task).push(trial);
}
const missing = [...expected.keys()].filter((name) => !byTask.has(name));
if (missing.length) throw new Error(`missing corpus tasks: ${missing.join(', ')}`);
for (const [name, spec] of expected) {
  const count = byTask.get(name)?.length || 0;
  if (count !== spec.attempts) {
    throw new Error(`expected ${spec.attempts} trial(s) for ${name}, found ${count}`);
  }
}

const ordered = [...expected.keys()].flatMap((name) => (
  [...byTask.get(name)].sort((left, right) => left.trial.localeCompare(right.trial))
));
const summary = {
  tasks: ordered.length,
  verifierPass: ordered.filter((trial) => trial.verifierPass).length,
  contractPass: ordered.filter((trial) => trial.contractPass).length,
  positiveGrepTerminal: ordered.filter((trial) => trial.kind === 'positive' && trial.grepTerminal).length,
  positiveDuplicateFree: ordered.filter((trial) => trial.kind === 'positive' && trial.coveredContextReads === 0).length,
  positiveTasks: ordered.filter((trial) => trial.kind === 'positive').length,
  coveredContextReads: ordered.reduce((sum, trial) => sum + trial.coveredContextReads, 0),
  retrievalBudgetPass: ordered.filter((trial) => trial.retrievalBudgetPass).length,
  maxRetrievalOutputChars: Math.max(0, ...ordered.map((trial) => trial.retrievalOutputChars)),
  controlFalsePositives: ordered.filter((trial) => trial.kind === 'control' && trial.grepCalls > 0).length,
};
const output = { manifest: manifestPath, runDirs, summary, trials: ordered };

if (jsonMode) {
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log(`grep-efficiency corpus: verifier ${summary.verifierPass}/${summary.tasks}, contract ${summary.contractPass}/${summary.tasks}`);
  console.log(`positive duplicate-free ${summary.positiveDuplicateFree}/${summary.positiveTasks}, terminal ${summary.positiveGrepTerminal}/${summary.positiveTasks}, covered reads ${summary.coveredContextReads}, retrieval budget ${summary.retrievalBudgetPass}/${summary.tasks}`);
  for (const trial of ordered) {
    console.log(`- ${trial.trial}: verify=${trial.verifierPass ? 'pass' : 'fail'} contract=${trial.contractPass ? 'pass' : 'fail'} grep=${trial.grepCalls} read=${trial.readCalls} terminal=${trial.grepTerminal} covered-read=${trial.coveredContextReads} retrieval-chars=${trial.retrievalOutputChars}/${trial.retrievalOutputCharBudget}`);
  }
}
