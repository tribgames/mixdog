#!/usr/bin/env node
// Records what Node's session-ingest projection answers for every case of
// src/runtime/memory/lib/session-ingest-projection.test.mjs (:10, :28, :55, :78): the projected rows, the ingest text
// and the exclusion, each over the test's own rows.
//
//   node benchmarks/rust-core/recorders/record-session-ingest-projection.mjs --tree <exact export of b6f10295a with node_modules>
//
// Output: native/core/fixtures/session-ingest-projection/golden.json (+ MANIFEST.json).
import { join } from 'node:path';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-session-ingest-projection.mjs';
const common = 'benchmarks/rust-core/recorders/lib/common.mjs';
const { FIXTURES_ROOT, commitStage, importFrom, nodeTreeIdentity, parseArgs, recordingProvenance, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const args = parseArgs();
const tree = resolveTree(args);
const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);
const { projectSessionMessagesForIngest, sessionMessageContentForIngest, shouldExcludeIngestMessage } = await importFrom(tree, 'src/runtime/memory/lib/session-ingest.mjs');

const projections = [
  {
    test: ':10',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>runtime context</system-reminder>' },
          { type: 'text', text: 'actual user instruction' },
          { type: 'image', source: 'ignored-binary' },
          { type: 'text', text: 'pasted continuation' },
        ],
      },
    ],
  },
  {
    test: ':28',
    messages: [
      { role: 'user', content: 'actual user instruction' },
      {
        role: 'user',
        content: ['<system-reminder>', '<active-turn-continuation>', 'continue without repeating completed tool calls', '</active-turn-continuation>', '</system-reminder>'].join('\n'),
        meta: { source: 'compact-active-turn-continuation', synthetic: true },
      },
    ],
  },
].map((c) => ({ ...c, projected: projectSessionMessagesForIngest(c.messages) }));

const envelope = ['# Session', 'Cwd: C:\\\\Project\\\\mixdog', 'Model: test', 'Workflow: solo', '', '# Project Instructions', 'repo-local rules', '# Additional context', 'prefetch notes', '# Prefetch', 'file list', '# Task', 'real user prompt'].join('\n');
const contents = [
  { role: 'user', content: envelope },
  { role: 'user', content: '# Session\nmeeting notes\n# Task is later' },
].map((message) => ({ test: ':55', message, content: sessionMessageContentForIngest(message) }));

const exclusions = [
  { role: 'user', content: 'Reference files:\nfoo.ts' },
  { role: 'user', content: '(attachment)' },
  { role: 'user', content: '<skill>body</skill>', meta: 'skill' },
  { role: 'user', content: '[mixdog-runtime] continue' },
  { role: 'assistant', content: '.' },
  { role: 'user', content: 'please continue the task' },
  { role: 'assistant', content: 'working on it' },
].map((message) => ({ test: ':78', message, excluded: shouldExcludeIngestMessage(message) }));

const finalDir = join(FIXTURES_ROOT, 'session-ingest-projection');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's session-ingest projection at ${NODE_COMMIT} over the cases of session-ingest-projection.test.mjs`, projections, contents, exclusions });
writeSetManifest(stage, {
  set: 'session-ingest-projection',
  recorder,
  command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recordingProvenance(recorder, [common]),
    tests: ['src/runtime/memory/lib/session-ingest-projection.test.mjs (:10, :28, :55, :78)'],
    exclusions: { undefinedToolCalls: ':78 passes `toolCalls: undefined`; JSON has no undefined and Node reads the absent key the same, so the row is recorded without it' },
  },
});
commitStage(stage, finalDir);
console.log(`projections=${projections.length} contents=${contents.length} exclusions=${exclusions.length}`);
