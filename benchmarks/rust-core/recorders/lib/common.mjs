// Shared plumbing for the P0-BENCH recorders: argument parsing, the Node tree
// under test, statistics, stable JSON, hashing, the secret scan and the
// fixture-set manifest writer. Node built-ins only.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const FIXTURES_ROOT = join(REPO_ROOT, 'native', 'core', 'fixtures');
export const RESULTS_ROOT = join(REPO_ROOT, 'benchmarks', 'rust-core', 'results');

/** `--name value` / `--flag` pairs. */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument ${argv[i]}`);
    const name = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args.set(name, 'true');
    else {
      args.set(name, next);
      i += 1;
    }
  }
  return args;
}

/**
 * The Node product tree the recorders drive (must contain `node_modules`).
 * Default: this checkout. CI uses `npm ci`; on a dev PC pass `--tree <dir>`
 * (a `git archive HEAD` extraction with a node_modules junction works).
 */
export function resolveTree(args) {
  const tree = resolve(args.get('tree') ?? process.env.MIXDOG_BENCH_TREE ?? REPO_ROOT);
  if (!existsSync(join(tree, 'node_modules'))) {
    throw new Error(`tree ${tree} has no node_modules: pass --tree <dir with node_modules> or run npm ci`);
  }
  loadedTree = tree;
  return tree;
}

export const importFrom = (tree, rel) => import(pathToFileURL(join(tree, rel)).href);

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

let loadedTree = null;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'target']);

function productFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile()) out.push(join(dir, entry.name));
    }
  };
  walk(root);
  return out;
}

const gitBlobSha1 = (data) => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');

/**
 * Identity of the Node product tree the recorder actually loaded (never the
 * checkout the recorder script lives in). Works for git checkouts and archive
 * extractions alike: `srcSha256`/`appsSha256` hash every source file's relative
 * path and bytes (node_modules/dist/out/target skipped). `commit` is set only
 * when this checkout's `git ls-tree -r HEAD src apps` lists exactly the tree's
 * files with identical blob ids (mode bits are ignored: archives lose them on
 * Windows); otherwise it is null and `repoHeadComparison` says how far the
 * tree is from HEAD. `--tree-commit` is not trusted for the same reason.
 */
export function productIdentity(tree = loadedTree, ref = 'HEAD') {
  if (!tree) throw new Error('productIdentity: no tree resolved yet (call resolveTree first)');
  const git = (...a) => execFileSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const perRoot = {};
  const blobs = new Map();
  const lfBlobs = new Map();
  for (const name of ['src', 'apps']) {
    const root = join(tree, name);
    const h = createHash('sha256');
    for (const file of productFiles(root).sort()) {
      const rel = relative(tree, file).split(sep).join('/');
      const data = readFileSync(file);
      h.update(`${rel}\0${sha256(data)}\n`);
      blobs.set(rel, gitBlobSha1(data));
      // Windows extraction can turn LF into CRLF (text=auto); the LF form is the committed blob.
      if (data.includes(0x0d) && !data.includes(0)) lfBlobs.set(rel, gitBlobSha1(Buffer.from(data.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')));
    }
    perRoot[name] = h.digest('hex');
  }
  // Compare against `ref` first, then against the last commits that touched
  // src/apps, so an archive taken a few commits ago still gets its commit.
  const compare = (commit) => {
    const committed = new Map();
    for (const line of git('ls-tree', '-r', commit, 'src', 'apps').split('\n').filter(Boolean)) {
      const [meta, path] = line.split('\t');
      committed.set(path, meta.split(' ')[2]);
    }
    let differing = 0;
    // Two-sided: a loaded file absent from the commit differs; the LF alternative counts only when it exists for that path.
    for (const [path, id] of blobs) {
      const want = committed.get(path);
      if (want === undefined) differing += 1;
      else if (want !== id && (!lfBlobs.has(path) || want !== lfBlobs.get(path))) differing += 1;
    }
    const missingFromTree = [...committed.keys()].filter((p) => !blobs.has(p)).length;
    return { commit, differing, missingFromTree };
  };
  const candidates = [git('rev-parse', `${ref}^{commit}`).trim()];
  if (ref === 'HEAD') candidates.push(...git('rev-list', '-n', '60', 'HEAD', '--', 'src', 'apps').split('\n').filter(Boolean));
  let best = null;
  for (const commit of [...new Set(candidates)]) {
    const c = compare(commit);
    if (!best || c.differing + c.missingFromTree < best.differing + best.missingFromTree) best = c;
    if (c.differing === 0 && c.missingFromTree === 0) break;
  }
  const differing = best.differing;
  const missingFromTree = best.missingFromTree;
  const equalsHead = differing === 0 && missingFromTree === 0;
  return {
    tree: 'product tree loaded by the recorder',
    treeKind: existsSync(join(tree, '.git')) ? 'git-checkout' : 'archive',
    version: JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8')).version,
    srcSha256: perRoot.src,
    appsSha256: perRoot.apps,
    files: blobs.size,
    commit: equalsHead ? best.commit : null,
    comparedAgainst: ref === 'HEAD' ? 'HEAD and the 60 latest commits touching src/apps' : ref,
    refComparison: { closestCommit: best.commit, exact: equalsHead, filesDifferingFromCommit: differing, commitFilesMissingFromTree: missingFromTree },
  };
}

/**
 * Identity of a product tree that is a git checkout of `tag`: HEAD is the tag's commit and the working tree has no
 * change, so the files the recorder loads are the tag's. Throws otherwise (an archive or a modified checkout proves
 * nothing about the release). The shape is `productIdentity`'s, with `exact` set by the comparison itself.
 */
export function tagCheckoutIdentity(tree, tag) {
  if (!existsSync(join(tree, '.git'))) throw new Error(`tree ${tree} is not a git checkout (no .git): record from a clone at ${tag}`);
  const git = (...a) => execFileSync('git', ['-C', tree, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim();
  const commit = git('rev-parse', 'HEAD');
  const tagged = git('rev-parse', `refs/tags/${tag}^{commit}`);
  if (commit !== tagged) throw new Error(`tree ${tree} is at ${commit}, not at ${tag} (${tagged})`);
  const changed = git('status', '--porcelain', '--untracked-files=all');
  if (changed) throw new Error(`tree ${tree} has changes against ${tag}:\n${changed}`);
  return {
    tree: 'product tree loaded by the recorder',
    treeKind: 'git-checkout',
    version: JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8')).version,
    tag,
    commit,
    exact: true,
    comparedAgainst: tag,
    refComparison: { closestCommit: tagged, exact: true, filesDifferingFromCommit: 0, commitFilesMissingFromTree: 0 },
  };
}

/** Nearest-rank percentile of an ascending numeric array. */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

export function summarize(samples) {
  const sorted = samples.filter(Number.isFinite).sort((a, b) => a - b);
  const r = (v) => (v === null ? null : Math.round(v * 100) / 100);
  return {
    n: sorted.length,
    min: r(sorted[0] ?? null),
    p50: r(percentile(sorted, 50)),
    p95: r(percentile(sorted, 95)),
    p99: r(percentile(sorted, 99)),
    max: r(sorted.at(-1) ?? null),
  };
}

/**
 * JSON in the key order Node built the value in. Goldens are written with this: a Rust test that hashes,
 * serializes, truncates to the first N keys or compares the text of a golden object (serde_json
 * `preserve_order` reads the order back) must see the order Node produced, and a sorted file cannot show it.
 */
export const orderedStringify = (value, indent = 2) => `${JSON.stringify(value, null, indent)}\n`;

/** JSON with sorted object keys: only for files whose bytes are compared for identity (the manifests). */
export function stableStringify(value, indent = 2) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sort(v[k])])
      );
    }
    return v;
  };
  return `${JSON.stringify(sort(value), null, indent)}\n`;
}

export function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export const writeJson = (path, value) => writeText(path, orderedStringify(value));

/** Manifests and their index: canonical (sorted) so hashing never depends on construction order. */
export const writeCanonicalJson = (path, value) => writeText(path, stableStringify(value));

/** Credential shapes that must never reach a checked-in fixture. */
export const SECRET_PATTERNS = [
  // `sk-DUMMY-` is the migration corpus's sanitized placeholder marker, the only accepted exemption.
  /sk-(?!DUMMY-)[A-Za-z0-9_-]{20,}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /xox[abp]-[A-Za-z0-9-]{20,}/,
];

export function scanForSecrets(text, where) {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) throw new Error(`secret-shaped text (${pattern}) in ${where}`);
  }
}

export function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out.sort();
}

let identityCache = null;
const productIdentityOnce = () => (identityCache ??= productIdentity());
const identityFor = (tree, ref) => (tree ? productIdentity(tree, ref) : productIdentityOnce());

/**
 * Writes `<setDir>/MANIFEST.json` for one fixture set: every file with its
 * size and sha256, the recorder command that reproduces it, and the identity
 * of the product it was recorded from. The manifest itself is excluded.
 */
export function writeSetManifest(setDir, { set, recorder, command, extra = {}, identityTree = null, identityRef = 'HEAD', identity = null }) {
  const files = walkFiles(setDir)
    .filter((f) => f !== join(setDir, 'MANIFEST.json'))
    .map((f) => {
      const data = readFileSync(f);
      if (!f.endsWith('.bin')) scanForSecrets(data.toString('utf8'), f);
      return { path: relative(setDir, f).split(sep).join('/'), bytes: data.length, sha256: sha256(data) };
    });
  writeCanonicalJson(join(setDir, 'MANIFEST.json'), {
    set,
    recorder,
    command,
    product: identity ?? identityFor(identityTree, identityRef),
    ...extra,
    fileCount: files.length,
    totalBytes: files.reduce((s, f) => s + f.bytes, 0),
    files,
  });
  return files.length;
}

/**
 * Safe re-recording of a set: the recorder writes into a staging copy of
 * `finalDir` (so files other recorders own are kept), with the sub-directories
 * it owns removed from the copy; `commitStage` swaps the finished copy in.
 * `finalDir` is never touched until the new set is completely written, so an
 * interrupted or crashed run leaves the previous set intact.
 */
export function stageSet(finalDir, ownedSubdirs = null) {
  const stage = `${finalDir}.stage`;
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  if (existsSync(finalDir)) cpSync(finalDir, stage, { recursive: true });
  for (const sub of ownedSubdirs ?? readdirSync(stage)) rmSync(join(stage, sub), { recursive: true, force: true });
  return stage;
}

// Swaps entry by entry, not the directory itself: Windows refuses to rename a
// directory some other process (a test run, an indexer) holds a handle inside.
export function commitStage(stage, finalDir) {
  const isDir = (p) => existsSync(p) && statSync(p).isDirectory();
  const sync = (from, to) => {
    mkdirSync(to, { recursive: true });
    const names = new Set(readdirSync(from));
    for (const name of readdirSync(to)) if (!names.has(name)) rmSync(join(to, name), { recursive: true, force: true });
    for (const name of names) {
      const src = join(from, name);
      const dst = join(to, name);
      if (isDir(src) && isDir(dst)) sync(src, dst);
      else {
        rmSync(dst, { recursive: true, force: true });
        renameSync(src, dst);
      }
    }
  };
  sync(stage, finalDir);
  rmSync(stage, { recursive: true, force: true });
}

/**
 * Re-lists a set whose manifest another recorder owns (a recorder that adds one
 * file to a shared set): keeps recorder/command/extra, recomputes files and the
 * identity from `tree`.
 */
export function refreshSetManifest(setDir, tree, ref = 'HEAD') {
  const old = JSON.parse(readFileSync(join(setDir, 'MANIFEST.json'), 'utf8'));
  const { set, recorder, command, product: _p, fileCount: _c, totalBytes: _t, files: _f, ...extra } = old;
  return writeSetManifest(setDir, { set, recorder, command, extra, identityTree: tree, identityRef: ref });
}

export const fileSize =(p) => statSync(p).size;
