//! What the PURE replays share on top of the case driver (`provider_case`): every recorded call to one entry, the
//! PURE ids of a set, a recorded argument as plain JSON, and builders of a result in Node's shape.

use mixdog_testkit::Exact;
use serde_json::Value;

use crate::provider_case::Case;
use crate::provider_case::CaseSet;

/// The arguments of every recorded call to `entry` (matched by its suffix), in order.
pub fn args_of(case: &Case, entry: &str) -> Vec<Vec<Exact>> {
    case.calls.iter().filter(|c| c.entry.ends_with(entry)).map(|c| c.args.clone()).collect()
}

/// The ids the manifest marks PURE, in recorded order.
pub fn pure_ids(set: &CaseSet) -> Vec<String> {
    set.ids().into_iter().filter(|id| set.level(id).get("level").as_str() == "pure").map(str::to_owned).collect()
}

/// A recorded argument as the plain JSON a Rust entry takes.
pub fn plain(value: &Exact) -> Value {
    value.to_plain().unwrap_or_else(|e| panic!("recorded argument has no plain form: {e}"))
}

/// The Rust result in the recorded shape against the recorded result, whole.
#[track_caller]
pub fn assert_result(set: &CaseSet, case: &Case, actual: &Exact) {
    case.recorded().assert_eq(&format!("provider-{} {}: result", set.set, case.id), actual);
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
