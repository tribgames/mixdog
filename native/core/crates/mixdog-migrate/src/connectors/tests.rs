//! The connector transition: the servers of one connector merge into one holding its accounts, and the stores that
//! name a merged-away server follow it.

#![allow(
    clippy::disallowed_methods,
    reason = "the tests build and read data dirs with blocking std::fs"
)]

use std::path::Path;

use serde_json::Value;
use serde_json::json;

use super::*;
use crate::run::tests::corpus;
use crate::run::tests::write;

#[test]
fn numbered_servers_sort_naturally() {
    let mut names = vec!["gmail-10", "gmail-2", "gmail", "gmail-1"];
    names.sort_by(|a, b| natural_order(a, b));
    assert_eq!(names, ["gmail", "gmail-1", "gmail-2", "gmail-10"]);
}

#[test]
fn ids_are_v4_and_stable() {
    let id = account_id("seed", "gmail", 1);
    assert_eq!(id, account_id("seed", "gmail", 1));
    assert_ne!(id, account_id("seed", "gmail", 2));
    assert_eq!(uuid::Uuid::parse_str(&id).unwrap().get_version_num(), 4);
}

/// A file 1.4.5 fails on stays as it is, and the others still move.
#[test]
fn unreadable_stores_are_left_as_they_are() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path();
    write(data, "mixdog-config.json", br#"{"agent":{"mcpServers":{"linear":{"url":"https://mcp.linear.app/mcp","connector":"linear"},"linear-2":{"url":"https://mcp.linear.app/mcp","oauthKey":"2","connector":"linear"}}}}"#);
    write(data, "agents/bad/agent.json", b"{not json");
    write(data, "agents/odd/agent.json", br#"{"connectors":{"allow":["linear-2"]}}"#);
    write(data, "agents/ok/agent.json", br#"{"connectors":{"off":["linear-2"]}}"#);
    write(data, "hooks.json", b"[");
    let conversion = convert(data, &|_| true).unwrap();
    let rels: Vec<&str> = conversion.outputs.iter().map(|(rel, _)| rel.as_str()).collect();
    assert_eq!(rels, ["agents/ok/agent.json.bak", "agents/ok/agent.json", "mixdog-config.json"]);
    // A quarantined store is not written.
    let conversion = convert(data, &|rel| !rel.starts_with("agents/")).unwrap();
    let rels: Vec<&str> = conversion.outputs.iter().map(|(rel, _)| rel.as_str()).collect();
    assert_eq!(rels, ["mixdog-config.json"]);
}

/// The v145 profile is already converted: nothing to do.
#[test]
#[ignore = "release gate over the migration corpus (MIXDOG_MIGRATION_CORPUS)"]
fn v145_needs_no_connector_transition() {
    let data = corpus().join("v145");
    assert!(!Path::new(&data.join(PENDING_FILE)).exists());
    assert!(convert(&data, &|_| true).unwrap().outputs.is_empty());
}

fn notion(extra: Value) -> Value {
    let mut server = json!({"url": "https://mcp.notion.com/mcp", "connector": "notion"});
    server.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    server
}

fn account_names(server: &Value) -> Vec<&str> {
    server["accounts"].as_array().unwrap().iter().map(|a| a["name"].as_str().unwrap()).collect()
}

#[test]
fn one_connectors_servers_merge_into_one_holding_the_accounts() {
    let servers = json!({
        "other": {"command": "x"},
        "notion-2": notion(json!({"oauthKey": "2"})),
        "notion": notion(json!({})),
    });
    let (merged_servers, groups) = merge_servers(Some(&servers));
    assert_eq!(groups, [Group { name: "notion".into(), from: vec!["notion".into(), "notion-2".into()] }]);
    assert_eq!(merged_servers.keys().collect::<Vec<_>>(), ["other", "notion"], "the other server stays, the merged one takes the surviving name");
    assert_eq!(merged_servers["other"], json!({"command": "x"}));
    let notion = &merged_servers["notion"];
    assert_eq!(notion["type"], "http");
    assert_eq!(notion["connector"], "notion");
    assert_eq!(notion["url"], "https://connectors.mixdog.invalid/notion/mcp");
    assert_eq!(account_names(notion), ["notion", "notion-2"], "the surviving server's account first");
    assert_eq!(notion["accounts"][1]["oauthKey"], "2");
    assert!(notion.get("enabled").is_none());
}

#[test]
fn a_connector_already_merged_is_left_as_it_is() {
    let servers = json!({"notion": notion(json!({"accounts": [{"name": "a", "url": "https://mcp.notion.com/mcp"}]}))});
    let (_, groups) = merge_servers(Some(&servers));
    assert!(groups.is_empty());
    assert_eq!(merge_servers(None).1, []);
}

#[test]
fn numbered_accounts_join_lowest_number_first_and_without_duplicates() {
    let servers = json!({
        "notion-10": notion(json!({"oauthKey": "10"})),
        "notion-2": notion(json!({"oauthKey": "2"})),
        "notion-3": notion(json!({"oauthKey": "2"})),
    });
    let (merged_servers, groups) = merge_servers(Some(&servers));
    assert_eq!(groups[0].from, ["notion-2", "notion-3", "notion-10"]);
    assert_eq!(groups[0].name, "notion-2", "with no server named for the connector, the lowest-numbered survives");
    // notion-3 is the same connection as notion-2 and adds no account.
    assert_eq!(account_names(&merged_servers["notion-2"]), ["notion-2", "notion-10"]);
}

#[test]
fn a_disabled_server_keeps_its_account_off_and_a_fully_disabled_connector_is_off() {
    let servers = json!({"notion": notion(json!({})), "notion-2": notion(json!({"oauthKey": "2", "enabled": false}))});
    let (merged_servers, _) = merge_servers(Some(&servers));
    let notion_server = &merged_servers["notion"];
    assert!(notion_server.get("enabled").is_none());
    assert_eq!(notion_server["accounts"][1]["enabled"], false);
    assert!(notion_server["accounts"][0].get("enabled").is_none());

    let servers = json!({"notion": notion(json!({"enabled": false})), "notion-2": notion(json!({"oauthKey": "2", "enabled": false}))});
    let (merged_servers, _) = merge_servers(Some(&servers));
    assert_eq!(merged_servers["notion"]["enabled"], false);
}

fn policy(allow: Option<&[&str]>, off: &[&str]) -> Policy {
    Policy {
        allow: allow.map(|a| a.iter().map(|s| (*s).to_owned()).collect()),
        off: off.iter().map(|s| (*s).to_owned()).collect(),
        tools: Default::default(),
    }
}

fn group() -> Vec<Group> {
    vec![Group { name: "notion".into(), from: vec!["notion".into(), "notion-2".into()] }]
}

#[test]
fn a_policy_naming_a_merged_away_server_follows_the_surviving_one() {
    let mapped = map_policy(&policy(None, &["notion-2"]), &group()).unwrap();
    assert_eq!(mapped.off.iter().collect::<Vec<_>>(), ["notion"], "off follows");
    let mapped = map_policy(&policy(Some(&["notion-2", "gmail"]), &[]), &group()).unwrap();
    assert_eq!(mapped.allow.unwrap().iter().collect::<Vec<_>>(), ["gmail", "notion"], "allowed follows");
    assert_eq!(map_policy(&policy(None, &["gmail"]), &group()), None, "a policy naming none of them is untouched");
    assert_eq!(map_policy(&policy(None, &["notion"]), &group()), None, "the surviving server's own entry needs no move");
}

#[cfg(node_twin)]
#[path = "node-twin/merge_cases.rs"]
mod merge_cases;
