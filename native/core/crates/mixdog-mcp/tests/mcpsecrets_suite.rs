//! The keychain side of MCP server edits against what today's Node product did
//! (`tests/golden/mcpsecrets.mjs` → `mcpsecrets.json`): which secrets each edit stores, checks or
//! deletes, when a removed server's sign-in is shared, and the keychain account names.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_mcp::config::Env;
use mixdog_mcp::mcp_secrets::McpServerSecrets;
use mixdog_mcp::mcp_secrets::SecretOps;
use mixdog_mcp::mcp_secrets::gmail_app_password_secret_account;
use mixdog_mcp::mcp_secrets::oauth_client_secret_account;
use mixdog_mcp::mcp_secrets::oauth_credential_of;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// Logs each effect the way the recorded fakes did.
struct Ops {
    log: Mutex<Vec<String>>,
    servers: Mutex<Map<String, Value>>,
}

#[async_trait]
impl SecretOps for Ops {
    async fn save_gmail_app_password(&self, email: &str, password: &str) -> Result<(), String> {
        self.log.lock().unwrap().push(format!("gmailSave:{email}:{password}"));
        if password.starts_with("bad") { Err("GMAIL_APP_PASSWORD_REJECTED: no".to_owned()) } else { Ok(()) }
    }

    async fn forget_gmail_app_password(&self, email: &str) -> Result<(), String> {
        self.log.lock().unwrap().push(format!("gmailForget:{email}"));
        Ok(())
    }

    async fn save_oauth_client_secret(&self, url: &str, secret: &str) -> Result<(), String> {
        self.log.lock().unwrap().push(format!("clientSecret:{url}:{secret}"));
        Ok(())
    }

    async fn read_secret(&self, _: &str) -> Result<Option<String>, String> {
        Ok(None)
    }

    async fn write_secret(&self, _: &str, _: Option<&str>) -> Result<(), String> {
        Ok(())
    }

    async fn clear_oauth(&self, cfg: &Value) -> Result<bool, String> {
        let name = cfg.get("name").and_then(Value::as_str).unwrap_or("undefined");
        self.log.lock().unwrap().push(format!("clear:{name}:true"));
        Ok(name == "revoker")
    }

    fn forget_account_health(&self, _: &str) {}

    fn configured_servers(&self) -> Map<String, Value> {
        self.servers.lock().unwrap().clone()
    }
}

fn release(value: Option<mixdog_mcp::mcp_secrets::Release>) -> Value {
    value.map_or(Value::Null, |r| r.to_value())
}

#[tokio::test]
async fn the_secret_handling_does_what_node_does() {
    let golden: Value = serde_json::from_str(include_str!("golden/mcpsecrets.json")).unwrap();
    let env: Env = [("MCPT_HOST".to_owned(), "example.com".to_owned())].into_iter().collect();
    let ops = Arc::new(Ops { log: Mutex::default(), servers: Mutex::default() });
    let secrets = McpServerSecrets::new(ops.clone(), env.clone());
    let mut failures = Vec::new();
    for case in golden["cases"].as_array().unwrap() {
        let (op, a) = (case["op"].as_str().unwrap(), &case["args"]);
        ops.log.lock().unwrap().clear();
        *ops.servers.lock().unwrap() = case["servers"].as_object().cloned().unwrap_or_default();
        let result: Result<Value, String> = match op {
            "storeClient" => secrets.store_oauth_client_secret(&a[0], &a[1], &a[2]).await.map(|()| Value::Null),
            "storeGmail" => secrets.store_gmail_app_password(&a[0], &a[1], a[2].as_bool().unwrap_or(false)).await.map(|()| Value::Null),
            "releaseOAuth" => secrets.release_oauth(&a[0]).await.map(release),
            "forgetUnused" => secrets.forget_unused_gmail_app_password(a[0].as_str().unwrap()).await.map(|b| json!(b)),
            "forgetStored" => secrets.forget_stored_secrets(&a[0]).await.map(|()| Value::Null),
            "releaseAccount" => secrets.release_account(&a[0]).await.map(release),
            "credential" => Ok(oauth_credential_of(&a[0], &env).map_or(Value::Null, Value::String)),
            "secretAccount" => Ok(json!(gmail_app_password_secret_account(a[0].as_str().unwrap()))),
            "clientAccount" => oauth_client_secret_account(a[0].as_str().unwrap()).map(|s| json!(s)),
            other => panic!("unknown op {other}"),
        };
        let label = format!("{op} {a}");
        match (result, case["error"].as_str()) {
            (Err(message), Some(expected)) => {
                if message != expected {
                    failures.push(format!("{label}: error {message:?}, Node {expected:?}"));
                }
            }
            (Ok(value), None) => {
                if value != case["result"] {
                    failures.push(format!("{label}: got {value}, Node {}", case["result"]));
                }
            }
            (other, expected) => failures.push(format!("{label}: got {other:?}, Node error {expected:?}")),
        }
        if json!(*ops.log.lock().unwrap()) != case["log"] {
            failures.push(format!("{label}: effects {:?}, Node {}", ops.log.lock().unwrap(), case["log"]));
        }
    }
    assert!(failures.is_empty(), "{} cases differ:\n{}", failures.len(), failures.iter().take(20).cloned().collect::<Vec<_>>().join("\n"));
}
