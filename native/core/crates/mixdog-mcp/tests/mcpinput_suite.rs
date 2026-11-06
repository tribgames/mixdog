//! The pure MCP server helpers against what today's Node product answered
//! (`tests/golden/mcpinput.mjs` → `mcpinput.json`): the editor input normalizer, the partial-edit
//! merges, and the connector account model. The golden carries Windows paths (the working folder
//! and home), so the replay runs only there.
#![cfg(windows)]

use std::path::Path;

use mixdog_mcp::connector_model::*;
use mixdog_mcp::connectors::connector;
use mixdog_mcp::mcp_server_input::*;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

fn mask(base: &str, text: &str) -> String {
    let escaped = serde_json::to_string(base).unwrap();
    text.replace(&escaped[1..escaped.len() - 1], "<BASE>")
}

fn unmask(base: &str, value: &Value) -> Value {
    let escaped = serde_json::to_string(base).unwrap();
    serde_json::from_str(&value.to_string().replace("<BASE>", &escaped[1..escaped.len() - 1])).unwrap()
}

fn map(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

fn run(base: &str, fn_name: &str, a: &Value) -> Result<Value, String> {
    let cwd = Path::new(base).join("work");
    let home = Path::new(base).join("home");
    Ok(match fn_name {
        "normalize" => {
            let (name, config) = normalize_mcp_server_input(a, &cwd, &home)?;
            json!({"name": name, "config": config})
        }
        "merge" => merge_mcp_server_config(&a[0], &a[1]),
        "mergedInput" => merged_server_input(&a[0], &a[1], text(&a[2])),
        "accountTarget" => match account_target(&map(&a[0]), text(&a[1])) {
            Some(t) => json!({"serverName": t.server_name, "cfg": t.cfg, "account": t.account, "accountCfg": t.account_cfg}),
            None => Value::Null,
        },
        "nameTaken" => json!(name_taken_message(&map(&a[0]), text(&a[1]))),
        "accountsOf" => Value::Array(accounts_of(&a[0])),
        "accountServers" => Value::Array(account_servers(&a[0])),
        "liveAccountServers" => Value::Array(live_account_servers(&a[0])),
        "serverSettings" => Value::Object(server_settings(&a[0])),
        "connectorOfServer" => json!(connector_of_server(&a[0]).map_or("", |c| c.id)),
        "gmailAppPasswordAccount" => json!(gmail_app_password_account(&a[0])),
        "withAccountEnabled" => with_account_enabled(&a[0], text(&a[1]), a[2].as_bool().unwrap_or(false)),
        "accountEntry" => account_entry("nm", &a[0]),
        "accountsUrl" => json!(accounts_url(text(&a[0]))),
        "gmailAddress" => json!(gmail_address(&a[0])),
        "gmailPassword" => json!(gmail_app_password_value(&a[0])),
        "gmailServerInput" => gmail_app_password_server_input(text(&a[0]), &a[1], &a[2])?,
        "connectorServerInput" => {
            let entry = connector(text(&a[0])).ok_or("unknown connector")?;
            connector_server_input(entry, "nm", &a[1])?
        }
        other => panic!("unknown function {other}"),
    })
}

#[test]
fn the_pure_server_helpers_answer_what_node_does() {
    let golden: Value = serde_json::from_str(include_str!("golden/mcpinput.json")).unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let base = scratch.path().to_string_lossy().into_owned();
    let mut failures = Vec::new();
    for case in golden["cases"].as_array().unwrap() {
        let fn_name = text(&case["fn"]);
        let args = unmask(&base, &case["args"]);
        let got = run(&base, fn_name, &args);
        let label = format!("{fn_name} {}", case["args"]);
        match (got, case["error"].as_str()) {
            (Err(message), Some(expected)) => {
                if mask(&base, &message) != expected {
                    failures.push(format!("{label}: error {message:?}, Node {expected:?}"));
                }
            }
            (Ok(value), None) => {
                let got = serde_json::from_str::<Value>(&mask(&base, &value.to_string())).unwrap();
                // Key order matters for stored config, so compare the text JSON.stringify writes.
                if mixdog_js::json_stringify(&got) != mixdog_js::json_stringify(&case["result"]) {
                    failures.push(format!("{label}:\n  got  {got}\n  node {}", case["result"]));
                }
            }
            (other, expected) => failures.push(format!("{label}: got {other:?}, Node error {expected:?}")),
        }
    }
    assert!(failures.is_empty(), "{} cases differ:\n{}", failures.len(), failures.iter().take(20).cloned().collect::<Vec<_>>().join("\n"));
}
