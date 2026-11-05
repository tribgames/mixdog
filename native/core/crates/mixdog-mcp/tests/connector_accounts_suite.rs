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
    serde_json::from_str(include_str!("golden/accounts.json")).unwrap()
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
