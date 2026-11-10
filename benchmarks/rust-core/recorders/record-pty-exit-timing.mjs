// Records when node-pty (the copy Node's desktop loads, b6f10295a) raises a Windows terminal's exit, against the shell's own end and
// its last output, so the core's tabs can follow the same rule (apps/mobile/fixtures/phone-terminal/exit-timing.json).
//
//   node benchmarks/rust-core/recorders/record-pty-exit-timing.mjs [--node-pty <package dir>] [--runs <n>] [--out <file>]
//
// What is timed, per run, in milliseconds on one monotonic clock: every `data` event, node-pty's own process-exit callback
// (`WindowsPtyAgent._$onProcessExit`, the native exit wait), `kill()`, the output socket's `end`, and the `exit` event the desktop's
// terminal manager acts on (terminal-manager.ts:378-384: held text out, `activity.exit()`, the exit line).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const pkg = args.get('node-pty') ?? 'C:/Project/mixdog/apps/desktop/node_modules/@homebridge/node-pty-prebuilt-multiarch';
const runs = Number(args.get('runs') ?? 3);
const out = args.get('out') ?? 'apps/mobile/fixtures/phone-terminal/exit-timing.json';
const require = createRequire(import.meta.url);
const agents = require(join(pkg, 'lib/windowsPtyAgent.js'));
const pty = require(join(pkg, 'lib/index.js'));
const files = ['lib/windowsPtyAgent.js', 'lib/windowsTerminal.js', 'lib/windowsConoutConnection.js', 'lib/worker/conoutSocketWorker.js'];

const t0 = process.hrtime.bigint();
const now = () => Number(process.hrtime.bigint() - t0) / 1e6;
let log = [];
const onProcessExit = agents.WindowsPtyAgent.prototype._$onProcessExit;
agents.WindowsPtyAgent.prototype._$onProcessExit = function (code) {
  log.push({ t: now(), ev: 'processExit', code });
  return onProcessExit.call(this, code);
};
// The kill's console process list is read by a forked agent that may find the console gone ("AttachConsole failed"): its answer
// changes nothing here, so it is answered empty and the agent is not forked.
agents.WindowsPtyAgent.prototype._getConsoleProcessList = () => Promise.resolve([]);

const cases = {
  // The shell writes and ends at once, 999 ms after, 1000 ms after.
  'output 0 ms before the end': ['-NoProfile', '-Command', "[Console]::Out.Write('x'); exit 3"],
  'output 999 ms before the end': ['-NoProfile', '-Command', "[Console]::Out.Write('x'); Start-Sleep -Milliseconds 999; exit 3"],
  'output 1000 ms before the end': ['-NoProfile', '-Command', "[Console]::Out.Write('x'); Start-Sleep -Milliseconds 1000; exit 3"],
  // The shell ends while a process it started keeps writing to the console for about three seconds more.
  'output after the end': ['-NoProfile', '-Command', "Start-Process -NoNewWindow cmd '/c ping -n 4 127.0.0.1'; Start-Sleep -Milliseconds 300; exit 3"],
  // An idle shell killed (the desktop's dispose, terminal-manager.ts:543).
  kill: ['-NoProfile'],
};

const recorded = {};
for (const [name, argv] of Object.entries(cases)) {
  recorded[name] = [];
  for (let run = 0; run < runs; run += 1) {
    log = [];
    const term = pty.spawn('powershell.exe', argv, { cols: 80, rows: 24, useConpty: true });
    term._agent.outSocket.on('end', () => log.push({ t: now(), ev: 'socketEnd' }));
    term.onData((data) => log.push({ t: now(), ev: 'data', length: data.length }));
    await new Promise((resolve) => {
      term.onExit(({ exitCode }) => {
        log.push({ t: now(), ev: 'exit', code: exitCode });
        setTimeout(resolve, 300);
      });
      if (name === 'kill') {
        setTimeout(() => {
          log.push({ t: now(), ev: 'kill' });
          term.kill();
        }, 2500);
      }
    });
    const at = (ev) => log.find((row) => row.ev === ev)?.t;
    const exit = at('exit');
    const processExit = at('processExit');
    const lastData = log.filter((row) => row.ev === 'data').at(-1)?.t;
    const dataAfterEnd = log.filter((row) => row.ev === 'data' && row.t > processExit).at(-1)?.t;
    const round = (ms) => (ms === undefined ? null : Math.round(ms * 10) / 10);
    recorded[name].push({
      exitAfterProcessExit: round(exit - processExit),
      exitAfterLastOutput: round(exit - lastData),
      exitAfterLastOutputAfterTheEnd: round(dataAfterEnd === undefined ? undefined : exit - dataAfterEnd),
      exitAfterKill: round(at('kill') === undefined ? undefined : exit - at('kill')),
      exitAfterSocketEnd: round(at('socketEnd') === undefined ? undefined : exit - at('socketEnd')),
      socketEndAfterProcessExit: round(at('socketEnd') === undefined ? undefined : at('socketEnd') - processExit),
      events: log.map((row) => ({ ...row, t: round(row.t - log[0].t) })),
    });
  }
}

const manifest = {
  recorder: 'benchmarks/rust-core/recorders/record-pty-exit-timing.mjs',
  recorderSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
  nodePty: { package: pkg, version: JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version },
  nodePtyFiles: Object.fromEntries(files.map((file) => [file, createHash('sha256').update(readFileSync(join(pkg, file))).digest('hex')])),
  node: process.version,
  runsPerCase: runs,
};
writeFileSync(out, `${JSON.stringify({ manifest, cases: recorded }, null, 2)}\n`);
console.log(`exit timing: ${Object.keys(recorded).length} cases x ${runs} runs -> ${out}`);
process.exit(0);
