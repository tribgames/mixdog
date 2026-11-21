#!/usr/bin/env node
// Usage: node scripts/check-machine-paths.mjs        (from anywhere inside the repository)
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
  'i'
);

// Every entry needs a reason. `path` is an exact repository path or a RegExp anchored on a directory the entry
// names; nothing else is exempt, so a production file placed beside exempt material is still scanned. Entries for
// material that is not tracked (or no longer tracked) match nothing, so the check passes before and after it leaves git.
const exact = (...files) =>
  new RegExp(`^(?:${files.map((file) => file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);
const under = (...dirs) =>
  new RegExp(`^(?:${dirs.map((dir) => dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})/`);

export const ALLOW = [
  {
    path: under('benchmarks/terminal-bench-2.1/records'),
    why: 'recorded benchmark run output: paths are what the run saw, never read as configuration',
  },
  {
    path: exact('native/core/vendor/fancy-regex-differential/corpus/shell.json'),
    why: 'vendored differential corpus: shell commands recorded as data, compared byte for byte',
  },
  {
    path: exact(
      'native/mixdog-browser-import/dist/mixdog-browser-import.exe',
      'native/mixdog-browser-import/dist/bitwarden_chromium_import_helper.exe'
    ),
    why: "prebuilt helpers embed the build machine's cargo registry path; open: rebuild with a path remap, then remove this entry",
  },
  // Recordings and recording-based tests still tracked: paths are what the recording machine saw, kept as data.
  {
    path: under(
      'apps/desktop/src/renderer/remote-protocol-chat-live.core',
      'apps/desktop/src/renderer/remote-protocol-chat-refusals.core'
    ),
    why: 'recorded data directories: nothing but recordings lives there',
  },
  {
    path: exact(
      'apps/desktop/src/renderer/transcript-tool-live-rows.fixture.json',
      'apps/desktop/src/renderer/transcript-tool-row-pairs.test.mjs',
      'apps/desktop/src/main/desktop-state-project.test.mjs',
      'packages/protocol-client/test/live-turn-items.json',
      'native/core/crates/mixdog-highlight/tests/corpus/bash.docs.txt',
      'native/core/crates/mixdog-markdown-ansi/tests/corpus/docs.json'
    ),
    why: 'recordings and recording-based tests, named file by file',
  },
  // Held by other owners, named file by file; delete each entry when its owner has rewritten the file.
  {
    path: exact(
      'apps/desktop/src/main/protocol/service-route.test.mjs',
      'apps/desktop/src/main/protocol/session-lane.test.mjs'
    ),
    why: 'frozen by the desktop protocol owner in this pass; remove once rewritten',
  },
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
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 28 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function readTracked(root, file) {
  try {
    return readFileSync(resolve(root, file));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return execFileSync('git', ['cat-file', 'blob', `:${file}`], {
      cwd: root,
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
    throw new Error(
      `${hits.length} developer-machine path(s) or unreadable file(s) in ${byFile.size} tracked file(s):\n  ${list}`
    );
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
