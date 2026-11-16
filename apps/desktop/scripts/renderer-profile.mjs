// CPU profile of the desktop main window's renderer, over the DevTools protocol.
//
// The app must be running with a debugging port (main/index.ts binds it to
// 127.0.0.1). Start it with the flag, for example:
//   installed app (Windows):  & "$env:LOCALAPPDATA\Programs\Mixdog\Mixdog.exe" --remote-debugging-port=9333
//   installed app (macOS):    open -a Mixdog --args --remote-debugging-port=9333
//   from source:              npm run dev            (apps/desktop; port 9342, or --port=<n>)
// Quit any running instance first: a second launch hands over to the first and
// the flag is lost.
//
// Then:
//   node apps/desktop/scripts/renderer-profile.mjs --port=9333 [--seconds=20] [--out=<dir>] [--target=<url part>]
// Writes renderer-<time>.cpuprofile (open it in Chrome DevTools → Performance)
// and renderer-<time>.txt with the top 25 functions by self and by total time.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CdpClient } from './cdp-client.mjs';
import { optionValue } from './cli-args.mjs';

const TOP = 25;
const argv = process.argv.slice(2);
const port = Number(optionValue('port', argv) || 9342);
const seconds = Number(optionValue('seconds', argv) || 20);
const outDir = resolve(optionValue('out', argv) || process.cwd());
const targetHint = optionValue('target', argv);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid --port: ${port}`);
if (!(seconds > 0)) throw new Error(`Invalid --seconds: ${seconds}`);

/** The app window's page: its renderer index (built file or dev server root),
 *  not the pet overlay, DevTools or a browser pane's guest page. */
function isMainWindow(target) {
  if (target.type !== 'page') return false;
  if (targetHint) return target.url.includes(targetHint);
  try {
    const url = new URL(target.url);
    if (url.protocol === 'file:') return url.pathname.endsWith('/renderer/index.html');
    return /^(127\.0\.0\.1|localhost)$/.test(url.hostname) && (url.pathname === '/' || url.pathname === '/index.html');
  } catch {
    return false;
  }
}

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => {
  if (!response.ok) throw new Error(`CDP target list failed with HTTP ${response.status}.`);
  return response.json();
});
const matches = targets.filter(isMainWindow);
if (matches.length !== 1) {
  const listed = targets.map((target) => `  ${target.type} ${target.url}`).join('\n');
  throw new Error(
    `${matches.length ? 'Several' : 'No'} main-window pages on port ${port}; pass --target=<url part>.\n${listed}`
  );
}
const [target] = matches;

// The debugger names its own socket; only a loopback one is ever dialled.
const socketUrl = new URL(target.webSocketDebuggerUrl);
if (socketUrl.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(socketUrl.hostname)) {
  throw new Error(`Refusing a non-loopback debugger socket: ${socketUrl.origin}`);
}
let client;
let profile;
try {
  client = new CdpClient(socketUrl.href, { defaultTimeoutMs: 30_000 });
  await client.connect();
  await client.request('Profiler.enable');
  await client.request('Profiler.setSamplingInterval', { interval: 200 });
  await client.request('Profiler.start');
  console.log(`Profiling ${target.url} for ${seconds}s…`);
  await new Promise((done) => setTimeout(done, seconds * 1000));
  ({ profile } = await client.request('Profiler.stop', {}, 120_000));
  await client.request('Profiler.disable');
} finally {
  client?.close();
}

function frameLabel({ functionName, url, lineNumber, columnNumber }) {
  const name = functionName || '(anonymous)';
  if (!url) return name;
  return `${name} ${url.replace(/^.*[\\/]/, '')}:${lineNumber + 1}:${columnNumber + 1}`;
}

/** Self and total ms per function label. Total counts a label once per sample
 *  even when it recurses. */
function summarize({ nodes, samples = [], timeDeltas = [], startTime, endTime }) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parent = new Map();
  for (const node of nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const self = new Map();
  const total = new Map();
  let sampledUs = 0;
  let clock = startTime;
  const stamps = timeDeltas.map((delta) => (clock += delta));
  for (let index = 0; index < samples.length; index += 1) {
    const next = index + 1 < samples.length ? stamps[index + 1] : Math.max(endTime, stamps[index]);
    const us = Math.max(0, next - stamps[index]);
    sampledUs += us;
    const leaf = byId.get(samples[index]);
    if (!leaf) continue;
    const leafLabel = frameLabel(leaf.callFrame);
    self.set(leafLabel, (self.get(leafLabel) ?? 0) + us);
    const seen = new Set();
    for (let id = leaf.id; id !== undefined; id = parent.get(id)) {
      const label = frameLabel(byId.get(id).callFrame);
      if (label === '(root)' || seen.has(label)) continue;
      seen.add(label);
      total.set(label, (total.get(label) ?? 0) + us);
    }
  }
  const top = (map) =>
    [...map]
      .sort((left, right) => right[1] - left[1])
      .slice(0, TOP)
      .map(([label, us]) => `${(us / 1000).toFixed(1).padStart(10)} ms  ${((us / sampledUs) * 100).toFixed(1).padStart(5)}%  ${label}`);
  return [
    `target: ${target.url}`,
    `window: ${((endTime - startTime) / 1e6).toFixed(1)} s, ${samples.length} samples`,
    '',
    `Top ${TOP} by self time`,
    ...top(self),
    '',
    `Top ${TOP} by total time`,
    ...top(total),
    '',
  ].join('\n');
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync(outDir, { recursive: true });
const profileFile = join(outDir, `renderer-${stamp}.cpuprofile`);
const summaryFile = join(outDir, `renderer-${stamp}.txt`);
const summary = summarize(profile);
writeFileSync(profileFile, JSON.stringify(profile));
writeFileSync(summaryFile, summary);
console.log(summary);
console.log(`Wrote ${profileFile}\nWrote ${summaryFile}`);
