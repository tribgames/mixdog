//! The recorded Node provider sets (`fixtures/provider-<set>/`) read at run time: the cases, the manifest's levels,
//! and the arguments of each recorded call, decoded through `mixdog_testkit::exact`.

use std::path::PathBuf;

use mixdog_testkit::Exact;
use serde_json::Value;

fn dir(set: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures").join(format!("provider-{set}"))
}

/// Every case of a set, decoded, in recorded order.
pub fn cases(set: &str) -> Vec<Exact> {
    Exact::load(dir(set).join("cases.json")).get("cases").as_array().to_vec()
}

/// One case by id.
pub fn case(set: &str, id: &str) -> Exact {
    cases(set)
        .into_iter()
        .find(|c| c.get("id").as_str() == id)
        .unwrap_or_else(|| panic!("provider-{set}: no case {id:?}"))
}

/// The ids the manifest marks `level`, in manifest order.
pub fn ids_at_level(set: &str, level: &str) -> Vec<String> {
    let manifest = Exact::load(dir(set).join("MANIFEST.json"));
    manifest
        .get("levels")
        .as_array()
        .iter()
        .filter(|l| l.get("level").as_str() == level)
        .map(|l| l.get("id").as_str().to_owned())
        .collect()
}

/// The recorded calls of a case: (entry, arguments).
pub fn calls(case: &Exact) -> Vec<(String, Vec<Exact>)> {
    case.try_get("calls")
        .map(|calls| {
            calls.as_array().iter().map(|c| (c.get("entry").as_str().to_owned(), c.get("args").as_array().to_vec())).collect()
        })
        .unwrap_or_default()
}

/// The arguments of the recorded calls to `entry` (matched by its suffix), in order.
pub fn args_of(case: &Exact, entry: &str) -> Vec<Vec<Exact>> {
    calls(case).into_iter().filter(|(e, _)| e.ends_with(entry)).map(|(_, a)| a).collect()
}

/// A recorded argument as the plain JSON a Rust entry takes.
pub fn plain(value: &Exact) -> Value {
    value.to_plain().unwrap_or_else(|e| panic!("recorded argument has no plain form: {e}"))
}

/// Compares a Rust result in the recorded shape with the recorded result, whole.
#[track_caller]
pub fn assert_result(set: &str, case: &Exact, actual: Exact) {
    let id = case.get("id").as_str();
    assert_eq!(actual, *case.get("result"), "provider-{set} {id}: result");
}

/// An object in recorded key order.
pub fn object(entries: Vec<(&str, Exact)>) -> Exact {
    Exact::Object(entries.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

pub fn string(s: &str) -> Exact {
    Exact::String(s.to_owned())
}

pub fn number(n: usize) -> Exact {
    Exact::from(n as f64)
}
