// Render completed traces for manual behavior review; this does not grade tasks.
// Usage: node stabilization-audit.mjs [--baseline <jobsDir>] <jobsDir> [...]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const benchRoot = fileURLToPath(new URL('..', import.meta.url));
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const jobPath = (value) => isAbsolute(value) ? value : resolve(benchRoot, value);
const args = process.argv.slice(2);
let baseline = null;
if (args[0] === '--baseline') {
  if (!args[1]) throw new Error('--baseline requires a jobs directory');
  baseline = jobPath(args[1]);
  args.splice(0, 2);
}
if (!args.length) throw new Error('Pass at least one completed jobs directory');

for (const name of args) {
  const root = jobPath(name);
  const report = json(join(root, 'report.json'));
  const manifest = json(join(root, 'runtime-manifest.json'));
  const previous = baseline ? json(join(baseline, 'report.json')) : null;
  if (previous && previous.preset.fingerprint !== report.preset.fingerprint) {
    throw new Error('Cannot compare different preset fingerprints');
  }
  let bundleChanges = [];
  if (baseline) {
    const previousManifest = json(join(baseline, 'runtime-manifest.json'));
    const before = new Map(previousManifest.files.map((file) => [file.path, file]));
    const after = new Map(manifest.files.map((file) => [file.path, file]));
    bundleChanges = [...new Set([...before.keys(), ...after.keys()])].sort().filter((path) => {
      const left = before.get(path);
      const right = after.get(path);
      return !left || !right || left.sha256 !== right.sha256 || left.mode !== right.mode;
    });
  }

  const lines = [];
  const index = [];
  const append = (text) => lines.push(...String(text).split('\n'));
  for (const trial of readdirSync(report.paths.runDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!trial.isDirectory() || !trial.name.includes('__')) continue;
    const task = trial.name.split('__')[0];
    const taskResult = report.tasks.find((row) => row.task === task);
    const previousTask = previous?.tasks.find((row) => row.task === task);
    append('');
    index.push({
      task, line: lines.length + 1, passed: taskResult?.passed,
      agentSeconds: taskResult?.agentSeconds,
      deltaSeconds: previousTask ? Number((taskResult.agentSeconds - previousTask.agentSeconds).toFixed(3)) : null,
    });
    append(`TASK ${trial.name}`);
    let edits = 0;
    const trace = readFileSync(join(report.paths.runDir, trial.name, 'agent', 'mixdog.txt'), 'utf8');
    for (const line of trace.split('\n').filter((value) => value.trim())) {
      const event = JSON.parse(line);
      if (event.type !== 'item.completed') continue;
      const item = event.item || {};
      if (item.type !== 'tool_call') {
        if (item.text) append(`MESSAGE ${item.text}`);
        continue;
      }
      const rawArguments = item.arguments ?? item.input ?? {};
      const input = typeof rawArguments === 'string' ? JSON.parse(rawArguments) : rawArguments;
      append(`TOOL ${item.name}`);
      if (item.name === 'shell') {
        append(input.command ?? '');
      } else if (item.name === 'apply_patch') {
        edits++;
        const patch = input.patch ?? '';
        append(edits === 1
          ? patch.split('\n').filter((value) => value.startsWith('*** ')).join('\n') + '\n[initial patch retained in original trace]'
          : patch);
      } else {
        append(JSON.stringify(input));
      }
      if (['shell', 'apply_patch', 'git', 'task'].includes(item.name) || item.status === 'failed') {
        const result = item.result ?? item.output ?? '';
        const text = typeof result === 'string' ? result : JSON.stringify(result);
        append('RESULT ' + text.slice(0, 1000) + (text.length > 1000 ? ' [inspection excerpt truncated; original retained]' : ''));
      }
    }
  }
  const output = join(root, 'behavior-commands.txt');
  writeFileSync(output, lines.join('\n') + '\n');
  console.log(JSON.stringify({
    run: basename(root), baseline: baseline ? basename(baseline) : null,
    bundle: manifest.bundleSha256, bundleChanges, audit: output, index,
  }));
  baseline = root;
}
