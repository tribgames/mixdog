// The workflow graph against the reviewed plan (docs/testing.md, "Release coverage"). Syntactic wiring is necessary, not sufficient: the
// artifacts prove execution (reconcile.mjs). This proves what YAML can: every release sink is reachable only through the full gate, the
// gate is a literal `needs` with default success semantics, no entry point publishes without it, and the declared legs have producers.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

import { KINDS, artifactTemplate } from './artifacts.mjs';
import { digestOf, idKey } from './ids.mjs';

const GATE = './.github/workflows/release-gate.yml';
const LITERAL_NAME = /^[a-z][a-z0-9-]*$/;

export function loadWorkflows(root) {
  const dir = join(root, '.github', 'workflows');
  return Object.fromEntries(readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).map((name) => [name, parse(readFileSync(join(dir, name), 'utf8'))]));
}

const needsOf = (job) => [job?.needs ?? []].flat();

function ancestors(jobs, name, seen = new Set()) {
  for (const dep of needsOf(jobs[name])) {
    if (!seen.has(dep) && jobs[dep]) {
      seen.add(dep);
      ancestors(jobs, dep, seen);
    }
  }
  return seen;
}

/**
 * Static matrix size of a job: 1 without a matrix, null when the matrix is computed at run time, else the count of one of the two forms
 * the gate uses (axes only, or an `include` list alone). Any other form (`exclude`, `include` beside axes) is refused, not miscounted.
 */
export function matrixSize(job) {
  const matrix = job.strategy?.matrix;
  if (matrix === undefined) return 1;
  if (typeof matrix === 'string') return null;
  const { include, exclude, ...axes } = matrix;
  const lists = Object.values(axes);
  if (exclude !== undefined || (include !== undefined && (lists.length || !Array.isArray(include))) || !lists.every(Array.isArray)) throw new Error('a matrix form the wiring check does not count');
  return Array.isArray(include) ? include.length : lists.reduce((total, values) => total * values.length, 1);
}

/**
 * @param {{[file: string]: object}} workflows parsed workflows by file name
 * @param {object} plan the reviewed plan
 * @returns {string[]} problems
 */
export function wiringProblems(workflows, plan) {
  const problems = [];
  const fail = (text) => problems.push(text);

  // -- the publication graph, closed: in every workflow that calls the gate each job is a reviewed sink or a reviewed non-sink
  const listed = new Map();
  for (const entry of [...(plan.sinks ?? []), ...(plan.nonSinks ?? [])]) {
    const key = `${entry.workflow}#${entry.job}`;
    if (listed.has(key)) fail(`${entry.workflow} ${entry.job} has two dispositions in the plan`);
    listed.set(key, entry);
  }
  for (const entry of plan.nonSinks ?? []) if (!entry.reason) fail(`non-sink ${entry.workflow} ${entry.job} has no reason`);
  for (const sink of plan.sinks ?? []) if (sink.gate === null && !sink.reason) fail(`ungated sink ${sink.workflow} ${sink.job} has no reason`);
  for (const [key] of listed) {
    const [file, name] = key.split('#');
    if (!workflows[file]?.jobs?.[name]) fail(`${file} ${name}: the job named by the plan does not exist`);
  }
  // every edge into another workflow is a disposition of its own (a new entry point calling a publishing workflow is unlisted), and a
  // workflow that calls the gate lists all its jobs
  const localCall = (job) => typeof job.uses === 'string' && job.uses.startsWith('./.github/workflows/');
  for (const [file, workflow] of Object.entries(workflows)) {
    const gated = Object.values(workflow.jobs ?? {}).some((job) => job.uses === GATE);
    for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
      if (job.uses === GATE || !(gated || localCall(job))) continue;
      if (!listed.has(`${file}#${name}`)) fail(`${file} ${name} is neither a reviewed sink nor a reviewed non-sink in the plan: list it (sinks, with its gate and exact condition, or nonSinks, with a reason)`);
    }
  }
  for (const sink of plan.sinks ?? []) {
    const workflow = workflows[sink.workflow];
    const job = workflow?.jobs?.[sink.job];
    if (!job) continue;
    if (sink.gate !== null) {
      if (workflow.jobs[sink.gate]?.uses !== GATE) fail(`sink ${sink.workflow} ${sink.job}: its gate ${sink.gate} is not a job that calls the full-release gate`);
      else if (!ancestors(workflow.jobs, sink.job).has(sink.gate)) fail(`sink ${sink.workflow} ${sink.job} (${sink.kind}) does not need its gate ${sink.gate}`);
    }
    if (sink.directGate && !needsOf(job).includes(sink.directGate)) fail(`sink ${sink.workflow} ${sink.job} must list ${sink.directGate} in its own needs`);
    if (String(job.if ?? '') !== (sink.if ?? '')) fail(`sink ${sink.workflow} ${sink.job}: its \`if\` is ${JSON.stringify(job.if ?? '')}, the one reviewed condition is ${JSON.stringify(sink.if ?? '')}`);
  }
  for (const file of plan.callOnly ?? []) {
    const triggers = Object.keys(workflows[file]?.on ?? {});
    if (JSON.stringify(triggers) !== JSON.stringify(['workflow_call'])) fail(`${file} must be reachable only through workflow_call (it has ${triggers.join(', ') || 'no trigger'})`);
  }
  // callers of the full gate pass an immutable SHA and a name of their own, which with the SHA names every artifact of the call
  const gateNames = new Map();
  for (const [file, workflow] of Object.entries(workflows)) {
    for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
      if (job.uses !== GATE) continue;
      if (!job.with?.ref) fail(`${file} ${name} calls the gate without a ref`);
      const gateName = job.with?.gate;
      if (typeof gateName !== 'string' || !LITERAL_NAME.test(gateName)) fail(`${file} ${name} must pass a literal gate name (${JSON.stringify(gateName)} is not one): artifacts are named by it`);
      else if (gateNames.has(gateName)) fail(`${file} ${name} and ${gateNames.get(gateName)} call the gate under the same name ${gateName}: their artifacts would collide`);
      else gateNames.set(gateName, `${file} ${name}`);
      if (job.with?.joins !== undefined && job.with.joins !== true) fail(`${file} ${name} must pass joins as the literal true or not at all (${JSON.stringify(job.with.joins)})`);
      if (job['continue-on-error']) fail(`${file} ${name} tolerates the gate's failure`);
      if (job.if !== undefined && !(plan.gateCallIfAllowed ?? []).includes(`${file}#${name}`)) fail(`${file} ${name}: the gate call has an \`if\``);
    }
  }
  // -- the gate itself: legs have producers, and the aggregator reconciles
  const gate = workflows['release-gate.yml'];
  if (!gate) fail('release-gate.yml is missing');
  else {
    if (!gate.on?.workflow_call?.inputs?.ref?.required) fail('release-gate.yml must be callable with a required ref');
    if (!gate.on?.workflow_call?.inputs?.gate?.required) fail('release-gate.yml must be callable with a required gate name');
    if (!needsOf(gate.jobs.complete).includes('inventory')) fail('release-gate.yml complete does not need inventory');
    const jobsOfLegs = new Map();
    for (const leg of plan.legs.filter((entry) => entry.workflow === 'release-gate.yml')) jobsOfLegs.set(leg.job, [...(jobsOfLegs.get(leg.job) ?? []), leg]);
    for (const [name, legs] of jobsOfLegs) {
      const job = gate.jobs[name];
      if (!job) {
        fail(`plan legs ${legs.map((leg) => leg.id).join(', ')} name the job ${name}, which release-gate.yml does not have`);
        continue;
      }
      let size;
      try {
        size = matrixSize(job);
      } catch (error) {
        fail(`job ${name}: ${error.message}; use axes alone or an include list alone`);
      }
      if (size !== undefined && size !== null && size !== legs.length) fail(`job ${name} expands to ${size} matrix entries, the plan declares ${legs.length} legs for it`);
      if (job['continue-on-error']) fail(`job ${name} tolerates its own failure`);
      for (const step of job.steps ?? []) if (step['continue-on-error']) fail(`job ${name} step ${JSON.stringify(step.name ?? step.uses)} tolerates its own failure`);
      const uploads = (job.steps ?? []).some((step) => step.uses === './.github/actions/upload-evidence');
      if (!uploads) fail(`job ${name} has declared legs and no upload-evidence step`);
      if (!job.env?.MIXDOG_LEG) fail(`job ${name} does not set MIXDOG_LEG`);
      if (!needsOf(gate.jobs.complete).includes(name)) fail(`release-gate.yml complete does not need ${name}, a job of declared legs`);
    }
    for (const [name, job] of Object.entries(gate.jobs)) {
      if (typeof job.strategy?.matrix === 'string' && !(plan.dynamicMatrixJobs ?? []).includes(name)) fail(`job ${name} has a matrix computed at run time that the plan does not list (dynamic matrices are pinned by the plan's legs and checked by the reconciliation)`);
    }
    for (const event of ['pull_request', 'push']) if (gate.on?.[event]?.paths || gate.on?.[event]?.['paths-ignore']) fail(`release-gate.yml ${event} is path filtered`);
  }
  verdictProblems(workflows, plan, fail);
  artifactProblems(workflows, fail);
  refProblems(workflows, plan, fail);
  // -- release.yml publication
  const release = workflows['release.yml'];
  if (release) {
    const publish = release.jobs.publish;
    if (!publish) fail('release.yml has no publish job');
    else {
      if (!needsOf(publish).includes('coverage-gate')) fail('release.yml publish does not list coverage-gate in its needs');
      if (publish.if !== undefined || publish['continue-on-error']) fail('release.yml publish has an `if` or tolerates failure');
    }
    const caller = release.jobs['coverage-gate'];
    if (caller?.uses !== './.github/workflows/release-gate.yml') fail('release.yml coverage-gate does not call release-gate.yml');
    if (caller?.with?.ref !== '${{ inputs.ref }}') fail('release.yml coverage-gate must pass the immutable ref the run was started for');
    if (Object.hasOwn(release.on?.workflow_call?.inputs ?? {}, 'run_critical')) fail('release.yml still has a run_critical input: no input may stand for a verified gate');
  }
  return problems;
}

/** The one name a release's join evidence has: uploaded by the Windows package job, downloaded by name by the join. */
export const JOIN_EVIDENCE = 'join-evidence-release-${{ inputs.ref }}-windows-desktop-package-1of1';

/**
 * Gate artifacts are run-scoped, keyed by kind, gate and SHA. A rerun may
 * replace only the names owned by its producers; downloads never merge them.
 */
function artifactProblems(workflows, fail) {
  for (const [file, workflow] of Object.entries(workflows)) {
    for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (!/^actions\/(?:upload|download)-artifact@/.test(step.uses ?? '')) continue;
        const where = `${file} ${name}`;
        const given = step.with?.name ?? step.with?.pattern ?? '';
        if (file === 'release-gate.yml') {
          const upload = step.uses.startsWith('actions/upload-artifact@');
          if (step.with?.['merge-multiple'] !== undefined || (upload ? step.with?.overwrite !== true : step.with?.overwrite !== undefined)) fail(`${where}: only producers replace their run-scoped artifact; downloads never merge`);
          if (!KINDS.some((kind) => given.startsWith(artifactTemplate(kind)))) fail(`${where}: the artifact ${JSON.stringify(given)} is not named by kind, gate and SHA (artifacts.mjs)`);
        } else if (String(given).startsWith('join-evidence') && given !== JOIN_EVIDENCE) fail(`${where}: the join evidence ${JSON.stringify(given)} is not named ${JOIN_EVIDENCE}`);
      }
    }
  }
}

const RUN_OF = (step) => String(step.run ?? '');
const normalizeCommand = (text) => text.replace(/\\\r?\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
/** The reviewed content digest of a job: every key of its parsed YAML (comments are not part of it). */
export const jobDigest = (job) => digestOf(job);

/**
 * The gate's own decision cannot be switched off. The verdict jobs (the inventory and `complete`) are pinned by content digest in the
 * plan, so any condition, `continue-on-error`, inserted or reordered step or edited command changes them and needs the plan's owners;
 * the semantic checks below name the common forms. The full-run switch every verdict step depends on is pinned to an expression that is
 * `true` for every call of the gate, and every leg uploads its evidence after the steps that write it.
 */
function verdictProblems(workflows, plan, fail) {
  const gate = workflows['release-gate.yml'];
  const wiring = plan.wiring ?? {};
  if (!gate?.jobs) return;
  if (gate.jobs.changes?.outputs?.full !== wiring.fullOutput) fail(`release-gate.yml changes.outputs.full is ${JSON.stringify(gate.jobs.changes?.outputs?.full)}, not the reviewed ${JSON.stringify(wiring.fullOutput)}: a call of the gate must be a full run whatever the selection says`);
  for (const [ref, reviewed] of Object.entries(wiring.verdictJobs ?? {})) {
    const [file, name] = ref.split('#');
    const job = workflows[file]?.jobs?.[name];
    if (!job) {
      fail(`${file} ${name}: the verdict job does not exist`);
      continue;
    }
    if (job['continue-on-error'] !== undefined) fail(`${file} ${name}: a verdict job has continue-on-error`);
    if (String(job.if ?? '') !== reviewed.if) fail(`${file} ${name}: its \`if\` is ${JSON.stringify(job.if)}, the reviewed condition is ${JSON.stringify(reviewed.if)}`);
    const steps = job.steps ?? [];
    for (const [index, step] of steps.entries()) {
      const label = `${file} ${name} step ${index + 1} ${JSON.stringify(step.name ?? step.uses ?? '')}`;
      if (step['continue-on-error'] !== undefined) fail(`${label} has continue-on-error: the verdict cannot tolerate a failed step`);
      const diagnostic = (reviewed.diagnostics ?? []).includes(step.name);
      const condition = step.if === undefined ? undefined : String(step.if);
      if (diagnostic ? condition !== 'always()' : condition !== undefined && condition !== wiring.fullCondition) fail(`${label} has the condition ${JSON.stringify(step.if)}; a verdict step runs unconditionally or on ${JSON.stringify(wiring.fullCondition)} only`);
    }
    for (const command of reviewed.commands ?? []) {
      const at = steps.findIndex((step) => normalizeCommand(RUN_OF(step)) === normalizeCommand(command));
      if (at < 0) fail(`${file} ${name} does not run the reviewed command exactly: ${command}`);
      else if (steps[at].shell !== undefined) fail(`${file} ${name}: the reviewed command runs with the shell ${steps[at].shell}, not the default one that fails the step on its exit status`);
    }
    const digest = jobDigest(job);
    if (digest !== reviewed.digest) fail(`${file} ${name} differs from the reviewed verdict job (digest ${digest}, reviewed ${reviewed.digest}): a change to the verdict is reviewed and pinned in plan.json wiring.verdictJobs`);
  }
  // every leg job writes its receipts before it uploads them, and uploads them unconditionally
  for (const name of new Set(plan.legs.filter((leg) => leg.workflow === 'release-gate.yml').map((leg) => leg.job))) {
    const steps = gate.jobs[name]?.steps ?? [];
    const upload = steps.findIndex((step) => step.uses === './.github/actions/upload-evidence');
    if (upload < 0) continue;
    if (steps[upload].if !== undefined) fail(`job ${name}: its evidence upload has the condition ${JSON.stringify(steps[upload].if)}`);
    const writers = steps.map((step, index) => (step.env?.MIXDOG_RECEIPT !== undefined || /MIXDOG_RECEIPT=/.test(RUN_OF(step)) ? index : -1)).filter((index) => index >= 0);
    if (writers.some((index) => index > upload)) fail(`job ${name}: a step that writes a receipt runs after the evidence upload`);
  }
}

/**
 * Release-visible effects (default branch, tags, releases, packages, stores, deploys) wait for the gate's evidence; private candidate
 * transport refs (refs/mixdog-candidates/) are written and cleaned outside it, because the gate checks out a remote ref. The jobs that
 * write any ref are not recognised by their commands: they are the plan's `pinnedJobs`, each pinned whole by content digest, so a change
 * to what they push is a reviewed change. Every sink workflow checks out, tags and releases exactly the commit its caller gated.
 */
function refProblems(workflows, plan, fail) {
  const wiring = plan.wiring ?? {};
  for (const [ref, digest] of Object.entries(wiring.pinnedJobs ?? {})) {
    const [file, name] = ref.split('#');
    const job = workflows[file]?.jobs?.[name];
    if (!job) fail(`pinned job ${ref} does not exist`);
    else if (jobDigest(job) !== digest) fail(`${ref} differs from the reviewed job (digest ${jobDigest(job)}, reviewed ${digest}): release authorization and ref writes are pinned in plan.json wiring.pinnedJobs`);
  }
  // No outward effect (ref write, asset publish, mirror, release, store upload) runs before every replacement promise its gate accepted
  // has its evidence. A gate call that joins (`joins: true`) must be in a workflow with a join verdict job (`cli.mjs join`), and every
  // gated sink of that workflow needs that job; a gate call that does not join accepts no promise (reconcile.mjs refuses one).
  const joinJobs = Object.entries(wiring.verdictJobs ?? {}).filter(([, reviewed]) => (reviewed.commands ?? []).some((command) => /cli\.mjs join\b/.test(command))).map(([ref]) => ref.split('#'));
  for (const [file, workflow] of Object.entries(workflows)) {
    const joining = Object.entries(workflow.jobs ?? {}).filter(([, job]) => job.uses === GATE && job.with?.joins === true);
    const here = joinJobs.filter(([joinFile]) => joinFile === file).map(([, name]) => name);
    if (joining.length && !here.length) fail(`${file} calls the gate with joins but has no join verdict job`);
    if (!joining.length) continue;
    for (const sink of (plan.sinks ?? []).filter((entry) => entry.workflow === file && entry.gate !== null)) {
      for (const joinJob of here) if (!ancestors(workflow.jobs, sink.job).has(joinJob)) fail(`sink ${file} ${sink.job} (${sink.kind}) does not need ${joinJob}: a promised replacement is checked there`);
    }
  }
  // a case scoped to some gates is checked in each of them: every such gate name is a caller that joins
  for (const scope of plan.gateScopes ?? []) {
    for (const name of scope.gates ?? []) {
      const joins = Object.values(workflows).some((workflow) => Object.values(workflow.jobs ?? {}).some((job) => job.uses === GATE && job.with?.gate === name && job.with?.joins === true));
      if (!joins) fail(`gate scope ${idKey(scope.id)} names the gate ${name}, which no caller runs with joins: the case would be checked nowhere`);
    }
  }
  // the commit a sink workflow publishes is the one its input names, in every checkout and every release it makes
  for (const [file, input] of Object.entries(wiring.sinkRefInputs ?? {})) {
    const workflow = workflows[file];
    if (!workflow) {
      fail(`${file}: the sink workflow does not exist`);
      continue;
    }
    if (workflow.on?.workflow_call?.inputs?.[input]?.required !== true) fail(`${file} needs the required input ${input}, the gated commit`);
    const expected = `\${{ inputs.${input} }}`;
    for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (/^actions\/checkout@/.test(step.uses ?? '') && step.with?.ref !== expected) fail(`${file} ${name}: a checkout of ${JSON.stringify(step.with?.ref ?? 'the default ref')}, not ${expected}`);
        if (/^softprops\/action-gh-release@/.test(step.uses ?? '') && step.with?.target_commitish !== expected) fail(`${file} ${name}: a release at ${JSON.stringify(step.with?.target_commitish ?? 'the default branch')}, not ${expected}`);
      }
    }
  }
  // an entry point resolves its base commit in one job; every other checkout and every sink call names a commit an earlier job made
  for (const [file, resolvers] of Object.entries(wiring.entryResolvers ?? {})) {
    for (const [name, job] of Object.entries(workflows[file]?.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (!/^actions\/checkout@/.test(step.uses ?? '') || resolvers.includes(name)) continue;
        if (!/^\$\{\{ needs\.[\w-]+\.outputs\.sha \}\}$/.test(step.with?.ref ?? '')) fail(`${file} ${name}: a checkout of ${JSON.stringify(step.with?.ref ?? 'the default ref')}, not a commit an earlier job of the run resolved`);
      }
    }
  }
  // a deploy sink call publishes the commit the gate it needs verified
  for (const sink of plan.sinks ?? []) {
    if (!sink.refInput) continue;
    const jobs = workflows[sink.workflow]?.jobs ?? {};
    const passed = jobs[sink.job]?.with?.[sink.refInput];
    const gated = jobs[sink.gate]?.with?.ref;
    if (!passed || passed !== gated) fail(`sink ${sink.workflow} ${sink.job} publishes ${JSON.stringify(passed)}, but ${sink.gate} verified ${JSON.stringify(gated)}`);
  }
  for (const sink of plan.sinks ?? []) {
    for (const need of sink.requiredNeeds ?? []) if (!needsOf(workflows[sink.workflow]?.jobs?.[sink.job]).includes(need)) fail(`sink ${sink.workflow} ${sink.job} must list ${need} in its needs`);
  }
}
