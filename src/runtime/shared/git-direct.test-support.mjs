// Side-effect import for the git-heavy suites. Import it before anything that
// spawns git or snapshots process.env.
//
// On Windows `git` on PATH is usually Git for Windows' cmd\git.exe launcher,
// which starts the real git.exe as a second process, so every spawn pays two
// process creations (~75 ms instead of ~40 ms). These suites spawn hundreds of
// git processes, test and code under test alike (the git runner worker shares
// process.env), so the real binary's directory (`git --exec-path`, where git
// itself resolves its subcommands) goes first on PATH. Same git, same config;
// only the launcher hop is skipped. Elsewhere `git` already is the binary.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join, normalize } from 'node:path';

if (process.platform === 'win32') {
  const probe = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true });
  const dir = probe.status === 0 ? normalize(probe.stdout.trim()) : '';
  if (dir && existsSync(join(dir, 'git.exe'))) process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;
}
