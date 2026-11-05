//! Node-recorded twin: `fixtures/connectors/connector-text-twin.json`
//! (`benchmarks/rust-core/recorders/record-connectors.mjs`).

use serde_json::Value;

use super::accounts::{ConnectorAccount, accounts_of_instructions, connector_accounts_instructions};
use super::triggers::{CONNECTOR_TRIGGER_MAX_CHARS, CONNECTOR_TRIGGERS, connector_trigger};

fn twin() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/connectors/connector-text-twin.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn the_curated_table_is_node_s() {
    let twin = twin();
    assert_eq!(twin["maxChars"], CONNECTOR_TRIGGER_MAX_CHARS);
    let node = twin["triggers"].as_object().unwrap();
    assert_eq!(node.len(), CONNECTOR_TRIGGERS.len());
    for (id, line) in CONNECTOR_TRIGGERS {
        assert_eq!(node[id], line, "{id}");
    }
}

#[test]
fn trigger_lookup_matches_node_for_every_recorded_id() {
    for case in twin()["triggerCases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap_or("");
        assert_eq!(connector_trigger(id), case["trigger"].as_str().unwrap(), "{case}");
    }
}

fn accounts_of(value: &Value) -> Vec<ConnectorAccount> {
    // A non-array is no list; an entry that is not an object with a text address is unnamed.
    value
        .as_array()
        .map(|list| {
            list.iter()
                .map(|a| ConnectorAccount {
                    email: a["email"].as_str().unwrap_or("").into(),
                    note: a["note"].as_str().map(String::from),
                })
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn account_instructions_and_their_parse_match_node() {
    for case in twin()["accountCases"].as_array().unwrap() {
        let text = connector_accounts_instructions(&accounts_of(&case["accounts"]));
        assert_eq!(text.as_deref(), case["instructions"].as_str(), "{case}");
        let parsed: Vec<String> = case["parsed"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().into()).collect();
        assert_eq!(accounts_of_instructions(text.as_deref().unwrap_or("")), parsed, "{case}");
    }
}

#[test]
fn parsing_raw_instruction_text_matches_node() {
    for case in twin()["rawCases"].as_array().unwrap() {
        let parsed: Vec<String> = case["parsed"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().into()).collect();
        // The recorded non-string inputs read as the empty text in Node.
        assert_eq!(accounts_of_instructions(case["text"].as_str().unwrap_or("")), parsed, "{case}");
    }
}
