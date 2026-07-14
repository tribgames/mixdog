#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

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

const sinceTs = parseSince(sinceArg);
const rows = files.flatMap(readRows)
  .filter((row) => sinceTs == null || Number(row.ts || 0) >= sinceTs)
  .filter((row) => !toolFilter || rowTool(row) === toolFilter)
  .filter((row) => !agentFilter || String(row.agent || '-') === agentFilter)
  .filter((row) => !categoryFilter || rowCategory(row) === categoryFilter)
  .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
const isCommandExit = (row) => rowCategory(row) === 'command-exit';
const actionableRows = rows.filter((row) => !isCommandExit(row));
const commandExitRows = rows.filter(isCommandExit);
// Limit each partition independently so a burst of ordinary command exits
// cannot crowd runtime/actionable failures out of the displayed report.
const actionableRecent = actionableRows.slice(-limit);
const commandExitRecent = commandExitRows.slice(-limit);
const recent = [...actionableRecent, ...commandExitRecent]
  .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
const byTool = new Map();
const byCategory = new Map();
const actionableByTool = new Map();
const commandExitByTool = new Map();
for (const row of recent) {
  const tool = rowTool(row);
  const category = rowCategory(row);
  inc(byTool, tool);
  inc(byCategory, `${tool} / ${category}`);
  inc(isCommandExit(row) ? commandExitByTool : actionableByTool, tool);
}

if (jsonMode) {
  console.log(JSON.stringify({
    shown: recent.length,
    matched: rows.length,
    actionable_failures: { shown: actionableRecent.length, matched: actionableRows.length },
    command_exits: { shown: commandExitRecent.length, matched: commandExitRows.length },
    since: sinceTs ? new Date(sinceTs).toISOString() : null,
    filters: {
      tool: toolFilter,
      agent: agentFilter,
      category: categoryFilter,
    },
    sources: files.filter(existsSync),
    tools: Object.fromEntries([...byTool.entries()].sort((a, b) => b[1] - a[1])),
    actionable_tools: Object.fromEntries([...actionableByTool.entries()].sort((a, b) => b[1] - a[1])),
    command_exit_tools: Object.fromEntries([...commandExitByTool.entries()].sort((a, b) => b[1] - a[1])),
    categories: Object.fromEntries([...byCategory.entries()].sort((a, b) => b[1] - a[1])),
    rows: recent,
  }, null, 2));
  process.exit(0);
}

console.log(`actionable failures: ${actionableRecent.length}/${actionableRows.length} shown`);
console.log(`command exits: ${commandExitRecent.length}/${commandExitRows.length} shown (retained)`);
console.log(`rows: ${recent.length}/${rows.length} shown`);
if (sinceTs) console.log(`since: ${new Date(sinceTs).toISOString()}`);
const filterParts = [
  toolFilter ? `tool=${toolFilter}` : '',
  agentFilter ? `agent=${agentFilter}` : '',
  categoryFilter ? `category=${categoryFilter}` : '',
].filter(Boolean);
if (filterParts.length) console.log(`filters: ${filterParts.join(', ')}`);
if (files.length > 0) console.log(`sources: ${files.filter(existsSync).join(', ') || '(none)'}`);
console.log(`actionable tools: ${[...actionableByTool.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(', ') || '(none)'}`);
console.log(`command-exit tools: ${[...commandExitByTool.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(', ') || '(none)'}`);
console.log(`categories: ${[...byCategory.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(', ') || '(none)'}`);
for (const row of recent) {
  const tool = rowTool(row);
  const category = rowCategory(row);
  const args = short(JSON.stringify(row.tool_args || row.args || {}), 140);
  const result = short(row.error_first_line || row.error_preview || row.result || row.error || row.message || '', 220);
  const agent = row.agent || '-';
  console.log(`- ${timeLabel(row.ts)} iter=${row.iteration ?? '-'} agent=${agent} ${tool} ${category} args=${args}${result ? ` result=${result}` : ''}`);
}
