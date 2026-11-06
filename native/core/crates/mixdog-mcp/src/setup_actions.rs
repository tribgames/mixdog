//! The `setup` tool actions that change MCP servers, skills, plugins and connectors (Node
//! `session-runtime/setup-tool/executor.mjs` `SETUP_ACTION_HANDLERS`, the MCP part of
//! `extended-actions.mjs`, and the `mcp` status rows): input checks, the call into the runtime,
//! and the public shape of the answer.
//!
//! The `setup` dispatcher (validation of the tool input, the caller-scope rules, the receipt)
//! belongs to `mixdog-core`; it routes the action names in [`SETUP_ACTIONS`] to [`run`], with a
//! [`SetupRuntime`] over the services of this crate. A handler answers the result the receipt
//! wraps.

use async_trait::async_trait;
use mixdog_js::JsRegex;
use mixdog_js::to_number;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::connectors::CATALOG;
use crate::connectors::Backend;
use crate::connectors::connector;
use crate::plugin_admin::clean;
use crate::plugin_admin::truthy;

/// The action names [`run`] serves.
pub const SETUP_ACTIONS: &[&str] = &[
    "add_mcp_server",
    "save_mcp_server",
    "remove_mcp_server",
    "set_mcp_enabled",
    "reconnect_mcp",
    "get_mcp_server",
    "set_disabled_skills",
    "set_extension_scope",
    "add_plugin",
    "update_plugin",
    "set_plugin_enabled",
    "remove_plugin",
    "connect_connector",
    "enable_plugin_mcp",
];

/// What the actions ask of the runtime (Node's `rt` facade): the answers are the services' own
/// replies, and a failure is the message Node's error carries.
#[async_trait]
pub trait SetupRuntime: Send + Sync {
    async fn add_mcp_server(&self, input: &Value) -> Result<Value, String>;
    async fn save_mcp_server(&self, input: &Value) -> Result<Value, String>;
    async fn remove_mcp_server(&self, name: &str) -> Result<Value, String>;
    async fn set_mcp_server_enabled(&self, name: &str, enabled: bool) -> Result<Value, String>;
    async fn reconnect_mcp(&self, name: Option<&str>) -> Result<Value, String>;
    /// `mcpStatus()`.
    async fn mcp_status(&self) -> Result<Value, String>;
    /// `getMcpServerConfig(name)`; `name` as the caller gave it.
    async fn mcp_server_config(&self, name: &Value) -> Result<Value, String>;
    async fn set_disabled_skills(&self, names: &[String]) -> Result<Value, String>;
    async fn set_extension_scope(&self, kind: &str, name: &str, projects: &[String]) -> Result<Value, String>;
    async fn add_plugin(&self, source: &str) -> Result<Value, String>;
    async fn update_plugin(&self, name: &str) -> Result<Value, String>;
    async fn set_plugin_enabled(&self, name: &str, enabled: bool) -> Result<Value, String>;
    async fn remove_plugin(&self, name: &str) -> Result<Value, String>;
    /// `pluginsStatus()`.
    async fn plugins_status(&self) -> Result<Value, String>;
    async fn enable_plugin_mcp(&self, plugin: &Value) -> Result<Value, String>;
}

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

fn require_text(value: &Value, label: &str) -> Result<String, String> {
    let text = clean(value);
    if text.is_empty() { Err(format!("{label} is required")) } else { Ok(text) }
}

fn require_boolean(value: &Value, label: &str) -> Result<bool, String> {
    value.as_bool().ok_or_else(|| format!("{label} (boolean) is required"))
}

fn require_enum(value: &Value, allowed: &[&str], label: &str) -> Result<String, String> {
    let id = clean(value);
    if allowed.contains(&id.as_str()) { Ok(id) } else { Err(format!("{label} must be one of {}", allowed.join(", "))) }
}

/// `validateMcpInput`: no credential values, a plain URL, one transport.
fn validate_mcp_input(server: &Value) -> Result<(), String> {
    static KEY: std::sync::LazyLock<JsRegex> =
        std::sync::LazyLock::new(|| JsRegex::new_static(r"authorization|cookie|api[-_]?key|token|password|secret", "i"));
    static QUERY_KEY: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r"key|token|password|secret|auth", "i"));
    for name in ["env", "headers"] {
        let Some(map) = field(server, name).as_object() else { continue };
        for (key, value) in map {
            if !value.is_null() && KEY.is_match(key) {
                return Err(format!("setup: {name}.{key} must use an environment-variable reference, not a credential value"));
            }
        }
    }
    if truthy(field(server, "url")) {
        let raw = mixdog_js::value_to_string(field(server, "url"));
        let url = url::Url::parse(&raw).map_err(|_| "Invalid URL".to_owned())?;
        if !["http", "https", "ws", "wss"].contains(&url.scheme()) {
            return Err("MCP URL must use HTTP(S) or WS(S)".to_owned());
        }
        if !url.username().is_empty() || url.password().is_some() || url.query_pairs().any(|(key, _)| QUERY_KEY.is_match(&key)) {
            return Err("MCP URL credentials are not accepted; use environment-variable references".to_owned());
        }
    }
    let (command, url, kind) = (truthy(field(server, "command")), truthy(field(server, "url")), field(server, "type"));
    if command && url {
        return Err("MCP input must select command or url, not both".to_owned());
    }
    if kind == "stdio" && url {
        return Err("stdio requires command, not url".to_owned());
    }
    if truthy(kind) && kind != "stdio" && command {
        return Err("network MCP transports require url, not command".to_owned());
    }
    Ok(())
}

fn mcp_server_input(args: &Value) -> Result<Value, String> {
    let server = field(args, "server");
    if !server.is_object() && !server.is_array() {
        return Err("server object is required".to_owned());
    }
    validate_mcp_input(server)?;
    Ok(server.clone())
}

fn number(value: &Value) -> Value {
    let zero = json!(0);
    mixdog_js::json_number(to_number(if truthy(value) { value } else { &zero }))
}

fn or_empty_text(value: &Value) -> Value {
    if truthy(value) { value.clone() } else { json!("") }
}

/// `mcpRows(status)`: the public rows of an MCP status.
pub fn mcp_rows(status: &Value) -> Value {
    let servers: Vec<Value> = field(status, "servers")
        .as_array()
        .map(|list| {
            list.iter()
                .map(|server| {
                    let mut row = Map::new();
                    row.insert("name".to_owned(), field(server, "name").clone());
                    row.insert("enabled".to_owned(), json!(field(server, "enabled") != &json!(false)));
                    row.insert("connected".to_owned(), json!(field(server, "connected") == &json!(true)));
                    let transport = if truthy(field(server, "transport")) { field(server, "transport") } else { field(server, "type") };
                    row.insert("transport".to_owned(), or_empty_text(transport));
                    row.insert("toolCount".to_owned(), number(field(server, "toolCount")));
                    row.insert("source".to_owned(), or_empty_text(field(server, "source")));
                    let owner = field(server, "owner");
                    if field(owner, "kind") == "plugin" {
                        row.insert("plugin".to_owned(), field(owner, "id").clone());
                        row.insert("pluginServer".to_owned(), field(owner, "key").clone());
                        let reason = field(server, "disabledReason");
                        row.insert("disabledReason".to_owned(), if truthy(reason) { reason.clone() } else { Value::Null });
                    }
                    let error = field(server, "error");
                    row.insert("error".to_owned(), if truthy(error) { error.clone() } else { Value::Null });
                    if field(server, "warnings").as_array().is_some_and(|w| !w.is_empty()) {
                        row.insert("warnings".to_owned(), field(server, "warnings").clone());
                    }
                    row.insert("scope".to_owned(), if field(server, "scope").is_array() { field(server, "scope").clone() } else { Value::Null });
                    if truthy(field(server, "connector")) {
                        row.insert("connector".to_owned(), field(server, "connector").clone());
                    }
                    // A multi-account connector's accounts: remove_mcp_server / sign-in take an account's name.
                    if let Some(accounts) = field(server, "accounts").as_array() {
                        let accounts: Vec<Value> = accounts
                            .iter()
                            .map(|account| {
                                let mut out = Map::new();
                                out.insert("name".to_owned(), field(account, "name").clone());
                                out.insert("email".to_owned(), or_empty_text(field(account, "email")));
                                if truthy(field(account, "authRequired")) {
                                    out.insert("authRequired".to_owned(), json!(true));
                                }
                                if truthy(field(account, "error")) {
                                    out.insert("error".to_owned(), field(account, "error").clone());
                                }
                                Value::Object(out)
                            })
                            .collect();
                        row.insert("accounts".to_owned(), Value::Array(accounts));
                    }
                    Value::Object(row)
                })
                .collect()
        })
        .unwrap_or_default();
    let mut out = Map::new();
    out.insert("connectedCount".to_owned(), number(field(status, "connectedCount")));
    out.insert("servers".to_owned(), Value::Array(servers));
    for key in ["warnings", "declarationErrors"] {
        if field(status, key).as_array().is_some_and(|w| !w.is_empty()) {
            out.insert(key.to_owned(), field(status, key).clone());
        }
    }
    Value::Object(out)
}

/// `publicMcpConfig(row)`: a server's configuration without its raw connection values.
fn public_mcp_config(row: &Value) -> Value {
    let config = field(row, "config");
    let endpoint_origin = field(config, "url")
        .as_str()
        .filter(|u| !u.is_empty())
        .and_then(|u| url::Url::parse(u).ok())
        .map(|u| u.origin().ascii_serialization());
    let owner = field(row, "owner");
    let mut out = Map::new();
    out.insert("name".to_owned(), field(row, "name").clone());
    out.insert("source".to_owned(), field(row, "source").clone());
    if field(owner, "kind") == "plugin" {
        out.insert("plugin".to_owned(), field(owner, "id").clone());
        out.insert("pluginServer".to_owned(), field(owner, "key").clone());
        out.insert("readOnly".to_owned(), json!(true));
    }
    out.insert("enabled".to_owned(), json!(field(row, "enabled") != &json!(false)));
    out.insert("type".to_owned(), if truthy(field(config, "type")) { field(config, "type").clone() } else { json!("stdio") });
    out.insert("cwd".to_owned(), or_empty_text(field(config, "cwd")));
    out.insert("endpointOrigin".to_owned(), endpoint_origin.map_or(Value::Null, Value::String));
    out.insert("argumentCount".to_owned(), json!(field(config, "args").as_array().map_or(0, Vec::len)));
    let names = |key: &str| Value::Array(field(config, key).as_object().map(|m| m.keys().cloned().map(Value::String).collect()).unwrap_or_default());
    out.insert("environmentNames".to_owned(), names("env"));
    out.insert("headerNames".to_owned(), names("headers"));
    for key in ["env_vars", "bearer_token_env_var", "env_http_headers"] {
        if let Some(value) = config.get(key) {
            out.insert(key.to_owned(), value.clone());
        }
    }
    let hidden: Vec<&str> = ["command", "args", "url", "env", "headers"].into_iter().filter(|k| config.get(*k).is_some()).collect();
    out.insert("hiddenFields".to_owned(), json!(hidden));
    out.insert(
        "note".to_owned(),
        json!("Raw connection values may contain credentials and are not returned. Omitted fields are preserved when editing."),
    );
    Value::Object(out)
}

fn with_name_and_rows(result: &Value) -> Value {
    let mut out = Map::new();
    if let Some(name) = result.get("name") {
        out.insert("name".to_owned(), name.clone());
    }
    out.insert("mcp".to_owned(), mcp_rows(field(result, "status")));
    Value::Object(out)
}

fn plugin_of(result: &Value) -> Value {
    let plugin = field(result, "plugin");
    if truthy(plugin) { plugin.clone() } else { Value::Null }
}

/// Runs setup action `action` over `args`.
pub async fn run(action: &str, args: &Value, rt: &dyn SetupRuntime) -> Result<Value, String> {
    match action {
        "add_mcp_server" => {
            let server = mcp_server_input(args)?;
            require_text(field(&server, "name"), "server.name")?;
            if clean(field(&server, "command")).is_empty() && clean(field(&server, "url")).is_empty() {
                return Err("server.command or server.url is required".to_owned());
            }
            Ok(with_name_and_rows(&rt.add_mcp_server(&server).await?))
        }
        "save_mcp_server" => {
            let server = mcp_server_input(args)?;
            let target = if truthy(field(&server, "originalName")) { field(&server, "originalName") } else { field(&server, "name") };
            require_text(target, "server.name or server.originalName")?;
            Ok(with_name_and_rows(&rt.save_mcp_server(&server).await?))
        }
        "remove_mcp_server" => {
            let name = require_text(field(args, "name"), "name")?;
            Ok(json!({"mcp": mcp_rows(&rt.remove_mcp_server(&name).await?)}))
        }
        "set_mcp_enabled" => {
            let name = require_text(field(args, "name"), "name")?;
            let enabled = require_boolean(field(args, "enabled"), "enabled")?;
            Ok(json!({"mcp": mcp_rows(&rt.set_mcp_server_enabled(&name, enabled).await?)}))
        }
        "reconnect_mcp" => {
            let name = clean(field(args, "name"));
            Ok(json!({"mcp": mcp_rows(&rt.reconnect_mcp((!name.is_empty()).then_some(name.as_str())).await?)}))
        }
        "get_mcp_server" => Ok(public_mcp_config(&rt.mcp_server_config(field(args, "name")).await?)),
        "set_disabled_skills" => {
            let Some(list) = field(args, "skills").as_array() else { return Err("skills (array of names) is required".to_owned()) };
            let names: Vec<String> = list.iter().map(clean).filter(|n| !n.is_empty()).collect();
            rt.set_disabled_skills(&names).await
        }
        "set_extension_scope" => {
            let kind = require_enum(field(args, "kind"), &["skills", "mcp", "plugins"], "kind")?;
            let projects: Vec<String> = match field(args, "projects") {
                Value::Array(list) => list.iter().map(clean).collect(),
                Value::Null => return Err(format!("Cannot read properties of {} (reading 'map')", if args.get("projects").is_some() { "null" } else { "undefined" })),
                _ => return Err("args.projects.map is not a function".to_owned()),
            };
            let name = require_text(field(args, "name"), "name")?;
            let status = rt.set_extension_scope(&kind, &name, &projects).await?;
            if kind == "mcp" {
                return Ok(json!({"mcp": mcp_rows(&status)}));
            }
            Ok(if truthy(&status) { status } else { json!({}) })
        }
        "add_plugin" => {
            let source = require_text(field(args, "source"), "source")?;
            Ok(json!({"plugin": plugin_of(&rt.add_plugin(&source).await?)}))
        }
        "update_plugin" => {
            let name = require_text(field(args, "name"), "name")?;
            Ok(json!({"plugin": plugin_of(&rt.update_plugin(&name).await?)}))
        }
        "set_plugin_enabled" => {
            let name = require_text(field(args, "name"), "name")?;
            let enabled = require_boolean(field(args, "enabled"), "enabled")?;
            Ok(json!({"plugin": plugin_of(&rt.set_plugin_enabled(&name, enabled).await?)}))
        }
        "remove_plugin" => {
            let name = require_text(field(args, "name"), "name")?;
            Ok(json!({"plugin": plugin_of(&rt.remove_plugin(&name).await?)}))
        }
        "connect_connector" => {
            // The chat path of the one-click connect: the attached Desktop renders a connect card.
            // Nothing is connected here.
            let wanted = require_text(field(args, "connector"), "connector")?;
            let Some(entry) = connector(&wanted) else {
                let ids: Vec<&str> = CATALOG.iter().map(|c| c.id).collect();
                return Err(format!("connector must be one of {}", ids.join(", ")));
            };
            let status = rt.mcp_status().await?;
            let server = field(&status, "servers").as_array().and_then(|rows| rows.iter().find(|row| field(row, "connector") == &json!(entry.id)));
            let connected = server.is_some_and(|s| field(s, "connected") == &json!(true));
            let mut out = Map::new();
            out.insert("connector".to_owned(), json!(entry.id));
            out.insert("name".to_owned(), json!(entry.name));
            out.insert("backend".to_owned(), json!(match entry.backend { Backend::OAuth { .. } => "oauth", Backend::ApiKey { .. } => "apiKey" }));
            if let Some(server) = server {
                out.insert("server".to_owned(), field(server, "name").clone());
            }
            out.insert("connected".to_owned(), json!(connected));
            out.insert(
                "note".to_owned(),
                json!(if connected {
                    format!("{} is already connected.", entry.name)
                } else {
                    format!("A connect card for {} is shown in this conversation; the user presses it (Desktop: Extensions → 커넥터). Check status mcp afterwards.", entry.name)
                }),
            );
            Ok(Value::Object(out))
        }
        "enable_plugin_mcp" => {
            let name = require_text(field(args, "name"), "name")?;
            let status = rt.plugins_status().await?;
            let plugin = field(&status, "plugins")
                .as_array()
                .and_then(|rows| rows.iter().find(|row| field(row, "name") == &json!(name) || field(row, "id") == &json!(name)))
                .cloned();
            let Some(plugin) = plugin else { return Err(format!("plugin \"{name}\" not found")) };
            let result = rt.enable_plugin_mcp(&plugin).await?;
            let mut out = Map::new();
            out.insert("serverName".to_owned(), field(&result, "serverName").clone());
            if truthy(field(&result, "serverNames")) {
                out.insert("serverNames".to_owned(), field(&result, "serverNames").clone());
            }
            out.insert("mcp".to_owned(), mcp_rows(field(&result, "status")));
            Ok(Value::Object(out))
        }
        other => Err(format!("setup: {other} is not an MCP, skills, plugins or connectors action")),
    }
}
