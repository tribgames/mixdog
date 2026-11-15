// Records what the Node spinner computes and draws, so the Rust spinner (`mixdog-tui-widgets` spinner.rs) is held to it:
//
//  * "progress": the real `useSpinnerProgress` hook (components/use-spinner-progress.mjs) driven with a scripted clock and
//    scripted token updates; each tick's display values (elapsedMs, stalledIntensity, displayedOutputTokens) are kept.
//  * "frames": the real `Spinner` component rendered with Ink (a fake terminal, FORCE_COLOR=3, Date.now frozen at each
//    tick's time) for a script of ticks; each tick's last frame is kept.
//
// The shared animation tick is replaced by nothing: every render here is an explicit tick of the script, so the
// recording does not depend on timers. The Node code is only read: it is bundled with esbuild into a temporary folder
// beside this script (bare imports resolve from the repository's node_modules) and the folder is removed afterwards.
//
//   node record-spinner-progress.mjs --tree C:/Project/mixdog --write <golden.json>
//   node record-spinner-progress.mjs --tree C:/Project/mixdog --check <golden.json>

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const tree = option('--tree');
if (!tree || (!option('--write') && !option('--check'))) {
  console.error('usage: record-spinner-progress.mjs --tree <mixdog checkout> (--write <golden.json> | --check <golden.json>)');
  process.exit(2);
}

// chalk reads these when it is imported.
delete process.env.NO_COLOR;
process.env.FORCE_COLOR = '3';
process.env.MIXDOG_TUI_AMBIGUOUS_WIDE = '1';

const components = resolve(tree, 'src/tui/components');
const { build } = await import('esbuild');
const directory = mkdtempSync(join(here, '.tmp-record-spinner-'));
let modules;
try {
  const entry = [
    `export { Spinner } from './Spinner.jsx';`,
    `export { useSpinnerProgress } from './use-spinner-progress.mjs';`,
    `export { render, Box } from 'ink';`,
    `export { default as React } from 'react';`,
    `export { setThemeSetting } from ${JSON.stringify(resolve(tree, 'src/tui/theme.mjs').replaceAll('\\', '/'))};`,
  ].join('\n');
  const outfile = join(directory, 'bundle.mjs');
  await build({
    stdin: { contents: entry, resolveDir: components, loader: 'jsx' },
    outfile,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    logLevel: 'error',
    plugins: [
      {
        name: 'no-shared-tick',
        setup(builder) {
          builder.onResolve({ filter: /useSharedTick\.mjs$/ }, (resolved) => ({ path: resolved.path, namespace: 'no-tick' }));
          builder.onLoad({ filter: /.*/, namespace: 'no-tick' }, () => ({ contents: 'export function useSharedTick() {}', loader: 'js' }));
        },
      },
    ],
  });
  modules = await import(pathToFileURL(outfile).href);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
const { Spinner, useSpinnerProgress, render, React, setThemeSetting } = modules;

const settle = (ms = 40) => new Promise((done) => setTimeout(done, ms));
const FRAME_MS = 130;

function useTheme(id) {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    setThemeSetting(id ?? 'basic', { persist: false });
  } finally {
    process.stdout.write = write;
  }
}

function mount(columns) {
  const stdout = new PassThrough();
  stdout.columns = columns;
  stdout.rows = 40;
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  let writes = [];
  const write = stdout.write.bind(stdout);
  stdout.write = (chunk, ...rest) => {
    writes.push(String(chunk));
    return write(chunk, ...rest);
  };
  const view = render(React.createElement(React.Fragment), { stdout, stdin, stderr: stdout, debug: true, exitOnCtrlC: false, patchConsole: false });
  return {
    stdout,
    take: () => {
      const out = writes;
      writes = [];
      return out;
    },
    view,
    close() {
      view.unmount();
      stdin.end();
      stdout.end();
    },
  };
}

// ---- progress: the hook over a script of ticks ----------------------------------------------------------------------

const progressScripts = [];
const tokenRun = (startedAt, ticks) => ticks.map(([now, outputTokens, extra]) => ({ now, startedAt, outputTokens, ...extra }));

// A response that grows, stalls, resumes and snaps down.
progressScripts.push({
  id: 'tokens-and-stall',
  ticks: tokenRun(1000, [
    [1000, 0], [1130, 12], [1260, 12], [1390, 40], [1520, 400], [1650, 400], [1780, 400], [2500, 400], [4000, 400], [4500, 400],
    [5000, 400], [5500, 400], [6000, 400], [7000, 900], [7130, 900], [7260, 60], [9000, 60], [12000, 60], [12130, 60], [14000, 60],
  ]),
});
// Waiting is not stalling: a tool wait, an approval prompt, a tool input and active tools hold the stall clock.
for (const [id, extra] of [
  ['tool-use', { mode: 'tool-use' }],
  ['tool-input', { mode: 'tool-input' }],
  ['active-tools', { hasActiveTools: true }],
  ['paused', { paused: true }],
]) {
  progressScripts.push({ id: `blocked-${id}`, ticks: tokenRun(1000, [[1000, 10, extra], [3000, 10, extra], [6000, 10, extra], [9000, 10, extra], [16000, 10, extra]]) });
}
// Pause accounting: time on the approval prompt is not turn time, and a new turn starts it over.
progressScripts.push({
  id: 'pause-accounting',
  ticks: [
    ...tokenRun(1000, [[10000, 12, { paused: true }], [15000, 12, { paused: true }], [15000, 12, { paused: false }], [16000, 12, {}]]),
    ...tokenRun(14000, [[16100, 12, { paused: true }], [17000, 12, { paused: false }]]),
  ],
});
// Input totals count when no output count is given; a count that drops snaps; a count that is not a number is none.
progressScripts.push({
  id: 'tokens-fallback',
  ticks: tokenRun(1000, [[1000, 0, { tokens: 30 }], [1130, 0, { tokens: 30 }], [1260, 25, { tokens: 900 }], [1390, null, { tokens: 0 }], [1520, 0, { tokens: 0 }]]),
});
// Reduced motion shows the target at once and never reddens.
progressScripts.push({
  id: 'reduced-motion',
  ticks: tokenRun(1000, [[1000, 0, { reducedMotion: true }], [1130, 333, { reducedMotion: true }], [9000, 333, { reducedMotion: true }], [9130, 20, { reducedMotion: true }]]),
});

async function recordProgress(script) {
  const out = [];
  const Probe = (props) => {
    const result = useSpinnerProgress(props);
    out.push({ elapsedMs: result.elapsedMs, stalledIntensity: result.stalledIntensity, displayedOutputTokens: result.displayedOutputTokens });
    return null;
  };
  const probeProps = (item) => {
    const rawElapsedMs = item.startedAt ? Math.max(0, item.now - item.startedAt) : 0;
    const reducedMotion = item.reducedMotion === true;
    return {
      now: item.now,
      startedAt: item.startedAt,
      rawElapsedMs,
      frame: reducedMotion ? 0 : Math.floor(rawElapsedMs / FRAME_MS),
      outputTokens: item.outputTokens === null ? Number.NaN : item.outputTokens,
      tokens: item.tokens ?? 0,
      paused: item.paused === true,
      hasActiveTools: item.hasActiveTools === true,
      mode: item.mode ?? 'responding',
      reducedMotion,
    };
  };
  const mounted = mount(80);
  for (const item of script.ticks) {
    const before = out.length;
    mounted.view.rerender(React.createElement(Probe, probeProps(item)));
    await settle(10);
    if (out.length === before) throw new Error(`${script.id}: no render for tick at ${item.now}`);
    // A render may happen more than once for one tick; the first is the tick's own.
    out.splice(before + 1);
  }
  mounted.close();
  return { id: script.id, ticks: script.ticks, out };
}

// ---- frames: the Spinner component over a script of ticks ----------------------------------------------------------

const base = { startedAt: 1000, outputTokens: 100, mode: 'responding', columns: 160, marginTop: 0 };
const step = (now, props = {}) => ({ now, props });
const frameScripts = [];
const frameScript = (id, { theme = 'basic', reducedMotion = false, columns, props = base, ticks }) =>
  frameScripts.push({ id, theme, reducedMotion, columns: columns ?? props.columns ?? 160, props, ticks });

// The byline with every part, the pause (frozen timer), the thought-for label and the width gates.
const requesting = { startedAt: 1000, outputTokens: 12, thinking: true, effort: 'high', interruptible: true, mode: 'requesting', columns: 160, marginTop: 0 };
frameScript('reduced-byline', {
  reducedMotion: true,
  props: requesting,
  ticks: [
    step(10000),
    step(10000, { paused: true }),
    step(15000, { paused: true }),
    step(15000, { paused: false }),
    step(16000, { mode: 'responding', thinking: false, thinkingMs: 4000 }),
    step(16000, { mode: 'compacting', thinking: false, columns: 52 }),
    step(16000, { mode: 'model-thinking', thinking: false, columns: 100, thinkingMs: 0 }),
    step(16000, { mode: 'reconnecting', verb: '  Retrying in 4s  ', columns: 100 }),
    step(16000, { mode: 'reconnecting', verb: '', columns: 100 }),
    step(16000, { mode: 'resuming', columns: 100 }),
    step(16000, { mode: 'task-wait', columns: 100 }),
    step(16000, { mode: 'auto-clear', columns: 40 }),
    step(16000, { mode: 'responding', columns: 30 }),
    step(16000, { mode: 'responding', columns: 12 }),
    step(16000, { mode: 'responding', interruptible: false, thinking: false, outputTokens: 2500, columns: 100 }),
    step(16000, { mode: 'responding', interruptible: true, thinking: true, effort: 'auto', outputTokens: 1250000, columns: 100 }),
  ],
});
// The token counter, the stall tint and the verb over a turn with motion.
frameScript('motion-counter', {
  ticks: [step(10000), step(10000), step(10000, { outputTokens: 40 }), step(10000, { outputTokens: 1000 }), step(10000, { outputTokens: 20 })],
});
frameScript('motion-stall', {
  props: { ...base, outputTokens: 10 },
  ticks: [step(10000), step(14000), step(16000), step(16000, { outputTokens: 20 }), step(16260, { outputTokens: 20 }), step(20000, { outputTokens: 20 })],
});
for (const blocked of [{ hasActiveTools: true }, { mode: 'tool-use' }, { mode: 'tool-input' }, { paused: true }]) {
  frameScript(`motion-blocked-${Object.keys(blocked)[0]}-${Object.values(blocked)[0]}`, {
    props: { ...base, outputTokens: 10, ...blocked },
    ticks: [step(10000), step(16000)],
  });
}
// The glyph and the shimmer over frames (130 ms apart), live thinking shimmer after its delay, the verb rotation.
frameScript('motion-shimmer', {
  props: { ...base, columns: 100, outputTokens: 300, thinking: true, thinkingActiveSince: 1000, effort: 'high', interruptible: true, marginTop: 1 },
  ticks: Array.from({ length: 14 }, (_, index) => step(1000 + index * 130 + (index > 8 ? 3000 : 0))),
});
frameScript('motion-requesting-shimmer', {
  props: { ...base, columns: 100, mode: 'requesting', outputTokens: 0, interruptible: true },
  ticks: Array.from({ length: 8 }, (_, index) => step(1000 + index * 70)),
});
frameScript('motion-verb-windows', {
  props: { ...base, columns: 100, outputTokens: 0 },
  ticks: [1000, 31000, 61000, 91000, 121000, 181000, 241000, 301000, 3601000].map((now) => step(now)),
});
// The quiet-time cue: neutral at two minutes, escalated at the watchdog's warn point.
frameScript('motion-quiet', {
  props: { ...base, columns: 140, interruptible: true, outputTokens: 50, quiet: { since: 1000, wait: 'provider', warnMs: 300000 } },
  ticks: [step(60000), step(125000), step(130000, { quiet: { since: 1000, wait: 'tool', tool: 'bash', warnMs: 300000 } }), step(400000), step(400000, { quiet: { since: 0 } })],
});
// Other themes tint the shimmer, the glyph and the stall.
for (const theme of ['light', 'dracula', 'onedark']) {
  frameScript(`theme-${theme}`, {
    theme,
    props: { ...base, columns: 120, outputTokens: 10, thinking: true, thinkingActiveSince: 1000, effort: 'low', interruptible: true, marginTop: 1 },
    ticks: [step(1500), step(5000), step(9000), step(12000), step(12390)],
  });
}

async function recordFrames(script) {
  process.env.MIXDOG_REDUCED_MOTION = script.reducedMotion ? '1' : '0';
  useTheme(script.theme);
  let clock = script.ticks[0].now;
  Date.now = () => clock;
  const mounted = mount(script.columns);
  const frames = [];
  let previous = '';
  for (const item of script.ticks) {
    clock = item.now;
    const props = { ...script.props, ...item.props };
    if (props.columns) {
      mounted.stdout.columns = props.columns;
      mounted.stdout.emit('resize');
    }
    mounted.take();
    mounted.view.rerender(React.createElement(Spinner, props));
    await settle(25);
    const writes = mounted.take();
    previous = writes.length ? writes[writes.length - 1] : previous;
    frames.push(previous);
  }
  mounted.close();
  return { id: script.id, theme: script.theme, reducedMotion: script.reducedMotion, columns: script.columns, props: script.props, ticks: script.ticks, frames };
}

const realNow = Date.now;
const progress = [];
for (const script of progressScripts) progress.push(await recordProgress(script));
const frames = [];
for (const script of frameScripts) frames.push(await recordFrames(script));
Date.now = realNow;

const recording = JSON.stringify({ format: 1, ambiguousWide: true, progress, frames }, null, 1) + '\n';
const writeTo = option('--write');
if (writeTo) {
  writeFileSync(writeTo, recording);
  console.log(`wrote ${writeTo} (${progress.length} progress scripts, ${frames.length} frame scripts)`);
} else {
  const checkAgainst = option('--check');
  if (readFileSync(checkAgainst, 'utf8') !== recording) {
    console.error(`record-spinner-progress: ${checkAgainst} differs from what the Node code records now`);
    process.exit(1);
  }
  console.log(`record-spinner-progress: ${checkAgainst} matches (${progress.length} progress scripts, ${frames.length} frame scripts)`);
}
process.exit(0);
