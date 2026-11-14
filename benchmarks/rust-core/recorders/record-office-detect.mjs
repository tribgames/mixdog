#!/usr/bin/env node
// What detectMicrosoftOffice answers (src/runtime/office/com/com-adapter.mjs): the one-shot `detect` action of the COM
// host for docx, xlsx and pptx, run through Node's adapter. Rust `mixdog-office-com` `OfficeCom::detect` must answer
// the same JSON for the same machine (crates/mixdog-office-com/tests/twin_detect.rs). Windows only: elsewhere the
// adapter answers that COM is Windows-only, and the recording says so. No Office installation is needed; without one
// the answer says it is not installed. The action only reads the registry and the running-object table.
//
//   node benchmarks/rust-core/recorders/record-office-detect.mjs [--tree <dir>]
//
// Output: native/core/fixtures/office-detect/golden.json.
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'office-detect');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-office-detect.mjs';
const { detectMicrosoftOffice } = await importFrom(tree, 'src/runtime/office/com/com-adapter.mjs');

const CASES = [
  { format: 'docx', path: '' },
  { format: 'xlsx', path: '' },
  { format: 'pptx', path: '' },
  { format: 'docx', path: 'C:\mixdog-office-detect\absent.docx' },
];

const cases = [];
for (const input of CASES) cases.push({ ...input, result: await detectMicrosoftOffice(input) });
writeJson(join(stage, 'golden.json'), { platform: process.platform, cases });
writeSetManifest(stage, { set: 'office-detect', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
