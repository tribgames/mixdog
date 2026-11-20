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

const graph = NATIVE_RELEASE_TOOLS.find((tool) => tool.kind === 'graph');
const other = Object.freeze({
  kind: 'other',
  dir: 'native/mixdog-other',
  manifestPath: 'src/runtime/agent/orchestrator/tools/other-manifest.json',
  tagPrefix: 'other-v',
  binaryName: `mixdog-other${process.platform === 'win32' ? '.exe' : ''}`,
});

function git(root, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, encoding: 'utf8' });
}

function write(root, path, text) {
  const full = join(root, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
}

// A repo whose manifests pin graph-v1.0.0 and other-v2.0.0, tagged at the first commit.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-release-status-'));
  git(root, 'init', '-q');
  for (const tool of [graph, other]) {
    write(root, tool.manifestPath, JSON.stringify({ version: tool === graph ? '1.0.0' : '2.0.0' }));
    write(root, `${tool.dir}/src/main.rs`, 'fn main() {}\n');
    write(root, `${tool.dir}/Cargo.toml`, '[package]\nname = "x"\n');
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'release sources');
  git(root, 'tag', 'graph-v1.0.0');
  git(root, 'tag', 'other-v2.0.0');
  return root;
}

const statuses = (root) => nativeReleaseStatuses(root, [graph, other]);

test('a tool whose source matches its pinned tag is released', () => {
  const root = fixture();
  try {
    assert.deepEqual(
      statuses(root).map((status) => status.unreleased),
      [false, false]
    );
    assert.deepEqual(unreleasedProblems(statuses(root)), []);
    // Manifest-only commits (the post-release pin sync) never count as native changes.
    write(root, graph.manifestPath, JSON.stringify({ version: '1.0.0', note: 'sync' }));
    git(root, 'commit', '-qam', 'chore(graph): sync manifest');
    assert.equal(statuses(root)[0].unreleased, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a committed source change after the pinned tag is an unreleased tool, others stay released', () => {
  const root = fixture();
  try {
    write(root, `${graph.dir}/src/fs_atomic.rs`, '// fix\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'fix: graph');
    const [graphStatus, otherStatus] = statuses(root);
    assert.equal(graphStatus.unreleased, true);
    assert.deepEqual(graphStatus.changedFiles, [`${graph.dir}/src/fs_atomic.rs`]);
    assert.equal(graphStatus.commits.length, 1);
    assert.equal(otherStatus.unreleased, false);
    const problems = unreleasedProblems([graphStatus, otherStatus]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^graph: 1 file\(s\) changed since graph-v1\.0\.0 .*native=auto/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a committed change that was reverted is not unreleased', () => {
  const root = fixture();
  try {
    write(root, `${graph.dir}/src/main.rs`, 'fn main() { 1; }\n');
    git(root, 'commit', '-qam', 'change');
    write(root, `${graph.dir}/src/main.rs`, 'fn main() {}\n');
    git(root, 'commit', '-qam', 'revert');
    assert.equal(statuses(root)[0].unreleased, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uncommitted and untracked native files are unreleased', () => {
  const root = fixture();
  try {
    write(root, `${other.dir}/src/new.rs`, '// wip\n');
    const otherStatus = statuses(root)[1];
    assert.equal(otherStatus.unreleased, true);
    assert.equal(otherStatus.changedFiles.length, 0);
    assert.equal(otherStatus.dirtyFiles.length, 1);
    assert.match(unreleasedProblems([otherStatus])[0], /uncommitted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a manifest pinning a tag that does not exist is unreleased', () => {
  const root = fixture();
  try {
    write(root, graph.manifestPath, JSON.stringify({ version: '9.9.9' }));
    const status = statuses(root)[0];
    assert.equal(status.tagMissing, true);
    assert.equal(status.unreleased, true);
    assert.match(unreleasedProblems([status])[0], /graph-v9\.9\.9 does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a local release binary older than its sources is stale, warned about and rebuilt', async () => {
  const root = fixture();
  try {
    const bin = join(root, graph.dir, 'target', 'release', graph.binaryName);
    write(root, `${graph.dir}/target/release/${graph.binaryName}`, 'old');
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(bin, past, past);
    assert.equal(statuses(root)[0].local.stale, true);
    assert.equal(statuses(root)[1].local.exists, false);
    assert.match(devWarnings(statuses(root)).join('\n'), /graph: .*older than its sources/);

    const built = [];
    const logs = [];
    const results = await refreshStaleLocalBinaries({
      root,
      tools: [graph, other],
      log: (line) => logs.push(line),
      build: async (_root, tool) => {
        built.push(tool.kind);
        write(root, `${tool.dir}/target/release/${tool.binaryName}`, 'new');
        return 0;
      },
    });
    assert.deepEqual(built, ['graph']);
    assert.deepEqual(results, [{ kind: 'graph', rebuilt: true }]);
    assert.equal(statuses(root)[0].local.stale, false);

    // A build that fails leaves the binary stale and says so instead of throwing.
    utimesSync(bin, past, past);
    const failed = await refreshStaleLocalBinaries({
      root,
      tools: [graph],
      log: (line) => logs.push(line),
      build: async () => 1,
    });
    assert.deepEqual(failed, [{ kind: 'graph', rebuilt: false }]);
    assert.match(logs.at(-1), /rebuild failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the release plan tracks graph while retained patch and spawn source changes are core changes', () => {
  const root = fixture();
  try {
    write(root, 'native/mixdog-patch/src/lib.rs', '// embedded library');
    write(root, 'native/mixdog-spawn/src/lib.rs', '// embedded library');
    const result = nativeReleaseStatuses(root);
    assert.deepEqual(
      result.map(({ kind }) => kind),
      ['graph']
    );
    assert.deepEqual(unreleasedProblems(result), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
