//! memory-scope-filter: `project_scope_predicate` and `append_project_scope` (memory/recall/filters.rs), the
//! project-scope clause every recall browse, session and core-row query appends.

use mixdog_testkit::Exact;

use super::{assert_case_count, case, golden, int, object, opt_str, same, string};
use crate::memory::recall::filters::{append_project_scope, project_scope_predicate};
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

#[test]
fn the_recording_has_three_cases() {
    assert_case_count(&golden(SET), 3);
}

#[test]
fn project_scope_predicate_keeps_common_all_slug_sql_shapes_and_param_offsets() {
    let name = "projectScopePredicate keeps common/all/slug SQL shapes and param offsets";
    let golden = golden(SET);
    let case = case(&golden, 0, name);
    let mut js_only = Vec::new();
    for (i, probe) in case.get("probes").as_array().iter().enumerate() {
        let input = probe.get("input");
        // A number scope is a JS typing shape: no recall request carries one to this clause (recall/plan.rs:95
        // takes a string projectScope only); it is reported, not replayed.
        let Ok(scope) = opt_str(input.get("scope")) else {
            js_only.push(i);
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
    assert_eq!(js_only, [8], "probes with a non-string scope");
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
