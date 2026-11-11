#!/usr/bin/env node
// Node's recall scope SQL (src/runtime/memory/lib/memory-recall-scope-filter.test.mjs, 3 cases) from the real
// `projectScopePredicate` and `appendProjectScopeClause`: every scope shape at several placeholder offsets and column
// options, and the append call's effect on the where list and params it is handed.
// Case 3 (truthy non-string scopes bound without coercion) is a JS typing artefact: recorded as it is, not replayable
// in Rust where the scope is Option<&str>; listed in the manifest.
//
//   node benchmarks/rust-core/recorders/record-memory-scope-filter.mjs --tree <dir>
import { begin, capture, finish, importFrom, exact } from './lib/mc-record.mjs';

const ctx = begin();
const { appendProjectScopeClause, projectScopePredicate } = await importFrom(ctx.tree, 'src/runtime/memory/lib/memory-recall-scope-filter.mjs');
const objectScope = { id: 42 };

const predicate = async (scope, next, options) => ({ input: { scope: exact(scope), next, options }, ...(await capture(() => projectScopePredicate(scope, next, options))) });
const shapes = [];
for (const [scope, next, options] of [
  ['common', 3], ['all', 3], [undefined, 3], ['mixdog', 5, { column: 'e.project_id' }], ['mixdog', 1], ['mixdog', 12, { column: 'x.pid' }],
  [null, 3], ['', 3], [0, 3], ['COMMON', 3], ['ALL', 3],
]) shapes.push(await predicate(scope, next, options));

const appendCases = [];
{
  const where = ['chunk_root IS NULL'];
  const params = [10];
  const steps = [];
  for (const scope of ['mixdog', 'all']) {
    appendProjectScopeClause(where, params, scope);
    steps.push({ scope, where: [...where], params: [...params] });
  }
  appendCases.push({ start: { where: ['chunk_root IS NULL'], params: [10] }, steps });
}
{
  const where = [];
  const params = [];
  appendProjectScopeClause(where, params, 'common');
  appendCases.push({ start: { where: [], params: [] }, steps: [{ scope: 'common', where: [...where], params: [...params] }] });
}

const typing = [];
for (const [label, scope, next] of [['number 7 at $3', 7, 3], ['object at $4', objectScope, 4]]) {
  const out = await capture(() => projectScopePredicate(scope, next));
  typing.push({ label, scope: exact(scope), next, ...out, boundParamIsTheScopeItself: out.result ? scope === (label.startsWith('object') ? objectScope : 7) && projectScopePredicate(scope, next).params[0] === scope : null });
}

finish(ctx, {
  url: import.meta.url,
  set: 'memory-scope-filter',
  golden: {
    domain: 'memory-scope-filter',
    source: 'src/runtime/memory/lib/memory-recall-scope-filter.test.mjs',
    cases: [
      { name: 'projectScopePredicate keeps common/all/slug SQL shapes and param offsets', probes: shapes },
      { name: 'appendProjectScopeClause binds the next placeholder without reordering existing params', runs: appendCases },
      { name: 'projectScopePredicate binds truthy numeric/object scopes without coercion (JS typing artefact)', probes: typing },
    ],
  },
  extra: {
    entry: { runs: 'projectScopePredicate and appendProjectScopeClause (memory-recall-scope-filter.mjs)', notRun: 'the queries that embed the clause (hybrid SQL, browse): other test files' },
    replay: "mixdog-services memory/recall/filters.rs: pub fn append_project_scope (:35), called by recall/browse.rs:60, :177 and :885 (the browse, session and core-row queries); the projectScope argument is read by recall/plan.rs:95 and reaches those calls through the `memory/recall` request (Recall::recall, recall/mod.rs:240). The hybrid search builds its own filters (recall/hybrid.rs, not append_project_scope). A replay compares the predicate text/params the recorded scope inputs produce (clause, params, and the typing case of non-string scopes)",
    exclusions: 'case 3 (truthy non-string scopes): JS-only typing, recorded as Node behaves; the recording holds the clause and param count',
    normalised: { none: 'no run-dependent value' },
  },
});
process.exit(0);
