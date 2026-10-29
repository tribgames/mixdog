import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;

const root = mkdtempSync(join(tmpdir(), 'mixdog-turn-baseline-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.on('exit', () => {
  rmSync(root, { recursive: true, force: true });
});

const { createTurnWorktreeSnapshot, resumeTurnWorktreeSnapshot } = await import('./turn-worktree-snapshot.mjs');

function git(cwd, args, { input, env } = {}) {
  const result = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    input: input === undefined ? undefined : Buffer.from(input),
    env: env ? { ...process.env, ...env } : process.env,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.toString('utf8').trim();
}

function put(repo, path, content) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

/** The per-file sequence the batched apply replaces, run with plain git: the
 *  tree, then each entry hashed with `hash-object --stdin --path` and added or
 *  force-removed, in an index of its own. */
function perFileResult(repo, state, tree, entries) {
  const index = join(root, `oracle-index-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: index };
  const args = (...rest) => [
    ...state.lineEndingArgs,
    '-c',
    'core.safecrlf=false',
    '-c',
    'core.quotepath=false',
    '--git-dir',
    state.gitDir,
    '--work-tree',
    repo,
    ...rest,
  ];
  git(repo, args('read-tree', tree), { env });
  const oids = new Map();
  for (const entry of entries) {
    let oid = entry.oid || null;
    if (entry.content !== undefined) {
      oid = git(repo, args('hash-object', '-w', '--stdin', '--path', entry.path), { input: entry.content, env });
    }
    if (oid) git(repo, args('update-index', '--add', '--cacheinfo', '100644', oid, entry.path), { env });
    else git(repo, args('update-index', '--force-remove', '--', entry.path), { env });
    oids.set(entry.path, oid);
  }
  const result = { tree: git(repo, args('write-tree'), { env }), oids };
  rmSync(index, { force: true });
  return result;
}

/** The git verbs `task` started, from git's own process trace. */
async function tracedVerbs(task) {
  const trace = join(root, `trace2-${Math.random().toString(36).slice(2)}.json`);
  process.env.GIT_TRACE2_EVENT = trace;
  let result;
  try {
    result = await task();
  } finally {
    delete process.env.GIT_TRACE2_EVENT;
  }
  const verbs = readFileSync(trace, 'utf8')
    .split('\n')
    .filter((line) => line.includes('"event":"start"'))
    .map((line) => JSON.parse(line).argv)
    .map((argv) => argv.find((arg) => /^(read-tree|ls-tree|check-attr|hash-object|update-index|write-tree)$/.test(arg)))
    .filter(Boolean);
  return { result, verbs };
}

const NFD_HANGUL = '\u1112\u1161\u11ab\u1100\u1165\u11af/\u1111\u1161\u110b\u1175\u11af.txt';
const LONG_PATH = `${Array.from({ length: 5 }, (_, index) => `${index}${'l'.repeat(25)}`).join('/')}/file.txt`;
const CRLF = 'one\r\ntwo\r\nthree\r\n';

const ATTRIBUTES = [
  '*.txt text eol=crlf',
  '*.sh eol=lf',
  '*.dat binary',
  '*.md text=auto',
  '*.bin -text',
  '*.flt filter=up',
  '[attr]keep -text',
  '*.keep keep',
  '',
].join('\n');

const CONFIGS = [
  { name: 'autocrlf true', autocrlf: 'true', attributes: '' },
  { name: 'autocrlf input', autocrlf: 'input', attributes: '' },
  { name: 'autocrlf false', autocrlf: 'false', attributes: '' },
  { name: 'eol, text=auto, binary attributes with autocrlf false', autocrlf: 'false', attributes: ATTRIBUTES },
  { name: 'eol, text=auto, binary attributes with autocrlf true', autocrlf: 'true', attributes: ATTRIBUTES },
  { name: 'eol, text=auto, binary attributes with autocrlf input', autocrlf: 'input', attributes: ATTRIBUTES },
];

function entriesFor(headBlob) {
  const names = [
    'new-crlf.txt',
    'dir/mixed.txt',
    'dir/sub/lone.txt',
    'tracked.txt',
    'crlf-tracked.txt',
    'auto.md',
    'script.sh',
    'blob.bin',
    'data.dat',
    'x.flt',
    'x.keep',
    'sp ace/two words.txt',
    '한글/파일.txt',
    NFD_HANGUL,
    LONG_PATH,
    'ünï/ç.txt',
    '[brk]/{x}.txt',
    '#hash.txt',
    '$dollar.txt',
    "q'uote.txt",
    '%pct.txt',
    // Git for Windows refuses a colon in a path. A leading colon is pathspec magic,
    // which sends the whole apply to the per-file sequence, so it stays mid-name here.
    process.platform === 'win32' ? 'colon.txt' : 'mid:colon.txt',
    process.platform === 'win32' ? 'glob[a-z]!.txt' : 'star*.txt',
    process.platform === 'win32' ? 'auxiliary.txt' : 'aux.txt',
    '.gitattributes',
    'nested/deep/inner.txt',
  ];
  const contents = [
    CRLF,
    'a\r\nb\nc\r\n',
    'a\rb\nc\r',
    'q\r\nw\r\n',
    'a\r\nb\r\n',
    'x\r\ny\r\n',
    'echo\r\n',
    Buffer.from([0x00, 0x0d, 0x0a, 0x41, 0x0d, 0x0a]),
    Buffer.from('plain\r\ntext\r\n'),
    'filtered\r\n',
    'kept\r\n',
    'sp\r\nace\r\n',
    '한글\r\n',
    'nfd\r\nname\r\n',
    'long\r\npath\r\n',
    'ünï\r\n',
    'brk\r\n',
    'hash\r\n',
    'dollar $Id: abc $\r\n',
    'quote\n',
    'pct\r\n',
    'lead\r\n',
    'star\r\n',
    'aux\r\n',
    '*.txt text eol=crlf\n',
    CRLF,
  ];
  return [
    ...names.map((path, index) => ({ path, content: contents[index] })),
    { path: 'recorded.txt', oid: headBlob },
    { path: 'gone.txt' },
    { path: 'never/was/there.txt' },
  ];
}

for (const config of CONFIGS) {
  test(`recorded first states give git's per-file trees and blob ids: ${config.name}`, {
    skip: gitAvailable ? false : 'git is unavailable',
  }, async () => {
    const repo = join(root, `repo-${CONFIGS.indexOf(config)}`);
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q']);
    // Blobs of both line endings in the base tree, committed before any conversion applies.
    git(repo, ['config', 'core.autocrlf', 'false']);
    put(repo, 'tracked.txt', 'q\n');
    put(repo, 'crlf-tracked.txt', 'a\r\nb\r\n');
    put(repo, 'recorded.txt', 'recorded\n');
    put(repo, 'gone.txt', 'gone\n');
    put(repo, 'dir/.gitattributes', '*.txt -text\n');
    put(repo, 'dir/mixed.txt', 'm\n');
    if (config.attributes) put(repo, '.gitattributes', config.attributes);
    // A nested attribute file that overrides whatever the root says.
    put(repo, 'nested/.gitattributes', '*.txt -text\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'seed']);
    git(repo, ['config', 'core.autocrlf', config.autocrlf]);
    // One of the paths has an attribute file only the commit has.
    rmSync(join(repo, 'dir', '.gitattributes'));

    const base = await createTurnWorktreeSnapshot(repo);
    const entries = entriesFor(git(repo, ['rev-parse', 'HEAD:tracked.txt']));
    const expected = perFileResult(repo, base.state, base.baselineTree, entries);
    const { result: resumed, verbs } = await tracedVerbs(() =>
      resumeTurnWorktreeSnapshot(repo, base.baselineTree, { baselineFiles: entries })
    );

    // One read-tree, one check-attr and one update-index: the batch, not the per-file fallback.
    assert.equal(verbs.filter((verb) => verb === 'update-index').length, 1);
    assert.equal(verbs.filter((verb) => verb === 'check-attr').length, 1);
    assert.equal(resumed.baselineTree, expected.tree, 'tree');
    const actual = new Map([...resumed.baselineFiles.values()].map(({ path, oid }) => [path, oid]));
    assert.deepEqual(
      [...actual].sort(([left], [right]) => (left < right ? -1 : 1)),
      [...expected.oids].sort(([left], [right]) => (left < right ? -1 : 1))
    );
    // `-text` in nested/.gitattributes keeps the bytes as they are, whatever the root says.
    assert.equal(actual.get('nested/deep/inner.txt'), git(repo, ['hash-object', '--no-filters', '--stdin'], { input: CRLF }));
    if (!config.attributes && config.autocrlf !== 'false') {
      // The comparison above would pass if nothing were converted at all.
      const raw = git(repo, ['hash-object', '--no-filters', '--stdin'], { input: CRLF });
      assert.notEqual(actual.get('new-crlf.txt'), raw);
    }
    assert.deepEqual(
      readdirSync(base.state.gitDir).filter((name) => name.startsWith('baseline-work') || name.startsWith('index.baseline')),
      []
    );
  });
}

test('a file and directory swap is decided by the per-file sequence, error included', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async () => {
  const repo = join(root, 'repo-swap');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  put(repo, 'a', 'a file\n');
  put(repo, 'd/f', 'inside d\n');
  put(repo, 'keep.txt', 'keep\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'seed']);
  const base = await createTurnWorktreeSnapshot(repo);
  const others = [
    { path: 'c.txt', content: 'c\n' },
    { path: 'e.txt', content: 'e\n' },
  ];
  const attempt = async (run) => {
    try {
      return { tree: await run() };
    } catch {
      return { failed: true };
    }
  };
  const scenarios = [
    { name: 'a file becomes a directory', entries: [{ path: 'a/b', content: 'b\n' }, ...others], fails: true },
    { name: 'a directory becomes a file', entries: [{ path: 'd', content: 'd\n' }, ...others], fails: true },
    {
      name: 'two added paths, one the directory of the other',
      entries: [{ path: 'x', content: 'x\n' }, { path: 'x/y', content: 'y\n' }, ...others],
      fails: true,
    },
    {
      name: 'a recorded oid below a file',
      entries: [{ path: 'a/b', oid: git(repo, ['rev-parse', 'HEAD:keep.txt']) }, ...others],
      fails: true,
    },
    {
      name: 'the file removed first',
      entries: [{ path: 'a' }, { path: 'a/b', content: 'b\n' }, ...others],
      fails: false,
    },
  ];
  for (const { name, entries, fails } of scenarios) {
    const expected = await attempt(async () => perFileResult(repo, base.state, base.baselineTree, entries).tree);
    assert.equal(Boolean(expected.failed), fails, `${name}: per-file outcome`);
    const { result: actual, verbs } = await tracedVerbs(() =>
      attempt(async () => (await resumeTurnWorktreeSnapshot(repo, base.baselineTree, { baselineFiles: entries })).baselineTree)
    );
    assert.deepEqual(actual, expected, name);
    assert.equal(verbs.includes('check-attr'), false, `${name}: no batch`);
    assert.deepEqual(
      readdirSync(base.state.gitDir).filter((entry) => entry.startsWith('baseline-work') || entry.startsWith('index.baseline')),
      []
    );
  }
});

test('recorded first states cost a constant number of git processes', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async () => {
  const repo = join(root, 'repo-count');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'core.autocrlf', 'true']);
  put(repo, 'keep.txt', 'keep\n');
  put(repo, 'gone.txt', 'gone\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'seed']);
  const base = await createTurnWorktreeSnapshot(repo);
  const entries = [
    ...['a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({ path: `pkg/${name}.txt`, content: `${name}\r\n` })),
    { path: 'gone.txt' },
    { path: 'never.txt' },
  ];
  const expected = perFileResult(repo, base.state, base.baselineTree, entries);

  const { result: resumed, verbs } = await tracedVerbs(() =>
    resumeTurnWorktreeSnapshot(repo, base.baselineTree, { baselineFiles: entries })
  );
  // The baseline applies first (read-tree and the ls-tree probe run together);
  // the capture after it runs its own write-tree.
  assert.deepEqual(
    verbs.slice(0, 6).sort(),
    ['read-tree', 'ls-tree', 'check-attr', 'hash-object', 'update-index', 'write-tree'].sort()
  );
  assert.equal(resumed.baselineTree, expected.tree);
  assert.deepEqual(
    Object.fromEntries([...resumed.baselineFiles.values()].map(({ path, oid }) => [path, oid])),
    Object.fromEntries(expected.oids)
  );
  assert.equal(existsSync(join(base.state.gitDir, 'index')), true);
});
