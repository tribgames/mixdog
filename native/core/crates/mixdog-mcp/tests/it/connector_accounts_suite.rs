//! The connector account choice replayed against what today's Node product answered
//! (`tests/golden/accounts.mjs` → `accounts.json`).
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

fn golden() -> Value {
    serde_json::from_str(include_str!("../golden/accounts.json")).unwrap()
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect()
}

#[test]
fn tool_names_split_as_node_splits_them() {
    for case in golden()["names"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let expected = strings(&case["parts"]);
        let got = split_mcp_tool_name(name).map(|(server, tool)| vec![server, tool]).unwrap_or_default();
        assert_eq!(got, expected, "{name:?}");
    }
}

#[tokio::test]
async fn the_account_choice_matches_node_in_every_recorded_scenario() {
    let tokens = mixdog_rt::testing::tokens();
    for scenario in golden()["scenarios"].as_array().unwrap() {
        let label = scenario["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let health = Arc::new(AccountHealth::default());
        let seeds = scenario["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| AccountSeed {
                name: a["name"].as_str().unwrap().to_owned(),
                id: a["id"].as_str().unwrap().to_owned(),
                email: a["email"].as_str().unwrap().to_owned(),
            })
            .collect();
        let accounts = ConnectorAccounts::new(
            scenario["connector"].as_str().unwrap(),
            seeds,
            Arc::clone(&health),
            dir.path().to_path_buf(),
            tokens.maintenance_io,
        )
        .unwrap();
        for (at, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            let here = format!("{label} / step {at}");
            match step["op"].as_str().unwrap() {
                "init" => {
                    for a in scenario["accounts"].as_array().unwrap() {
                        let name = a["name"].as_str().unwrap();
                        if a["authRequired"].as_bool().unwrap() {
                            accounts.record(name, &AccountReport { error: "needs sign-in".to_owned(), auth_required: true, ..AccountReport::default() });
                        } else {
                            accounts.note_tools(name, strings(&a["tools"]));
                            accounts.record(name, &AccountReport::default());
                        }
                    }
                    accounts.set_listed(strings(&step["listed"]));
                }
                "state" | "backup" => {
                    let file = match step["file"].as_str().unwrap() {
                        "in-use" => "connector-accounts-in-use.json",
                        _ => "connector-accounts-by-conversation.json",
                    };
                    let suffix = if step["op"] == "backup" { ".bak" } else { "" };
                    std::fs::write(dir.path().join(format!("{file}{suffix}")), step["raw"].as_str().unwrap()).unwrap();
                }
                "choose" => {
                    let wanted = step.get("wanted").and_then(Value::as_str);
                    let call = ChooseCall { tool: step["tool"].as_str().unwrap(), wanted, conversation: step["conversation"].as_str().unwrap() };
                    let got = accounts.choose(&call).await;
                    match (&got, &step["expect"]) {
                        (Ok(chosen), expect) if expect.get("ok").is_some() => {
                            assert_eq!(chosen.name, expect["ok"]["name"].as_str().unwrap(), "{here}");
                            assert_eq!(chosen.label, expect["ok"]["label"].as_str().unwrap(), "{here}");
                        }
                        (Err(AccountError::Refused(message)), expect) if expect.get("error").is_some() => {
                            assert_eq!(message, expect["error"].as_str().unwrap(), "{here}");
                        }
                        other => panic!("{here}: got {other:?}, Node answered {}", step["expect"]),
                    }
                }
                other => panic!("unknown op {other}"),
            }
        }
        let quarantined = std::fs::read_dir(dir.path())
            .unwrap()
            .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().contains(".corrupt-"))
            .count();
        assert_eq!(quarantined as u64, scenario["leftover"].as_u64().unwrap(), "{label}: damaged files moved aside");
    }
}

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

#[tokio::test(flavor = "multi_thread")]
async fn three_connector_accounts_publish_one_toolset_and_route_the_selected_account() {
    use mixdog_mcp::{McpHub, McpIo, McpServerConfig};
    use mixdog_mcp::connector_transport::AccountRuntime;
    use mixdog_mcp::result::OutputPolicy;
    use mixdog_mcp::server::ServerState;
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let hub = McpHub::new(
        McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk },
        dir.path().join("artifacts"), OutputPolicy::default(),
    );
    hub.set_account_runtime(AccountRuntime {
        health: Arc::new(AccountHealth::default()), data_dir: dir.path().to_path_buf(), maintenance: tokens.maintenance_io,
    });
    let accounts: Vec<Value> = ["gmail", "gmail-2", "gmail-3"].iter().map(|name| json!({
        "name": name, "id": format!("identity-{name}"), "type": "stdio",
        "command": env!("CARGO_BIN_EXE_mixdog-mcp-mock-server"),
        "env": {"MOCK_TOOLS": "[\"fixture_0\"]", "MOCK_FIXTURES": json!([name]).to_string()}
    })).collect();
    let config = McpServerConfig::from_entry("gmail", &json!({
        "type": "http", "url": "https://connectors.mixdog.invalid/gmail/mcp", "connector": "gmail", "accounts": accounts,
    }), &std::env::vars().collect()).unwrap();
    hub.apply(vec![config]);
    let server = hub.server("gmail").unwrap();
    let mut state = server.subscribe();
    tokio::time::timeout(std::time::Duration::from_secs(60), state.wait_for(|state| !matches!(**state, ServerState::Starting)))
        .await.unwrap().unwrap();
    let tools = hub.tools();
    assert_eq!(tools.iter().map(|tool| tool.spec().name.as_str()).collect::<Vec<_>>(), ["mcp__gmail__fixture_0"]);
    assert_eq!(tools[0].spec().input_schema["properties"]["account"]["type"], "string");
    let chosen = hub.resolve_tool_account("mcp__gmail__fixture_0", &json!({"account": "gmail-3"}), "conversation").await.unwrap().unwrap();
    assert_eq!(chosen.name, "gmail-3");
    let result = call_group(&hub, &server, json!({"text": "hello", "account": "gmail-3"})).await.unwrap();
    assert_eq!(result["content"][0]["text"], "gmail-3");
    assert_eq!(result["content"][1]["text"], "(Gmail account: gmail-3)");
    let remembered = hub.resolve_tool_account("mcp__gmail__fixture_0", &json!({}), "conversation").await.unwrap().unwrap();
    assert_eq!(remembered.name, "gmail-3");
    let received = server.account_server("gmail-3").unwrap()
        .call_tool_settled("", "fixture_args", json!({}), &CancellationToken::new(), None).await.unwrap();
    assert_eq!(serde_json::from_str::<Value>(received["content"][0]["text"].as_str().unwrap()).unwrap(), json!([{"text": "hello"}]));
    for name in ["gmail", "gmail-2", "gmail-3"] {
        wait_account(&server.account_server(name).unwrap(), |state| matches!(state, ServerState::Ready(_))).await;
    }
    let expected = "Accounts: gmail, gmail-2, gmail-3. `account` picks one; left out, a call uses the account used last, and its result names it.\n\nmock instructions";
    wait_account(&server, |state| matches!(state, ServerState::Ready(ready) if ready.instructions.as_deref() == Some(expected))).await;
    let state = server.state();
    let ServerState::Ready(ready) = &*state else { panic!("connector not ready") };
    assert_eq!(ready.instructions.as_deref(), Some("Accounts: gmail, gmail-2, gmail-3. `account` picks one; left out, a call uses the account used last, and its result names it.\n\nmock instructions"));
    hub.close_all().await;
}

fn account_hub(dir: &std::path::Path) -> Arc<mixdog_mcp::McpHub> {
    let tokens = mixdog_rt::testing::tokens();
    let hub = mixdog_mcp::McpHub::new(
        mixdog_mcp::McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk },
        dir.join("artifacts"), mixdog_mcp::result::OutputPolicy::default(),
    );
    hub.set_account_runtime(mixdog_mcp::connector_transport::AccountRuntime {
        health: Arc::new(AccountHealth::default()), data_dir: dir.to_path_buf(), maintenance: tokens.maintenance_io,
    });
    hub
}

fn mock_account(name: &str, id: &str) -> Value {
    serde_json::json!({
        "name": name, "id": id, "type": "stdio", "command": env!("CARGO_BIN_EXE_mixdog-mcp-mock-server"),
        "env": {"MOCK_TOOLS": "[\"fixture_0\"]", "MOCK_FIXTURES": serde_json::json!([name]).to_string()}
    })
}

fn accounts_config(accounts: Vec<Value>) -> mixdog_mcp::McpServerConfig {
    mixdog_mcp::McpServerConfig::from_entry("gmail", &serde_json::json!({
        "type": "http", "url": "https://connectors.mixdog.invalid/gmail/mcp", "connector": "gmail", "accounts": accounts,
    }), &std::env::vars().collect()).unwrap()
}

async fn wait_account(server: &mixdog_mcp::McpServer, wanted: impl Fn(&mixdog_mcp::server::ServerState) -> bool) {
    let mut state = server.subscribe();
    tokio::time::timeout(std::time::Duration::from_secs(60), state.wait_for(|state| wanted(state))).await.unwrap().unwrap();
}

async fn call_group(hub: &mixdog_mcp::McpHub, server: &mixdog_mcp::McpServer, args: Value) -> Result<Value, mixdog_mcp::server::CallError> {
    let chosen = hub.resolve_tool_account("mcp__gmail__fixture_0", &args, "conversation").await
        .map_err(|error| mixdog_mcp::server::CallError::Recovery { message: error.to_string(), outcome_unknown: false })?.unwrap();
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
            call_id: "send".into(), thread_id: "conversation".into(), turn_id: "turn".into(), tool: "mcp__gmail__fixture_0".into(),
            cwd: AbsPath::new(dir.path().to_path_buf()).unwrap(), surface: SurfaceKind::Lead, cancel: CancellationToken::new(), deadline: None,
            progress: Arc::new(MockProgress::default()),
            io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
            approvals: Arc::new(MockApprovalGate::default()), files: Arc::new(MockFileService::default()), processes: Arc::new(MockProcessManager::default()),
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
    let calls = server.account_server("gmail-2").unwrap()
        .call_tool_settled("", "fixture_count", json!({}), &CancellationToken::new(), None).await.unwrap();
    hub.close_all().await;
    assert!(refused.unwrap_err().message_for_model.contains("same identity"), "the old approval must not authorize the replacement");
    assert_eq!(unbound["isError"], true);
    assert!(unbound["content"][0]["text"].as_str().unwrap().contains("requires a bound account identity"));
    assert_eq!(calls["content"][0]["text"], "0");
}
