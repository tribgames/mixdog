// The release inventory: every tracked test file and every Rust test target of the exact release commit, from `git ls-files` and the
// manifests, and nothing else (docs/testing.md, "Release coverage"). It names no case: the cases a file or target holds are what its
// runner reports at run time. It never reads a test command's arguments, a workflow or a run. A test file the plan neither routes nor
// classifies is an error, not an ignore.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import { digestOf, idKey, compareKeys, matchesAny } from './ids.mjs';
import { scanRust } from './inventory-rust.mjs';
import { parseToml } from './toml-lite.mjs';
import { classesOf, clausesFor, obligationOf, planDigest } from './plan.mjs';

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });

/** Tracked paths of the checkout, `/`-separated with tracked spelling. */
export function trackedFiles(root) {
  return git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
}

export const headOf = (root) => git(root, ['rev-parse', 'HEAD']).trim();

/**
 * Why the checkout is not exactly the commit `sha`, or null. The inventory is defined on a commit: `git ls-files` of a checkout whose
 * index or working tree differs (a tracked file deleted or edited, an untracked file added) is not that commit's tree, so it is refused
 * by name rather than read.
 */
export function checkoutProblem(root, sha) {
  const head = headOf(root);
  if (head !== sha) return `the checkout is at ${head}, not the commit ${sha}`;
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=all', '-z']).split('\0').filter(Boolean);
  if (dirty.length === 0) return null;
  return `the checkout differs from the commit ${sha} in ${dirty.length} path(s); the inventory is of a commit, so commit or remove these, or run it in a clean checkout of the commit:\n${dirty.map((line) => `  ${line}`).join('\n')}`;
}

const JS = /\.(?:mjs|cjs|js|ts|tsx|mts|cts|jsx)$/;
const NODE_NAME = /\.(?:test|spec)\.(?:mjs|cjs|js|ts|tsx|mts|cts|jsx)$|-test\.mjs$|_test\.(?:mjs|cjs|js|ts)$/;
const PY_NAME = /(?:^|\/)test_[^/]*\.py$|_test\.py$/;
// Diagnostic only (docs/testing.md): the source with comments removed, searched for a direct load of a test runner.
const LOADS_RUNNER = {
  node: {
    comments: /\/\*[\s\S]*?\*\/|(?<![:'"`\\])\/\/.*$/gm,
    loads:
      /(?:from|import)\s+['"](?:node:)?test['"]|require\(\s*['"](?:node:)?test['"]\s*\)|import\(\s*['"](?:node:)?test['"]\s*\)/,
  },
  python: {
    comments: /#.*$/gm,
    loads: /^\s*(?:import\s+(?:[\w.]+\s*,\s*)*(?:pytest|unittest)\b|from\s+(?:pytest|unittest)\b)/m,
  },
};
const TEST_DIR = /(?:^|\/)(?:tests?|__tests__|e2e|spec)\//;
// source types whose test-looking files no adapter reads: each is an unassigned error unless a reviewed class names it
const CODE =
  /\.(?:rb|go|java|kt|swift|cs|c|cpp|cc|h|hpp|php|lua|sh|ps1|ex|exs|hs|sol|scala|r|m|dart|zig|tf|ml|jl|pl|clj|erl|fs|vb|bat|cmd)$/;
const SHELL_TEST = /\.test\.sh$/;
const TEST_LOOKING_NAME = /(?:^|\/)(?:test_[^/]*|[^/]*[._-](?:test|spec|tests))\.[A-Za-z0-9]+$/;

function workspaceMembers(tracked, read) {
  const roots = new Map();
  for (const path of tracked.filter((file) => posix.basename(file) === 'Cargo.toml')) {
    let toml;
    try {
      toml = parseToml(read(path));
    } catch {
      continue;
    }
    if (!toml.workspace?.members) continue;
    const dir = posix.dirname(path) === '.' ? '' : posix.dirname(path);
    const members = new Set();
    for (const pattern of toml.workspace.members) {
      for (const file of tracked) {
        if (posix.basename(file) !== 'Cargo.toml') continue;
        const memberDir = posix.dirname(file);
        const relative = dir ? (memberDir.startsWith(`${dir}/`) ? memberDir.slice(dir.length + 1) : null) : memberDir;
        if (relative !== null && matchesAny(relative, [pattern])) members.add(memberDir);
      }
    }
    for (const pattern of toml.workspace.exclude ?? [])
      for (const member of [...members])
        if (matchesAny(posix.relative(dir || '.', member), [pattern])) members.delete(member);
    roots.set(dir, members);
  }
  return roots;
}

/**
 * @returns {{ manifest: object, errors: {code: string, path: string, line: number, message: string}[], stats: object }}
 */
export function buildInventory({
  root,
  tracked,
  plan,
  sha = null,
  read = (path) => readFileSync(join(root, path), 'utf8'),
}) {
  const errors = [];
  const units = [];
  const classified = new Map();
  const note = (path, rule) => classified.set(path, rule);
  /** Routes a test file (a family's runner reports its cases) to the legs the plan names, or reports it unrouted. */
  const assign = (family, path) => {
    const { requires } = clausesFor(plan, family, path);
    units.push({ id: [family, path], source: path, requires });
    if (requires.length === 0)
      errors.push({
        code: 'unrouted',
        path,
        line: 0,
        message: `no route of the plan assigns this ${family} test file to a leg`,
      });
  };
  /** The reviewed class of the path, recorded; false when there is none. Two classes that match one path are an error: no class shadows another. */
  const classify = (path) => {
    const rules = classesOf(plan, path);
    if (rules.length > 1)
      errors.push({
        code: 'ambiguous-class',
        path,
        line: 0,
        message: `${rules.length} reviewed classes match this path (${rules.map((rule) => rule.glob).join(', ')})`,
      });
    if (rules.length) note(path, rules[0]);
    return rules.length > 0;
  };

  // --- Node, shell and Python. One convention: a test file is one named the way its runner discovers tests; any other tracked source
  // file that loads a test runner is an error unless the plan classifies it.
  const loadsRunner = (family, text) =>
    LOADS_RUNNER[family].loads.test(text.replace(LOADS_RUNNER[family].comments, ''));
  const unnamed = (path) =>
    errors.push({
      code: 'unassigned-test-file',
      path,
      line: 0,
      message:
        'loads a test runner but is not named like a test file of its runner, so no run discovers it; name it as a test or classify it',
    });
  for (const path of tracked) {
    const family = JS.test(path) ? 'node' : SHELL_TEST.test(path) ? 'shell' : path.endsWith('.py') ? 'python' : null;
    if (family === null) continue;
    const named = { node: NODE_NAME, shell: SHELL_TEST, python: PY_NAME }[family].test(path);
    if (named && !classify(path)) assign(family, path);
    else if (!named && family !== 'shell' && loadsRunner(family, read(path)) && !classify(path)) unnamed(path);
  }

  // --- Rust: the packages, the files their targets reach, the doctests
  const rust = scanRust(tracked, read);
  const members = workspaceMembers(tracked, read);
  const obligations = (clauses) =>
    clauses.map((clause) => ({ anyOf: clause.anyOf.map((ref) => obligationOf(plan, ref)).sort() }));
  for (const pkg of rust.packages) {
    const standalone = (plan.rust?.standalone ?? []).find((unit) => unit.manifestDir === pkg.dir);
    const workspace = [...members.entries()].find(([, set]) => set.has(pkg.dir));
    const planned = standalone || (workspace && workspace[0] === (plan.rust?.workspace ?? ''));
    if (!planned && !classify(pkg.manifest))
      errors.push({
        code: 'package-unplanned',
        path: pkg.manifest,
        line: 0,
        message: `${pkg.name} is neither a member of the planned workspace, a planned standalone unit, nor a reviewed class`,
      });
    if (!planned) continue;
    // every test target of the package is expected, by name: which of them hold tests is what a listing shows at run time
    for (const target of pkg.targets) {
      if (classify(target.root)) continue;
      const id = ['rust', pkg.manifest, target.kind, target.name];
      units.push(
        standalone
          ? { id, source: target.root, listed: true, requires: obligations(standalone.requires) }
          : { id, source: target.root, workspace: true }
      );
    }
  }
  for (const error of rust.errors) if (!(error.path && classify(error.path))) errors.push(error);
  // rustdoc blocks of a lib target: nextest does not run them, so the plan names the leg that runs them with `cargo test --doc`
  for (const doc of new Map(rust.doctests.map((entry) => [`${entry.manifest}\u0000${entry.target}`, entry])).values()) {
    const planned = (plan.rust?.doctests ?? []).find((unit) => unit.manifestDir === doc.dir);
    if (planned)
      units.push({
        id: ['rust', doc.manifest, 'doctest', doc.target],
        source: doc.manifest,
        requires: obligations(planned.requires),
      });
  }
  for (const doc of rust.doctests) {
    if (!(plan.rust?.doctests ?? []).some((unit) => unit.manifestDir === doc.dir) && !classify(doc.file))
      errors.push({
        code: 'unassigned-test-file',
        path: doc.file,
        line: 0,
        message:
          'holds rustdoc blocks that rustdoc would run as doctests; nextest does not run them, so the plan needs a doctest leg for the package or a reviewed class',
      });
  }

  // --- everything else that looks like a test and is none of the above
  for (const path of tracked) {
    if (path.endsWith('.rs') || path.endsWith('.py') || JS.test(path) || SHELL_TEST.test(path)) continue;
    const looking =
      (TEST_DIR.test(path) && CODE.test(path)) ||
      (TEST_LOOKING_NAME.test(path) &&
        !/\.(?:md|json|txt|png|bin|snap|lock|toml|ya?ml|csv|golden|expected|jsonl|svg|html|css)$/.test(path));
    if (looking && !classify(path))
      errors.push({
        code: 'unassigned-test-file',
        path,
        line: 0,
        message: 'looks like a test of a framework no adapter reads and no reviewed class names it',
      });
  }

  units.sort((a, b) => compareKeys(idKey(a.id), idKey(b.id)));
  errors.sort((a, b) =>
    compareKeys(`${a.code} ${a.path} ${a.line} ${a.message}`, `${b.code} ${b.path} ${b.line} ${b.message}`)
  );
  const legs = plan.legs.map((leg) => leg.id).sort();
  const slots = plan.legs
    .flatMap((leg) =>
      leg.slots.map((slot) => ({ leg: leg.id, slot: slot.id, parent: slot.parent ?? null, producer: slot.producer }))
    )
    .sort((a, b) => compareKeys(`${a.leg} ${a.slot}`, `${b.leg} ${b.slot}`));
  const manifest = {
    v: 2,
    sha,
    planDigest: planDigest(plan),
    legs,
    slots,
    units,
    classified: [...classified]
      .map(([path, rule]) => ({
        path,
        class: rule.class,
        reason: rule.reason,
        ...(rule.joinSlot ? { joinSlot: rule.joinSlot } : {}),
      }))
      .sort((a, b) => compareKeys(a.path, b.path)),
  };
  manifest.digest = digestOf(manifest);
  return {
    manifest,
    errors,
    stats: { files: tracked.length, units: units.length, errors: errors.length, classified: classified.size },
  };
}
