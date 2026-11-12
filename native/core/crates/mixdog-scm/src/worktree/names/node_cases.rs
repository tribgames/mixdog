//! Node's worktree name cases (`fixtures/worktree-names-cases`, `record-worktree-names-cases.mjs`): each recorded hint
//! through `slug_from_hint` and `name_error`, each base through `unique_slug`, against Node's `slugFromHint`,
//! `worktreeNameError` and `uniqueSlug`. The cases the manifest names as differences are left out.
#![allow(clippy::disallowed_methods, reason = "test fixture loading")]

use serde_json::Value;
use serde_json::json;

use super::*;

fn fixture(name: &str) -> Value {
    let path = format!("{}/../../fixtures/worktree-names-cases/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn every_recorded_worktree_name_is_nodes() {
    let golden = fixture("golden.json");
    let excluded = fixture("MANIFEST.json")["excluded"].as_object().unwrap().clone();
    let taken_by = |case: &Value| case["taken"].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_owned()).collect::<Vec<_>>();
    let mut failures = Vec::new();
    let mut replayed = 0;
    for case in golden["cases"].as_array().unwrap() {
        let name = case["case"].as_str().unwrap();
        if excluded.contains_key(name) {
            continue;
        }
        let got = match case["kind"].as_str().unwrap() {
            "slug" => {
                let slug = slug_from_hint(case["hint"].as_str().unwrap());
                json!({ "slug": slug, "nameError": name_error(&slug) })
            }
            "bound" => json!({ "max": SLUG_MAX_LENGTH }),
            "unique" => {
                let taken = taken_by(case);
                json!({ "slug": unique_slug(case["base"].as_str().unwrap(), |s| taken.iter().any(|t| t == s)) })
            }
            "random" => {
                let pattern = |s: &str| s.strip_prefix("busy-").is_some_and(|hex| hex.len() == 8 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
                assert_eq!(case["pattern"], "^busy-[0-9a-f]{8}$");
                json!({ "matches": pattern(&unique_slug(case["base"].as_str().unwrap(), |s| !pattern(s))) })
            }
            other => panic!("{name}: kind {other} has no replay and no exclusion"),
        };
        replayed += 1;
        if got != case["recorded"] {
            failures.push(format!("{name}:\n  want {}\n  got  {got}", case["recorded"]));
        }
    }
    assert!(failures.is_empty(), "{} case(s) differ:\n{}", failures.len(), failures.join("\n"));
    assert_eq!(replayed + excluded.len(), golden["cases"].as_array().unwrap().len());
}
