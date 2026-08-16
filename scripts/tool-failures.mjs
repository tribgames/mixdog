#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { classifyToolFailure } from '../src/runtime/agent/orchestrator/agent-trace-format.mjs';

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const pref = `${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}

const limit = Math.max(1, Number.parseInt(argValue('--limit', '40'), 10) || 40);
const dataDir = argValue('--data-dir', null);
const mixdogHome = process.env.MIXDOG_HOME || resolve(homedir(), '.mixdog');
const mixdogDataDir = process.env.MIXDOG_DATA_DIR || resolve(mixdogHome, 'data');
const sinceArg = argValue('--since', null);
const toolFilter = argValue('--tool', null);
const agentFilter = argValue('--agent', null);
const categoryFilter = argValue('--category', null);
const jsonMode = process.argv.includes('--json');
const files = dataDir
  ? [resolve(dataDir, 'history', 'tool-failures.jsonl')]
    : [
      resolve(process.cwd(), '.mixdog', 'data', 'history', 'tool-failures.jsonl'),
      resolve(mixdogDataDir, 'history', 'tool-failures.jsonl'),
    ];

function readRows(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return { file, ...JSON.parse(line) };
      } catch {
        return { file, parse_error: line };
      }
    });
}

function inc(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function short(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function timeLabel(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '-';
  try {
    return new Date(n).toISOString();
  } catch {
    return String(ts);
  }
}

function parseSince(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^now$/i.test(raw)) return Date.now();
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n > 10_000_000_000 ? n : n * 1000;
  }
  const rel = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    return Date.now() - n * mult;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function rowTool(row) {
  return row.tool_name || row.toolName || row.tool || row.name || '(unknown)';
}

function rowCategory(row) {
  return row.category || row.result_kind || row.resultKind || '(uncategorized)';
}

function rowErrorText(row) {
  return row.error_preview || row.result || row.error || row.message || row.error_first_line || '';
}

function isKnownTestFixture(row) {
  if (row.session_id !== 'no-session' || row.agent != null || row.model != null) return false;
  const tool = rowTool(row);
  if (tool === 'unknown_test_tool') return true;
  return tool === 'apply_patch' && /^Error:\s*patch failed\s*$/i.test(String(rowErrorText(row)).trim());
}

function normalizeRowCategory(row) {
  const storedCategory = rowCategory(row);
  let category = storedCategory;
  if (isKnownTestFixture(row)) {
    category = 'expected-test';
  } else if (rowTool(row) === 'apply_patch') {
    const derived = classifyToolFailure(rowErrorText(row), 'apply_patch');
    // Failure previews are bounded and may end before the nested cause. Never
    // downgrade a stored specific category to the generic fallback merely
    // because the historical preview lacks that tail.
    if (derived !== 'runtime/failure' || storedCategory === 'runtime/failure') {
      category = derived;
    }
  }
  return category === storedCategory
    ? row
    : { ...row, stored_category: storedCategory, category };
}

const sinceTs = parseSince(sinceArg);
const onlyArg = String(argValue('--only', 'all') || 'all').toLowerCase();
const rows = files.flatMap(readRows)
  .map(normalizeRowCategory)
  .filter((row) => sinceTs == null || Number(row.ts || 0) >= sinceTs)
  .filter((row) => !toolFilter || rowTool(row) === toolFilter)
  .filter((row) => !agentFilter || String(row.agent || '-') === agentFilter)
  .filter((row) => !categoryFilter || rowCategory(row) === categoryFilter)
  .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
const isCommandExit = (row) => rowCategory(row) === 'command-exit';
// Absorbed-by-design outcomes (compacted-history placeholder preflight, etc.):
// retained in the log and displayed, but never counted as actionable work.
const isExpectedAbsorbed = (row) => /^expected-/.test(String(rowCategory(row)));
const isPatchFailure = (row) => /^patch\//.test(String(rowCategory(row)));
const categoryFamily = (row) => String(rowCategory(row)).split('/')[0] || '(uncategorized)';
const rowLeadingErrorLine = (row) => [
  row.error_first_line,
  row.error_preview,
  row.result,
  row.error,
  row.message,
].filter(Boolean).join('\n').split(/\r?\n/)
  .map((line) => line.trim())
  .find((line) => line && !line.startsWith('⚠️ '))
  ?.replace(/^Error:\s*/i, '') || '';
const isExpectedCancellation = (row) => {
  if (rowCategory(row) === 'expected-cancellation') return true;
  return /^Session\s+"[^"]+"\s+closed:\s*(?:aborted|closed)\s+during call\b/i.test(rowLeadingErrorLine(row));
};
const cancellationRows = rows.filter(isExpectedCancellation);
const liveRows = rows.filter((row) => !isExpectedCancellation(row));
const commandExitRows = liveRows.filter(isCommandExit);
// Ordinary non-zero test/command exits and absorbed preflights are reported
// separately so a green-but-noisy run never reads as N tool/patch failures.
const expectedRows = liveRows.filter((row) => !isCommandExit(row) && isExpectedAbsorbed(row));
const actionableRows = liveRows.filter((row) => !isCommandExit(row) && !isExpectedAbsorbed(row));
const patchRows = actionableRows.filter(isPatchFailure);
const wants = (kind) => onlyArg === 'all' || onlyArg === kind;
// Limit each partition independently so a burst of ordinary command exits
// cannot crowd runtime/actionable failures out of the displayed report.
const actionableRecent = wants('actionable') ? actionableRows.slice(-limit) : [];
const commandExitRecent = wants('exits') ? commandExitRows.slice(-limit) : [];
const expectedRecent = wants('expected') ? expectedRows.slice(-limit) : [];
const recent = [...actionableRecent, ...commandExitRecent, ...expectedRecent]
  .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
function tally(list, keyFn) {
  const map = new Map();
  for (const row of list) inc(map, keyFn(row));
  return map;
}
const sortedEntries = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);
const asObject = (map) => Object.fromEntries(sortedEntries(map));
const asText = (map) => sortedEntries(map).map(([k, v]) => `${k}:${v}`).join(', ') || '(none)';
// Aggregates cover every MATCHED row in the window (not just the displayed
// tail) so `--since 24h` headline totals cannot be read as the whole picture
// while a truncated tail hides the rest.
const byTool = tally(recent, rowTool);
const byCategory = tally(recent, (row) => `${rowTool(row)} / ${rowCategory(row)}`);
const actionableByTool = tally(actionableRows, rowTool);
const actionableByCategory = tally(actionableRows, rowCategory);
const actionableByFamily = tally(actionableRows, categoryFamily);
const commandExitByTool = tally(commandExitRows, rowTool);
const expectedByCategory = tally(expectedRows, rowCategory);
const patchByCategory = tally(patchRows, rowCategory);
const reclassifiedRows = rows.filter((row) => row.stored_category && row.stored_category !== rowCategory(row));
const reclassifiedByCategory = tally(reclassifiedRows, (row) => `${row.stored_category} -> ${rowCategory(row)}`);

if (jsonMode) {
  console.log(JSON.stringify({
    shown: recent.length,
    matched: rows.length,
    actionable_failures: { shown: actionableRecent.length, matched: actionableRows.length },
    command_exits: { shown: commandExitRecent.length, matched: commandExitRows.length },
    expected_absorbed: { shown: expectedRecent.length, matched: expectedRows.length },
    session_cancellations: { shown: 0, matched: cancellationRows.length },
    patch_failures: { matched: patchRows.length, categories: asObject(patchByCategory) },
    reclassified: { matched: reclassifiedRows.length, categories: asObject(reclassifiedByCategory) },
    since: sinceTs ? new Date(sinceTs).toISOString() : null,
    filters: {
      tool: toolFilter,
      agent: agentFilter,
      category: categoryFilter,
      only: onlyArg,
    },
    sources: files.filter(existsSync),
    tools: asObject(byTool),
    actionable_tools: asObject(actionableByTool),
    actionable_categories: asObject(actionableByCategory),
    actionable_families: asObject(actionableByFamily),
    command_exit_tools: asObject(commandExitByTool),
    expected_categories: asObject(expectedByCategory),
    categories: asObject(byCategory),
    rows: recent,
  }, null, 2));
  process.exit(0);
}

console.log(`actionable failures: ${actionableRecent.length}/${actionableRows.length} shown (excludes command exits, absorbed preflights, session cancellations)`);
console.log(`command exits: ${commandExitRecent.length}/${commandExitRows.length} shown (retained) — ordinary non-zero test/command exits, not tool failures`);
console.log(`expected/absorbed: ${expectedRecent.length}/${expectedRows.length} shown (retained) — absorbed by design, not actionable`);
console.log(`session cancellations: ${cancellationRows.length} matched (not shown)`);
console.log(`rows: ${recent.length}/${rows.length} shown`);
if (sinceTs) console.log(`since: ${new Date(sinceTs).toISOString()}`);
const filterParts = [
  toolFilter ? `tool=${toolFilter}` : '',
  agentFilter ? `agent=${agentFilter}` : '',
  categoryFilter ? `category=${categoryFilter}` : '',
  onlyArg !== 'all' ? `only=${onlyArg}` : '',
].filter(Boolean);
if (filterParts.length) console.log(`filters: ${filterParts.join(', ')}`);
if (files.length > 0) console.log(`sources: ${files.filter(existsSync).join(', ') || '(none)'}`);
console.log(`actionable tools (matched): ${asText(actionableByTool)}`);
console.log(`actionable categories (matched): ${asText(actionableByCategory)}`);
console.log(`actionable families (matched): ${asText(actionableByFamily)}`);
console.log(`patch failures (matched): ${patchRows.length} — ${asText(patchByCategory)}`);
console.log(`command-exit tools (matched): ${asText(commandExitByTool)}`);
console.log(`expected/absorbed categories (matched): ${asText(expectedByCategory)}`);
console.log(`reclassified rows (matched): ${reclassifiedRows.length} — ${asText(reclassifiedByCategory)}`);
console.log(`shown categories: ${asText(byCategory)}`);
for (const row of recent) {
  const tool = rowTool(row);
  const category = rowCategory(row);
  const args = short(JSON.stringify(row.tool_args || row.args || {}), 140);
  const result = short(row.error_first_line || row.error_preview || row.result || row.error || row.message || '', 220);
  const agent = row.agent || '-';
  console.log(`- ${timeLabel(row.ts)} iter=${row.iteration ?? '-'} agent=${agent} ${tool} ${category} args=${args}${result ? ` result=${result}` : ''}`);
}
