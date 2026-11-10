#!/usr/bin/env node
// What Node's `backfillFallbackSessionTitle` (manager/session-fallback-title.mjs) does to a session: the real function over each
// session header and transcript, including the stored values JavaScript reads as falsy or truthy (`0`, `''`, numbers) in
// `generatedTitleStage`, `title` and `meta.source`. The title it set is recorded; `titleUpdatedAt` is the clock, so only that it is set.
//
//   node --experimental-transform-types benchmarks/rust-core/recorders/record-fallback-title.mjs --tree <tree> --ref <commit>
// Output: native/core/fixtures/fallback-title/golden.json
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const { backfillFallbackSessionTitle } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/manager/session-fallback-title.mjs');

const user = (content, extra = {}) => ({ role: 'user', content, ...extra });
const cases = [
  ['a plain first turn', {}, [user('Fix the parser bug please')]],
  ['the earliest usable human turn', {}, [user('Reference files: a'), user('Fix the parser bug please'), user('Second ask')]],
  ['an injected turn never names it', {}, [user('goal text', { meta: { source: 'goal' } }), user('Typed by the human')]],
  ['an imported turn is human', {}, [user('Imported prompt text', { meta: { source: 'import' } })]],
  ['meta.source 0 is falsy', {}, [user('Typed with source zero', { meta: { source: 0 } })]],
  ['meta.source empty is falsy', {}, [user('Typed with empty source', { meta: { source: '' } })]],
  ['meta.source 1 is set', {}, [user('Injected by one', { meta: { source: 1 } }), user('Typed by the human')]],
  ['meta that is an array', {}, [user('Typed with array meta', { meta: [] })]],
  ['synthetic and internal turns', {}, [user('x', { meta: { synthetic: true } }), user('y', { internal: true }), user('Real one')]],
  ['nothing usable', {}, [user('')]],
  ['a usable title is kept', { title: 'Kept' }, [user('Other')]],
  ['an untitled placeholder is replaced', { title: 'Untitled session' }, [user('Replaces untitled')]],
  ['title 0 is falsy', { title: 0 }, [user('Replaces zero title')]],
  ['title empty is falsy', { title: '' }, [user('Replaces empty title')]],
  ['title 5 is the text 5', { title: 5 }, [user('Other')]],
  ['a locked title', { titleLocked: true }, [user('Nope')]],
  ['generatedTitleStage first', { generatedTitleStage: 'first' }, [user('Nope')]],
  ['generatedTitleStage 0 is falsy', { generatedTitleStage: 0 }, [user('Stage zero names it')]],
  ['generatedTitleStage empty is falsy', { generatedTitleStage: '' }, [user('Stage empty names it')]],
  ['generatedTitleStage 1 is set', { generatedTitleStage: 1 }, [user('Nope')]],
  ['generatedTitleStage null is falsy', { generatedTitleStage: null }, [user('Stage null names it')]],
];
const recorded = cases.map(([name, header, messages]) => {
  const session = { ...header };
  const changed = backfillFallbackSessionTitle(session, messages);
  return {
    name,
    header,
    messages,
    changed,
    title: changed ? session.title : null,
    titleUpdatedAtSet: changed ? typeof session.titleUpdatedAt === 'number' : null,
  };
});

const finalDir = join(FIXTURES_ROOT, 'fallback-title');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { cases: recorded });
writeSetManifest(stage, {
  set: 'fallback-title',
  recorder: 'benchmarks/rust-core/recorders/record-fallback-title.mjs',
  command: 'node --experimental-transform-types benchmarks/rust-core/recorders/record-fallback-title.mjs --tree <tree> --ref <commit>',
  identityTree: tree,
  identityRef: args.get('ref') ?? 'HEAD',
});
commitStage(stage, finalDir);
console.log(`recorded ${recorded.length} fallback-title cases`);