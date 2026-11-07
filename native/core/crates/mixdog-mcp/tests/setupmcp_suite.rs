//! The MCP, skills, plugins and connectors `setup` actions against what today's Node product did
//! (`tests/golden/setupmcp.mjs` → `setupmcp.json`): the calls each makes on the runtime and the
//! result it answers (the receipt belongs to the dispatcher).

use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_mcp::setup_actions::SETUP_ACTIONS;
use mixdog_mcp::setup_actions::SetupRuntime;
use mixdog_mcp::setup_actions::run;
use serde_json::Value;
use serde_json::json;

struct Facade {
    status: Value,
    configs: Value,
    plugins: Value,
    calls: Mutex<Vec<Value>>,
}

impl Facade {
    fn record(&self, call: Value) {
        self.calls.lock().unwrap().push(call);
    }
}

#[async_trait]
impl SetupRuntime for Facade {
    async fn add_mcp_server(&self, server: &Value) -> Result<Value, String> {
        self.record(json!(["addMcpServer", server]));
        let name = server["name"].as_str().unwrap_or_default();
        Ok(if name == "nameless" { json!({"status": self.status}) } else { json!({"name": format!("{name}!"), "status": self.status}) })
    }

    async fn save_mcp_server(&self, server: &Value) -> Result<Value, String> {
        self.record(json!(["saveMcpServer", server]));
        let name = if server.get("originalName").is_some_and(|o| o.as_str().is_some_and(|s| !s.is_empty())) { &server["originalName"] } else { &server["name"] };
        let status = if server["name"] == "empty" { json!({}) } else { self.status.clone() };
        Ok(json!({"name": name, "status": status}))
    }

    async fn remove_mcp_server(&self, name: &str) -> Result<Value, String> {
        self.record(json!(["removeMcpServer", name]));
        Ok(self.status.clone())
    }

    async fn set_mcp_server_enabled(&self, name: &str, enabled: bool) -> Result<Value, String> {
        self.record(json!(["setMcpServerEnabled", name, enabled]));
        Ok(json!({}))
    }

    async fn reconnect_mcp(&self, name: Option<&str>) -> Result<Value, String> {
        self.record(json!(["reconnectMcp", name]));
        Ok(self.status.clone())
    }

    async fn mcp_status(&self) -> Result<Value, String> {
        Ok(self.status.clone())
    }

    async fn mcp_server_config(&self, name: &Value) -> Result<Value, String> {
        self.record(json!(["getMcpServerConfig", name]));
        let key = if name.is_null() { String::new() } else { name.as_str().unwrap_or_default().trim().to_owned() };
        self.configs.get(&key).cloned().ok_or_else(|| format!("MCP server not configured: {key}"))
    }

    async fn set_disabled_skills(&self, names: &[String]) -> Result<Value, String> {
        self.record(json!(["setDisabledSkills", names]));
        Ok(json!({"disabled": names}))
    }

    async fn set_extension_scope(&self, kind: &str, name: &str, projects: &[String]) -> Result<Value, String> {
        self.record(json!(["setExtensionScope", kind, name, projects]));
        Ok(match kind {
            "mcp" => self.status.clone(),
            "plugins" => self.plugins.clone(),
            _ if name == "null" => Value::Null,
            _ => json!({"skills": []}),
        })
    }

    async fn add_plugin(&self, source: &str) -> Result<Value, String> {
        self.record(json!(["addPlugin", source]));
        Ok(if source == "none" { json!({}) } else { json!({"plugin": {"id": "x", "source": source}}) })
    }

    async fn update_plugin(&self, name: &str) -> Result<Value, String> {
        self.record(json!(["updatePlugin", name]));
        Ok(if name == "none" { Value::Null } else { json!({"plugin": {"id": name, "updated": true}}) })
    }

    async fn set_plugin_enabled(&self, name: &str, enabled: bool) -> Result<Value, String> {
        self.record(json!(["setPluginEnabled", name, enabled]));
        Ok(json!({"plugin": {"id": name, "enabled": enabled}}))
    }

    async fn remove_plugin(&self, name: &str) -> Result<Value, String> {
        self.record(json!(["removePlugin", name]));
        Ok(json!({"plugin": null}))
    }

    async fn plugins_status(&self) -> Result<Value, String> {
        Ok(self.plugins.clone())
    }

    async fn enable_plugin_mcp(&self, plugin: &Value) -> Result<Value, String> {
        self.record(json!(["enablePluginMcp", plugin]));
        Ok(if plugin["id"] == "p2" {
            json!({"serverName": "s9", "status": {}})
        } else {
            json!({"serverName": "s1", "serverNames": ["s1", "s2"], "status": self.status})
        })
    }
}

#[tokio::test]
async fn every_setup_action_calls_and_answers_what_node_does() {
    let golden: Value = serde_json::from_str(include_str!("golden/setupmcp.json")).unwrap();
    let fixtures = &golden["fixtures"];
    let facade = Facade {
        status: fixtures["STATUS"].clone(),
        configs: fixtures["CONFIGS"].clone(),
        plugins: fixtures["PLUGINS"].clone(),
        calls: Mutex::default(),
    };
    let mut failures = Vec::new();
    for case in golden["cases"].as_array().unwrap() {
        facade.calls.lock().unwrap().clear();
        let args = &case["args"];
        let action = args["action"].as_str().unwrap();
        assert!(SETUP_ACTIONS.contains(&action), "{action} is not served");
        let got = run(action, args, &facade).await;
        let label = format!("{args}");
        match (&got, case["error"].as_str()) {
            (Err(message), Some(expected)) => {
                if message != expected {
                    failures.push(format!("{label}: error {message:?}, Node {expected:?}"));
                }
            }
            (Ok(value), None) => {
                if mixdog_js::json_stringify(value) != mixdog_js::json_stringify(&case["result"]) {
                    failures.push(format!("{label}:\n  got  {value}\n  node {}", case["result"]));
                }
            }
            (other, expected) => failures.push(format!("{label}: got {other:?}, Node error {expected:?}")),
        }
        if json!(*facade.calls.lock().unwrap()) != case["calls"] {
            failures.push(format!("{label}: calls {:?}, Node {}", facade.calls.lock().unwrap(), case["calls"]));
        }
    }
    assert!(failures.is_empty(), "{} cases differ:\n{}", failures.len(), failures.iter().take(20).cloned().collect::<Vec<_>>().join("\n"));
}

/// A setup action's `mcp/*` calls address the session that runs it (`threadId`): the setup tool's
/// `rt.*` calls act on the calling session's runtime in Node. Outside an action nothing is added.
#[tokio::test]
async fn a_setup_action_addresses_the_session_that_runs_it() {
    use std::sync::Arc;

    use mixdog_core_api::CoreError;
    use mixdog_core_api::CoreRequest;
    use mixdog_core_api::DomainService;
    use mixdog_core_api::Reply;
    use mixdog_core_api::ids::ConnectionId;
    use mixdog_core_api::ids::Method;
    use mixdog_core_api::service::Admit;
    use mixdog_mcp::setup_runtime::ServiceSetupRuntime;
    use mixdog_mcp::setup_runtime::as_caller;

    struct Seen(Mutex<Vec<Value>>);
    #[async_trait]
    impl DomainService for Seen {
        fn methods(&self) -> &'static [&'static str] {
            &["mcp/mcpStatus"]
        }
        async fn call(&self, request: CoreRequest) -> Result<Reply, CoreError> {
            self.0.lock().unwrap().push(request.params);
            Ok(Reply::Value(json!({"servers": []})))
        }
        fn notify(&self, _: Method, _: Value, _: ConnectionId) -> Admit {
            Admit::Accepted
        }
    }

    let seen = Arc::new(Seen(Mutex::default()));
    let runtime = ServiceSetupRuntime::new(seen.clone(), seen.clone(), seen.clone());
    as_caller("sess_a", runtime.mcp_status()).await.unwrap();
    runtime.mcp_status().await.unwrap();
    assert_eq!(*seen.0.lock().unwrap(), [json!({"threadId": "sess_a"}), json!({})]);
}