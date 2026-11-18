#!/usr/bin/env node
// Fails when a tracked file carries a developer-machine path (a build checkout, a project checkout or a user
// profile of the machines this repository was developed on). Such paths leak the author's layout into the public
// repository and the npm package, and make a fixture or note mean something only on one disk.
//
// Text and binary files are both scanned, as bytes: an ASCII path inside a binary (or a UTF-16 text, whose NULs are
// dropped for the comparison) is found. A tracked file that cannot be read fails the check; one deleted from the
// working tree but still in the index is read from the index, because that is what would be published.
//
// Usage: node scripts/check-machine-paths.mjs        (from anywhere inside the repository)
// CI: run it in the release gate next to the other `scripts/check-*.mjs` steps, on a full checkout.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SEP = '[\\\\/]+';
// Built from fragments so this file does not match itself.
export const MACHINE_PATH = new RegExp(
  [
    `D:${SEP}mixdog-build`,
    `D:${SEP}Project`,
    `C:${SEP}Users${SEP}tem` + 'pe',
    `C:${SEP}Project${SEP}mixdog`,
    `[\\\\/](?:Users|home)${SEP}tem` + 'pe(?![A-Za-z0-9_])',
  ].join('|'),
  'i',
);

// Every entry needs a reason. `path` is an exact repository path or a RegExp anchored on a directory the entry
// names; nothing else is exempt, so a production file placed beside exempt material is still scanned. Entries for
// material that is not tracked (or no longer tracked) match nothing, so the check passes before and after it leaves git.
const exact = (...files) => new RegExp(`^(?:${files.map((file) => file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);
const under = (...dirs) => new RegExp(`^(?:${dirs.map((dir) => dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})/`);

export const ALLOW = [
  { path: under('benchmarks/terminal-bench-2.1/records'), why: 'recorded benchmark run output: paths are what the run saw, never read as configuration' },
  { path: exact('native/core/vendor/fancy-regex-differential/corpus/shell.json'), why: 'vendored differential corpus: shell commands recorded as data, compared byte for byte' },
  {
    path: exact('native/mixdog-browser-import/dist/mixdog-browser-import.exe', 'native/mixdog-browser-import/dist/bitwarden_chromium_import_helper.exe'),
    why: 'prebuilt helpers embed the build machine\'s cargo registry path; open: rebuild with a path remap, then remove this entry',
  },
  // Rust-core-versus-Node-1.4.5 comparison material (data recorded from Node and the tests built on it). It leaves git
  // with the ci-rust-lane change; the entries are the families still tracked, each a data directory or an exact file.
  {
    path: under(
      'apps/desktop/src/renderer/fixtures/phone-scm',
      'apps/desktop/src/renderer/remote-protocol-chat-history.node',
      'apps/desktop/src/renderer/remote-protocol-chat-roster.node',
      'apps/desktop/src/renderer/remote-protocol-chat-live.core',
      'apps/desktop/src/renderer/remote-protocol-chat-refusals.core',
      'apps/desktop/src/shared/test-recorded',
      'apps/mobile/fixtures',
      'benchmarks/terminal-bench-2.1/analysis/parity/fixtures',
    ),
    why: 'recorded-from-Node data directories: nothing but recordings lives there',
  },
  {
    path: exact(
      'apps/desktop/src/renderer/remote-protocol-chat.recorded.json',
      'apps/desktop/src/renderer/remote-protocol-chat.record.mjs',
      'apps/desktop/src/renderer/remote-protocol-chat-roster.record.mjs',
      'apps/desktop/src/renderer/remote-protocol-chat-node-export.mjs',
      'apps/desktop/src/renderer/remote-protocol-files.slow.test.mjs',
      'apps/desktop/src/renderer/remote-protocol-files-downloads.slow.test.mjs',
      'apps/desktop/src/renderer/remote-protocol-settings.slow.test.mjs',
      'apps/desktop/src/renderer/transcript-tool-live-rows.fixture.json',
      'apps/desktop/src/renderer/transcript-tool-row-pairs.test.mjs',
      'apps/desktop/src/main/desktop-state-project.test.mjs',
      'packages/protocol-client/test/live-turn-items.json',
      'packages/protocol-client/test/live-turn-rows.node.json',
      'packages/protocol-client/test/live-turn-state.node.json',
      'packages/protocol-client/test/rows/node-oracle/moved-tests.test.mjs',
      'native/core/crates/mixdog-highlight/tests/corpus/bash.docs.txt',
      'native/core/crates/mixdog-markdown-ansi/tests/corpus/docs.json',
    ),
    why: 'recorders, recordings and recording-based tests of the same move, named file by file',
  },
  // Held by other owners, named file by file; delete each entry when its owner has rewritten the file.
  { path: exact('apps/desktop/src/main/protocol/service-route.test.mjs', 'apps/desktop/src/main/protocol/session-lane.test.mjs'), why: 'frozen by the desktop protocol owner in this pass; remove once rewritten' },
  { path: exact('native/core/crates/mixdog-entry/Cargo.toml', 'native/core/crates/mixdog-entry/tests/pty_twin.rs'), why: 'owned by the entry change; remove once rewritten' },
];
export function scan(files, read, allow = ALLOW) {
  const hits = [];
  for (const file of files) {
    if (allow.some((entry) => entry.path.test(file))) continue;
    let bytes;
    try {
      bytes = read(file);
    } catch (error) {
      hits.push({ file, line: 0, unreadable: error.message });
      continue;
    }
    const text = Buffer.from(bytes).toString('latin1');
    // A UTF-16 text is ASCII with NULs between: dropping them lets the same pattern match it.
    const view = text.includes('\0') ? text.replaceAll('\0', '') : text;
    view.split(/\r?\n/).forEach((line, index) => {
      if (MACHINE_PATH.test(line)) hits.push({ file, line: index + 1 });
    });
  }
  return hits;
}

export function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 28 }).toString('utf8').split('\0').filter(Boolean);
}

function readTracked(root, file) {
  try {
    return readFileSync(resolve(root, file));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return execFileSync('git', ['cat-file', 'blob', `:${file}`], { cwd: root, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
  }
}

export function checkMachinePaths(root, files = trackedFiles(root)) {
  const hits = scan(files, (file) => readTracked(root, file));
  if (hits.length > 0) {
    const byFile = new Map();
    for (const hit of hits) byFile.set(hit.file, [...(byFile.get(hit.file) ?? []), hit]);
    const list = [...byFile]
      .map(([file, found]) => {
        const bad = found.find((hit) => hit.unreadable);
        if (bad) return `${file}: unreadable (${bad.unreadable.split('\n')[0]})`;
        const lines = found.map((hit) => hit.line);
        return `${file}:${lines.slice(0, 3).join(',')}${lines.length > 3 ? ` (+${lines.length - 3})` : ''}`;
      })
      .join('\n  ');
    throw new Error(`${hits.length} developer-machine path(s) or unreadable file(s) in ${byFile.size} tracked file(s):\n  ${list}`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    checkMachinePaths(resolve(fileURLToPath(import.meta.url), '..', '..'));
    console.log('[machine-paths] ok');
  } catch (error) {
    console.error(`[machine-paths] ${error.message}`);
    process.exitCode = 1;
  }
}
