// The controlled git the recorder provides (git-standin.cs, compiled by the .NET Framework's csc, present on every Windows):
// an executable that records its argv, cwd and environment block, answers from a script, and, as a launcher, sets variables and
// starts another stand-in. The install trees of git-launch-cases hold copies of it as Git/cmd/git.exe, Git/bin/git.exe (launcher)
// and Git/<msystem>/bin/git.exe (the real binary).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecorderError } from './recorder-error.mjs';

const CSC = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
export const standinSource = new URL('./git-standin.cs', import.meta.url);

let built = null;
export function buildStandin() {
  if (built) return built;
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-git-standin-'));
  built = join(dir, 'standin.exe');
  try { execFileSync(CSC, ['/nologo', '/target:exe', `/out:${built}`, fileURLToPath(standinSource)], { stdio: 'pipe' }); } catch (e) { built = null; throw new RecorderError(`the git stand-in did not compile: ${e.message}`); }
  return built;
}

const escape = (text) => text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
/** Installs a stand-in at `exe`. answers: [[lastArg|'*', exitCode, stdout|'$ENV', stderr]]; wrapper: lines of the launcher script. */
export function installStandin(exe, { answers = [], wrapper = null } = {}) {
  copyFileSync(buildStandin(), exe);
  if (wrapper) writeFileSync(`${exe}.wrapper`, wrapper.join('\n'));
  else writeFileSync(`${exe}.answers`, answers.map(([match, code, out, err]) => [match, code, out === '$ENV' ? out : escape(out), escape(err)].join('\t')).join('\n'));
}

/** What the stand-in recorded at `exe`: one {argv, cwd, env} per start, in order. */
export function standinStarts(exe) {
  const log = `${exe}.log`;
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}
