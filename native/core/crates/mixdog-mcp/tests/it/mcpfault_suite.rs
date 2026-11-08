//! Faults injected into the MCP service: a config save that fails after the secrets were written,
//! a release that fails among several, and a rollback that fails. They do not depend on what
//! today's Node product recorded (the first is a defect Node has and this port fixes), so they
//! run on every platform.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::Method;
use mixdog_mcp::extension_service::ExtensionConfig;
use mixdog_mcp::extension_service::ExtensionHost;
use mixdog_mcp::mcp_secrets::McpServerSecrets;
use mixdog_mcp::mcp_secrets::SecretOps;
use mixdog_mcp::mcp_secrets::gmail_app_password_secret_account;
use mixdog_mcp::mcp_secrets::oauth_client_secret_account;
use mixdog_mcp::mcp_service::McpRuntime;
use mixdog_mcp::mcp_service::McpService;
use mixdog_mcp::mcp_service::OAuthState;
use mixdog_mcp::plugin_servers::Catalog;
use mixdog_mcp::plugin_servers::resolve_mcp_server_catalog;
use mixdog_mcp::scope_runtime::request_scope;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

const WEB: &str = "https://web.example/mcp";

struct Config {
    agent: Mutex<Map<String, Value>>,
    fail_save: AtomicBool,
}

#[async_trait]
impl ExtensionConfig for Config {
    fn agent(&self) -> Map<String, Value> {
        self.agent.lock().unwrap().clone()
    }

    async fn save_agent(&self, _: &Map<String, Value>, after: &Map<String, Value>) -> Result<(), String> {
        if self.fail_save.load(Ordering::SeqCst) {
            return Err("disk full".to_owned());
        }
        *self.agent.lock().unwrap() = after.clone();
        Ok(())
    }

    fn set_disabled_skills(&self, _: &[String]) {}
}

struct Host {
    /// The failure of the working-folder read, when the test switches one on.
    cwd_error: Option<&'static str>,
    /// Each host call a request made, with the scope the request was running for (`request_scope()`).
    seen: Mutex<Vec<(&'static str, Option<String>)>>,
}

#[async_trait]
impl ExtensionHost for Host {
    async fn reconcile_plugins_and_announce(&self) {}
    async fn announce(&self, _: &str) {}
    async fn announce_without_invalidating(&self, _: &str) {}

    async fn tool_names(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }

    async fn reconnect_mcp_and_announce(&self, only: Option<&str>, _: bool, _: &[String]) -> Value {
        json!({"reconnected": only})
    }

    async fn reconnect_all_mcp_and_announce(&self) -> Value {
        self.seen.lock().unwrap().push(("reconnect_all", request_scope()));
        json!({})
    }

    async fn schedule_mcp_toggle(&self, _: &str, _: bool) -> Value {
        json!({})
    }

    async fn publish_mcp_changes(&self, _: &[(String, bool)]) {}
    async fn announce_mcp_changes(&self, _: &[(String, bool)]) {}

    async fn connect_configured_mcp(&self, _: &str, _: bool) -> Value {
        json!({})
    }

    fn invalidate_skills(&self) {}
    async fn flush_skills_save(&self) {}

    async fn current_cwd(&self, _: Option<&str>) -> Result<PathBuf, String> {
        self.seen.lock().unwrap().push(("current_cwd", request_scope()));
        match self.cwd_error {
            Some(message) => Err(message.to_owned()),
            None => Ok(std::env::temp_dir()),
        }
    }

    async fn plugin_mcp_summary(&self, _: Option<&str>) -> Result<Value, String> {
        Ok(Value::Object(Map::new()))
    }

    async fn skills_status(&self, _: Option<&str>) -> Value {
        Value::Null
    }
}

struct Runtime(Arc<Config>);

#[async_trait]
impl McpRuntime for Runtime {
    /// Every thread holds a scope of its own name here; the control session holds none.
    async fn scope_of_request(&self, thread: Option<&str>) -> Result<Option<String>, String> {
        Ok(thread.map(|thread| format!("scope-of-{thread}")))
    }

    async fn catalog(&self) -> Catalog {
        resolve_mcp_server_catalog(&Value::Object(self.0.agent()), &[], "", "")
    }

    async fn status(&self) -> Value {
        json!({"servers": []})
    }

    async fn server_config(&self, name: &str) -> Result<Value, String> {
        Err(format!("MCP server not configured: {name}"))
    }

    async fn plugins_status(&self) -> Value {
        json!({"plugins": []})
    }

    async fn await_keychain_prewarm(&self) {}
    async fn reload_full_config(&self) {}

    async fn oauth_state(&self, _: &Value) -> Option<OAuthState> {
        None
    }

    async fn begin_login(&self, _: &str, _: &Value) -> Result<Value, String> {
        Err("unused".to_owned())
    }

    async fn login_status(&self, _: &str, _: &Value) -> Result<Value, String> {
        Err("unused".to_owned())
    }

    async fn cancel_login(&self, _: &str) -> Result<Value, String> {
        Err("unused".to_owned())
    }

    async fn complete_login(&self, _: &str, _: &str) -> Result<Value, String> {
        Err("unused".to_owned())
    }

    async fn guard_sign_out(&self, _: &str) -> Box<dyn Send> {
        Box::new(())
    }

    async fn clear_oauth(&self, _: &Value) -> Result<bool, String> {
        Ok(false)
    }

    fn forget_account_health(&self, _: &str) {}

    async fn probe_auth(&self, _: &Value) -> Result<Value, String> {
        Err("unused".to_owned())
    }

    fn tools(&self) -> Vec<Value> {
        Vec::new()
    }
}

/// An in-memory keychain with the faults the tests switch on.
struct Ops {
    config: Arc<Config>,
    keychain: Mutex<BTreeMap<String, String>>,
    /// Accounts (by name) whose sign-in release fails.
    failing_release: Mutex<Vec<String>>,
    /// Accounts (by name) whose sign-in release waits for `gate` before it does anything.
    stalled_release: Mutex<Vec<String>>,
    gate: tokio::sync::Notify,
    released: Mutex<Vec<String>>,
    fail_gmail_forget: AtomicBool,
}

impl Ops {
    fn kept(&self, account: &str) -> Option<String> {
        self.keychain.lock().unwrap().get(account).cloned()
    }
}

#[async_trait]
impl SecretOps for Ops {
    async fn save_gmail_app_password(&self, email: &str, password: &str) -> Result<(), String> {
        self.keychain.lock().unwrap().insert(gmail_app_password_secret_account(email), password.to_owned());
        Ok(())
    }

    async fn forget_gmail_app_password(&self, email: &str) -> Result<(), String> {
        if self.fail_gmail_forget.load(Ordering::SeqCst) {
            return Err("keychain locked".to_owned());
        }
        self.keychain.lock().unwrap().remove(&gmail_app_password_secret_account(email));
        Ok(())
    }

    async fn save_oauth_client_secret(&self, url: &str, secret: &str) -> Result<(), String> {
        let account = oauth_client_secret_account(url)?;
        if secret.is_empty() {
            self.keychain.lock().unwrap().remove(&account);
        } else {
            self.keychain.lock().unwrap().insert(account, secret.to_owned());
        }
        Ok(())
    }

    async fn read_secret(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self.kept(account))
    }

    async fn write_secret(&self, account: &str, value: Option<&str>) -> Result<(), String> {
        match value {
            Some(value) => self.keychain.lock().unwrap().insert(account.to_owned(), value.to_owned()),
            None => self.keychain.lock().unwrap().remove(account),
        };
        Ok(())
    }

    async fn clear_oauth(&self, cfg: &Value) -> Result<bool, String> {
        let name = cfg["name"].as_str().unwrap_or_default().to_owned();
        // A keychain call yields before it answers.
        tokio::task::yield_now().await;
        if self.stalled_release.lock().unwrap().contains(&name) {
            self.gate.notified().await;
        }
        self.released.lock().unwrap().push(name.clone());
        if self.failing_release.lock().unwrap().contains(&name) { Err(format!("cannot revoke {name}")) } else { Ok(true) }
    }

    fn forget_account_health(&self, _: &str) {}

    fn configured_servers(&self) -> Map<String, Value> {
        resolve_mcp_server_catalog(&Value::Object(self.config.agent()), &[], "", "").servers
    }
}

struct Fixture {
    host: Arc<Host>,
    service: McpService,
    config: Arc<Config>,
    ops: Arc<Ops>,
    _home: tempfile::TempDir,
}

fn fixture(servers: Value) -> Fixture {
    fixture_over(servers, Host { cwd_error: None, seen: Mutex::default() })
}

fn fixture_over(servers: Value, host: Host) -> Fixture {
    let home = tempfile::tempdir().unwrap();
    let mut agent = Map::new();
    agent.insert("mcpServers".to_owned(), servers);
    let config = Arc::new(Config { agent: Mutex::new(agent), fail_save: AtomicBool::new(false) });
    let ops = Arc::new(Ops {
        config: Arc::clone(&config),
        keychain: Mutex::default(),
        failing_release: Mutex::default(),
        stalled_release: Mutex::default(),
        gate: tokio::sync::Notify::new(),
        released: Mutex::default(),
        fail_gmail_forget: AtomicBool::new(false),
    });
    let secrets = Arc::new(McpServerSecrets::new(ops.clone(), Default::default()));
    let host = Arc::new(host);
    let service = McpService::new(config.clone(), host.clone(), Arc::new(Runtime(Arc::clone(&config))), secrets, home.path().join("home"));
    Fixture { host, service, config, ops, _home: home }
}

async fn call(f: &Fixture, method: &'static str, params: Value) -> Result<Value, String> {
    let request = CoreRequest { method: Method(method), params, op: None, ctx: CallContext::internal("test") };
    match f.service.call(request).await {
        Ok(Reply::Value(value)) => Ok(value),
        Ok(_) => Err("not a value".to_owned()),
        Err(CoreError::DomainError { message: Some(message), .. }) => Err(message.to_string()),
        Err(other) => Err(other.to_string()),
    }
}

fn web_server() -> Value {
    json!({"web": {"type": "http", "url": WEB, "oauthClientId": "old"}})
}

fn edit_client(secret: &str) -> Value {
    json!({"input": {"originalName": "web", "name": "web", "url": WEB, "oauthClientId": "new", "oauthClientSecret": secret}})
}

#[tokio::test]
async fn a_save_that_fails_leaves_the_client_secret_it_found() {
    let f = fixture(web_server());
    let account = oauth_client_secret_account(WEB).unwrap();
    f.ops.keychain.lock().unwrap().insert(account.clone(), "old-secret".to_owned());
    f.config.fail_save.store(true, Ordering::SeqCst);

    assert_eq!(call(&f, "mcp/saveMcpServer", edit_client("new-secret")).await.unwrap_err(), "disk full");
    assert_eq!(f.ops.kept(&account).as_deref(), Some("old-secret"));
    assert_eq!(f.config.agent()["mcpServers"]["web"]["oauthClientId"], "old");

    // The same save with the disk working takes the new pair.
    f.config.fail_save.store(false, Ordering::SeqCst);
    call(&f, "mcp/saveMcpServer", edit_client("new-secret")).await.unwrap();
    assert_eq!(f.ops.kept(&account).as_deref(), Some("new-secret"));
    assert_eq!(f.config.agent()["mcpServers"]["web"]["oauthClientId"], "new");
}

#[tokio::test]
async fn a_failed_save_does_not_leave_a_secret_that_was_never_there() {
    let f = fixture(json!({"web": {"type": "http", "url": WEB}}));
    f.config.fail_save.store(true, Ordering::SeqCst);
    assert_eq!(call(&f, "mcp/saveMcpServer", edit_client("fresh")).await.unwrap_err(), "disk full");
    assert_eq!(f.ops.kept(&oauth_client_secret_account(WEB).unwrap()), None);
}

#[tokio::test]
async fn a_failed_release_is_reported_at_once_and_the_others_still_run() {
    let account = |name: &str, key: &str| json!({"name": name, "url": "https://mcp.notion.com/mcp", "oauthKey": key});
    let f = fixture(json!({"hub": {"type": "http", "url": "https://mcp.notion.com/accounts", "connector": "notion", "accounts": [account("notion", "k1"), account("notion-2", "k2"), account("notion-3", "k3")]}}));
    f.ops.failing_release.lock().unwrap().push("notion".to_owned());
    // The second account's release hangs until the gate opens.
    f.ops.stalled_release.lock().unwrap().push("notion-2".to_owned());

    // `Promise.all`: the failure comes back while a release is still pending (bounded: the
    // call gets a thousand turns of the scheduler, then the test fails instead of hanging).
    let outcome = tokio::select! {
        outcome = call(&f, "mcp/removeMcpServer", json!({"name": "hub"})) => Some(outcome),
        () = async { for _ in 0..1000 { tokio::task::yield_now().await } } => None,
    };
    assert_eq!(outcome.expect("the failure waited for the stalled release").unwrap_err(), "cannot revoke notion");
    assert!(!f.ops.released.lock().unwrap().contains(&"notion-2".to_owned()));
    // The server itself is gone: the failure is about the sign-ins left behind.
    assert!(f.config.agent()["mcpServers"].get("hub").is_none());

    // The release that was left running still finishes once it can.
    f.ops.gate.notify_one();
    for _ in 0..1000 {
        if f.ops.released.lock().unwrap().len() == 3 {
            break;
        }
        tokio::task::yield_now().await;
    }
    let mut released = f.ops.released.lock().unwrap().clone();
    released.sort();
    assert_eq!(released, ["notion", "notion-2", "notion-3"]);
}

/// A working folder that cannot be read (the read never ran) is the caller's error, not the process folder.
#[tokio::test]
async fn a_working_folder_that_cannot_be_read_is_the_failure_reported() {
    let f = fixture_over(json!({}), Host { cwd_error: Some("the interactive lane is full"), seen: Mutex::default() });
    assert_eq!(call(&f, "mcp/mcpStatus", json!({})).await.unwrap_err(), "the interactive lane is full");
}

#[tokio::test]
async fn a_rollback_that_fails_is_the_failure_reported() {
    let add = json!({"input": {"connector": "gmail", "email": "a@example.com", "appPassword": "abcdefghijklmnop"}});
    let f = fixture(json!({}));
    f.config.fail_save.store(true, Ordering::SeqCst);
    // The rollback works: the save's own failure comes back and the password is gone again.
    assert_eq!(call(&f, "connector/addConnectorAccount", add.clone()).await.unwrap_err(), "disk full");
    assert_eq!(f.ops.kept(&gmail_app_password_secret_account("a@example.com")), None);

    // The rollback fails too: that failure is what the caller gets, as in Node.
    f.ops.fail_gmail_forget.store(true, Ordering::SeqCst);
    assert_eq!(call(&f, "connector/addConnectorAccount", add).await.unwrap_err(), "keychain locked");
}

/// A management request runs under the scope its `threadId` resolves to (`McpRuntime::scope_of_request`), so
/// the MCP glue reads and changes that scope; one that names no thread runs for the control session.
#[tokio::test]
async fn a_management_request_runs_under_the_scope_its_thread_resolves_to() {
    let f = fixture(json!({}));
    call(&f, "mcp/mcpStatus", json!({"threadId": "t1"})).await.unwrap();
    call(&f, "mcp/reconnectMcp", json!({"threadId": "t2"})).await.unwrap();
    call(&f, "mcp/reconnectMcp", json!({})).await.unwrap();
    let seen = f.host.seen.lock().unwrap().clone();
    assert_eq!(
        seen,
        vec![("current_cwd", Some("scope-of-t1".to_owned())), ("reconnect_all", Some("scope-of-t2".to_owned())), ("reconnect_all", None)]
    );
}