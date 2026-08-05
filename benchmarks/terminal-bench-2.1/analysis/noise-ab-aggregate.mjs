// Aggregate the noise-polish A/B runs: per-trial reward, agent duration,
// tool-call counts, retrieval counts, and find/list/glob/grep output sizes,
// computed identically for every jobs dir passed as label=path.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const RETRIEVAL = new Set(['read', 'grep', 'find', 'glob', 'list', 'code_graph', 'explore', 'tree']);

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function* walkTimes(node, path = '') {
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    const p = path ? `${path}.${key}` : key;
    if (typeof value === 'string' && /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) yield [p, value];
    else if (value && typeof value === 'object') yield* walkTimes(value, p);
  }
}

function trialMetrics(trialDir) {
  const reward = Number((readFileSync(join(trialDir, 'verifier', 'reward.txt'), 'utf8')).trim());
  const result = JSON.parse(readFileSync(join(trialDir, 'result.json'), 'utf8'));
  const times = [...walkTimes(result)];
  const pick = (re) => times.filter(([k]) => re.test(k));
  const agentStart = pick(/agent_execution\.started_at$/i)[0]?.[1] ?? pick(/started/i)[0]?.[1];
  const agentEnd = pick(/agent_execution\.finished_at$/i)[0]?.[1] ?? pick(/finished/i).at(-1)?.[1];
  const agentSeconds = agentStart && agentEnd
    ? (new Date(agentEnd) - new Date(agentStart)) / 1000
    : null;

  const transcript = JSON.parse(readFileSync(join(trialDir, 'agent', 'session-transcript.json'), 'utf8'));
  let jitterSeconds = 0;
  try {
    const bootLog = readFileSync(join(trialDir, 'agent', 'mixdog.txt'), 'utf8');
    const jitter = bootLog.match(/\[boot-timing\] jitter=(\d+)ms/);
    if (jitter) jitterSeconds = Number(jitter[1]) / 1000;
  } catch { /* older trials have no boot log */ }
  const messages = transcript.messages ?? [];
  const byTool = {};
  const outChars = {};
  const callNames = new Map();
  for (const message of messages) {
    for (const call of message.toolCalls ?? message.tool_calls ?? []) {
      const name = call.name ?? call.function?.name ?? 'unknown';
      byTool[name] = (byTool[name] ?? 0) + 1;
      callNames.set(call.id ?? call.tool_call_id ?? Symbol(), name);
    }
    if (message.role === 'tool') {
      const name = message.name
        ?? callNames.get(message.toolCallId ?? message.tool_call_id)
        ?? 'unknown';
      const content = typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content ?? '');
      outChars[name] = (outChars[name] ?? 0) + content.length;
    }
  }
  const totalCalls = Object.values(byTool).reduce((a, b) => a + b, 0);
  const retrievalCalls = Object.entries(byTool)
    .filter(([name]) => RETRIEVAL.has(name))
    .reduce((sum, [, count]) => sum + count, 0);
  const retrievalChars = Object.entries(outChars)
    .filter(([name]) => RETRIEVAL.has(name))
    .reduce((sum, [, chars]) => sum + chars, 0);
  return {
    reward, agentSeconds, jitterSeconds,
    agentNetSeconds: agentSeconds == null ? null : agentSeconds - jitterSeconds,
    totalCalls, retrievalCalls, retrievalChars,
    findChars: outChars.find ?? 0, byTool, timesSample: times.slice(0, 8),
  };
}

for (const arg of process.argv.slice(2)) {
  const [label, root] = arg.split('=');
  const stamp = readdirSync(root).find((n) => /\d{4}-/.test(n));
  const base = join(root, stamp);
  const rows = [];
  for (const name of readdirSync(base)) {
    if (!existsSync(join(base, name, 'agent', 'session-transcript.json'))) continue;
    const m = trialMetrics(join(base, name));
    rows.push({ task: name.replace(/__.*/, ''), ...m });
  }
  console.log(`== ${label} ==`);
  for (const r of rows) {
    console.log(`${r.task} reward=${r.reward} agent_s=${r.agentSeconds?.toFixed(1)} net_s=${r.agentNetSeconds?.toFixed(1)} jitter_s=${r.jitterSeconds.toFixed(1)} calls=${r.totalCalls} retr=${r.retrievalCalls} tools=${JSON.stringify(r.byTool)}`);
  }
  const nums = (k) => rows.map((r) => r[k] ?? 0);
  const avg = (k) => (nums(k).reduce((a, b) => a + b, 0) / (rows.length || 1)).toFixed(1);
  console.log(`avg: agent_s=${avg('agentSeconds')} net_s=${avg('agentNetSeconds')} median_net=${median(nums('agentNetSeconds')).toFixed(1)} calls=${avg('totalCalls')} retr=${avg('retrievalCalls')} retrChars=${avg('retrievalChars')}`);
  console.log(`timing fields sample: ${JSON.stringify(rows[0]?.timesSample)}`);
}
