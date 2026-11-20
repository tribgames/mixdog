// The release reconciler (docs/testing.md, "Release coverage"): two independently produced sets, compared at the exact release commit.
// The inventory (the manifest) assigns each test file and Rust target to the legs that must run it; the receipts hold what each leg's own
// runner reported, case by case. A case's name comes from the runner at run time, never from the source. Fail closed:
//   1. every artifact is intact, from this commit and run, with a single producer attempt per leg, and exactly the declared legs and slots;
//   2. every reported case belongs to an assigned file or target, on a leg that is assigned it, and none failed;
//   3. every assigned file or target ran at least one case on each of its clauses' legs (a clause whose only reports are skips is met
//      only when each skip is an exception whose replacement runs that case elsewhere);
//   4. every skipped, todo or ignored report matches an exact reviewed exception tuple, and every tuple was reported (stale tuples fail).
// It returns every problem, sorted, so a reviewer sees what is missing, extra, stale or on the wrong leg, and who produces it.
// It does not prove a test body checks anything: a case that returns early passes.
import { readReceipts, receiptProblems } from '../receipt.mjs';
import { digestOf, idKey, compareKeys, matchesAny } from './ids.mjs';
import { OS_OF, allows } from './exceptions.mjs';
import { isJoinObligation, obligationOf, planDigest } from './plan.mjs';
import { listedSuites, listedTests } from './adapters.mjs';

const FAILED = new Set(['fail', 'cancelled']);
const isSkipped = (observation) => ['skip', 'todo', 'xfail', 'ignored'].includes(observation.status);

/**
 * The file or target a case belongs to: `['node', file]`, `['python', file]`, `['shell', file]` (a suite report belongs to its file),
 * or `['rust', manifest, kind, target]` of a Rust target (`doctest` for the rustdoc blocks of a lib).
 */
function unitKey(id) {
  const family = id[0].replace(/-suite$/, '');
  return family === 'rust' ? idKey(id.slice(0, 4)) : idKey([family, id[1]]);
}

/**
 * @param {object} input
 * @param {object} input.manifest the inventory manifest (inventory.mjs)
 * @param {object} input.plan the reviewed plan
 * @param {object} input.exceptions the reviewed exception list
 * @param {{path: string, parent: string|null, receipt?: object, problem?: string}[]} input.receipts every receipt, children included
 *   (receipt.mjs readReceipts: `parent` is the receipt whose children folder held it)
 * @param {{sha: string, runId: string, attempt: string, repository: string, workflow: string, allowReused?: boolean, joins?: boolean, gate?: string}} input.context the trusted run (`joins`: the caller joins prepared-environment evidence)
 * @param {{[variant: string]: {all: object, profiles: {[profile: string]: object}}}} [input.rustLists] unfiltered nextest listings per variant
 * @param {Map<string, object>} [input.byName] tracked packages by name (adapters.packagesByName)
 * @returns {string[]} problems; empty means the release is covered
 */
export function reconcile({ manifest, plan, exceptions, receipts, context, rustLists = {}, byName = new Map() }) {
  const problems = [];
  const fail = (text) => problems.push(text);
  const at = (ref) => obligationOf(plan, ref);

  // ---- 0. the denominator and the plan it was routed by
  manifestProblems(manifest, plan, context, fail);
  /** the files and targets the inventory expects, by identity */
  const expected = new Map(manifest.units.map((unit) => [idKey(unit.id), unit]));
  /** unit → the clauses it must discharge; a classified file or target has none but its skips are still checked */
  const required = new Map(
    [...expected].filter(([, unit]) => unit.requires && !unit.listed).map(([key, unit]) => [key, unit.requires])
  );
  const exempt = new Set(
    manifest.classified.flatMap((entry) => ['node', 'python', 'shell'].map((family) => idKey([family, entry.path])))
  );

  // ---- 1. artifacts
  const intact = artifacts(receipts, plan.legs, context, fail);

  // ---- 2-3. observations, then the Rust targets against the runners' listings
  const { observed, passed, listings } = observations(intact, fail);
  const { dropped, promised } = rustListingProblems({
    manifest,
    plan,
    rustLists,
    byName,
    listings,
    expected,
    required,
    exempt,
    at,
    fail,
  });
  for (const [unit, list] of observed) {
    if (required.has(unit) || exempt.has(unit)) continue;
    fail(
      `unknown: ${unit} was reported by ${list[0].leg} slot ${list[0].slot} but the inventory assigns no test file or target of that name`
    );
  }
  const excepted = exceptions.exceptions;
  const { used, usedAt } = skipProblems(observed, dropped, excepted, fail);
  routingProblems(required, observed, dropped, fail);
  replacementProblems({ excepted, used, usedAt, passed, promised, plan, context, at, fail });
  return [...new Set(problems)].sort(compareKeys);
}

/** Step 2: every report of every intact receipt, by file or target; failures are problems here, the rest is judged by the later steps. */
function observations(intact, fail) {
  const observed = new Map();
  /** case → the obligations that passed it */
  const passed = new Map();
  const listings = [];
  for (const { path, receipt, leg } of intact) {
    const slot = receipt.envelope.slot;
    const where = `${leg.id}#${slot}`;
    if (receipt.listing !== undefined) listings.push({ where, list: receipt.listing });
    for (const record of receipt.records) {
      const key = idKey(record.id);
      if (FAILED.has(record.status))
        fail(
          `failed: ${key} ${record.status} in ${leg.id} slot ${slot}${record.reasonText ? ` (${record.reasonText})` : ''}`
        );
      // a passing suite says nothing: its cases are reported on their own
      if (record.kind === 'suite' && record.status === 'pass') continue;
      if (record.status === 'pass') passed.set(key, [...(passed.get(key) ?? []), where]);
      const unit = unitKey(record.id);
      observed.set(unit, [
        ...(observed.get(unit) ?? []),
        {
          key,
          id: record.id,
          kind: record.kind,
          at: where,
          leg: leg.id,
          slot,
          os: leg.os,
          status: record.status,
          reasonCode: record.reasonCode ?? 'uncoded',
          reasonText: record.reasonText ?? '',
          path,
        },
      ]);
    }
  }
  return { observed, passed, listings };
}

/** Step 3: the Rust targets the inventory expects, against the runners' own listings. Adds listed targets' clauses to `required`. */
function rustListingProblems({
  manifest,
  plan,
  rustLists,
  byName,
  listings,
  expected,
  required,
  exempt,
  at,
  fail,
}) {
  /** per build variant, and per leg slot for the listings of standalone runs: the targets the listing shows */
  const shown = new Map();
  /** a target the plan declares absent from a variant (a platform cfg), by rule and never by what a listing lacks */
  const absentOn = (unit, variant) =>
    (plan.rust?.absent ?? []).some((rule) => rule.variants.includes(variant) && matchesAny(unit.source, [rule.glob]));
  /** @param {'workspace'|'listed'} how */
  const osOf = (where) => plan.legs.find((leg) => where.startsWith(`${leg.id}#`))?.os;
  const consider = (suites, how, clausesOf, from, variant) => {
    for (const suite of suites) {
      const key = idKey(suite.id);
      if (manifest.classified.some((entry) => entry.path === suite.root)) {
        exempt.add(key);
        continue;
      }
      if (!expected.get(key)?.[how] || absentOn(expected.get(key), how === 'listed' ? osOf(variant) : variant)) {
        fail(`unexplained: ${key} is listed by ${from} but the inventory expects no such target there`);
        continue;
      }
      shown.set(variant, (shown.get(variant) ?? new Set()).add(key));
      if (suite.count > 0) required.set(key, [...(required.get(key) ?? []), ...clausesOf(expected.get(key))]);
    }
  };
  const dropped = new Set();
  /** an ignored test a profile leg is to run: the exact case must pass there */
  const promised = new Map();
  for (const variant of plan.rust?.variants ?? []) {
    const lists = rustLists[variant.name];
    if (!lists) {
      fail(`missing: no unfiltered nextest listing for build variant ${variant.name} (${variant.listLeg})`);
      continue;
    }
    try {
      const testAts = variant.testLegs.map(at);
      const legs = [
        ...new Set([
          ...testAts,
          ...Object.values(variant.profileLegs ?? {})
            .flat()
            .map(at),
        ]),
      ].sort();
      consider(
        listedSuites(lists.all, byName),
        'workspace',
        () => [{ anyOf: legs }],
        `the ${variant.name} build`,
        variant.name
      );
      const profileMatches = new Map();
      for (const [profile, list] of Object.entries(lists.profiles ?? {})) {
        for (const test of listedTests(list, byName))
          if (test.matches)
            profileMatches.set(idKey(test.id), [...(profileMatches.get(idKey(test.id)) ?? []), profile]);
      }
      for (const test of listedTests(lists.all, byName)) {
        const targets = (profileMatches.get(idKey(test.id)) ?? [])
          .filter((profile) => variant.profileLegs?.[profile])
          .flatMap((profile) => variant.profileLegs[profile].map(at));
        if (!test.ignored || targets.length === 0) continue;
        // the partitions report it ignored (a scheduler exclusion); the profile leg must pass the same case
        promised.set(`${idKey(test.id)}|${variant.name}`, { key: idKey(test.id), targets, variant: variant.name });
        for (const testAt of testAts) dropped.add(`${idKey(test.id)}|${testAt}`);
      }
    } catch (error) {
      fail(`the listing of ${variant.name} is unreadable: ${error.message}`);
    }
  }
  for (const { where, list } of listings) {
    try {
      consider(
        listedSuites(list, byName),
        'listed',
        (unit) => unit.requires.filter((clause) => clause.anyOf.includes(where)),
        where,
        where
      );
    } catch (error) {
      fail(`the listing in ${where} is unreadable: ${error.message}`);
    }
  }
  // a target the inventory expects that a listing does not show has vanished from that variant; another variant showing it proves nothing
  for (const [key, unit] of expected) {
    if (unit.workspace) {
      for (const variant of (plan.rust?.variants ?? []).filter((entry) => rustLists[entry.name]))
        if (!absentOn(unit, variant.name) && !shown.get(variant.name)?.has(key))
          fail(`vanished: ${key} is expected on ${variant.name} but its listing does not show it`);
    } else if (unit.listed) {
      // each platform the plan assigns the crate to has its own listing, and must show the target (or be declared without it)
      for (const clause of unit.requires) {
        const seen = clause.anyOf.some((where) => shown.get(where)?.has(key));
        if (!seen && !clause.anyOf.some((where) => absentOn(unit, osOf(where))))
          fail(`vanished: ${key} is expected on ${clause.anyOf.join(' or ')} but no listing there shows it`);
      }
    }
  }
  return { dropped, promised };
}

/** Step 4: an exact reviewed exception for every skip; marks the tuples used and which obligations reported them. */
function skipProblems(observed, dropped, excepted, fail) {
  const used = new Set();
  /** tuple → the obligations that reported the skip it excuses */
  const usedAt = new Map();
  for (const list of observed.values()) {
    for (const observation of list) {
      if (
        !isSkipped(observation) ||
        (observation.status === 'ignored' && dropped.has(`${observation.key}|${observation.at}`))
      )
        continue;
      const kind =
        observation.status === 'ignored'
          ? 'ignored'
          : observation.status === 'todo' || observation.status === 'xfail'
            ? 'todo'
            : 'skip';
      const probe = {
        id: observation.id,
        platform: observation.os,
        slot: observation.slot,
        kind,
        reasonCode: observation.reasonCode,
        reasonText: observation.reasonText,
      };
      const index = excepted.findIndex((tuple) => allows(tuple, probe));
      if (index < 0)
        fail(
          `unexcepted skip: ${observation.key} ${kind} on ${observation.os} (${observation.leg} slot ${observation.slot}) reason ${observation.reasonCode}${observation.reasonText ? ` "${observation.reasonText}"` : ''} has no reviewed exception`
        );
      else {
        used.add(index);
        usedAt.set(index, [...(usedAt.get(index) ?? []), observation.at]);
        observation.tuple = excepted[index];
      }
    }
  }
  return { used, usedAt };
}

/** Step 5: each file or target ran a case on the legs that must run it. */
function routingProblems(required, observed, dropped, fail) {
  for (const [unit, clauses] of required) {
    if (clauses.length === 0) {
      fail(`unrouted: ${unit} has no applicable leg`);
      continue;
    }
    const all = (observed.get(unit) ?? []).filter(
      (observation) => !(observation.status === 'ignored' && dropped.has(`${observation.key}|${observation.at}`))
    );
    const named = new Set(clauses.flatMap((clause) => clause.anyOf));
    for (const observation of all)
      if (!named.has(observation.at))
        fail(
          `wrong leg: ${unit} was reported by ${observation.leg} slot ${observation.slot}, which no routing clause of it names`
        );
    for (const clause of clauses) {
      const here = all.filter((observation) => clause.anyOf.includes(observation.at));
      const ran = here.some((observation) => observation.kind === 'case' && observation.status === 'pass');
      // a leg that only skips a file is not where it runs: its skips must each say where the case runs instead
      const elsewhere =
        here.length > 0 &&
        here.every((observation) => isSkipped(observation) && observation.tuple?.replacement.kind === 'runs');
      if (!ran && !elsewhere)
        fail(
          `no-cases: ${unit} ran no case in ${clause.anyOf.join(' or ')}: nothing was reported there, or every report was a failure or a skip with no replacement`
        );
    }
  }
}

/** Step 6: every exception was reported, and what runs its case instead did. */
function replacementProblems({ excepted, used, usedAt, passed, promised, plan, context, at, fail }) {
  excepted.forEach((tuple, index) => {
    const key = idKey(tuple.id);
    if (!used.has(index)) {
      fail(
        `stale exception: ${key} on ${tuple.platform} (${tuple.kind}, ${tuple.reasonCode}) was not reported by any leg: the case runs, is gone, or skips for another reason`
      );
      return;
    }
    // where the excepted case is executed instead: a pass of it there, or a pass of every test that starts it as a child process
    const replacement = tuple.replacement;
    if (replacement.kind === 'runs') {
      let targets;
      try {
        targets = replacement.in.map(at);
      } catch (error) {
        fail(`no replacement: ${key} is excepted on ${tuple.platform} with a replacement that ${error.message}`);
        return;
      }
      // a prepared environment only a release workflow builds: its own join checks that pass (cli.mjs join), the gate cannot see it
      const joins = targets.filter((target) => isJoinObligation(plan, target));
      // a gate call with no join (release-gate.yml `joins`) cannot accept the promise: nothing would check it before an outward effect
      // unless the plan scopes the case to other gates (it tests an artifact only they build), and then this gate is not asked for it
      const scope = (plan.gateScopes ?? []).find((entry) => idKey(entry.id) === key);
      if (joins.length === targets.length && !context.joins && scope && !scope.gates.includes(context.gate)) return;
      if (joins.length && !context.joins) {
        fail(
          `no replacement: ${key} is excepted on ${tuple.platform} with a replacement in a join leg, which this gate call (${context.gate}) has no join for`
        );
        return;
      }
      if (joins.length === targets.length) return;
      if (joins.length)
        fail(
          `no replacement: ${key} is excepted on ${tuple.platform} with a replacement that mixes gate legs and join legs`
        );
      if (!(passed.get(key) ?? []).some((where) => targets.includes(where)))
        fail(
          `no replacement: ${key} is excepted on ${tuple.platform} because it runs in ${targets.join(' or ')}, which reported no pass of it`
        );
    } else if (replacement.kind === 'parent') {
      // the child is a test of the parent's own invocation: the parent must pass where the child was reported
      for (const parentId of replacement.parents)
        for (const where of new Set(usedAt.get(index)))
          if (!(passed.get(idKey(parentId)) ?? []).includes(where))
            fail(
              `no replacement: ${key} is excepted on ${tuple.platform} because ${idKey(parentId)} starts it, which did not pass in ${where}`
            );
    }
  });
  // a scope names a case an exception sends to a join leg, or it is stale
  for (const scope of plan.gateScopes ?? [])
    if (
      !excepted.some(
        (tuple) =>
          idKey(tuple.id) === idKey(scope.id) &&
          tuple.replacement.kind === 'runs' &&
          tuple.replacement.in.every((ref) => isJoinObligation(plan, at(ref)))
      )
    )
      fail(
        `stale scope: ${idKey(scope.id)} is scoped to ${scope.gates.join(', ')} but no exception sends it to a join leg`
      );
  for (const { key, targets, variant } of promised.values())
    if (!(passed.get(key) ?? []).some((where) => targets.includes(where)))
      fail(
        `no replacement: ${key} is ignored in the ${variant} partitions and a profile leg is to run it, but ${targets.join(' or ')} reported no pass of it`
      );
}


/** The manifest is version 1, of this commit, intact, and routed by this plan. */
function manifestProblems(manifest, plan, context, fail) {
  if (manifest.v !== 2) fail('the manifest is not version 2');
  if (manifest.sha !== context.sha) fail(`the manifest is for ${manifest.sha}, the release commit is ${context.sha}`);
  const { digest, ...bare } = manifest;
  if (digest !== digestOf(bare)) fail('the manifest digest does not match its content');
  if (manifest.planDigest !== planDigest(plan))
    fail('the manifest was routed by another plan than the one in the checkout');
  if (JSON.stringify(plan.legs.map((leg) => leg.id).sort()) !== JSON.stringify(manifest.legs))
    fail('the manifest legs differ from the plan legs');
}

/**
 * Step 1 of the decision for a set of declared legs: every receipt is intact, of this commit, repository, workflow, run and attempt,
 * from the leg, slot, producer and parent invocation it names, and the declared slots equal the received ones in both directions.
 * @returns {{path: string, receipt: object, leg: object}[]} the receipts whose records are observations
 */
function artifacts(receipts, legs, context, fail) {
  const planLegs = new Map(legs.map((leg) => [leg.id, leg]));
  const byLeg = new Map();
  const legAttempts = new Map();
  const invocationIds = new Map();
  const byPath = new Map(receipts.filter((entry) => entry.receipt).map((entry) => [entry.path, entry.receipt]));
  const intact = [];
  for (const { path, parent, receipt, problem } of receipts) {
    if (problem) {
      fail(`${path}: ${problem}`);
      continue;
    }
    const own = receiptProblems(receipt);
    for (const text of own) fail(`${path}: the receipt ${text}`);
    if (own.length) continue;
    const env = receipt.envelope;
    if (invocationIds.has(receipt.id))
      fail(`${path}: the invocation id ${receipt.id} is also the id of ${invocationIds.get(receipt.id)}`);
    invocationIds.set(receipt.id, path);
    if (env.sha !== context.sha) fail(`${path}: produced at ${env.sha}, not the release commit ${context.sha}`);
    if (env.repository !== context.repository)
      fail(`${path}: produced in the repository ${env.repository}, not ${context.repository}`);
    if (env.workflow !== context.workflow)
      fail(`${path}: produced by the workflow ${env.workflow}, not ${context.workflow}`);
    if (String(env.runId) !== String(context.runId)) fail(`${path}: from run ${env.runId}, not ${context.runId}`);
    const attempt = String(env.attempt);
    const reused = context.allowReused && /^[1-9]\d*$/.test(attempt) && Number(attempt) < Number(context.attempt);
    if (attempt !== String(context.attempt) && !reused)
      fail(`${path}: from attempt ${attempt}, not permitted in attempt ${context.attempt}`);
    if (legAttempts.has(env.leg) && legAttempts.get(env.leg) !== attempt)
      fail(`${path}: leg ${env.leg} mixes producer attempts`);
    legAttempts.set(env.leg, attempt);
    const leg = planLegs.get(env.leg);
    if (!leg) {
      fail(`${path}: names the leg ${env.leg}, which the plan does not declare`);
      continue;
    }
    if (OS_OF[receipt.platform] !== leg.os) fail(`${path}: ran on ${receipt.platform}, the leg ${leg.id} is ${leg.os}`);
    const slot = leg.slots.find((entry) => entry.id === env.slot);
    if (!slot) {
      fail(`${path}: slot ${env.slot} is not a slot of ${leg.id} (${leg.slots.map((entry) => entry.id).join(', ')})`);
      continue;
    }
    if (env.producer !== slot.producer)
      fail(
        `${path}: written by the ${env.producer} producer, the plan's producer of ${leg.id} slot ${slot.id} is ${slot.producer}`
      );
    // the parent is the invocation whose children folder held this receipt, and it must be the declared parent slot of the same leg
    if (slot.parent === undefined) {
      if (parent !== null || env.parentSlot !== null)
        fail(`${path}: ${leg.id} slot ${slot.id} is a top-level slot but the receipt was left by a child invocation`);
    } else {
      const actual = parent === null ? undefined : byPath.get(parent);
      if (!actual)
        fail(
          `${path}: ${leg.id} slot ${slot.id} is a child of ${slot.parent} but the receipt was not left in a children folder of a ${slot.parent} invocation`
        );
      else if (
        actual.envelope?.leg !== leg.id ||
        actual.envelope?.slot !== slot.parent ||
        actual.id !== env.parentInvocation ||
        env.parentSlot !== slot.parent
      ) {
        fail(
          `${path}: ${leg.id} slot ${slot.id} must be launched by its parent slot ${slot.parent}; it names ${env.parentSlot} (invocation ${env.parentInvocation}) and was left by ${actual.envelope?.leg} slot ${actual.envelope?.slot} (invocation ${actual.id})`
        );
      }
    }
    const slots = byLeg.get(leg.id) ?? new Map();
    if (slots.has(env.slot))
      fail(`${path}: a second receipt for ${leg.id} slot ${env.slot} (${slots.get(env.slot).path})`);
    else slots.set(env.slot, { path, receipt });
    byLeg.set(leg.id, slots);
    intact.push({ path, receipt, leg });
  }
  for (const leg of legs) {
    for (const slot of leg.slots) {
      if (byLeg.get(leg.id)?.has(slot.id)) continue;
      fail(`missing: no receipt for leg ${leg.id} slot ${slot.id} (${leg.workflow} job ${leg.job})`);
    }
  }

  return intact;
}

/**
 * The release workflow's join: the evidence of its join legs (plan.joinLegs, a prepared environment only that workflow builds) against
 * the gate's manifest of the same commit. Every declared join slot reported, intact and from this run; every exception whose replacement
 * names a join obligation has a pass of its case there; any other outcome in a join leg (a skip, a failure, an unknown case) fails,
 * since a join leg exists only to execute what the gate could not.
 * @returns {string[]} problems; empty means the prepared-environment replacements were executed
 */
export function reconcileJoin({ manifest, plan, exceptions, receipts, context }) {
  const problems = [];
  const fail = (text) => problems.push(text);
  manifestProblems(manifest, plan, context, fail);
  const units = new Map(manifest.units.map((unit) => [idKey(unit.id), unit]));
  const passed = new Set();
  const packaged = new Set(manifest.classified.filter((entry) => entry.joinSlot).map((entry) => entry.path));
  for (const { receipt, leg } of artifacts(receipts, plan.joinLegs ?? [], context, fail)) {
    const at = `${leg.id}#${receipt.envelope.slot}`;
    for (const record of receipt.records) {
      const key = idKey(record.id);
      if (record.kind !== 'case' || !(units.has(unitKey(record.id)) || packaged.has(record.id[1])))
        fail(`unknown: ${key} was reported in ${at} but the inventory assigns no test file of that name`);
      else if (record.status !== 'pass')
        fail(
          `${record.status}: ${key} in ${at}${record.reasonText ? ` (${record.reasonText})` : ''}: a join leg runs a prepared environment, where nothing may skip or fail`
        );
      else {
        passed.add(`${key}|${at}`);
        passed.add(`${record.id[1]}|${at}`);
      }
    }
  }
  // a file that runs after packaging has its own required slot: no release sink before it ran and passed there
  for (const entry of manifest.classified.filter((item) => item.joinSlot))
    if (!passed.has(`${entry.path}|${entry.joinSlot}`))
      fail(`no replacement: ${entry.path} runs after packaging in ${entry.joinSlot}, which reported no pass of it`);
  for (const tuple of exceptions.exceptions) {
    if (tuple.replacement.kind !== 'runs') continue;
    const targets = tuple.replacement.in
      .map((ref) => obligationOf(plan, ref))
      .filter((target) => isJoinObligation(plan, target));
    if (targets.length && !targets.some((target) => passed.has(`${idKey(tuple.id)}|${target}`)))
      fail(
        `no replacement: ${idKey(tuple.id)} is excepted on ${tuple.platform} because it runs in ${targets.join(' or ')}, which reported no pass of it`
      );
  }
  return [...new Set(problems)].sort(compareKeys);
}

/** Load every receipt under the given paths (a leg's files and their children folders). */
export function loadReceipts(paths) {
  return readReceipts(paths);
}
