#!/usr/bin/env node
// Tool-usage efficiency diag for worker/heavy-worker (before/after rule changes).
// Usage: node scripts/tool-efficiency-diag.mjs [--since 24h|<epoch-ms>|ISO]
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

function sinceArg() {
  const i = process.argv.indexOf('--since');
  const raw = i >= 0 ? process.argv[i + 1] : '24h';
  const rel = String(raw).match(/^(\d+(?:\.\d+)?)(h|m|d)$/i);
  if (rel) {
    const mult = { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2].toLowerCase()];
    return Date.now() - Number(rel[1]) * mult;
  }
  if (/^\d+$/.test(raw)) return Number(raw);
  const p = Date.parse(raw);
  return Number.isFinite(p) ? p : Date.now() - 86_400_000;
}

const dataDir = process.env.MIXDOG_DATA_DIR || resolve(homedir(), '.mixdog', 'data');
const files = [resolve(dataDir, 'history', 'agent-trace.jsonl.1'), resolve(dataDir, 'history', 'agent-trace.jsonl')];
const since = sinceArg();
const rows = [];
for (const f of files) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    try { const r = JSON.parse(line); if ((r.ts || 0) >= since) rows.push(r); } catch {}
  }
}
const F = (r, n) => (r[n] != null ? r[n] : (r.payload && r.payload[n] != null ? r.payload[n] : null));
const bySess = new Map();
for (const r of rows) {
  const k = r.sessionId || r.session_id || '?';
  if (!bySess.has(k)) bySess.set(k, []);
  bySess.get(k).push(r);
}
console.log(`window since ${new Date(since).toISOString()}`);
for (const target of ['heavy-worker', 'worker']) {
  let batch1 = 0, batchTot = 0, llmCalls = 0, sessions = 0, toolCalls = 0;
  let grepContent = 0, grepContentWithCtx = 0, grepThenRead = 0, rereads = 0, outTok = 0;
  for (const [, rs] of bySess) {
    let agent = null;
    for (const r of rs) { const x = F(r, 'agent'); if (x) { agent = x; break; } }
    if (agent !== target) continue;
    sessions++;
    rs.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    for (const b of rs.filter((r) => r.kind === 'batch')) {
      const c = Number(F(b, 'tool_call_count')) || 0;
      batchTot++; if (c === 1) batch1++;
    }
    const usage = rs.filter((r) => r.kind === 'usage_raw');
    llmCalls += usage.length;
    outTok += usage.reduce((s, r) => s + (Number(F(r, 'output_tokens')) || 0), 0);
    const tools = rs.filter((r) => r.kind === 'tool');
    toolCalls += tools.length;
    const seenRead = new Map();
    for (let i = 0; i < tools.length; i++) {
      const t = tools[i];
      const n = String(F(t, 'tool_name'));
      const a = F(t, 'tool_args_summary') || {};
      if (n === 'read') {
        const p = typeof a.path === 'string' ? a.path : JSON.stringify(a.path);
        seenRead.set(p, (seenRead.get(p) || 0) + 1);
      }
      if (n === 'grep' && ['content', 'content_with_context'].includes(String(a.output_mode || ''))) {
        grepContent++;
        // Implicit context: output_mode content_with_context carries context
        // without explicit -C/-A/-B flags.
        if (a['-C'] != null || a['-A'] != null || a['-B'] != null
          || String(a.output_mode) === 'content_with_context') grepContentWithCtx++;
        const gpath = typeof a.path === 'string' ? a.path : JSON.stringify(a.path || '');
        for (let j = i + 1; j < Math.min(i + 4, tools.length); j++) {
          const u = tools[j];
          if (String(F(u, 'tool_name')) !== 'read') continue;
          const ra = F(u, 'tool_args_summary') || {};
          const rpath = typeof ra.path === 'string' ? ra.path : JSON.stringify(ra.path || '');
          if (rpath && gpath && (rpath.includes(gpath) || gpath.includes(rpath))) { grepThenRead++; break; }
        }
      }
    }
    for (const [, c] of seenRead) if (c >= 3) rereads++;
  }
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  console.log(`\n${target}: sessions=${sessions} llmCalls=${llmCalls} toolCalls=${toolCalls} outTok=${outTok}`);
  console.log(`  llmCalls/session=${sessions ? Math.round(llmCalls / sessions) : 0}  tools/llmCall=${llmCalls ? (toolCalls / llmCalls).toFixed(2) : '-'}`);
  console.log(`  single-call batches: ${batch1}/${batchTot} (${pct(batch1, batchTot)}%)`);
  console.log(`  content greps with -C/-A/-B: ${grepContentWithCtx}/${grepContent} (${pct(grepContentWithCtx, grepContent)}%)  grep->read follow-ups: ${grepThenRead}`);
  console.log(`  same-path re-reads >=3x: ${rereads}`);
}
