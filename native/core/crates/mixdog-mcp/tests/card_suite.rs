//! The Gmail `describe_emails` approval-card enrichment replayed against what today's Node
//! product put on the card (`tests/golden/card.mjs` → `card.json`), plus the hub's server order.
#![allow(clippy::disallowed_methods, reason = "test fixtures run a real stdio process")]

use std::sync::Arc;

use mixdog_core_api::domain::approval::ActionKind;
use mixdog_mcp::McpHub;
use mixdog_mcp::McpIo;
use mixdog_mcp::McpServerConfig;
use mixdog_mcp::policy::GmailCardEnricher;
use mixdog_mcp::result::OutputPolicy;
use mixdog_tools::policy::CardEnricher;
use mixdog_tools::policy::OutboundCard;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

const MOCK: &str = env!("CARGO_BIN_EXE_mixdog-mcp-mock-server");

fn io() -> McpIo {
    let tokens = mixdog_rt::testing::tokens();
    McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io }
}

fn hub(dir: &std::path::Path) -> Arc<McpHub> {
    McpHub::new(io(), dir.to_path_buf(), OutputPolicy::default())
}

fn config(name: &str, extra: Value) -> McpServerConfig {
    let mut entry = json!({"command": MOCK});
    entry.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    McpServerConfig::from_entry(name, &entry, &std::env::vars().collect()).unwrap()
}

fn golden() -> Value {
    serde_json::from_str(include_str!("golden/card.json")).unwrap()
}

fn category_of(name: &str) -> ActionKind {
    if name == "trash_emails" { ActionKind::Trash } else { ActionKind::Email }
}

fn details_of(value: &Value) -> std::collections::BTreeMap<String, String> {
    value.as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_gmail_card_gets_what_node_gave_it_in_every_recorded_case() {
    for case in golden()["cases"].as_array().unwrap() {
        let label = case["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let hub = hub(dir.path());
        let server = case["server"].as_str().unwrap();
        let mut extra = json!({});
        if let Some(connector) = case["connector"].as_str() {
            extra["connector"] = json!(connector);
        }
        let throws = !case["throws"].is_null();
        if !throws && !case["result"].is_null() {
            extra["env"] = json!({"MOCK_DESCRIBE_RESULT": case["result"].to_string()});
        }
        let registered = !label.contains("not connected");
        if registered {
            hub.apply(vec![config(server, extra)]);
            hub.server(server).unwrap().connect().await.unwrap();
        }
        let tool = case["tool"].as_str().unwrap();
        let name = format!("mcp__{server}__{tool}");
        let args = &case["args"];
        let mut card = OutboundCard::build(&name, args, category_of(tool));
        assert_eq!(card.account, case["baseline"]["account"].as_str().unwrap(), "{label}: account before the lookup");
        assert_eq!(card.details, details_of(&case["baseline"]["details"]), "{label}: details before the lookup");
        GmailCardEnricher::new(Arc::clone(&hub)).enrich(None, &name, args, &mut card).await;
        assert_eq!(card.account, case["card"]["account"].as_str().unwrap(), "{label}: account");
        assert_eq!(card.details, details_of(&case["card"]["details"]), "{label}: details");
        // What the lookup was asked: nothing when Node asked nothing.
        let asked = case["asked"].as_array().unwrap();
        if registered {
            let seen = hub
                .server(server)
                .unwrap()
                .call_tool_unlisted("t", "describe_args", json!({}), &CancellationToken::new(), None)
                .await
                .unwrap();
            let seen: Value = match &seen.parts[0] {
                mixdog_core_api::domain::tool::ToolPart::Text(t) => serde_json::from_str(t).unwrap(),
                other => panic!("{label}: {other:?}"),
            };
            match asked.first() {
                Some(first) => assert_eq!(seen, first["args"], "{label}: lookup arguments"),
                None => assert_eq!(seen, Value::Null, "{label}: no lookup"),
            }
        } else {
            assert!(asked.is_empty(), "{label}");
        }
        hub.close_all().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_card_of_another_kind_is_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    let hub = hub(dir.path());
    hub.apply(vec![config("gmail-acct", json!({"connector": "gmail", "env": {"MOCK_DESCRIBE_RESULT": json!({"content": [{"type": "text", "text": "{\"account\":\"a@example.com\"}"}]}).to_string()}}))]);
    hub.server("gmail-acct").unwrap().connect().await.unwrap();
    let args = json!({"channel": "#x"});
    let mut card = OutboundCard::build("mcp__gmail-acct__send_message", &args, ActionKind::Message);
    let before = card.clone();
    GmailCardEnricher::new(Arc::clone(&hub)).enrich(None, "mcp__gmail-acct__send_message", &args, &mut card).await;
    assert_eq!(card, before);
    hub.close_all().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn servers_are_listed_in_the_order_they_were_added() {
    let dir = tempfile::tempdir().unwrap();
    let hub = hub(dir.path());
    let names = |hub: &McpHub| hub.status().into_iter().map(|s| s.name).collect::<Vec<_>>();
    hub.apply(vec![config("zeta", json!({})), config("alpha", json!({})), config("mid", json!({}))]);
    assert_eq!(names(&hub), ["zeta", "alpha", "mid"]);
    assert_eq!(hub.servers().iter().map(|s| s.name().to_owned()).collect::<Vec<_>>(), ["zeta", "alpha", "mid"]);
    // A kept server holds its place; a changed or new one goes after the kept ones.
    hub.apply(vec![config("new", json!({})), config("alpha", json!({"args": ["x"]})), config("zeta", json!({})), config("mid", json!({}))]);
    assert_eq!(names(&hub), ["zeta", "mid", "new", "alpha"]);
    hub.close_all().await;
}
