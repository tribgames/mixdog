#!/usr/bin/env node
// The release coverage tool (docs/testing.md, "Release coverage").
//
//   node scripts/ci/coverage/cli.mjs inventory --root <checkout> [--sha <commit>] --out <manifest.json>
//       Builds the inventory (test files and Rust targets, never cases) from `git ls-files` of the exact commit: HEAD must equal --sha (HEAD itself when it is not given) and the
//       index and working tree must be clean, or it names what differs and stops (the inventory is of a commit, never of local files).
//       Exits 1 and writes nothing when a test file or target is unassigned or unrouted; `--report <file>` writes the errors
//       as JSON either way.
//   node scripts/ci/coverage/cli.mjs reconcile --root <checkout> --manifest <manifest.json> --evidence <dir> --rust-lists <dir>
//                                              --sha <commit> --run-id <id> --attempt <n> --repository <owner/name> --workflow <ref>
//       Compares the manifest with the receipts under <dir> (every *.json receipt, children folders followed). Exit 0 only when the
//       release is covered.
//   node scripts/ci/coverage/cli.mjs join --manifest <manifest.json> --evidence <dir> --sha <commit> --run-id <id> --attempt <n>
//                                         --repository <owner/name> --workflow <ref>
//       The release workflow's join (release.yml): the receipts of the plan's join legs (prepared environments only that workflow builds)
//       against the gate's manifest. Exit 0 only when every exception whose replacement names a join obligation passed there.
//   node scripts/ci/coverage/cli.mjs exceptions
//       Validates scripts/ci/coverage/exceptions.json against its schema.
//   node scripts/ci/coverage/cli.mjs wiring --root <checkout>
//       Checks the parsed workflows against the reviewed plan: every release sink behind the full gate, legs with producers.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { packagesByName } from './adapters.mjs';
import { loadRustLists } from './artifacts.mjs';
import { loadExceptions } from './exceptions.mjs';
import { buildInventory, checkoutProblem, headOf, trackedFiles } from './inventory.mjs';
import { loadPlan } from './plan.mjs';
import { reconcile, reconcileJoin } from './reconcile.mjs';
import { readReceipts } from '../receipt.mjs';
import { loadWorkflows, wiringProblems } from './wiring.mjs';

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

/** Receipt files below `dir`: every *.json outside a `.children` folder (reconcile follows those itself). */
function receiptFiles(dir) {
  const out = [];
  const walk = (folder) => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) {
        if (!name.endsWith('.children') && !name.endsWith('.parts')) walk(path);
      } else if (name.endsWith('.json')) out.push(path);
    }
  };
  walk(dir);
  return out;
}

async function main(argv) {
  const [command, ...rest] = argv;
  const plan = loadPlan();
  if (command === 'exceptions') {
    loadExceptions(plan);
    console.log('exceptions.json: ok');
    return 0;
  }
  const options = flags(rest);
  const root = resolve(options.root ?? '.');
  const context = { sha: options.sha, runId: options['run-id'], attempt: options.attempt,
    repository: options.repository, workflow: options.workflow, allowReused: process.env.ALLOW_REUSED_EVIDENCE === 'true' };
  if (command === 'wiring') {
    const problems = wiringProblems(loadWorkflows(root), plan);
    for (const problem of problems) console.error(problem);
    if (problems.length) return 1;
    console.log('wiring: every release sink is reached only through the full gate');
    return 0;
  }
  if (command === 'inventory') {
    // The inventory is of a commit: the checkout must be that commit (HEAD when no --sha names one), with nothing changed or added.
    const sha = options.sha ?? headOf(root);
    const problem = checkoutProblem(root, sha);
    if (problem) {
      console.error(problem);
      return 1;
    }
    const tracked = trackedFiles(root);
    const { manifest, errors, stats } = buildInventory({ root, tracked, plan, sha });
    if (options.report) {
      mkdirSync(dirname(resolve(options.report)), { recursive: true });
      writeFileSync(options.report, `${JSON.stringify(errors, null, 1)}\n`);
    }
    if (errors.length) {
      for (const error of errors) console.error(`${error.code}: ${error.path}${error.line ? `:${error.line}` : ''} ${error.message}`);
      const byCode = Object.entries(Object.groupBy(errors, (error) => error.code)).map(([code, list]) => `${code} ${list.length}`).sort();
      console.error(`${errors.length} inventory error(s) in ${stats.files} tracked files of ${sha} (${byCode.join(', ')}): no manifest is written; each needs a route of the plan or a reviewed class`);
      return 1;
    }
    mkdirSync(dirname(resolve(options.out)), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(manifest)}\n`);
    console.log(`inventory: ${stats.units} test files and targets, digest ${manifest.digest}`);
    return 0;
  }
  if (command === 'reconcile') {
    const manifest = JSON.parse(readFileSync(options.manifest, 'utf8'));
    const tracked = trackedFiles(root);
    const { byName, errors } = packagesByName(tracked, (path) => readFileSync(join(root, path), 'utf8'));
    const loaded = options['rust-lists'] ? loadRustLists(options['rust-lists'], plan, { gate: process.env.GATE_NAME, sha: options.sha }) : { lists: {}, problems: [] };
    const rustLists = loaded.lists;
    const problems = [...loaded.problems, ...reconcile({
      manifest,
      plan,
      exceptions: loadExceptions(plan),
      receipts: readReceipts(receiptFiles(options.evidence)),
      context: { ...context, joins: process.env.GATE_JOINS === 'true', gate: process.env.GATE_NAME },
      rustLists,
      byName,
    })];
    for (const error of errors) problems.push(`${error.code}: ${error.path} ${error.message}`);
    for (const problem of problems) console.error(problem);
    if (problems.length) {
      console.error(`${problems.length} coverage problem(s): the release is not covered at ${options.sha}`);
      return 1;
    }
    console.log(`coverage: every test file and target of ${options.sha} ran a case on each leg that must run it, and every skip is an exact reviewed exception`);
    return 0;
  }
  if (command === 'join') {
    const problems = reconcileJoin({
      manifest: JSON.parse(readFileSync(options.manifest, 'utf8')),
      plan,
      exceptions: loadExceptions(plan),
      receipts: readReceipts(receiptFiles(options.evidence)),
      context,
    });
    for (const problem of problems) console.error(problem);
    if (problems.length) {
      console.error(`${problems.length} join problem(s): the prepared-environment replacements of ${options.sha} were not executed`);
      return 1;
    }
    console.log(`join: every prepared-environment replacement of ${options.sha} passed`);
    return 0;
  }
  console.error('usage: cli.mjs inventory|reconcile|join|exceptions|wiring ...');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(process.argv[1]))) process.exit(await main(process.argv.slice(2)));
