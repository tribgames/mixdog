// Micro-bench: fixed per-call overhead of the shell tool path vs raw spawn.
// Usage: node scripts/tool-overhead-microbench.mjs [bash|powershell] [N]
// Prints per-call ms for executeBashTool('echo hi') and raw child spawn,
// so (tool - raw) isolates our tool-layer overhead (policy, wrappers, I/O).
import { spawn } from 'node:child_process';
import { executeBashTool } from '../src/runtime/agent/orchestrator/tools/builtin/bash-tool.mjs';

const shell = process.argv[2] || (process.platform === 'win32' ? 'powershell' : 'bash');
const N = Number(process.argv[3] || 15);

const stats = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const sum = s.reduce((t, v) => t + v, 0);
  return {
    mean: (sum / s.length).toFixed(1),
    p50: s[Math.floor(s.length / 2)].toFixed(1),
    min: s[0].toFixed(1),
    max: s[s.length - 1].toFixed(1),
  };
};

const rawOnce = () => new Promise((resolveDone, reject) => {
  const child = shell === 'powershell'
    ? spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'echo hi'])
    : spawn('bash', ['-c', 'echo hi']);
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.on('error', reject);
  child.on('close', () => resolveDone(out));
});

const toolOnce = async () => {
  const out = await executeBashTool({ command: 'echo hi', shell }, process.cwd(), {});
  return String(out);
};

// Warm-up both paths (module init, shell resolution cache, standbys).
await toolOnce(); await toolOnce();
await rawOnce(); await rawOnce();

const toolMs = [];
for (let i = 0; i < N; i++) {
  const t0 = performance.now();
  await toolOnce();
  toolMs.push(performance.now() - t0);
}
const rawMs = [];
for (let i = 0; i < N; i++) {
  const t0 = performance.now();
  await rawOnce();
  rawMs.push(performance.now() - t0);
}

const t = stats(toolMs);
const r = stats(rawMs);
console.log(`shell=${shell} n=${N}`);
console.log(`tool  mean=${t.mean}ms p50=${t.p50}ms min=${t.min}ms max=${t.max}ms`);
console.log(`raw   mean=${r.mean}ms p50=${r.p50}ms min=${r.min}ms max=${r.max}ms`);
console.log(`overhead(mean tool-raw)=${(Number(t.mean) - Number(r.mean)).toFixed(1)}ms`);
process.exit(0);
