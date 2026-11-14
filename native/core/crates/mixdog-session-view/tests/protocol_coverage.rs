//! The audit of what the Node terminal UI needs, proven against protocol 2: every store member of class `action` or `lifecycle`
//! reaches a method (or section) the protocol declares, and every state field the UI reads is one the projection produces. What is
//! missing is listed in `tests/fixtures/core-gaps.json`, and the missing set must equal that file, so the test stays green while the
//! core catches up and the file only shrinks (`nr-tui-core-gaps` empties it).

use std::collections::BTreeSet;
use std::path::PathBuf;

use mixdog_app_protocol::client_method_spec;
use mixdog_app_server_client::SectionName;
use mixdog_session_view::action_route::{RouteContext, resolve_action};
use mixdog_session_view::state::PROJECTED_FIELDS;
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    serde_json::from_str(
        &std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn names(list: &Value) -> BTreeSet<String> {
    list.as_array()
        .expect("a list")
        .iter()
        .map(|e| e["name"].as_str().expect("a name").to_string())
        .collect()
}

fn method_declared(method: &str) -> bool {
    client_method_spec(method).is_some()
}

/// The members of the two calling surfaces: the TUI's store and the plain REPL's runtime.
fn members(calls: &Value) -> Vec<&Value> {
    calls["members"]
        .as_array()
        .unwrap()
        .iter()
        .chain(calls["repl"]["members"].as_array().unwrap())
        .collect()
}

/// The reason an `action` member has no v2 target, or `None` when it has one.
fn action_gap(member: &Value) -> Option<String> {
    let name = member["name"].as_str().unwrap();
    let target = &member["target"];
    if let Some(method) = target["method"].as_str() {
        return (!method_declared(method)).then(|| format!("{name}: no method {method}"));
    }
    if let Some(section) = target["section"].as_str() {
        return (!SectionName::ALL.iter().any(|s| s.wire() == section))
            .then(|| format!("{name}: no section {section}"));
    }
    match resolve_action(name, &[], &RouteContext::default()) {
        Ok(resolved) => (!method_declared(&resolved.method))
            .then(|| format!("{name}: no method {}", resolved.method)),
        Err(e) => Some(format!("{name}: {e}")),
    }
}

#[test]
fn every_action_and_lifecycle_entry_reaches_the_protocol_or_is_a_listed_gap() {
    let calls = fixture("tui-store-calls.json");
    let mut missing = BTreeSet::new();
    for member in members(&calls) {
        let name = member["name"].as_str().unwrap();
        match member["class"].as_str().unwrap() {
            "action" => {
                if action_gap(member).is_some() {
                    missing.insert(name.to_string());
                }
            }
            "lifecycle" => {
                let methods = member["methods"]
                    .as_array()
                    .unwrap_or_else(|| panic!("{name}: a lifecycle entry names its methods"));
                if methods
                    .iter()
                    .any(|m| !method_declared(m.as_str().unwrap()))
                {
                    missing.insert(name.to_string());
                }
            }
            "serverRequest" => {
                let method = member["method"]
                    .as_str()
                    .unwrap_or_else(|| panic!("{name}: a serverRequest entry names its method"));
                assert!(method_declared(method), "{name}: no method {method}");
            }
            "local" => {}
            other => panic!("{name}: unknown class {other}"),
        }
    }
    let gaps = fixture("core-gaps.json");
    assert_eq!(
        missing,
        names(&gaps["methods"]),
        "tests/fixtures/core-gaps.json lists exactly the methods the audit finds missing"
    );
}

#[test]
fn every_member_is_listed_once_with_its_class() {
    let calls = fixture("tui-store-calls.json");
    for list in [&calls["members"], &calls["repl"]["members"]] {
        let listed = list.as_array().unwrap();
        assert_eq!(names(list).len(), listed.len(), "a member is listed once");
    }
    for member in members(&calls) {
        let class = member["class"].as_str().unwrap();
        assert!(
            calls["classes"].get(class).is_some(),
            "{}: class {class}",
            member["name"]
        );
    }
}

#[test]
fn every_state_field_the_ui_reads_is_projected_or_a_listed_gap() {
    let fields = fixture("tui-state-fields.json");
    let mut missing = BTreeSet::new();
    for field in fields["fields"].as_array().unwrap() {
        let name = field["name"].as_str().unwrap();
        match field["kind"].as_str().unwrap() {
            "section" | "projection" => {
                if !PROJECTED_FIELDS.contains(&name) {
                    missing.insert(name.to_string());
                }
            }
            "local" => assert!(
                !PROJECTED_FIELDS.contains(&name),
                "{name} is local to the store, not projected"
            ),
            other => panic!("{name}: unknown kind {other}"),
        }
    }
    let gaps = fixture("core-gaps.json");
    assert_eq!(
        missing,
        names(&gaps["stateFields"]),
        "tests/fixtures/core-gaps.json lists exactly the state fields the audit finds missing"
    );
}

#[test]
fn every_listed_gap_is_a_member_of_the_audit() {
    let calls = fixture("tui-store-calls.json");
    let audited = members(&calls)
        .into_iter()
        .map(|m| m["name"].as_str().unwrap().to_string())
        .collect::<BTreeSet<_>>();
    let gaps = fixture("core-gaps.json");
    for gap in names(&gaps["methods"]) {
        assert!(
            audited.contains(&gap),
            "{gap} is in core-gaps.json but not in tui-store-calls.json"
        );
    }
}
