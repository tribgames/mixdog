// A receipt is the evidence of one test invocation (scripts/ci/coverage/evidence.mjs): an envelope that says where it was produced, a
// record per terminal case or suite with its full identity, and a trailer that binds the records. The invocation (the runner, never the
// tests) creates it BEFORE it runs, with a fresh id and `complete: false`, and refuses to start when the file already exists (a receipt
// is never reused). Each test process the invocation starts writes what it saw to a part file of its own in `<receipt>.parts/` (a single
// writer per stream); the runner closes the receipt after the last process ended: records joined in part-file order, `complete: true`,
// the exit status, the trailer. A runner a test starts for a real suite finds `MIXDOG_CHILD_RECEIPTS` (the parent's
// `<receipt>.children`) and writes a receipt of its own there under a child slot; the reconciler reads those too.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

import { EVIDENCE_VERSION, contentHash, envelopeFromEnv, integrityProblems, makeRecord } from './coverage/evidence.mjs';

const partsOf = (path) => `${path}.parts`;
export const childrenOf = (path) => `${path}.children`;

/** The receipt a runner writes: `MIXDOG_RECEIPT`, else a fresh file in the parent's children folder, else none (a plain run). */
export function receiptPath(env = process.env) {
  if (env.MIXDOG_RECEIPT) return resolve(env.MIXDOG_RECEIPT);
  if (env.MIXDOG_CHILD_RECEIPTS) {
    mkdirSync(env.MIXDOG_CHILD_RECEIPTS, { recursive: true });
    return join(resolve(env.MIXDOG_CHILD_RECEIPTS), `${randomUUID()}.json`);
  }
  return null;
}

/** Slot and invocation id of the receipt whose children folder `dir` (`<receipt>.children`) is, read from that receipt's file. */
export function parentOf(dir) {
  if (!resolve(dir).endsWith('.children')) throw new Error(`${dir} is not the children folder of a receipt`);
  const parent = JSON.parse(readFileSync(resolve(dir).slice(0, -'.children'.length), 'utf8'));
  return { slot: parent.envelope.slot, invocation: parent.id };
}

/** Creates the receipt of an invocation that is about to run. A file that is already there is a reused receipt: an error. */
export function beginReceipt(
  path,
  kind,
  { slot = process.env.MIXDOG_SLOT ?? 'root', parent = null, ...extra } = {},
  env = process.env
) {
  if (existsSync(path)) throw new Error(`receipt ${path} already exists: a receipt belongs to one invocation`);
  mkdirSync(dirname(path), { recursive: true });
  const envelope = envelopeFromEnv(env, {
    kind,
    slot,
    parentSlot: parent?.slot ?? null,
    parentInvocation: parent?.invocation ?? null,
  });
  const receipt = {
    v: EVIDENCE_VERSION,
    id: randomUUID(),
    kind,
    platform: process.platform,
    complete: false,
    envelope,
    records: [],
    ...extra,
  };
  writeFileSync(path, `${JSON.stringify(receipt)}\n`, { flag: 'wx' });
}

/** What one test process saw: `records` are terminal observations ({kind, id, status, reasonCode?, reasonText?}). One file per process. */
export function appendPart(path, part) {
  const dir = partsOf(path);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${process.pid}.ndjson`), `${JSON.stringify(part)}\n`);
}

/** Closes the receipt: the records of the part files (a run may add its own through `extra.records`), complete, exit status, trailer. */
export function finishReceipt(path, exitCode, extra = {}) {
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  const dir = partsOf(path);
  const parts = existsSync(dir)
    ? readdirSync(dir)
        .sort()
        .flatMap((name) =>
          readFileSync(join(dir, name), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        )
    : [];
  const events = [...parts.flatMap((part) => part.records ?? []), ...(extra.records ?? [])];
  receipt.records = events.map((event, seq) => makeRecord(seq, event));
  receipt.trailer = { recordCount: receipt.records.length, contentHash: contentHash(receipt.records) };
  if (extra.listing !== undefined) receipt.listing = extra.listing;
  receipt.exitCode = exitCode;
  receipt.complete = true;
  writeFileSync(path, `${JSON.stringify(receipt)}\n`);
  rmSync(dir, { recursive: true, force: true });
}

/** Every receipt of `paths` and their children folders as { path, parent, receipt?, problem? }; `parent` is null for a top-level one. */
export function readReceipts(paths) {
  const out = [];
  const visit = (path, parent) => {
    let receipt;
    try {
      receipt = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      out.push({
        path,
        parent,
        problem:
          error.code === 'ENOENT' ? 'no receipt: the invocation did not run' : `unreadable receipt (${error.message})`,
      });
      return;
    }
    out.push({ path, parent, receipt });
    const children = childrenOf(path);
    if (existsSync(children))
      for (const name of readdirSync(children).sort()) if (name.endsWith('.json')) visit(join(children, name), path);
  };
  for (const path of paths) visit(path, null);
  return out;
}

/** Why a receipt is not intact evidence: wrong version, not complete, failed exit, a trailer that does not bind its records. */
export const receiptProblems = integrityProblems;
