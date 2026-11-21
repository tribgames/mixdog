import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { canonical, idKey } from './ids.mjs';

export const EVIDENCE_VERSION = 2;
/** Terminal outcomes. `pass` is the only one that is execution; `skip` needs an exact reviewed exception; the rest are failures. */
export const STATUSES = new Set(['pass', 'fail', 'skip', 'todo', 'xfail', 'cancelled', 'ignored']);
export const KINDS = new Set(['case', 'suite']);
/** The runners that write receipts (scripts/test.mjs and node-runner.mjs, run-nextest.mjs, run-receipt.mjs, run-shell-suite.mjs, run-doctest.mjs). */
export const PRODUCERS = new Set(['node', 'nextest', 'unittest', 'shell', 'doctest']);

const FAMILIES = {
  node: { families: { case: { name: 'node', min: 3 }, suite: { name: 'node-suite', min: 3 } } },
  shell: { families: { case: { name: 'shell', length: 3 } } },
  unittest: { families: { case: { name: 'python', length: 4 }, suite: { name: 'python-suite', length: 3 } } },
  nextest: { families: { case: { name: 'rust', length: 5 } } },
  doctest: { families: { case: { name: 'rust', length: 5 } } },
};

/** Why a record's identity does not fit the runner and kind that wrote it, or null. */
export function identityProblem(producer, record) {
  const rule = FAMILIES[producer]?.families[record.kind];
  if (!rule) return `a ${record.kind} record is not something a ${producer} runner writes`;
  const id = record.id;
  if (id[0] !== rule.name) return `${JSON.stringify(id)} is not a ${rule.name} identity`;
  if (rule.length !== undefined ? id.length !== rule.length : id.length < rule.min)
    return `${JSON.stringify(id)} does not carry the runner's case component`;
  return null;
}

/** The commit the checkout the runner was started in is at: read from git, never from anything the workflow or the environment claims. */
export function headSha(cwd = process.cwd()) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
}

export function envelopeFromEnv(
  env = process.env,
  { kind, slot = 'root', parentSlot = null, parentInvocation = null } = {}
) {
  return {
    repository: env.GITHUB_REPOSITORY ?? null,
    sha: headSha(),
    workflow: env.GITHUB_WORKFLOW_REF ?? null,
    runId: env.GITHUB_RUN_ID ?? null,
    attempt: env.GITHUB_RUN_ATTEMPT ?? null,
    leg: env.MIXDOG_LEG ?? null,
    os: env.MIXDOG_LEG_OS ?? null,
    slot,
    parentSlot,
    parentInvocation,
    producer: kind,
  };
}

/** A record as the trailer hashes it. */
export const recordLine = (record) => canonical(record);

export function contentHash(records) {
  const hash = createHash('sha256');
  for (const record of records) hash.update(`${recordLine(record)}\n`);
  return hash.digest('hex');
}

export function makeRecord(seq, event) {
  const { kind, id, status, reasonCode, reasonText, assertions, parent } = event;
  const record = { seq, event: 'finish', kind, id, status };
  if (reasonCode !== undefined) record.reasonCode = reasonCode;
  if (reasonText !== undefined) record.reasonText = reasonText;
  if (assertions !== undefined) record.assertions = assertions;
  if (parent !== undefined) record.parent = parent;
  return record;
}

/** Why a receipt is not evidence of an intact invocation. Identity and coverage are the reconciler's job, not this one's. */
export function integrityProblems(receipt) {
  const problems = [];
  if (receipt?.v !== EVIDENCE_VERSION) return [`is not version ${EVIDENCE_VERSION} evidence`];
  if (typeof receipt.id !== 'string' || !receipt.id) problems.push('has no invocation id');
  if (receipt.complete !== true) return [...problems, 'is not complete: the invocation did not finish'];
  if (receipt.exitCode !== 0) problems.push(`ended with exit status ${receipt.exitCode}`);
  if (!Array.isArray(receipt.records)) return [...problems, 'has no records'];
  if (receipt.trailer?.recordCount !== receipt.records.length)
    problems.push(`trailer counts ${receipt.trailer?.recordCount} records, the file holds ${receipt.records.length}`);
  if (receipt.trailer?.contentHash !== contentHash(receipt.records))
    problems.push('trailer content hash does not match the records');
  for (const [index, record] of receipt.records.entries()) {
    if (record.seq !== index) problems.push(`record ${index} has seq ${record.seq}`);
    if (!KINDS.has(record.kind)) problems.push(`record ${index} has unknown kind ${record.kind}`);
    if (!STATUSES.has(record.status)) problems.push(`record ${index} has unknown status ${record.status}`);
    try {
      idKey(record.id);
      const wrong =
        KINDS.has(record.kind) && PRODUCERS.has(receipt.kind) ? identityProblem(receipt.kind, record) : null;
      if (wrong) problems.push(`record ${index}: ${wrong}`);
    } catch {
      problems.push(`record ${index} has no identity`);
    }
  }
  const env = receipt.envelope;
  for (const field of ['repository', 'sha', 'workflow', 'runId', 'attempt', 'leg', 'slot', 'producer'])
    if (!env?.[field]) problems.push(`envelope has no ${field}`);
  if (env?.sha && !/^[0-9a-f]{40}$/.test(env.sha)) problems.push(`envelope sha ${env.sha} is not a full commit id`);
  if (env?.producer && !PRODUCERS.has(env.producer))
    problems.push(`envelope names the unknown producer ${env.producer}`);
  if (env?.producer && receipt.kind !== env.producer)
    problems.push(`was written by a ${receipt.kind} runner but its envelope names the producer ${env.producer}`);
  if (env && (env.parentSlot === null) !== (env.parentInvocation === null))
    problems.push('envelope names a parent slot without its invocation, or an invocation without its slot');
  return problems;
}
