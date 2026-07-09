import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { runExplore } from '../src/standalone/explore-tool.mjs';
// Attribute LLM send time (not just wall) for this high-fanout batch.
process.env.MIXDOG_AGENT_TRACE_TIMING = '1';
const queries = [
  'standalone explore tool implementation entry point',
  'V4A patch format parsing/conversion implementation',
  'recall memory entries persistent store (sqlite) read/query implementation',
  'output styles: how style definitions are loaded and applied at session runtime',
  'Discord backend outbound message send implementation',
  'shell command destructive/danger policy scan before execution',
  'where does mixdog store per-user data and sessions on this machine (out of repo)',
  'channel runtime crash logging write path',
];
const t0 = Date.now();
const res = await runExplore({ query: queries, cwd: 'C:/Project/mixdog' }, { callerCwd: 'C:/Project/mixdog' });
console.log('BATCH_ELAPSED_MS', Date.now() - t0);
const txt = res.content?.[0]?.text || '';
console.log('FAILED_COUNT', (txt.match(/EXPLORATION_FAILED/g) || []).length);
// Sum send_ms from loop rows emitted since t0 → LLM time vs the wall above.
const tracePath = process.env.MIXDOG_AGENT_TRACE_PATH
  || join(process.env.MIXDOG_DATA_DIR || join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data'), 'history', 'agent-trace.jsonl');
let sendMs = 0, sends = 0; const sessions = new Set();
if (existsSync(tracePath)) {
  for (const line of readFileSync(tracePath, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r.ts >= t0 && r.kind === 'loop' && r.agent === 'explorer') { sendMs += Number(r.send_ms) || 0; sends++; sessions.add(r.session_id); }
    } catch { /* skip */ }
  }
}
console.log('LLM_SEND_MS_TOTAL', sendMs, 'sends', sends, 'sessions', sessions.size);
process.exit(0);
