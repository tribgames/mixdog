//! memory-scope-filter: `project_scope_predicate` and `append_project_scope` (memory/recall/filters.rs), the
//! project-scope clause every recall browse, session and core-row query appends. A non-string scope is compared at the
//! wire (`resolve_query_project_scope` of the request, recall/plan.rs).

use mixdog_testkit::Exact;

use super::{assert_case_count, case, golden, int, object, opt_str, same, string};
use crate::memory::recall::filters::{append_project_scope, project_scope_predicate};
use crate::memory::recall::plan::{SearchArgs, resolve_query_project_scope};
use crate::memory::recall::row::P;

const SET: &str = "memory-scope-filter";

fn param(p: &P) -> Exact {
    match p {
        P::T(text) => string(text.clone()),
        P::I(n) => int(*n),
        other => panic!("a scope parameter of another type: {other:?}"),
    }
}

fn recorded_param(value: &Exact) -> P {
    match value {
        Exact::String(text) => P::T(text.clone()),
        Exact::Number(n) if n.fract() == 0.0 => P::I(*n as i64),
        other => panic!("a recorded start parameter of another type: {other:?}"),
    }
}

fn clause(clause: String, params: &[P]) -> Exact {
    object(vec![("clause", string(clause)), ("params", Exact::Array(params.iter().map(param).collect()))])
}

/// A non-string scope at the wire: the recall request's `projectScope` read by `resolve_query_project_scope` (no cwd
/// resolved), then its clause at the probe's offset; compared with the recorded `wire` whole.
fn at_wire(what: &str, scope: &Exact, next: usize, recorded: &Exact) {
    let args = SearchArgs::new(serde_json::json!({ "projectScope": scope.to_plain().expect("a plain scope") }));
    let resolved = resolve_query_project_scope(&args, None);
    let (text, params) = project_scope_predicate(Some(&resolved), next, "project_id");
    let Exact::Object(mut fields) = clause(text, &params) else { unreachable!("an object") };
    fields.insert(0, ("resolved".to_owned(), string(resolved)));
    let wire = recorded.get("wire");
    let recorded = object(vec![("resolved", wire.get("resolved").clone()), ("clause", wire.get("result").get("clause").clone()), ("params", wire.get("result").get("params").clone())]);
    same(&format!("{what} at the wire"), &recorded, &Exact::Object(fields));
}

#[test]
fn the_recording_has_three_cases() {
    assert_case_count(&golden(SET), 3);
}

#[test]
fn project_scope_predicate_keeps_common_all_slug_sql_shapes_and_param_offsets() {
    let name = "projectScopePredicate keeps common/all/slug SQL shapes and param offsets";
    let golden = golden(SET);
    let case = case(&golden, 0, name);
    for (i, probe) in case.get("probes").as_array().iter().enumerate() {
        let input = probe.get("input");
        // A number scope keeps its type only on the wire: compared there.
        let Ok(scope) = opt_str(input.get("scope")) else {
            at_wire(&format!("{name}: probe {i}"), input.get("scope"), input.get("next").as_f64() as usize, probe);
            continue;
        };
        let column = match input.get("options") {
            Exact::Undefined => "project_id",
            options => options.get("column").as_str(),
        };
        let next = input.get("next").as_f64() as usize;
        let (text, params) = project_scope_predicate(scope, next, column);
        same(&format!("{name}: probe {i}"), probe.get("result"), &clause(text, &params));
    }
}

#[test]
fn project_scope_predicate_binds_truthy_numeric_object_scopes_at_the_wire() {
    let name = "projectScopePredicate binds truthy numeric/object scopes without coercion (JS typing artefact)";
    let golden = golden(SET);
    let case = case(&golden, 2, name);
    for probe in case.get("probes").as_array() {
        at_wire(&format!("{name}: {}", probe.get("label").as_str()), probe.get("scope"), probe.get("next").as_f64() as usize, probe);
    }
}

#[test]
fn append_project_scope_clause_binds_the_next_placeholder_without_reordering_existing_params() {
    let name = "appendProjectScopeClause binds the next placeholder without reordering existing params";
    let golden = golden(SET);
    let case = case(&golden, 1, name);
    for (r, run) in case.get("runs").as_array().iter().enumerate() {
        let start = run.get("start");
        let mut where_clauses: Vec<String> = start.get("where").as_array().iter().map(|w| w.as_str().to_owned()).collect();
        let mut params: Vec<P> = start.get("params").as_array().iter().map(recorded_param).collect();
        for (s, step) in run.get("steps").as_array().iter().enumerate() {
            append_project_scope(&mut where_clauses, &mut params, opt_str(step.get("scope")).expect("string scope"), "project_id");
            let actual = object(vec![
                ("where", Exact::Array(where_clauses.iter().cloned().map(Exact::String).collect())),
                ("params", Exact::Array(params.iter().map(param).collect())),
            ]);
            let expected = object(vec![("where", step.get("where").clone()), ("params", step.get("params").clone())]);
            same(&format!("{name}: run {r} step {s}"), &expected, &actual);
        }
    }
}
