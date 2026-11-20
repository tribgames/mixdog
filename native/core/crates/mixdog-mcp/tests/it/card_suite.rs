//! The Gmail `describe_emails` approval-card enrichment: what the card shows of the messages a mail or trash call names, and
//! that a connector that cannot answer leaves the card as it was; plus the hub's server order.
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

const MOCK: &str = env!("CARGO_BIN_EXE_mixdog-mcp-mock-server");

fn io() -> McpIo {
    let tokens = mixdog_rt::testing::tokens();
    McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk }
}

fn hub(dir: &std::path::Path) -> Arc<McpHub> {
    McpHub::new(io(), dir.to_path_buf(), OutputPolicy::default())
}

fn config(name: &str, extra: Value) -> McpServerConfig {
    let mut entry = json!({"command": MOCK});
    entry.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    McpServerConfig::from_entry(name, &entry, &std::env::vars().collect()).unwrap()
}

fn category_of(name: &str) -> ActionKind {
    if name == "trash_emails" { ActionKind::Trash } else { ActionKind::Email }
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

fn text_result(body: Value) -> String {
    json!({"content": [{"type": "text", "text": body.to_string()}]}).to_string()
}

/// The card a mail or trash call shows after the enricher asked the connector, from a connector that answers `describe_emails`
/// with `body` (`None`: the connector's answer is not JSON text).
async fn enriched(connector: &str, body: Option<Value>, tool: &str, args: Value) -> OutboundCard {
    let dir = tempfile::tempdir().unwrap();
    let hub = hub(dir.path());
    let result = match body {
        Some(body) => text_result(body),
        None => json!({"content": [{"type": "text", "text": "not json"}]}).to_string(),
    };
    hub.apply(vec![config("gmail-acct", json!({"connector": connector, "env": {"MOCK_DESCRIBE_RESULT": result}}))]);
    hub.server("gmail-acct").unwrap().connect().await.unwrap();
    let name = format!("mcp__gmail-acct__{tool}");
    let mut card = OutboundCard::build(&name, &args, category_of(tool));
    GmailCardEnricher::new(Arc::clone(&hub)).enrich(None, &name, &args, &mut card).await;
    hub.close_all().await;
    card
}

#[tokio::test(flavor = "multi_thread")]
async fn a_trash_card_lists_who_wrote_what_when_and_how_many_more_there_are() {
    let emails = json!([
        {"from": "Bob", "subject": "Hi", "date": "2024-05-06T10:00:00Z"},
        {"from": "Ann", "subject": "Re: Hi"},
        {"subject": "No sender"}
    ]);
    let card = enriched("gmail", Some(json!({"account": "a@example.com", "emails": emails})), "trash_emails", json!({"ids": ["1", "2", "3", "4", "5"]})).await;
    assert_eq!(card.account, "a@example.com");
    // A date is cut to its first ten characters; a missing part is left out of its line.
    assert_eq!(card.details["messages"], "Bob · Hi · 2024-05-06\nAnn · Re: Hi\nNo sender");
    assert_eq!(card.details["more"], "2", "five ids, three shown");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_card_keeps_what_the_call_carries_when_the_connector_cannot_say_more() {
    let before = {
        let args = json!({"ids": ["1"]});
        OutboundCard::build("mcp__gmail-acct__trash_emails", &args, ActionKind::Trash)
    };
    // Not JSON text, a JSON null, a server of another connector: nothing is added and nothing fails.
    for (connector, body) in [("gmail", None), ("gmail", Some(Value::Null)), ("other", Some(json!({"account": "x@example.com", "emails": []})))] {
        let card = enriched(connector, body, "trash_emails", json!({"ids": ["1"]})).await;
        assert_eq!(card, before, "{connector}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_empty_account_in_the_answer_leaves_the_card_account_as_built() {
    let card = enriched("gmail", Some(json!({"account": "", "emails": [{"from": "Bob"}]})), "trash_emails", json!({"ids": ["1"]})).await;
    // Rule (1.4.5 outbound-policy.mjs:241, policy/card.rs mcp): a card's account is the call's `from`/`account` for an email
    // card, else the server's name; the enricher replaces it only with a non-empty answer account. A trash card never takes
    // the call's `account` as its own, so with an empty answer it stays the server's name.
    assert_eq!(card.account, "gmail-acct");
    let mail = enriched("gmail", Some(json!({"account": "", "emails": []})), "send_email", json!({"to": "x@example.com", "account": "mine@example.com"})).await;
    assert_eq!(mail.account, "mine@example.com", "an email card keeps the account its call names");
    assert_eq!(card.details["messages"], "Bob");
    assert!(!card.details.contains_key("more"));
}
