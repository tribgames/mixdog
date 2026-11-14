//! The Rust session action router against the recording of the TypeScript one (`tests/goldens/action-route.json`, written by
//! `tests/recorders/record-action-route.mjs`): every action, with the argument lists and call contexts of the recording, gives the
//! same `{ method, params }` or the same error.

use std::path::PathBuf;

use mixdog_session_view::action_route::{RouteContext, resolve_action, session_actions};
use serde_json::Value;

fn golden() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/goldens/action-route.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("the recording is checked in"))
        .expect("the recording is JSON")
}

#[test]
fn router_answers_as_the_recorded_one() {
    let golden = golden();
    let entries = golden["entries"].as_array().expect("entries");
    assert!(
        entries.len() > 3000,
        "the recording covers every action: {} entries",
        entries.len()
    );
    let mut mismatches = Vec::new();
    for entry in entries {
        let action = entry["action"].as_str().unwrap();
        let args = golden["args"][entry["args"].as_str().unwrap()]
            .as_array()
            .unwrap();
        let context = &golden["contexts"][entry["context"].as_str().unwrap()];
        let ctx = RouteContext {
            thread_id: context["threadId"].as_str(),
        };
        let answer = match resolve_action(action, args, &ctx) {
            Ok(r) => serde_json::json!({ "method": r.method, "params": r.params }),
            Err(e) => {
                serde_json::json!({ "error": { "message": e.to_string(), "code": e.code() } })
            }
        };
        if answer != entry["result"] {
            mismatches.push(format!(
                "{action} {} {}: {answer} != {}",
                entry["context"], entry["args"], entry["result"]
            ));
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} differ, first: {:?}",
        mismatches.len(),
        mismatches.iter().take(3).collect::<Vec<_>>()
    );
}

#[test]
fn the_session_surface_is_the_recorded_one() {
    let golden = golden();
    let recorded: std::collections::BTreeSet<&str> = golden["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["action"].as_str().unwrap())
        .collect();
    let mut listed: std::collections::BTreeSet<&str> = session_actions().into_iter().collect();
    listed.insert("noSuchAction");
    assert_eq!(recorded, listed);
    assert_eq!(
        golden["actions"].as_u64().unwrap() as usize,
        session_actions().len()
    );
}
