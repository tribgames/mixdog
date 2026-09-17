// Observed tool-use shape → one short model-facing reminder.
//
// Two shapes recur per model in agent traces although the shared rules and
// the tool descriptions already state the batching contract: one tool call
// per model round (Gemini 3.8 Flash: 105/105 rounds single-call, 0/69 array
// arguments) and one round of N same-tool calls that differ only in the
// tool's array field (Grok 4.6: read×3, grep×2 … with 0/116 arrays). The
// reminder repeats the contract only after the transcript shows it being
// ignored, so a model that batches never reads it.
import { ARRAY_INPUTS, ARRAY_SURFACE } from '../tools/tool-batch-trace.mjs';
import { _isMutationTool, _stripMcpPrefix } from './loop/tool-classify.mjs';

// Three single-call rounds of the same tool in a row, each of which could
// have shared the previous response, establish the serial pattern (read →
// read → read, grep → grep → grep, edit → edit → edit). A round counts only
// when its call did not need the round before it: none of its arguments came
// out of that round's result and it is not a step ordered behind a mutation.
// A different tool restarts the streak — read → shell → apply_patch is a
// workflow, not a waste — and any batched round (several calls, or one call
// carrying an array) clears it.
export const SERIAL_CALL_ROUNDS = 3;
// Two same-tool calls that differ only in one array field already fit one call.
export const MERGEABLE_CALLS_MIN = 2;
// No cap and no cooldown: the reminder repeats every time a pattern recurs,
// and only a round that actually batches silences it.

// Single calls that are sequential by nature: waiting on a task, Computer Use
// (one call per turn is enforced), stateful browser steps, and loading a
// schema or skill body the next call depends on.
const SERIAL_BY_NATURE = new Set(['task', 'load_tool', 'tool_search', 'skill', 'computer', 'browser']);
// A route may also declare a one-line `round-reminder:` (rules/routes/*.md)
// for model families that plan the first response well but go one call at a
// time once tool results arrive (recorded Gemini 3.8 Flash: every round after
// the first single-call, on both transports, with the rules in the system
// prompt and the replayed history intact). The agent loop resolves it and
// this channel appends it after every single-call round that neither batched
// nor earned the serial reminder, unless the provider delivers it itself as
// a turn-scoped system message. A round whose arguments came out of the
// round before it could not have joined it, so it stays silent there too —
// the same exemption the serial streak already makes.
const EDIT_TOOLS = new Set(['edit', 'apply_patch']);
// Argument strings shorter than this ('a', 'ok') prove nothing about provenance.
const PROVENANCE_MIN_LENGTH = 3;
const RESULT_TEXT_CAP = 200_000;
// Tools whose results are locations. A round that reads one of the files they
// just located, one window at a time, gets the located set back as one read.
const LOCATING_TOOLS = new Set(['grep', 'code_graph', 'glob', 'find', 'list']);
const READ_TOOL = 'read';
const SITE_ANCHOR = /^(?:# )?((?:[A-Za-z]:)?[^\s:*?"<>|]+\.[A-Za-z0-9]{1,6}):(\d+)(?=[:\s]|$)/;
const SITE_RANGE = /\[lines (\d+)-(\d+)\]/;
const SITE_PATH_ONLY = /^((?:[A-Za-z]:)?[^\s:*?"<>|]+\.[A-Za-z0-9]{1,6})$/;
// code_graph file sections (`# symbols path`) whose rows carry `(Lstart-end)`.
const SITE_SECTION = /^# [a-z_]+ ((?:[A-Za-z]:)?[^\s:*?"<>|]+\.[A-Za-z0-9]{1,6})$/;
const SITE_ROW_RANGE = /\(L(\d+)-(\d+)\)/;
const SITES_MAX = 40;
// read takes ≤10 entries per call; more sites → several calls in one response.
const SITE_ENTRIES_MAX = 10;
const SITE_LEAD_LINES = 20;
const SITE_TRAIL_LINES = 40;
// Providers whose flattened read schema takes plain path strings only.
const PATH_STRING_ONLY_PROVIDER = /grok|xai/i;

// The most recent rounds per session, newest first: their calls and what came
// back. Several are kept so that a name an earlier round already revealed (a
// file list, a status) is not credited to the last round when the model
// walks that list one item per round. Process-local on purpose — persisting
// this would store whole tool results with every session; after a restart the
// first round simply starts a new streak.
const ROUNDS_REMEMBERED = 6;
const roundHistory = new WeakMap();

function toolName(call) {
  return String(_stripMcpPrefix(call?.name) || '');
}

function callArguments(call) {
  const value = call?.arguments;
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function countsAsSerialCall(call) {
  const name = toolName(call);
  return Boolean(name) && !SERIAL_BY_NATURE.has(name.toLowerCase());
}

function resultText(results) {
  const parts = [];
  for (const result of Array.isArray(results) ? results : []) {
    const content = result && typeof result === 'object' && 'content' in result ? result.content : result;
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content)) {
      for (const part of content) if (typeof part?.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('\n').slice(0, RESULT_TEXT_CAP);
}

// Strings an argument set could have taken from a tool result: every string
// value and, for path-like tokens inside it, the file name (a read of
// `src/b.mjs` after a result mentioning `./b.mjs` or `b.mjs` is provenance).
// Separators are normalized so a Windows path a result printed with
// backslashes still matches the argument the model wrote with slashes.
function provenanceCandidates(args) {
  const out = new Set();
  const visit = (value) => {
    if (typeof value === 'string') {
      const text = value.trim().replace(/\\/g, '/');
      if (text.length >= PROVENANCE_MIN_LENGTH) out.add(text);
      for (const raw of text.split(/\s+/)) {
        const token = raw.replace(/^["'`(]+|["'`,;:)]+$/g, '');
        const isPath = token.includes('/');
        if (!isPath && !/\.[A-Za-z0-9]{1,6}$/.test(token)) continue;
        // A path inside a longer argument (`rg -l x C:/app/dir`) counts as a
        // whole, and by its file name.
        if (isPath && token.length >= PROVENANCE_MIN_LENGTH) out.add(token);
        const base = token.split('/').pop();
        if (base.length >= PROVENANCE_MIN_LENGTH) out.add(base);
      }
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(args);
  return out;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A result mentions a candidate only as a whole token: not inside a longer
// word, and — for a bare name — not as a directory prefix of a longer path
// (`src` in `src/x.mjs` is the scope the call was given, not something the
// result revealed). A candidate that is itself a path may continue into a
// deeper one: a result that printed `…/Programs/mixdog-desktop/Mixdog.exe`
// revealed `…/Programs/mixdog-desktop` too. Either separator matches.
function mentions(text, candidate) {
  const isPath = candidate.includes('/');
  const token = escapeRegExp(candidate).replace(/\//g, '[\\\\/]');
  const trailing = isPath ? '(?![\\w-])' : '(?![\\w\\-\\\\/])';
  return new RegExp(`(?<![\\w-])${token}${trailing}`).test(text);
}

// Did this call need the previous round? Provenance (an argument the previous
// result revealed), or ordering behind a mutation. Not provenance: arguments
// a remembered call already carried (a shared grep scope, the same file with
// another window) and names the round before last had already shown — those
// were known before the previous round ran, so the call could have joined
// it. An edit after an edit is ordered only when it targets text the
// previous edit created.
function dependsOnPrevious(call, history) {
  const [last, ...older] = history;
  if (!last) return false;
  const name = toolName(call);
  const args = callArguments(call);
  const previous = last.calls.length === 1 ? last.calls[0] : null;
  if (EDIT_TOOLS.has(name) && previous && EDIT_TOOLS.has(previous.name)) {
    const created = previous.args?.new_string;
    const target = args?.old_string;
    return typeof created === 'string' && typeof target === 'string' && target.length > 0 && created.includes(target);
  }
  if (last.mutating && !EDIT_TOOLS.has(name)) return true;
  const known = new Set();
  for (const round of history) {
    for (const prior of round.calls) for (const candidate of provenanceCandidates(prior.args)) known.add(candidate);
  }
  for (const candidate of provenanceCandidates(args)) {
    if (known.has(candidate) || !mentions(last.text, candidate)) continue;
    if (older.some((round) => mentions(round.text, candidate))) continue;
    return true;
  }
  return false;
}

// `path:line` anchors (grep blocks, code_graph rows) and bare path lines
// (glob, find) in a locating tool's result, grouped per file.
function locatedSites(described, text) {
  if (!described.some((item) => LOCATING_TOOLS.has(item.name))) return null;
  const byFile = new Map();
  let count = 0;
  let section = null;
  const add = (file, span) => {
    const site = byFile.get(file) || { file, spans: [] };
    if (span) site.spans.push(span);
    byFile.set(file, site);
    count += 1;
  };
  for (const raw of text.split('\n')) {
    if (count >= SITES_MAX) break;
    const line = raw.trim();
    const header = SITE_SECTION.exec(line);
    if (header) {
      section = header[1].replace(/\\/g, '/');
      continue;
    }
    const anchor = SITE_ANCHOR.exec(line);
    if (anchor) {
      const range = SITE_RANGE.exec(line);
      const at = Number(anchor[2]);
      add(anchor[1].replace(/\\/g, '/'), range ? [Number(range[1]), Number(range[2])] : [at, at]);
      continue;
    }
    const row = section ? SITE_ROW_RANGE.exec(line) : null;
    if (row) {
      add(section, [Number(row[1]), Number(row[2])]);
      continue;
    }
    const pathOnly = SITE_PATH_ONLY.exec(line);
    if (pathOnly) add(pathOnly[1].replace(/\\/g, '/'), null);
  }
  return byFile.size ? { count, files: [...byFile.values()] } : null;
}

function rememberRound(sessionRef, calls, results) {
  const described = calls.map((call) => ({ name: toolName(call), args: callArguments(call) }));
  const text = resultText(results);
  const entry = {
    calls: described,
    text,
    mutating: described.some((item) => _isMutationTool(item.name, item.args)),
    sites: locatedSites(described, text),
  };
  roundHistory.set(sessionRef, [entry, ...(roundHistory.get(sessionRef) || [])].slice(0, ROUNDS_REMEMBERED));
}

function readTargets(args) {
  const raw = args?.file_path ?? args?.path;
  const values = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const value of values) {
    const target = typeof value === 'string' ? value : value && typeof value === 'object' ? value.file_path ?? value.path : null;
    if (typeof target === 'string' && target.trim()) out.push(target.trim().replace(/\\/g, '/'));
  }
  return out;
}

function baseName(file) {
  return file.split('/').pop();
}

// One window per site (a lead above, a trail below), overlapping windows of a
// file merged — never the whole file.
function siteWindows(site) {
  if (!site.spans.length) return [{ file_path: site.file }];
  const windows = [];
  for (const [start, end] of [...site.spans].sort((a, b) => a[0] - b[0])) {
    const from = Math.max(1, start - SITE_LEAD_LINES);
    const to = end + SITE_TRAIL_LINES;
    const last = windows[windows.length - 1];
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else windows.push({ from, to });
  }
  return windows.map((window) => ({ file_path: site.file, offset: window.from, limit: window.to - window.from + 1 }));
}

function describeWindow(entry) {
  return entry.offset ? `${entry.file_path} offset:${entry.offset} limit:${entry.limit}` : entry.file_path;
}

// One single-file read right after a locating round that returned several
// files: hand the located set back in the shape one read call takes.
function locatedSitesNudge(call, history, sessionRef) {
  const last = history[0];
  const sites = last?.sites;
  if (!sites || sites.files.length < 2 || toolName(call) !== READ_TOOL) return null;
  const targets = readTargets(callArguments(call));
  if (targets.length !== 1) return null;
  const located = new Set(sites.files.map((site) => baseName(site.file)));
  if (!located.has(baseName(targets[0]))) return null;
  const entries = sites.files.flatMap(siteWindows);
  const chunks = [];
  for (let i = 0; i < entries.length; i += SITE_ENTRIES_MAX) chunks.push(entries.slice(i, i + SITE_ENTRIES_MAX));
  const asEntries = !PATH_STRING_ONLY_PROVIDER.test(String(sessionRef.provider || ''));
  let shape;
  if (!asEntries) shape = `one read per window, all in the same response: ${entries.map(describeWindow).join(', ')}`;
  else if (chunks.length === 1) shape = `one read call: read ${JSON.stringify(chunks[0])}`;
  else shape = `${chunks.length} read calls in the same response: ${chunks.map((c) => `read ${JSON.stringify(c)}`).join('; ')}`;
  return {
    trigger: 'located_sites',
    tools: [READ_TOOL],
    text:
      `Tool batching: ${sites.count} sites in ${sites.files.length} files were located; this round read one file. ` +
      `Read all in one response — ${shape} — then every edit in one response.`,
  };
}

// A locating round right after a read, with no argument taken from what was
// read: the search could have run before the read.
function lateLocatingNudge(calls, history) {
  const last = history[0];
  if (!last || last.mutating || !last.calls.some((item) => item.name === READ_TOOL)) return null;
  const names = calls.map(toolName);
  if (!names.length || !names.every((name) => LOCATING_TOOLS.has(name))) return null;
  const known = new Set();
  for (const round of history) {
    for (const prior of round.calls) for (const candidate of provenanceCandidates(prior.args)) known.add(candidate);
  }
  for (const call of calls) {
    for (const candidate of provenanceCandidates(callArguments(call))) {
      if (!known.has(candidate) && mentions(last.text, candidate)) return null;
    }
  }
  return {
    trigger: 'late_locating',
    tools: names,
    text: 'Tool order: this search could have run before the last read. Locate every site first, then one read over all of them.',
  };
}

function carriesArray(call) {
  const fields = ARRAY_INPUTS.get(toolName(call));
  if (!fields) return false;
  const args = callArguments(call);
  return fields.some((field) => Array.isArray(args[field]) && args[field].length > 1);
}

// A scalar, or a one-element array standing in for one (providers whose
// schemas only take arrays send every single target that way).
function singleTarget(value) {
  if (typeof value === 'string') return value;
  return Array.isArray(value) && value.length === 1 && typeof value[0] === 'string' ? value[0] : null;
}

// Calls to one array-capable tool whose arguments are identical except for
// a single target in one of its array fields. Every other argument must
// match, so two grep calls with different scopes are never reported as one.
function mergeableGroups(calls) {
  const groups = new Map();
  for (const call of calls) {
    const name = toolName(call);
    const fields = ARRAY_INPUTS.get(name);
    if (!fields) continue;
    const args = callArguments(call);
    for (const field of fields) {
      if (singleTarget(args[field]) === null) continue;
      const rest = { ...args };
      delete rest[field];
      const key = stableJson([name, field, rest]);
      const group = groups.get(key) || { name, field, count: 0 };
      group.count += 1;
      groups.set(key, group);
    }
  }
  return [...groups.values()].filter((group) => group.count >= MERGEABLE_CALLS_MIN);
}

function arrayHints(tools) {
  const names = new Set((Array.isArray(tools) ? tools : []).map((tool) => String(_stripMcpPrefix(tool?.name) || '')));
  return [...ARRAY_SURFACE].filter(([name]) => names.has(name)).map(([, surface]) => surface.hint);
}

function serialText(names, hints) {
  const edits = names.some((name) => EDIT_TOOLS.has(name)) ? ' Edits to different files or regions go together too.' : '';
  const arrays = hints.length ? ` Several targets → array argument (${hints.join(', ')}).` : '';
  return (
    `Tool batching: the last ${names.length} rounds were single calls (${names.join(', ')}) that did not need the previous result; ` +
    `send such calls together in one response.${edits}${arrays}`
  );
}

function mergeableText(groups, hints) {
  const described = groups
    .map((group) => `${group.count} \`${group.name}\` calls differing only in \`${group.field}\``)
    .join('; ');
  const arrays = hints.length ? ` Array arguments here: ${hints.join(', ')}.` : '';
  return `Tool batching: this round issued ${described}; one call with that field as an array.${arrays}`;
}

function nudgeState(sessionRef) {
  const current = sessionRef.batchingNudge;
  if (current && typeof current === 'object' && Array.isArray(current.serial)) {
    if (typeof current.perRound !== 'number') current.perRound = 0;
    return current;
  }
  sessionRef.batchingNudge = { serial: [], nudges: 0, perRound: 0 };
  return sessionRef.batchingNudge;
}

/**
 * Record one completed tool round. Returns `{ trigger, tools, text }` when a
 * reminder is due, else null. State lives on the session so it survives
 * process restarts with the transcript it describes.
 */
export function observeToolBatchForNudge({ sessionRef, calls, results, tools, reminder = null }) {
  if (!sessionRef || typeof sessionRef !== 'object' || !Array.isArray(calls) || !calls.length) return null;
  const state = nudgeState(sessionRef);
  const hints = arrayHints(tools);
  const history = roundHistory.get(sessionRef) || [];
  rememberRound(sessionRef, calls, results);
  let nudge = null;
  if (calls.length === 1) {
    const call = calls[0];
    const name = toolName(call);
    // An array inside the call merges targets of one tool; it says nothing
    // about whether the round itself could have joined the previous one, so
    // the streak runs through array-carrying single calls like any other.
    if (!countsAsSerialCall(call)) {
      state.serial = [];
    } else if (state.serial.length && (state.serial[0] !== name || dependsOnPrevious(call, history))) {
      // Another tool, or a legitimately ordered step: the streak restarts here.
      state.serial = [name];
    } else {
      state.serial.push(name);
      if (state.serial.length >= SERIAL_CALL_ROUNDS) {
        nudge = { trigger: 'serial_calls', tools: state.serial.slice(), text: serialText(state.serial, hints) };
      }
    }
    if (!nudge && !carriesArray(call)) nudge = locatedSitesNudge(call, history, sessionRef);
    if (!nudge) nudge = lateLocatingNudge(calls, history);
    const line = typeof reminder === 'string' ? reminder.trim() : '';
    if (!nudge && line && countsAsSerialCall(call) && !carriesArray(call) && !dependsOnPrevious(call, history)) {
      // The streak is untouched: the serial reminder stays the stronger signal.
      state.perRound += 1;
      return { trigger: 'per_round', tools: [toolName(call)], text: line };
    }
  } else {
    state.serial = [];
    const groups = mergeableGroups(calls);
    if (groups.length) {
      nudge = {
        trigger: 'same_tool_scalars',
        tools: groups.map((group) => group.name),
        text: mergeableText(groups, hints),
      };
    }
    if (!nudge) nudge = lateLocatingNudge(calls, history);
  }
  if (!nudge) return null;
  // Only a serial verdict resets the streak; the order reminders leave it alone.
  if (nudge.trigger === 'serial_calls' || nudge.trigger === 'same_tool_scalars') state.serial = [];
  state.nudges += 1;
  return nudge;
}

// Same channel as the PostToolBatch hook: a runtime-authored user message
// after the round's tool results. `<system-reminder>`-only content is
// classified as protected context, never as the human's instruction.
export function batchingNudgeMessage(nudge) {
  return {
    role: 'user',
    content: `<system-reminder>\n${nudge.text}\n</system-reminder>`,
    meta: { source: 'batching-nudge' },
  };
}
