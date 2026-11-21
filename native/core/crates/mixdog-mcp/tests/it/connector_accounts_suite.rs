//! The connector account choice: which account a call uses, what is remembered per conversation, and how a group of accounts
//! publishes one toolset and routes each call.
#![allow(clippy::disallowed_methods, reason = "test fixtures write and inspect directories directly")]

use std::sync::Arc;

use mixdog_mcp::connector_accounts::AccountError;
use mixdog_mcp::connector_accounts::AccountHealth;
use mixdog_mcp::connector_accounts::AccountReport;
use mixdog_mcp::connector_accounts::AccountSeed;
use mixdog_mcp::connector_accounts::ChooseCall;
use mixdog_mcp::connector_accounts::ConnectorAccounts;
use mixdog_mcp::connector_accounts::split_mcp_tool_name;
use serde_json::Value;

#[tokio::test]
async fn a_state_file_that_cannot_be_read_is_an_error_not_an_empty_choice() {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    // A directory where the file belongs: reading it fails for a reason other than "missing".
    std::fs::create_dir(dir.path().join("connector-accounts-in-use.json")).unwrap();
    let seeds = vec![AccountSeed { name: "linear".to_owned(), id: "i".to_owned(), email: "a@example.com".to_owned() }];
    let accounts = ConnectorAccounts::new("linear", seeds, Arc::new(AccountHealth::default()), dir.path().to_path_buf(), tokens.maintenance_io).unwrap();
    let got = accounts.choose(&ChooseCall { tool: "search", wanted: None, conversation: "" }).await;
    assert!(matches!(got, Err(AccountError::State(_))), "{got:?}");
}

#[tokio::test]
async fn a_retired_servers_late_report_does_not_overwrite_its_replacements_health() {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let health = Arc::new(AccountHealth::default());
    let seed = || vec![AccountSeed { name: "gmail".to_owned(), id: "i".to_owned(), email: "a@example.com".to_owned() }];
    let old = ConnectorAccounts::new("gmail", seed(), Arc::clone(&health), dir.path().to_path_buf(), tokens.maintenance_io).unwrap();
    // The reviewed interleaving: the old server reports, a replacement takes the names and reports healthy, then the old server's
    // late report lands. Health belongs to the newest generation, so it does not.
    old.record("gmail", &AccountReport { error: "before".to_owned(), ..AccountReport::default() });
    let new = ConnectorAccounts::new("gmail", seed(), Arc::clone(&health), dir.path().to_path_buf(), tokens.maintenance_io).unwrap();
    assert!(health.get("gmail").is_none(), "the replacement starts from none of the old server's records");
    new.record("gmail", &AccountReport::default());
    old.record("gmail", &AccountReport { error: "closed".to_owned(), ..AccountReport::default() });
    assert_eq!(health.get("gmail").unwrap().error, "");
}

async fn three_gmail_accounts() -> (tempfile::TempDir, Arc<mixdog_mcp::McpHub>, Arc<mixdog_mcp::McpServer>) {
    use mixdog_mcp::server::ServerState;

    let dir = tempfile::tempdir().unwrap();
    let hub = account_hub(dir.path());
    let accounts = ["gmail", "gmail-2", "gmail-3"].iter().map(|name| mock_account(name, &format!("identity-{name}"))).collect();
    hub.apply(vec![accounts_config(accounts)]);
    let server = hub.server("gmail").unwrap();
    wait_account(&server, |state| !matches!(state, ServerState::Starting)).await;
    (dir, hub, server)
}

#[tokio::test(flavor = "multi_thread")]
async fn three_connector_accounts_publish_one_toolset() {
    let (_dir, hub, _server) = three_gmail_accounts().await;
    let tools = hub.tools();
    assert_eq!(tools.iter().map(|tool| tool.spec().name.as_str()).collect::<Vec<_>>(), ["mcp__gmail__fixture_0"]);
    assert_eq!(tools[0].spec().input_schema["properties"]["account"]["type"], "string");
    hub.close_all().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_call_goes_to_the_selected_account_and_the_next_without_one_goes_to_it_too() {
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    let (_dir, hub, server) = three_gmail_accounts().await;
    let chosen = hub.resolve_tool_account("mcp__gmail__fixture_0", &json!({"account": "gmail-3"}), "conversation").await.unwrap().unwrap();
    assert_eq!(chosen.name, "gmail-3");
    let result = call_group(&hub, &server, json!({"text": "hello", "account": "gmail-3"})).await.unwrap();
    assert_eq!(result["content"][0]["text"], "gmail-3");
    assert_eq!(result["content"][1]["text"], "(Gmail account: gmail-3)");
    let remembered = hub.resolve_tool_account("mcp__gmail__fixture_0", &json!({}), "conversation").await.unwrap().unwrap();
    assert_eq!(remembered.name, "gmail-3");
    let received = server.account_server("gmail-3").unwrap().call_tool_settled("", "fixture_args", json!({}), &CancellationToken::new(), None).await.unwrap();
    assert_eq!(serde_json::from_str::<Value>(received["content"][0]["text"].as_str().unwrap()).unwrap(), json!([{"text": "hello"}]));
    hub.close_all().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_connector_instructions_list_its_accounts_before_the_servers_own() {
    use mixdog_mcp::server::ServerState;

    let (_dir, hub, server) = three_gmail_accounts().await;
    for name in ["gmail", "gmail-2", "gmail-3"] {
        wait_account(&server.account_server(name).unwrap(), |state| matches!(state, ServerState::Ready(_))).await;
    }
    let expected =
        "Accounts: gmail, gmail-2, gmail-3. `account` picks one; left out, a call uses the account used last, and its result names it.\n\nmock instructions";
    wait_account(&server, |state| matches!(state, ServerState::Ready(ready) if ready.instructions.as_deref() == Some(expected))).await;
    hub.close_all().await;
}
fn account_hub(dir: &std::path::Path) -> Arc<mixdog_mcp::McpHub> {
    let tokens = mixdog_rt::testing::tokens();
    let hub = mixdog_mcp::McpHub::new(
        mixdog_mcp::McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk },
        dir.join("artifacts"),
        mixdog_mcp::result::OutputPolicy::default(),
    );
    hub.set_account_runtime(mixdog_mcp::connector_transport::AccountRuntime {
        health: Arc::new(AccountHealth::default()),
        data_dir: dir.to_path_buf(),
        maintenance: tokens.maintenance_io,
    });
    hub
}

fn mock_account(name: &str, id: &str) -> Value {
    serde_json::json!({
        "name": name, "id": id, "type": "stdio", "command": mixdog_testkit::bin_exe!("mixdog-mcp-mock-server"),
        "env": {"MOCK_TOOLS": "[\"fixture_0\"]", "MOCK_FIXTURES": serde_json::json!([name]).to_string()}
    })
}

fn accounts_config(accounts: Vec<Value>) -> mixdog_mcp::McpServerConfig {
    mixdog_mcp::McpServerConfig::from_entry(
        "gmail",
        &serde_json::json!({
            "type": "http", "url": "https://connectors.mixdog.invalid/gmail/mcp", "connector": "gmail", "accounts": accounts,
        }),
        &std::env::vars().collect(),
    )
    .unwrap()
}

async fn wait_account(server: &mixdog_mcp::McpServer, wanted: impl Fn(&mixdog_mcp::server::ServerState) -> bool) {
    let mut state = server.subscribe();
    tokio::time::timeout(std::time::Duration::from_secs(60), state.wait_for(|state| wanted(state))).await.unwrap().unwrap();
}

async fn call_group(hub: &mixdog_mcp::McpHub, server: &mixdog_mcp::McpServer, args: Value) -> Result<Value, mixdog_mcp::server::CallError> {
    let chosen = hub
        .resolve_tool_account("mcp__gmail__fixture_0", &args, "conversation")
        .await
        .map_err(|error| mixdog_mcp::server::CallError::Recovery { message: error.to_string(), outcome_unknown: false })?
        .unwrap();
    let binding = mixdog_core_api::domain::tool::ConnectorAccountBinding { name: chosen.name, id: chosen.id };
    server.call_tool_settled_bound("conversation", "fixture_0", args, &tokio_util::sync::CancellationToken::new(), None, Some(&binding)).await
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hung_account_times_out_without_taking_down_the_connector() {
    use mixdog_mcp::server::ServerState;
    use serde_json::json;

    let dir = tempfile::tempdir().unwrap();
    let hub = account_hub(dir.path());
    let mut hung = mock_account("gmail-2", "hung");
    hung["env"]["MOCK_HANG_INITIALIZE"] = json!("1");
    let mut config = accounts_config(vec![mock_account("gmail", "working"), hung]);
    config.startup_timeout = Some(std::time::Duration::from_millis(10));
    config.accounts[1].server.startup_timeout = Some(std::time::Duration::from_millis(100));
    hub.apply(vec![config]);
    let server = hub.server("gmail").unwrap();
    wait_account(&server, |state| !matches!(state, ServerState::Starting)).await;
    let usable = matches!(&*server.state(), ServerState::Ready(_));
    let tools = hub.tools().iter().map(|tool| tool.spec().name.clone()).collect::<Vec<_>>();
    let working = call_group(&hub, &server, json!({"account": "gmail"})).await;
    let hung = server.account_server("gmail-2").unwrap();
    wait_account(&hung, |state| matches!(state, ServerState::Failed { .. })).await;
    let failure = hung.state().describe();
    let refused = call_group(&hub, &server, json!({"account": "gmail-2"})).await;
    let still_usable = matches!(&*server.state(), ServerState::Ready(_));
    hub.close_all().await;

    assert!(usable && still_usable);
    assert_eq!(tools, ["mcp__gmail__fixture_0"]);
    assert_eq!(working.unwrap()["content"][0]["text"], "gmail");
    assert!(failure.contains("startup exceeded"));
    assert_eq!(refused.unwrap()["isError"], true);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dropped_account_recovers_on_call_and_on_reconcile() {
    use mixdog_mcp::server::ServerState;
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    let dir = tempfile::tempdir().unwrap();
    let hub = account_hub(dir.path());
    let mut second = mock_account("gmail-2", "two");
    second["env"]["MOCK_TOOLS"] = json!("[\"fixture_0\", \"fixture_1\"]");
    second["env"]["MOCK_FIXTURES"] = json!(json!(["gmail-2", "only-gmail-2"]).to_string());
    let config = accounts_config(vec![mock_account("gmail", "one"), second]);
    hub.apply(vec![config.clone()]);
    let server = hub.server("gmail").unwrap();
    wait_account(&server, |state| matches!(state, ServerState::Ready(_))).await;
    let account = server.account_server("gmail-2").unwrap();
    wait_account(&account, |state| matches!(state, ServerState::Ready(_))).await;
    wait_account(&server, |state| matches!(state, ServerState::Ready(ready) if ready.catalog.entries.len() == 2)).await;
    account.call_tool_settled("", "die_soon", json!({}), &CancellationToken::new(), None).await.unwrap();
    wait_account(&account, |state| matches!(state, ServerState::Failed { .. })).await;
    let tools = hub.tools().iter().map(|tool| tool.spec().name.clone()).collect::<Vec<_>>();
    let answer = call_group(&hub, &server, json!({"account": "gmail-2"})).await;
    let calls = account.call_tool_settled("", "fixture_count", json!({}), &CancellationToken::new(), None).await;
    account.call_tool_settled("", "die_soon", json!({}), &CancellationToken::new(), None).await.unwrap();
    wait_account(&account, |state| matches!(state, ServerState::Failed { .. })).await;
    hub.apply(vec![config]);
    wait_account(&account, |state| matches!(state, ServerState::Ready(_))).await;
    let same_namespace = Arc::ptr_eq(&server, &hub.server("gmail").unwrap());
    hub.close_all().await;

    assert_eq!(tools, ["mcp__gmail__fixture_0", "mcp__gmail__fixture_1"]);
    assert_eq!(answer.unwrap()["content"][0]["text"], "gmail-2");
    assert_eq!(calls.unwrap()["content"][0]["text"], "1");
    assert!(same_namespace);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_approved_account_replaced_under_the_same_name_cannot_receive_the_send() {
    use mixdog_core_api::domain::common::AbsPath;
    use mixdog_core_api::domain::mock::{MockApprovalGate, MockFileService, MockProcessManager, MockProgress};
    use mixdog_core_api::domain::tool::{CallOptions, ConnectorAccountBinding, SurfaceKind, ToolContext, ToolIo};
    use mixdog_mcp::server::ServerState;
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    let dir = tempfile::tempdir().unwrap();
    let hub = account_hub(dir.path());
    hub.apply(vec![accounts_config(vec![mock_account("gmail-2", "original")])]);
    wait_account(&hub.server("gmail").unwrap(), |state| matches!(state, ServerState::Ready(_))).await;
    let chosen = hub.resolve_tool_account("mcp__gmail__fixture_0", &json!({"account": "gmail-2"}), "conversation").await.unwrap().unwrap();
    let (approve, approval) = tokio::sync::oneshot::channel();
    let dispatch = {
        let hub = hub.clone();
        let tokens = mixdog_rt::testing::tokens();
        let ctx = ToolContext {
            call_id: "send".into(),
            thread_id: "conversation".into(),
            turn_id: "turn".into(),
            tool: "mcp__gmail__fixture_0".into(),
            cwd: AbsPath::new(dir.path().to_path_buf()).unwrap(),
            surface: SurfaceKind::Lead,
            cancel: CancellationToken::new(),
            deadline: None,
            progress: Arc::new(MockProgress::default()),
            io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
            approvals: Arc::new(MockApprovalGate::default()),
            files: Arc::new(MockFileService::default()),
            processes: Arc::new(MockProcessManager::default()),
            options: CallOptions { connector_account: Some(ConnectorAccountBinding { name: chosen.name, id: chosen.id }), ..Default::default() },
            review: None,
        };
        tokio::spawn(async move {
            approval.await.unwrap();
            // Like the executor, resolve the current tool only after approval settles.
            hub.tool("mcp__gmail__fixture_0").unwrap().call(&ctx, json!({"account": "gmail-2"})).await
        })
    };
    hub.apply(vec![accounts_config(vec![mock_account("gmail-2", "replacement")])]);
    let server = hub.server("gmail").unwrap();
    wait_account(&server, |state| matches!(state, ServerState::Ready(_))).await;
    let unbound = server.call_tool_settled("conversation", "fixture_0", json!({"account": "gmail-2"}), &CancellationToken::new(), None).await.unwrap();
    approve.send(()).unwrap();
    let refused = dispatch.await.unwrap();
    let calls = server.account_server("gmail-2").unwrap().call_tool_settled("", "fixture_count", json!({}), &CancellationToken::new(), None).await.unwrap();
    hub.close_all().await;
    assert!(refused.unwrap_err().message_for_model.contains("same identity"), "the old approval must not authorize the replacement");
    assert_eq!(unbound["isError"], true);
    assert!(unbound["content"][0]["text"].as_str().unwrap().contains("requires a bound account identity"));
    assert_eq!(calls["content"][0]["text"], "0");
}

fn seeds(names: &[&str]) -> Vec<AccountSeed> {
    names.iter().map(|name| AccountSeed { name: (*name).to_owned(), id: format!("id-{name}"), email: format!("{name}@example.com") }).collect()
}

fn accounts_of(dir: &std::path::Path, names: &[&str]) -> Arc<ConnectorAccounts> {
    let tokens = mixdog_rt::testing::tokens();
    ConnectorAccounts::new("gmail", seeds(names), Arc::new(AccountHealth::default()), dir.to_path_buf(), tokens.maintenance_io).unwrap()
}

#[test]
fn a_connector_tool_name_splits_into_its_server_and_its_tool() {
    assert_eq!(split_mcp_tool_name("mcp__gmail__search_emails"), Some(("gmail".to_owned(), "search_emails".to_owned())));
    assert_eq!(split_mcp_tool_name("search_emails"), None);
    assert_eq!(split_mcp_tool_name(""), None);
}

#[tokio::test]
async fn a_named_account_is_the_one_chosen() {
    let dir = tempfile::tempdir().unwrap();
    let accounts = accounts_of(dir.path(), &["gmail", "gmail-2"]);
    let chosen = accounts.choose(&ChooseCall { tool: "search", wanted: Some("gmail-2"), conversation: "c1" }).await.unwrap();
    assert_eq!(chosen.name, "gmail-2");
    assert_eq!(chosen.id, "id-gmail-2");
    assert_eq!(chosen.label, "gmail-2@example.com");
}

// connector_accounts.rs module doc (1.4.5 connector-accounts-mcp.mjs): the account named, else the one last used in the
// conversation, else the connector's last-used account, else the topmost one.
#[tokio::test(flavor = "multi_thread")]
async fn the_account_last_used_in_a_conversation_is_chosen_when_none_is_named() {
    let dir = tempfile::tempdir().unwrap();
    let accounts = accounts_of(dir.path(), &["gmail", "gmail-2", "gmail-3"]);
    let ask = |conversation| ChooseCall { tool: "search", wanted: None, conversation };
    assert_eq!(accounts.choose(&ask("c1")).await.unwrap().name, "gmail", "nothing remembered: the topmost");
    accounts.remember("gmail-3", "c1").await.unwrap();
    assert_eq!(accounts.choose(&ask("c1")).await.unwrap().name, "gmail-3", "the conversation's own account");
    accounts.remember("gmail-2", "c2").await.unwrap();
    assert_eq!(accounts.choose(&ask("c1")).await.unwrap().name, "gmail-3", "c2's choice does not change c1's");
    assert_eq!(accounts.choose(&ask("c2")).await.unwrap().name, "gmail-2");
    assert_eq!(accounts.choose(&ask("c3")).await.unwrap().name, "gmail-2", "a new conversation takes the connector's last-used account");
    let named = ChooseCall { tool: "search", wanted: Some("gmail"), conversation: "c1" };
    assert_eq!(accounts.choose(&named).await.unwrap().name, "gmail", "a named account wins over the remembered one");
}

#[tokio::test]
async fn an_account_nobody_configured_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let accounts = accounts_of(dir.path(), &["gmail"]);
    let got = accounts.choose(&ChooseCall { tool: "search", wanted: Some("nobody"), conversation: "c1" }).await;
    assert!(matches!(got, Err(AccountError::Refused(_))), "{got:?}");
}
