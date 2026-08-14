#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeReductionTraceRows } from '../src/runtime/agent/orchestrator/session/reduction-metrics.mjs';

export function parseTraceJsonl(text) {
    const rows = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { /* retain valid rows */ }
    }
    return rows;
}

function main(argv) {
    const tracePath = argv[2];
    if (!tracePath) {
        process.stderr.write('Usage: node scripts/reduction-trace-report.mjs <agent-trace.jsonl>\n');
        return 2;
    }
    const rows = parseTraceJsonl(readFileSync(resolve(tracePath), 'utf8'));
    process.stdout.write(`${JSON.stringify(summarizeReductionTraceRows(rows), null, 2)}\n`);
    return 0;
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
    process.exitCode = main(process.argv);
}
