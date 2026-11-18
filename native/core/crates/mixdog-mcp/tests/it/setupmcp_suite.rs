//! The MCP, skills, plugins and connectors setup actions: the input each checks, the calls each makes on the runtime and the
//! result it answers (the receipt belongs to the dispatcher).

use std::sync::Mutex;

use async_trait::async_trait;
#[cfg(node_twin)]
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


#[cfg(node_twin)]
#[tokio::test]
async fn every_setup_action_calls_and_answers_what_node_does() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("tests/golden/setupmcp.json")).unwrap();
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

fn facade() -> Facade {
    Facade {
        status: json!({"connectedCount": 1, "servers": [{"name": "fs", "connected": true, "transport": "stdio", "toolCount": 3, "source": "user"}]}),
        configs: json!({"fs": {"name": "fs", "source": "user", "enabled": true, "config": {"command": "node", "args": ["a", "b"], "env": {"HOME_DIR": "x"}, "url": "https://example.com/mcp?x=1"}}}),
        plugins: json!({"plugins": [{"id": "p1", "name": "plug"}]}),
        calls: Mutex::default(),
    }
}

async fn refusal(action: &str, args: Value) -> String {
    let facade = facade();
    let answer = run(action, &args, &facade).await.unwrap_err();
    assert!(facade.calls.lock().unwrap().is_empty(), "{action} {args}: a refused input reaches no runtime");
    answer
}

#[tokio::test]
async fn an_added_server_needs_a_name_and_a_command_or_a_url() {
    assert_eq!(refusal("add_mcp_server", json!({})).await, "server object is required");
    assert_eq!(refusal("add_mcp_server", json!({"server": {"command": "x"}})).await, "server.name is required");
    assert_eq!(refusal("add_mcp_server", json!({"server": {"name": "a"}})).await, "server.command or server.url is required");
    assert_eq!(refusal("save_mcp_server", json!({"server": {"command": "x"}})).await, "server.name or server.originalName is required");
}

#[tokio::test]
async fn a_server_input_holds_no_credential_values_and_one_transport() {
    assert_eq!(
        refusal("add_mcp_server", json!({"server": {"name": "a", "command": "x", "env": {"API_KEY": "secret"}}})).await,
        "setup: env.API_KEY must use an environment-variable reference, not a credential value"
    );
    assert_eq!(
        refusal("add_mcp_server", json!({"server": {"name": "a", "url": "https://h.example/m", "headers": {"Authorization": "Bearer x"}}})).await,
        "setup: headers.Authorization must use an environment-variable reference, not a credential value"
    );
    assert_eq!(refusal("add_mcp_server", json!({"server": {"name": "a", "url": "https://u:p@h.example/m"}})).await, "MCP URL credentials are not accepted; use environment-variable references");
    assert_eq!(refusal("add_mcp_server", json!({"server": {"name": "a", "url": "https://h.example/m?token=1"}})).await, "MCP URL credentials are not accepted; use environment-variable references");
    assert_eq!(refusal("add_mcp_server", json!({"server": {"name": "a", "url": "ftp://h.example/m"}})).await, "MCP URL must use HTTP(S) or WS(S)");
    assert_eq!(refusal("add_mcp_server", json!({"server": {"name": "a", "command": "x", "url": "https://h.example/m"}})).await, "MCP input must select command or url, not both");
    assert_eq!(refusal("add_mcp_server", json!({"server": {"name": "a", "type": "stdio", "url": "https://h.example/m"}})).await, "stdio requires command, not url");
    assert_eq!(refusal("add_mcp_server", json!({"server": {"name": "a", "type": "http", "command": "x"}})).await, "network MCP transports require url, not command");
}

#[tokio::test]
async fn a_valid_added_server_reaches_the_runtime_and_answers_its_name_and_the_public_rows() {
    let facade = facade();
    let answer = run("add_mcp_server", &json!({"server": {"name": "fs", "command": "node"}}), &facade).await.unwrap();
    assert_eq!(facade.calls.lock().unwrap()[0], json!(["addMcpServer", {"name": "fs", "command": "node"}]));
    assert_eq!(answer["name"], "fs!");
    assert_eq!(
        answer["mcp"],
        json!({"connectedCount": 1, "servers": [{"name": "fs", "enabled": true, "connected": true, "transport": "stdio", "toolCount": 3, "source": "user", "error": null, "scope": null}]})
    );
}

#[tokio::test]
async fn enabling_and_removing_name_the_server_and_enabling_needs_a_boolean() {
    assert_eq!(refusal("remove_mcp_server", json!({})).await, "name is required");
    assert_eq!(refusal("set_mcp_enabled", json!({"name": "fs"})).await, "enabled (boolean) is required");
    assert_eq!(refusal("set_mcp_enabled", json!({"name": "fs", "enabled": "yes"})).await, "enabled (boolean) is required");
    let facade = facade();
    run("set_mcp_enabled", &json!({"name": " fs ", "enabled": false}), &facade).await.unwrap();
    assert_eq!(facade.calls.lock().unwrap()[0], json!(["setMcpServerEnabled", "fs", false]), "the name is trimmed");
}

#[tokio::test]
async fn a_server_description_hides_every_raw_connection_value() {
    let facade = facade();
    let answer = run("get_mcp_server", &json!({"name": "fs"}), &facade).await.unwrap();
    assert_eq!(answer["endpointOrigin"], "https://example.com", "the address is reduced to its origin");
    assert_eq!(answer["argumentCount"], 2);
    assert_eq!(answer["environmentNames"], json!(["HOME_DIR"]));
    assert_eq!(answer["hiddenFields"], json!(["command", "args", "url", "env"]));
    let text = answer.to_string();
    assert!(!text.contains("\"node\"") && !text.contains("?x=1"), "no raw command, argument or query is returned: {text}");
    assert_eq!(answer["type"], "stdio", "a server with no declared type is stdio");
}

#[tokio::test]
async fn an_extension_scope_names_a_known_kind_a_name_and_a_list_of_projects() {
    assert_eq!(refusal("set_extension_scope", json!({"kind": "themes", "name": "x", "projects": []})).await, "kind must be one of skills, mcp, plugins");
    assert_eq!(refusal("set_extension_scope", json!({"kind": "mcp", "projects": []})).await, "name is required");
    assert_eq!(refusal("set_extension_scope", json!({"kind": "mcp", "name": "fs", "projects": "p"})).await, "args.projects.map is not a function");
    assert_eq!(refusal("set_disabled_skills", json!({})).await, "skills (array of names) is required");
}

#[tokio::test]
async fn plugin_actions_need_their_source_or_name_and_answer_the_plugin() {
    assert_eq!(refusal("add_plugin", json!({})).await, "source is required");
    assert_eq!(refusal("update_plugin", json!({})).await, "name is required");
    assert_eq!(refusal("set_plugin_enabled", json!({"name": "p"})).await, "enabled (boolean) is required");
    let facade = facade();
    assert_eq!(run("set_plugin_enabled", &json!({"name": "p", "enabled": true}), &facade).await.unwrap(), json!({"plugin": {"id": "p", "enabled": true}}));
    assert_eq!(run("remove_plugin", &json!({"name": "p"}), &facade).await.unwrap(), json!({"plugin": null}));
}

#[tokio::test]
async fn enabling_a_plugins_servers_finds_the_plugin_by_name_or_id() {
    assert_eq!(refusal("enable_plugin_mcp", json!({"name": "unknown"})).await, "plugin \"unknown\" not found");
    let facade = facade();
    let answer = run("enable_plugin_mcp", &json!({"name": "plug"}), &facade).await.unwrap();
    assert_eq!(facade.calls.lock().unwrap()[0], json!(["enablePluginMcp", {"id": "p1", "name": "plug"}]));
    assert_eq!(answer["serverName"], "s1");
    assert_eq!(answer["serverNames"], json!(["s1", "s2"]));
}

#[tokio::test]
async fn an_unknown_action_and_an_unknown_connector_are_refused() {
    assert_eq!(refusal("teleport", json!({})).await, "setup: teleport is not an MCP, skills, plugins or connectors action");
    assert!(refusal("connect_connector", json!({"connector": "nope"})).await.starts_with("connector must be one of "));
    assert_eq!(refusal("connect_connector", json!({})).await, "connector is required");
}