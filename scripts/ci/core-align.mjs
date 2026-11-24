#!/usr/bin/env node
// A build of part of the core's workspace (a push's or a pull request's changed crates and their dependents) unifies the features
// of fewer crates than a build of the whole, so on its own it would compile some crates otherwise than the whole build does. The
// `changes` job resolves the selection once against `cargo tree --workspace` and every job that compiles it takes that result:
// each round selects the workspace crates the last tree of the selection resolved otherwise, with the features the whole gives
// them (`args`), until `check` finds no crate, third-party ones included, in either role, resolved otherwise.
//
//   node scripts/ci/core-align.mjs args --packages "-p a -p b" --metadata <cargo metadata --no-deps> --whole <tree of the whole>
//          [--tree <tree of the selection so far>] [--features <the features so far>]
//   node scripts/ci/core-align.mjs check --whole <tree of the whole> --tree <tree of the selection>
//
// A tree is cargo tree's own indented one, `cargo tree --locked --charset utf8 -f "{p} {f}"`, over the same selection and
// features as the build.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HACK = 'mixdog-workspace-hack';

/**
 * `<role> <name> <version>` -> the feature lists cargo tree printed for the crate in that role (four columns a level): a crate is
 * built for the host (`host`) below a `[build-dependencies]` heading, as a proc macro, or below a crate built for the host;
 * otherwise for the target (`target`). Cargo resolves the features of the two roles apart, and a host build of a crate is another
 * unit than its target build.
 */
export function parseTree(text) {
  const out = new Map();
  const hostAt = [];
  const headingAt = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/ \(\*\)$/, '');
    if (!line.trim()) continue;
    const column = /^[\s│├└─]*/u.exec(line)[0].length;
    const depth = column / 4;
    const body = line.slice(column);
    if (body.startsWith('[')) {
      headingAt[depth] = body.trim();
      continue;
    }
    const host =
      (depth > 0 && (hostAt[depth - 1] || headingAt[depth - 1] === '[build-dependencies]')) ||
      / \(proc-macro\)/.test(body);
    hostAt.length = depth;
    headingAt.length = depth;
    hostAt[depth] = host;
    const at = body.lastIndexOf(' ');
    const [name, version] = body.slice(0, at).split(' ');
    const key = `${host ? 'host' : 'target'} ${name} ${version}`;
    if (!out.has(key)) out.set(key, new Set());
    out.get(key).add(
      body
        .slice(at + 1)
        .split(',')
        .filter(Boolean)
        .sort()
        .join(',')
    );
  }
  return out;
}

const nameOf = (key) => key.split(' ')[1];

// The features of a crate in the target role: `--features <crate>/<feature>` names those of the selected package.
const featuresOf = (tree, name) => {
  const out = new Set();
  for (const [key, lists] of tree)
    if (key.startsWith('target ') && nameOf(key) === name)
      for (const list of lists) for (const feature of list.split(',').filter(Boolean)) out.add(feature);
  return out;
};

/**
 * The `--features` of a partial build: for each crate it selects, the features the whole build enables on it that the last tree
 * of the selection lacked. Only those: `--features <crate>/<feature>` also turns on an optional dependency named <crate> of every
 * other selected crate, which the whole build may not do.
 */
export function selectionFeatures(whole, selected, extra = [], tree = new Map()) {
  const features = new Set(extra);
  for (const name of selected) {
    const had = featuresOf(tree, name);
    for (const feature of featuresOf(whole, name)) if (!had.has(feature)) features.add(`${name}/${feature}`);
  }
  return [...features].sort();
}

/**
 * The workspace crates a partial build must also select so that it can name their features: the workspace members the tree
 * resolves otherwise. A third-party crate cannot be selected; its difference is the workspace hack's to close.
 */
export function widening(whole, tree, members) {
  const names = new Set();
  for (const [key, lists] of tree) {
    const name = nameOf(key);
    if (members.includes(name) && name !== HACK && [...lists].some((list) => !whole.get(key)?.has(list)))
      names.add(name);
  }
  return [...names].sort();
}

/** Every crate the selection compiles with a feature list the whole does not give it, in that role. */
export function mismatches(whole, tree) {
  const out = [];
  for (const [key, lists] of tree)
    for (const list of lists)
      if (!whole.get(key)?.has(list))
        out.push(`${key}: the selection resolves [${list}], the whole [${[...(whole.get(key) ?? [])].join('] [')}]`);
  return out;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const whole = parseTree(readFileSync(args.whole, 'utf8'));
  if (command === 'args') {
    const members = JSON.parse(readFileSync(args.metadata, 'utf8')).packages.map((pkg) => pkg.name);
    const given = args.packages.split(/\s+/).filter((part) => part && part !== '-p');
    const tree = args.tree ? parseTree(readFileSync(args.tree, 'utf8')) : undefined;
    const selected = [...new Set([...given, ...(tree ? widening(whole, tree, members) : [])])];
    const required = (args.features ?? '')
      .split(',')
      .filter((feature) => feature && selected.includes(feature.split('/')[0]));
    console.log(`packages=${selected.map((name) => `-p ${name}`).join(' ')}`);
    // The first round names the features it was given; each next one adds what its tree still lacked.
    console.log(`features=${(tree ? selectionFeatures(whole, selected, required, tree) : required).join(',')}`);
  } else if (command === 'check') {
    const problems = mismatches(whole, parseTree(readFileSync(args.tree, 'utf8')));
    for (const problem of problems) console.error(problem);
    if (problems.length) {
      console.error(
        'This selection would compile the crates above with other features than the whole build: a workspace crate is selected with its features by the next round, a third-party feature belongs in the workspace hack (cargo hakari generate).'
      );
      process.exit(1);
    }
    console.log('every crate of the selection resolves as in the whole build');
  } else {
    throw new Error(`unknown command ${command}`);
  }
}
