#!/usr/bin/env node
// Genuine 1.4.5 approval-surface presence: Node's own `resolvePreToolAskApproval` (loop/tool-helpers.mjs)
// over the unattended port, for a run that is a room member or no run, with and without a
// `toolApprovalHook`. A run's ask is held for its owner exactly when the run has no hook; the Rust
// `HeldApprovals` over `HeldHome.ui_attached` (= `ApprovalSurfaces::attached`) must hold the same.
//
//   node benchmarks/rust-core/recorders/record-approval-surface.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/approval-surface/golden.json
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every user directory points at a fresh temp dir before any Mixdog module loads.
const sandbox = mkdtempSync(join(tmpdir(), 'rec-approval-surface-'));
for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[name] = join(sandbox, name.toLowerCase());
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';

const { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const args = parseArgs();
const tree = resolveTree(args);
const { resolvePreToolAskApproval } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/loop/tool-helpers.mjs');
const { setUnattendedApprovalPort } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/human-gate/unattended-port.mjs');

const SESSION = 'sess_rmem_abcdef_ann';
const rows = [];
for (const run of [null, { kind: 'room', agentId: 'ann', name: 'abcdef' }]) {
  for (const hookPresent of [false, true]) {
    let who = null;
    setUnattendedApprovalPort({
      runOf: () => run,
      hold: async () => {
        who = 'held';
        return { approved: false };
      },
    });
    const hook = hookPresent
      ? async () => {
          who = 'hook';
          return { approved: false };
        }
      : undefined;
    const out = await resolvePreToolAskApproval({
      toolName: 'github',
      args: {},
      cwd: sandbox,
      sessionId: SESSION,
      askReason: 'posts',
      toolApprovalHook: hook,
    });
    rows.push({
      run: run ? run.kind : null,
      hookPresent,
      answeredBy: who ?? 'nobody',
      denial: out.denial ?? null,
    });
  }
}
setUnattendedApprovalPort(null);

const finalOut = join(FIXTURES_ROOT, 'approval-surface');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'resolvePreToolAskApproval over the unattended port: who answers a run\'s ask with and without a toolApprovalHook',
  rows,
});
writeSetManifest(out, {
  set: 'approval-surface',
  recorder: 'benchmarks/rust-core/recorders/record-approval-surface.mjs',
  command: 'node benchmarks/rust-core/recorders/record-approval-surface.mjs --tree <tree>',
  extra: { rows: rows.length },
});
commitStage(out, finalOut);
console.log(`rows=${rows.length}`);
