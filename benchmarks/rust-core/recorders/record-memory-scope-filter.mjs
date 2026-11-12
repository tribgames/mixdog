#!/usr/bin/env node
// Node's recall scope SQL (src/runtime/memory/lib/memory-recall-scope-filter.test.mjs, 3 cases) from the real
// `projectScopePredicate` and `appendProjectScopeClause`: every scope shape at several placeholder offsets and column
// options, and the append call's effect on the where list and params it is handed.
// A non-string scope (the numeric-zero shape of case 1, case 3's number and object) keeps its JS type only on the
// wire: each also records `wire`, what the clause is when the scope arrives as a recall request's `projectScope` (the
// real `resolveQueryProjectScope`, query-search-plan.mjs:13, with no cwd, then `projectScopePredicate` at the same
// offset), the level the core is asked at.
//
//   node benchmarks/rust-core/recorders/record-memory-scope-filter.mjs --tree <dir>
import { begin, capture, finish, importFrom, exact } from './lib/mc-record.mjs';

const ctx = begin();
const { appendProjectScopeClause, projectScopePredicate } = await importFrom(ctx.tree, 'src/runtime/memory/lib/memory-recall-scope-filter.mjs');
const { resolveQueryProjectScope } = await importFrom(ctx.tree, 'src/runtime/memory/lib/query-search-plan.mjs');
const objectScope = { id: 42 };

/** The scope as a recall request's `projectScope` (no cwd: `resolveProjectScope` answers null), then its clause. */
const atWire = async (scope, next) => {
  const resolved = resolveQueryProjectScope({ projectScope: scope }, () => null);
  return { resolved, ...(await capture(() => projectScopePredicate(resolved, next))) };
};
const predicate = async (scope, next, options) => ({
  input: { scope: exact(scope), next, options },
  ...(await capture(() => projectScopePredicate(scope, next, options))),
  ...(typeof scope === 'number' ? { wire: await atWire(scope, next) } : {}),
});
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
  typing.push({ label, scope: exact(scope), next, ...out, boundParamIsTheScopeItself: out.result ? scope === (label.startsWith('object') ? objectScope : 7) && projectScopePredicate(scope, next).params[0] === scope : null, wire: await atWire(scope, next) });
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
    entry: { runs: 'projectScopePredicate and appendProjectScopeClause (memory-recall-scope-filter.mjs); resolveQueryProjectScope (query-search-plan.mjs) for the `wire` of non-string scopes', notRun: 'the queries that embed the clause (hybrid SQL, browse): other test files' },
    replay: "mixdog-services memory/recall/filters.rs project_scope_predicate and append_project_scope, called by recall/browse.rs (the browse, session and core-row queries) with the scope recall/plan.rs resolve_query_project_scope reads from the `memory/recall` request (Recall::recall). Every string-scope probe and append run is compared whole (clause, params); a non-string scope (case 1's numeric zero, case 3's number and object) is compared at the wire: the request's projectScope through resolve_query_project_scope with no cwd, then project_scope_predicate, against the recorded `wire` (resolved scope, clause, params)",
    exclusions: 'none',
    normalised: { none: 'no run-dependent value' },
  },
});
process.exit(0);
