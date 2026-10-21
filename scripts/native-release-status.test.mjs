import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  devWarnings,
  NATIVE_RELEASE_TOOLS,
  nativeReleaseStatuses,
  refreshStaleLocalBinaries,
  unreleasedProblems,
} from './native-release-status.mjs';

const patch = NATIVE_RELEASE_TOOLS.find((tool) => tool.kind === 'patch');
const graph = NATIVE_RELEASE_TOOLS.find((tool) => tool.kind === 'graph');

function git(root, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, encoding: 'utf8' });
}

function write(root, path, text) {
  const full = join(root, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
}

// A repo whose manifests pin patch-v1.0.0 and graph-v2.0.0, tagged at the first commit.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-release-status-'));
  git(root, 'init', '-q');
  for (const tool of [patch, graph]) {
    write(root, tool.manifestPath, JSON.stringify({ version: tool === patch ? '1.0.0' : '2.0.0' }));
    write(root, `${tool.dir}/src/main.rs`, 'fn main() {}\n');
    write(root, `${tool.dir}/Cargo.toml`, '[package]\nname = "x"\n');
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'release sources');
  git(root, 'tag', 'patch-v1.0.0');
  git(root, 'tag', 'graph-v2.0.0');
  return root;
}

const statuses = (root) => nativeReleaseStatuses(root, [patch, graph]);

test('a tool whose source matches its pinned tag is released', () => {
  const root = fixture();
  try {
    assert.deepEqual(
      statuses(root).map((status) => status.unreleased),
      [false, false]
    );
    assert.deepEqual(unreleasedProblems(statuses(root)), []);
    // Manifest-only commits (the post-release pin sync) never count as native changes.
    write(root, patch.manifestPath, JSON.stringify({ version: '1.0.0', note: 'sync' }));
    git(root, 'commit', '-qam', 'chore(patch): sync manifest');
    assert.equal(statuses(root)[0].unreleased, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a committed source change after the pinned tag is an unreleased tool, others stay released', () => {
  const root = fixture();
  try {
    write(root, `${patch.dir}/src/fs_atomic.rs`, '// fix\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'fix: patch');
    const [patchStatus, graphStatus] = statuses(root);
    assert.equal(patchStatus.unreleased, true);
    assert.deepEqual(patchStatus.changedFiles, [`${patch.dir}/src/fs_atomic.rs`]);
    assert.equal(patchStatus.commits.length, 1);
    assert.equal(graphStatus.unreleased, false);
    const problems = unreleasedProblems([patchStatus, graphStatus]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^patch: 1 file\(s\) changed since patch-v1\.0\.0 .*native=auto/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a committed change that was reverted is not unreleased', () => {
  const root = fixture();
  try {
    write(root, `${patch.dir}/src/main.rs`, 'fn main() { 1; }\n');
    git(root, 'commit', '-qam', 'change');
    write(root, `${patch.dir}/src/main.rs`, 'fn main() {}\n');
    git(root, 'commit', '-qam', 'revert');
    assert.equal(statuses(root)[0].unreleased, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uncommitted and untracked native files are unreleased', () => {
  const root = fixture();
  try {
    write(root, `${graph.dir}/src/new.rs`, '// wip\n');
    const graphStatus = statuses(root)[1];
    assert.equal(graphStatus.unreleased, true);
    assert.equal(graphStatus.changedFiles.length, 0);
    assert.equal(graphStatus.dirtyFiles.length, 1);
    assert.match(unreleasedProblems([graphStatus])[0], /uncommitted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a manifest pinning a tag that does not exist is unreleased', () => {
  const root = fixture();
  try {
    write(root, patch.manifestPath, JSON.stringify({ version: '9.9.9' }));
    const status = statuses(root)[0];
    assert.equal(status.tagMissing, true);
    assert.equal(status.unreleased, true);
    assert.match(unreleasedProblems([status])[0], /patch-v9\.9\.9 does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a local release binary older than its sources is stale, warned about and rebuilt', async () => {
  const root = fixture();
  try {
    const bin = join(root, patch.dir, 'target', 'release', patch.binaryName);
    write(root, `${patch.dir}/target/release/${patch.binaryName}`, 'old');
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(bin, past, past);
    assert.equal(statuses(root)[0].local.stale, true);
    assert.equal(statuses(root)[1].local.exists, false);
    assert.match(devWarnings(statuses(root)).join('\n'), /patch: .*older than its sources/);

    const built = [];
    const logs = [];
    const results = await refreshStaleLocalBinaries({
      root,
      tools: [patch, graph],
      log: (line) => logs.push(line),
      build: async (_root, tool) => {
        built.push(tool.kind);
        write(root, `${tool.dir}/target/release/${tool.binaryName}`, 'new');
        return 0;
      },
    });
    assert.deepEqual(built, ['patch']);
    assert.deepEqual(results, [{ kind: 'patch', rebuilt: true }]);
    assert.equal(statuses(root)[0].local.stale, false);

    // A build that fails leaves the binary stale and says so instead of throwing.
    utimesSync(bin, past, past);
    const failed = await refreshStaleLocalBinaries({
      root,
      tools: [patch],
      log: (line) => logs.push(line),
      build: async () => 1,
    });
    assert.deepEqual(failed, [{ kind: 'patch', rebuilt: false }]);
    assert.match(logs.at(-1), /rebuild failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
