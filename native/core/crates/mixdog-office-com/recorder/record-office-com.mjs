#!/usr/bin/env node
// Records what the unchanged PowerShell Office hosts do (src/runtime/office/com/office-com-host.ps1 and
// office-com-session-host.ps1 of the reference checkout), as fixtures the Rust port is held to:
//
//   node record-office-com.mjs --area <area> [--tree C:/Project/mixdog] [--dll <mixdog_office_com_recorder.dll>]
//                              [--scenario <id>] [--scratch <dir>] [--keep]
//
// Run it on the migration PC, in a session where Windows PowerShell 5.1 and Microsoft Office (Word, Excel, PowerPoint)
// are installed and no Office window holds unsaved work. It starts and kills Office applications. Build the DLL first
// (`cargo build -p mixdog-office-com-recorder --release --offline`, then `--dll <target>/release/mixdog_office_com_recorder.dll`).
//
// What it does for each scenario of recorder/scenarios/<area>.json:
//   1. copies the four .ps1 files of <tree>/src/runtime/office/com into a scratch directory (the reference tree is
//      never edited), puts one dot-source of hook.ps1 at the front of the line `if ($env:MIXDOG_OFFICE_HOST_LIBRARY -eq '1') { return }`
//      of the host copy and one of hook-session.ps1 at the front of the line `$state = $null` of the session-host copy
//      (the same line, so no line number of the hosts moves), and copies hook.ps1, hook-session.ps1 and the DLL beside them;
//   2. runs the scenario's steps with powershell.exe and com-adapter.mjs's exact arguments (-NoLogo -NoProfile
//      -NonInteractive -Sta -ExecutionPolicy Bypass -File), the hooked copies with MIXDOG_COM_RECORDER_LOG set, and
//      stores tests/fixtures/<area>/<scenario>.json: the requests, every stdout line (identity notifications
//      included), the MIXDOG_OFFICE_CLEANUP stderr lines, the exit code, the call log cut per request, and the files
//      the scenario names after it ran (normalise.mjs);
//   3. runs the scenario a second time on the unmodified scripts without the hook, stores the wall time of each
//      request (the proxy's own cost is not counted) and requires the unhooked responses to equal the hooked ones
//      after normalisation (the proxy changed nothing Office or PowerShell saw): a difference stops the run and no
//      fixture is written;
//   4. rewrites tests/fixtures/MANIFEST.json: every fixture with its sha256, the sha256 of the four .ps1 files it
//      was recorded from, the Windows PowerShell version and the Office build.
//
// Scenario file: { "area", "scenarios": [ { "id", "description", "collect": [names of files to keep], "steps": [...] } ] }.
// Steps (a step with "prepare": true runs on the unhooked scripts and is not recorded; "label" names a step; strings in
// requests may hold ${work}, the scenario's own directory):
//   { "copy": "<file under tests/fixtures/inputs>", "as": "<name in the work directory>" }
//   { "oneShot": { request }, "timeoutMs", "expect": { "contains": "<text of the compact JSON answer>" } }
//   { "session": "<name>", "start": true }                          start a session host
//   { "send": { "session": "<name>", "request": { ... } }, "timeoutMs", "expect" }  one request, until its answer
//   { "wait": <ms> }
//   { "hostApp": "<name>", "format": "docx|xlsx|pptx", "files": ["a.pptx", ...] }   an application of its own that
//        creates and keeps those documents open (an unhooked helper; the hosts then find them in the running application)
//   { "kill": { "session": "<name>" } | { "app": "<name>" } }       end the application process (a crash)
//   { "eof": "<name>" }                                              close the session host's stdin and wait for it
//   area "registry" is not run through PowerShell: scenarios/registry.json names the source text the operation names
//   are read from, and the names are written to tests/fixtures/registry/operations.json.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { normaliseFile, normaliseResponse, sha256 } from './normalise.mjs';

const RECORDER_DIR = dirname(fileURLToPath(import.meta.url));
const CRATE = dirname(RECORDER_DIR);
const FIXTURES = join(CRATE, 'tests', 'fixtures');
const SCRIPTS = ['office-com-host.ps1', 'office-com-session-host.ps1', 'office-com-cleanup.ps1', 'office-word-formatting.ps1'];
const HOST_LINE = "if ($env:MIXDOG_OFFICE_HOST_LIBRARY -eq '1') { return }";
const SESSION_LINE = /^\$state = \$null(?=\r?$)/m;
const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// com-adapter.mjs spawnPowerShell: the exact arguments.
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-File'];
const DEFAULT_TIMEOUT_MS = 120_000;

function parseArgs(argv) {
  const options = { area: '', tree: 'C:/Project/mixdog', dll: '', scenario: '', scratch: tmpdir(), keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--keep') options.keep = true;
    else if (['--area', '--tree', '--dll', '--scenario', '--scratch'].includes(flag)) options[flag.slice(2)] = argv[++index] ?? '';
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!options.area) throw new Error('--area is required (a file of recorder/scenarios)');
  return options;
}

const readText = (path) => readFileSync(path, 'utf8');
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---------------------------------------------------------------------------------------------------------------------
// The manifest.

function manifestSources(tree) {
  const directory = join(tree, 'src', 'runtime', 'office', 'com');
  return Object.fromEntries(SCRIPTS.map((name) => [name, sha256(readFileSync(join(directory, name)))]));
}

function updateManifest(written, environment) {
  const path = join(FIXTURES, 'MANIFEST.json');
  const manifest = existsSync(path) ? JSON.parse(readText(path)) : { schemaVersion: 1, fixtures: [] };
  const known = new Map((manifest.fixtures ?? []).map((entry) => [entry.path, entry]));
  for (const entry of written) known.set(entry.path, entry);
  const next = {
    schemaVersion: 1,
    recorder: 'recorder/record-office-com.mjs',
    sources: environment.sources,
    powershell: environment.powershell ?? manifest.powershell ?? null,
    office: environment.office ?? manifest.office ?? null,
    fixtures: [...known.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  writeJson(path, next);
}

function fixtureEntry(relative, area, scenario, extra = {}) {
  return { path: relative, sha256: sha256(readFileSync(join(FIXTURES, relative))), area, scenario, ...extra };
}

// ---------------------------------------------------------------------------------------------------------------------
// The registry area: the operation names of the host's source text, by the regex office-runtime-com.test.mjs uses.

function recordRegistry(tree) {
  const spec = JSON.parse(readText(join(RECORDER_DIR, 'scenarios', 'registry.json')));
  const sourcePath = join(tree, spec.sourcePath);
  const source = readText(sourcePath);
  const operations = {};
  for (const { format, start, end } of spec.sections) {
    const from = source.indexOf(start);
    if (from < 0) throw new Error(`${spec.source}: no "${start}"`);
    const to = source.indexOf(end, from + start.length);
    if (to < 0) throw new Error(`${spec.source}: no "${end}" after "${start}"`);
    const block = source.slice(from, to);
    operations[format] = [...block.matchAll(new RegExp(spec.regex, spec.flags))].map((match) => match[1]).sort();
  }
  const counts = Object.fromEntries(Object.entries(operations).map(([format, names]) => [format, names.length]));
  for (const [format, expected] of Object.entries(spec.expectedCounts)) {
    if (counts[format] !== expected) throw new Error(`${format}: ${counts[format]} operation names, expected ${expected}`);
  }
  writeJson(join(FIXTURES, spec.output), {
    schemaVersion: 1,
    source: spec.sourcePath,
    sourceSha256: sha256(readFileSync(sourcePath)),
    regex: spec.regex,
    flags: spec.flags,
    sections: spec.sections,
    counts,
    operations,
  });
  console.log(`registry: ${Object.entries(counts).map(([format, count]) => `${format} ${count}`).join(', ')} -> ${spec.output}`);
  return [fixtureEntry(spec.output, 'registry', null, { recorded: 'source' })];
}

// ---------------------------------------------------------------------------------------------------------------------
// Scratch copies of the hosts.

/** `text` with its one line `line` (a string or a pattern) preceded by `prefix`; the line must be there exactly once. */
function patchOnce(text, line, prefix, what) {
  const pattern = typeof line === 'string' ? null : new RegExp(line.source, line.flags.includes('g') ? line.flags : `${line.flags}g`);
  const found = pattern ? (text.match(pattern)?.length ?? 0) : text.split(line).length - 1;
  if (found !== 1) throw new Error(`${what}: expected the line to patch once, found ${found}`);
  return pattern ? text.replace(pattern, (match) => `${prefix}${match}`) : text.replace(line, () => `${prefix}${line}`);
}

function prepareScripts(tree, dll, root) {
  const source = join(tree, 'src', 'runtime', 'office', 'com');
  const plain = join(root, 'plain');
  const hooked = join(root, 'hooked');
  mkdirSync(plain, { recursive: true });
  mkdirSync(hooked, { recursive: true });
  for (const name of SCRIPTS) {
    copyFileSync(join(source, name), join(plain, name));
    copyFileSync(join(source, name), join(hooked, name));
  }
  const host = readFileSync(join(hooked, 'office-com-host.ps1'), 'utf8');
  writeFileSync(join(hooked, 'office-com-host.ps1'), patchOnce(host, HOST_LINE, ". (Join-Path $PSScriptRoot 'hook.ps1'); ", 'office-com-host.ps1'), 'utf8');
  const session = readFileSync(join(hooked, 'office-com-session-host.ps1'), 'utf8');
  writeFileSync(join(hooked, 'office-com-session-host.ps1'), patchOnce(session, SESSION_LINE, ". (Join-Path $PSScriptRoot 'hook-session.ps1'); ", 'office-com-session-host.ps1'), 'utf8');
  copyFileSync(join(RECORDER_DIR, 'hook.ps1'), join(hooked, 'hook.ps1'));
  copyFileSync(join(RECORDER_DIR, 'hook-session.ps1'), join(hooked, 'hook-session.ps1'));
  copyFileSync(dll, join(hooked, 'mixdog_office_com_recorder.dll'));
  return { plain, hooked };
}

// ---------------------------------------------------------------------------------------------------------------------
// Processes.

/** Collects a child's stdout lines and stderr and tells when a line arrives or the child is gone. */
function watch(child) {
  const watcher = { lines: [], stderr: '', exited: null, listeners: new Set() };
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const wake = () => watcher.listeners.forEach((listener) => listener());
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    const parts = pending.split(/\r?\n/);
    pending = parts.pop() ?? '';
    for (const part of parts) if (part.trim()) watcher.lines.push(part.trim());
    wake();
  });
  child.stderr.on('data', (chunk) => {
    watcher.stderr += chunk;
  });
  child.on('close', (code) => {
    if (pending.trim()) watcher.lines.push(pending.trim());
    pending = '';
    watcher.exited = code ?? -1;
    wake();
  });
  child.on('error', (error) => {
    watcher.exited = -1;
    watcher.stderr += `${error.message}\n`;
    wake();
  });
  return watcher;
}

/** Resolves when `ready()` holds; rejects after `timeoutMs` (every wait here has a deadline). */
function until(watcher, ready, timeoutMs, what) {
  return new Promise((resolveWait, rejectWait) => {
    const check = () => {
      if (!ready()) return false;
      cleanup();
      resolveWait();
      return true;
    };
    const timer = setTimeout(() => {
      cleanup();
      rejectWait(new Error(`timed out after ${timeoutMs} ms waiting for ${what}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      watcher.listeners.delete(check);
    };
    watcher.listeners.add(check);
    check();
  });
}

const parseLine = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return { unparsed: line };
  }
};
const cleanupLines = (stderr) => stderr.split(/\r?\n/).filter((line) => line.includes('MIXDOG_OFFICE_CLEANUP'));

function substitute(value, work) {
  if (typeof value === 'string') return value.split('${work}').join(work);
  if (Array.isArray(value)) return value.map((item) => substitute(item, work));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, work)]));
  return value;
}

const HOST_APP_SCRIPT = `param([string]$Format, [string]$Dir, [string]$Names)
$ErrorActionPreference = 'Stop'
$progId = @{ docx = 'Word.Application'; xlsx = 'Excel.Application'; pptx = 'PowerPoint.Application' }[$Format]
$processName = @{ docx = 'WINWORD'; xlsx = 'EXCEL'; pptx = 'POWERPNT' }[$Format]
$before = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$app = New-Object -ComObject $progId
$after = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id } | Where-Object { $before -notcontains $_ })
foreach ($name in ($Names -split ',')) {
    $path = Join-Path $Dir $name
    switch ($Format) {
        'docx' { $document = $app.Documents.Add(); $document.SaveAs2($path) }
        'xlsx' { $book = $app.Workbooks.Add(); $book.SaveAs($path) }
        'pptx' { $deck = $app.Presentations.Add(0); $null = $deck.Slides.Add(1, 12); $deck.SaveAs($path) }
    }
}
[Console]::Out.WriteLine((@{ ready = $true; appPid = $(if ($after.Count -gt 0) { [int]$after[0] } else { 0 }) } | ConvertTo-Json -Compress))
$null = [Console]::In.ReadLine()
try { $app.Quit() } catch {}
`;

// ---------------------------------------------------------------------------------------------------------------------
// One run of one scenario.

async function runScenario(scenario, run) {
  const { hooked: hookedRun, scripts, work, logPath } = run;
  mkdirSync(work, { recursive: true });
  const sessions = new Map();
  const apps = new Map();
  const recorded = [];
  let logOffset = 0;
  let requestCounter = 0;

  const environment = (hooked) => {
    const env = { ...process.env };
    delete env.MIXDOG_COM_RECORDER_LOG;
    if (hooked) env.MIXDOG_COM_RECORDER_LOG = logPath;
    return env;
  };
  const spawnHost = (script, hooked) =>
    spawn(POWERSHELL, [...POWERSHELL_ARGS, join(hooked ? scripts.hooked : scripts.plain, script)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: environment(hooked) });
  const takeCalls = () => {
    if (!existsSync(logPath)) return [];
    const bytes = readFileSync(logPath);
    const text = bytes.subarray(logOffset).toString('utf8');
    logOffset = bytes.length;
    // The sequence numbers restart at 1 for each request: a replay consumes one request's calls at a time.
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line, index) => line.replace(/^\{"seq":\d+/, `{"seq":${index + 1}`));
  };
  const normal = (value) => normaliseResponse(value, { work });
  const outcome = (watcher, from) => ({ stdout: watcher.lines.slice(from).map((line) => normal(parseLine(line))), stderr: cleanupLines(watcher.stderr).map((line) => normal(line)) });
  const expectIn = (step, answers) => {
    if (!step.expect) return;
    const text = JSON.stringify(answers);
    if (!text.includes(step.expect.contains)) throw new Error(`${scenario.id}: ${step.label ?? 'a step'} did not answer with ${JSON.stringify(step.expect.contains)}: ${text.slice(0, 400)}`);
  };
  const applicationPid = (name, kind) => {
    if (kind === 'app') return apps.get(name)?.pid ?? 0;
    const watcher = sessions.get(name)?.watcher;
    const pids = (watcher?.lines ?? []).map(parseLine).map((message) => Number(message.appPid)).filter((pid) => pid > 0);
    return pids.at(-1) ?? 0;
  };

  try {
    for (const step of scenario.steps) {
      const hooked = hookedRun && !step.prepare;
      const keep = !step.prepare;
      const timeoutMs = step.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const started = Date.now();
      let entry = null;
      if (step.copy) {
        copyFileSync(join(FIXTURES, 'inputs', step.copy), join(work, step.as ?? step.copy));
        entry = { kind: 'copy', file: step.as ?? step.copy };
      } else if (step.oneShot) {
        const child = spawnHost('office-com-host.ps1', hooked);
        const watcher = watch(child);
        child.stdin.end(JSON.stringify(substitute(step.oneShot, work)), 'utf8');
        try {
          await until(watcher, () => watcher.exited !== null, timeoutMs, 'the host to exit');
        } catch (error) {
          child.kill();
          throw error;
        }
        const answers = outcome(watcher, 0);
        entry = { kind: 'one-shot', request: step.oneShot, ...answers, exitCode: watcher.exited };
        if (keep) expectIn(step, answers.stdout);
      } else if (step.session && step.start) {
        const child = spawnHost('office-com-session-host.ps1', hooked);
        sessions.set(step.session, { child, watcher: watch(child), sent: 0 });
        entry = { kind: 'session-start', session: step.session };
      } else if (step.send) {
        const session = sessions.get(step.send.session);
        if (!session) throw new Error(`${scenario.id}: no session ${step.send.session}`);
        const requestId = `recorder_request_${(requestCounter += 1)}`;
        const from = session.watcher.lines.length;
        session.child.stdin.write(`${JSON.stringify({ ...substitute(step.send.request, work), requestId })}\n`, 'utf8');
        await until(session.watcher, () => session.watcher.lines.slice(from).some((line) => parseLine(line).requestId === requestId) || session.watcher.exited !== null, timeoutMs, `the answer to ${requestId}`);
        const answers = outcome(session.watcher, from);
        answers.stdout.forEach((message) => delete message.requestId);
        entry = { kind: 'send', session: step.send.session, request: step.send.request, ...answers };
        if (keep) expectIn(step, answers.stdout);
      } else if (step.wait !== undefined) {
        await sleep(step.wait);
        entry = { kind: 'wait', ms: step.wait };
      } else if (step.hostApp) {
        const child = spawn(POWERSHELL, [...POWERSHELL_ARGS, run.hostAppScript, '-Format', step.format, '-Dir', work, '-Names', step.files.join(',')], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: environment(false),
        });
        const watcher = watch(child);
        await until(watcher, () => watcher.lines.length > 0 || watcher.exited !== null, timeoutMs, `${step.hostApp} to be ready`);
        const ready = parseLine(watcher.lines[0] ?? '{}');
        if (!ready.ready) throw new Error(`${scenario.id}: the helper application did not start: ${watcher.stderr.slice(0, 400)}`);
        apps.set(step.hostApp, { child, watcher, pid: Number(ready.appPid) || 0 });
        entry = { kind: 'host-app', app: step.hostApp, files: step.files };
      } else if (step.kill) {
        const pid = step.kill.session ? applicationPid(step.kill.session, 'session') : applicationPid(step.kill.app, 'app');
        if (!pid) throw new Error(`${scenario.id}: no application process to end for ${JSON.stringify(step.kill)}`);
        process.kill(pid);
        entry = { kind: 'kill', target: step.kill };
      } else if (step.eof) {
        const session = sessions.get(step.eof);
        if (!session) throw new Error(`${scenario.id}: no session ${step.eof}`);
        const from = session.watcher.lines.length;
        session.child.stdin.end();
        await until(session.watcher, () => session.watcher.exited !== null, timeoutMs, `${step.eof} to exit`);
        entry = { kind: 'eof', session: step.eof, ...outcome(session.watcher, from), exitCode: session.watcher.exited };
        sessions.delete(step.eof);
      } else {
        throw new Error(`${scenario.id}: a step this recorder does not know: ${JSON.stringify(step)}`);
      }
      if (keep) recorded.push({ label: step.label ?? null, ...entry, calls: ['one-shot', 'send', 'eof'].includes(entry.kind) ? takeCalls() : undefined, ms: Date.now() - started });
      else takeCalls();
    }
  } finally {
    for (const { child } of sessions.values()) child.kill();
    for (const { child, pid } of apps.values()) {
      try {
        child.stdin.end();
      } catch {}
      if (pid) {
        await sleep(2000);
        try {
          process.kill(pid);
        } catch {}
      }
    }
  }
  return recorded;
}


// ---------------------------------------------------------------------------------------------------------------------
// The run.

/** The Windows PowerShell version and the Office build of this machine (null when not found). */
function probeEnvironment() {
  const script = String.raw`$PSVersionTable.PSVersion.ToString(); (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration' -ErrorAction SilentlyContinue).VersionToReport`;
  const result = spawnSync(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const [version, build] = String(result.stdout ?? '').split(/\r?\n/).map((line) => line.trim());
  return { powershell: version || null, office: build ? { build } : null };
}

/** What a run must show the same hooked and unhooked: the answers, the cleanup lines and the exit codes. */
const answersOf = (steps) => steps.map(({ kind, stdout, stderr, exitCode }) => ({ kind, stdout, stderr, exitCode }));

function firstDifference(hooked, plain) {
  const left = answersOf(hooked);
  const right = answersOf(plain);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) return `step ${index}: hooked ${JSON.stringify(left[index]).slice(0, 600)} / unhooked ${JSON.stringify(right[index]).slice(0, 600)}`;
  }
  return null;
}

async function recordArea(options, tree) {
  if (process.platform !== 'win32') throw new Error('recording needs Windows, Windows PowerShell 5.1 and Microsoft Office');
  if (!options.dll || !existsSync(options.dll)) throw new Error('--dll names the built mixdog_office_com_recorder.dll (cargo build -p mixdog-office-com-recorder --release --offline)');
  const spec = JSON.parse(readText(join(RECORDER_DIR, 'scenarios', `${options.area}.json`)));
  const scenarios = (spec.scenarios ?? []).filter((scenario) => !options.scenario || scenario.id === options.scenario);
  if (scenarios.length === 0) throw new Error(`no scenario ${options.scenario || ''} in scenarios/${options.area}.json`);
  const root = mkdtempSync(join(resolve(options.scratch), 'mixdog-office-rec-'));
  const written = [];
  try {
    const scripts = prepareScripts(tree, resolve(options.dll), root);
    const hostAppScript = join(root, 'host-app.ps1');
    writeFileSync(hostAppScript, HOST_APP_SCRIPT, 'utf8');
    const environment = { ...probeEnvironment(), sources: manifestSources(tree) };
    for (const scenario of scenarios) {
      const base = join(root, 'run', scenario.id);
      const run = (hooked) => ({ hooked, scripts, tree, hostAppScript, work: join(base, hooked ? 'hooked' : 'plain'), logPath: join(base, 'calls.jsonl') });
      console.log(`${options.area}/${scenario.id}: hooked run`);
      const hookedRun = run(true);
      const hooked = await runScenario(scenario, hookedRun);
      console.log(`${options.area}/${scenario.id}: unhooked run`);
      const plain = await runScenario(scenario, run(false));
      const difference = firstDifference(hooked, plain);
      if (difference) throw new Error(`${scenario.id}: the proxy changed what the host answered: ${difference}`);
      const files = {};
      for (const name of scenario.collect ?? []) files[name] = await normaliseFile(join(hookedRun.work, name), { tree });
      const timed = (steps) => steps.map((step, index) => ({ step: index, label: step.label, kind: step.kind, ms: step.ms })).filter((step) => ['one-shot', 'send', 'eof'].includes(step.kind));
      const relative = `${options.area}/${scenario.id}.json`;
      writeJson(join(FIXTURES, relative), {
        schemaVersion: 1,
        area: options.area,
        scenario: scenario.id,
        description: scenario.description ?? '',
        steps: hooked.map(({ ms, ...step }) => step),
        files,
        timingsMs: timed(plain),
      });
      written.push(fixtureEntry(relative, options.area, scenario.id, { recorded: 'live' }));
    }
    updateManifest(written, environment);
  } finally {
    if (options.keep) console.log(`scratch kept: ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tree = resolve(options.tree);
  if (options.area === 'registry') {
    updateManifest(recordRegistry(tree), { sources: manifestSources(tree) });
    return;
  }
  await recordArea(options, tree);
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exit(1);
});
