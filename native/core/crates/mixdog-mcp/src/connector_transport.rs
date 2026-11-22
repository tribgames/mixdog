//! One connector endpoint over its private account connections. The hub publishes only
//! this endpoint's union; account names remain selectors, never provider tool namespaces.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_rt::{Liveness, MaintenanceIo, TaskClass};
use serde_json::{Value, json};
use tokio::sync::mpsc;

/// Many requests hold it shared while they run and close takes it alone: every request is admitted at once, none queues behind a count,
/// and close waits for those in flight.
#[allow(clippy::disallowed_types, reason = "the running gate is a many-readers/one-closer lock; a permit count would queue the request past its capacity")]
type RunningGate = tokio::sync::RwLock<()>;
use tokio_util::sync::CancellationToken;

use crate::config::McpServerConfig;
use crate::connector_accounts::{AccountHealth, AccountReport, AccountSeed, ConnectorAccounts};
use crate::server::{McpServer, ServerState};
use crate::transport::{CloseCause, Incoming, IncomingRx, IncomingTx, Transport, TransportError};

pub struct AccountRuntime {
    pub health: Arc<AccountHealth>,
    pub data_dir: PathBuf,
    pub maintenance: MaintenanceIo,
}

pub(crate) struct AccountGroup {
    pub choice: Arc<ConnectorAccounts>,
    pub servers: Vec<Arc<McpServer>>,
    service: String,
    catalogs: Mutex<HashMap<String, AccountCatalog>>,
}

struct AccountCatalog {
    tools: Vec<Value>,
    instructions: String,
}

fn union_tools(lists: &[Vec<Value>]) -> Vec<Value> {
    let mut first: Vec<Value> = Vec::new();
    let mut conflicting = HashSet::new();
    for tool in lists.iter().flatten() {
        let name = tool["name"].as_str().unwrap_or_default();
        if let Some(previous) = first.iter().find(|previous| previous["name"] == name) {
            // JSON objects compare structurally, independently of insertion order.
            if previous.get("inputSchema") != tool.get("inputSchema") {
                conflicting.insert(name.to_owned());
            }
        } else {
            first.push(tool.clone());
        }
    }
    first.retain(|tool| !conflicting.contains(tool["name"].as_str().unwrap_or_default()));
    for tool in &mut first {
        if !tool["inputSchema"].is_object() {
            tool["inputSchema"] = json!({});
        }
        let schema = tool["inputSchema"].as_object_mut().expect("schema");
        schema.entry("type").or_insert(json!("object"));
        let properties = schema.entry("properties").or_insert(json!({}));
        if !properties.is_object() {
            *properties = json!({});
        }
        properties["account"] = json!({
            "type": "string",
            "description": "The account to use (its email address or account name). Left out: the account used last."
        });
    }
    first
}

/// An account's health error is a failure of its connect or call (Node records what the last connect or call
/// found): connecting and closed are states, not errors, and must not read as a failed account.
fn health_error(state: &ServerState) -> String {
    match state {
        ServerState::Failed { cause } => cause.clone(),
        ServerState::Starting | ServerState::Ready(_) | ServerState::Closed => String::new(),
    }
}

fn error_result(message: impl ToString) -> Value {
    json!({"isError": true, "content": [{"type": "text", "text": message.to_string()}]})
}

fn progress_relay(token: Value, tx: IncomingTx) -> Arc<dyn Fn(Value) + Send + Sync> {
    Arc::new(move |mut params: Value| {
        params["progressToken"] = token.clone();
        let _ = tx.send(Incoming::Message(json!({"jsonrpc": "2.0", "method": "notifications/progress", "params": params})));
    })
}

struct AccountTransport {
    group: Arc<AccountGroup>,
    tx: IncomingTx,
    cancel: CancellationToken,
    inflight: Arc<Mutex<HashMap<String, CancellationToken>>>,
    /// A request holds a read guard while it runs; closing takes the write side, so it waits for every request in flight.
    running: Arc<RunningGate>,
}

impl Drop for AccountTransport {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

#[async_trait]
impl Transport for AccountTransport {
    async fn send(&self, message: Value, _: Liveness) -> Result<(), TransportError> {
        if self.cancel.is_cancelled() {
            return Err(TransportError::Closed);
        }
        if message["method"] == "notifications/cancelled" {
            if let Some(cancel) = self.inflight.lock().unwrap_or_else(|e| e.into_inner()).get(&message["params"]["requestId"].to_string()) {
                cancel.cancel();
            }
            return Ok(());
        }
        let Some(id) = message.get("id").cloned() else { return Ok(()) };
        let key = id.to_string();
        let cancel = self.cancel.child_token();
        self.inflight.lock().unwrap_or_else(|e| e.into_inner()).insert(key.clone(), cancel.clone());
        let (group, tx, inflight) = (self.group.clone(), self.tx.clone(), self.inflight.clone());
        let running = self.running.clone().read_owned().await;
        mixdog_rt::spawn("mcp.connector.request", TaskClass::Work, async move {
            let work = async {
                let result = match message["method"].as_str().unwrap_or_default() {
                    "initialize" => group.initialize().await,
                    "ping" => Ok(json!({})),
                    "tools/list" => Ok(json!({"tools": group.catalog().0})),
                    "tools/call" => Ok(group.call(&message["params"], &cancel, tx.clone()).await),
                    _ => Err("Method not found".to_owned()),
                };
                let reply = match result {
                    Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
                    Err(error) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32001, "message": error}}),
                };
                let _ = tx.send(Incoming::Message(reply));
            };
            if message["method"] == "tools/call" {
                // Let the child RPC observe cancellation and send its own cancellation notice.
                work.await;
            } else {
                tokio::select! { () = work => {}, () = cancel.cancelled() => {} }
            }
            inflight.lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
            drop(running);
        });
        Ok(())
    }

    async fn close(&self) {
        self.cancel.cancel();
        let _running = self.running.write().await;
        let _ = self.tx.send(Incoming::Closed(CloseCause { reason: "connector closed".into(), stderr_tail: String::new() }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_failed_connection_is_an_account_health_error() {
        assert_eq!(health_error(&ServerState::Starting), "");
        assert_eq!(health_error(&ServerState::Closed), "");
        assert_eq!(health_error(&ServerState::Failed { cause: "boom".into() }), "boom");
    }

    /// The account failed its last connect and its next is scheduled but has not begun, so its state is still that
    /// failure: the connector does not answer from it, and answers once the scheduled connect ended.
    #[tokio::test]
    async fn a_connector_waits_for_the_connect_scheduled_for_its_failed_account() {
        let tokens = mixdog_rt::testing::tokens();
        let io = crate::McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk };
        let dir = tempfile::tempdir().unwrap();
        let url = "http://127.0.0.1:9/mcp";
        let entry = json!({"connector": "linear", "url": url, "accounts": [{"name": "work", "url": url, "oauthKey": "work"}]});
        let config = McpServerConfig::from_entry("linear", &entry, &Default::default()).unwrap();
        let mut account = config.accounts[0].server.clone();
        account.blocked = Some("the last attempt failed".to_owned());
        let spiller = crate::result::Spiller::new(dir.path().to_path_buf(), io.durability);
        let server = McpServer::new(account, io, spiller, crate::result::OutputPolicy::default(), None);
        server.connect().await.unwrap_err();
        let scheduled = CancellationToken::new();
        *server.scheduled_start.lock().unwrap() = Some(scheduled.clone());
        let runtime = AccountRuntime { health: Arc::new(AccountHealth::default()), data_dir: dir.path().to_path_buf(), maintenance: tokens.maintenance_io };
        let group = AccountGroup::new(&config, vec![server], &runtime);

        let mut asked = std::pin::pin!(group.initialize());
        assert!(futures::poll!(asked.as_mut()).is_pending(), "the scheduled connect has not ended");
        scheduled.cancel();
        assert_eq!(asked.await.unwrap_err(), "failed: the last attempt failed");
    }

    #[test]
    fn account_union_compares_schema_objects_and_rejects_conflicting_tools() {
        let lists = vec![
            vec![
                json!({"name": "search", "inputSchema": {"type": "object", "properties": {"q": {"type": "string"}}}}),
                json!({"name": "conflict", "inputSchema": {"type": "object"}}),
            ],
            vec![
                json!({"name": "search", "inputSchema": {"properties": {"q": {"type": "string"}}, "type": "object"}}),
                json!({"name": "conflict", "inputSchema": {"type": "string"}}),
            ],
        ];
        let tools = union_tools(&lists);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "search");
        assert_eq!(tools[0]["inputSchema"]["properties"]["q"]["type"], "string");
        assert_eq!(tools[0]["inputSchema"]["properties"]["account"]["type"], "string");
    }
}

impl AccountGroup {
    pub fn new(config: &McpServerConfig, servers: Vec<Arc<McpServer>>, runtime: &AccountRuntime) -> Arc<Self> {
        let connector = config.connector.as_deref().expect("accounts belong to a catalog connector");
        let seeds = config
            .accounts
            .iter()
            .map(|account| AccountSeed { name: account.server.name.clone(), id: account.id.clone(), email: account.email.clone() })
            .collect();
        Arc::new(Self {
            choice: ConnectorAccounts::new(connector, seeds, runtime.health.clone(), runtime.data_dir.clone(), runtime.maintenance).expect("live accounts"),
            servers,
            service: crate::connectors::connector(connector).map_or(connector, |entry| entry.name).to_owned(),
            catalogs: Mutex::new(HashMap::new()),
        })
    }

    pub fn open(self: &Arc<Self>) -> (Arc<dyn Transport>, IncomingRx) {
        let (tx, rx) = mpsc::unbounded_channel();
        let cancel = CancellationToken::new();
        for server in &self.servers {
            let (mut state, tx, cancel) = (server.subscribe(), tx.clone(), cancel.clone());
            mixdog_rt::spawn("mcp.connector.catalog", TaskClass::Work, async move {
                loop {
                    tokio::select! {
                        () = cancel.cancelled() => break,
                        changed = state.changed() => {
                            if changed.is_err() { break; }
                            let _ = tx.send(Incoming::Message(json!({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"})));
                        }
                    }
                }
            });
        }
        (
            Arc::new(AccountTransport {
                group: self.clone(),
                tx,
                cancel,
                inflight: Arc::new(Mutex::new(HashMap::new())),
                running: Arc::new(RunningGate::new(())),
            }),
            rx,
        )
    }

    fn catalog(&self) -> (Vec<Value>, String) {
        let mut lists = Vec::new();
        let mut own = Vec::new();
        let mut catalogs = self.catalogs.lock().unwrap_or_else(|e| e.into_inner());
        for server in &self.servers {
            if let Some(ready) = server.connection() {
                catalogs.insert(
                    server.name().to_owned(),
                    AccountCatalog { tools: ready.tools.clone(), instructions: ready.instructions.clone().unwrap_or_default() },
                );
            }
            // Node keeps the discovered union when an account drops or its next
            // connection fails; connectivity changes must not remove its schemas.
            match catalogs.get(server.name()) {
                Some(catalog) => {
                    let instructions = catalog.instructions.as_str();
                    let addresses = crate::connector_instructions::accounts_of_instructions(instructions);
                    let email = addresses.first().cloned();
                    let error = health_error(&server.state());
                    self.choice.record(server.name(), &AccountReport { email, error, auth_required: server.sign_in_required() });
                    self.choice.note_tools(server.name(), catalog.tools.iter().filter_map(|tool| tool["name"].as_str().map(str::to_owned)));
                    lists.push(catalog.tools.clone());
                    if addresses.is_empty() && !instructions.trim().is_empty() && !own.iter().any(|s| s == instructions) {
                        own.push(instructions.to_owned());
                    }
                }
                None => {
                    let error = health_error(&server.state());
                    self.choice.record(server.name(), &AccountReport { auth_required: server.sign_in_required(), error: error.clone(), email: None });
                }
            }
        }
        let listed = union_tools(&lists);
        self.choice.set_listed(listed.iter().filter_map(|tool| tool["name"].as_str().map(str::to_owned)));
        let labels = self.choice.labels().into_iter().map(|(email, note)| crate::connector_instructions::ConnectorAccount { email, note }).collect::<Vec<_>>();
        let mut instructions = crate::connector_instructions::connector_accounts_instructions(&labels).into_iter().collect::<Vec<_>>();
        instructions.extend(own);
        (listed, instructions.join("\n\n"))
    }

    pub(crate) fn instructions(&self) -> String {
        self.catalog().1
    }

    async fn initialize(&self) -> Result<Value, String> {
        // Connections are started and retried by the hub. A ready account makes the
        // namespace usable; siblings continue on their own per-server startup budgets.
        use futures::StreamExt;
        let mut settled = self
            .servers
            .iter()
            .map(|server| async move {
                // A connect scheduled for the account has not begun until it says so: the state before it is the last
                // attempt's, and a namespace that read it would fail beside an account about to connect.
                let scheduled = server.scheduled_start.lock().unwrap_or_else(|e| e.into_inner()).clone();
                if let Some(ended) = scheduled {
                    ended.cancelled().await;
                }
                let mut state = server.subscribe();
                state.wait_for(|state| !matches!(**state, ServerState::Starting)).await.map(|state| Arc::clone(&state)).ok()
            })
            .collect::<futures::stream::FuturesUnordered<_>>();
        let mut first_error = None;
        let mut ready = false;
        while let Some(state) = settled.next().await {
            match state.as_deref() {
                Some(ServerState::Ready(_)) => {
                    ready = true;
                    break;
                }
                Some(state) => {
                    first_error.get_or_insert_with(|| state.describe());
                }
                None => {}
            }
        }
        if !ready {
            return Err(first_error.unwrap_or_else(|| format!("No {} account is connected", self.service)));
        }
        let (_, instructions) = self.catalog();
        Ok(json!({
            "protocolVersion": crate::server::PROTOCOL_VERSION, "capabilities": {"tools": {"listChanged": true}},
            "serverInfo": {"name": self.service, "version": "1.0.0"}, "instructions": instructions
        }))
    }

    async fn bind_account(&self, params: &Value, tool: &str, conversation: &str) -> Result<crate::connector_accounts::Chosen, String> {
        let binding = params["_meta"].get("mixdog/approved-account").ok_or("A grouped connector call requires a bound account identity before dispatch.")?;
        let chosen = self
            .choice
            .approved(
                tool,
                &mixdog_core_api::domain::tool::ConnectorAccountBinding {
                    name: binding["name"].as_str().unwrap_or_default().to_owned(),
                    id: binding["id"].as_str().unwrap_or_default().to_owned(),
                },
            )
            .map_err(|error| error.to_string())?;
        self.choice.remember(&chosen.name, conversation).await.map_err(|error| error.to_string())?;
        Ok(chosen)
    }

    async fn call(&self, params: &Value, cancel: &CancellationToken, tx: IncomingTx) -> Value {
        let tool = params["name"].as_str().unwrap_or_default();
        let conversation = params["_meta"]["mixdog/conversation"].as_str().unwrap_or_default().trim();
        let mut args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
        if let Some(args) = args.as_object_mut() {
            args.shift_remove("account");
        }
        let chosen = match self.bind_account(params, tool, conversation).await {
            Ok(chosen) => chosen,
            Err(message) => return error_result(message),
        };
        let server = self.servers.iter().find(|server| server.name() == chosen.name).expect("chosen connection");
        let progress = params["_meta"].get("progressToken").cloned().map(|token| progress_relay(token, tx));
        let mut result = match server.call_account(conversation, tool, args, cancel, progress).await {
            Ok(result) => {
                self.choice.record(&chosen.name, &AccountReport::default());
                if result.get("isError") != Some(&Value::Bool(true)) {
                    let parts = result["content"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|part| part["type"] == "text")
                        .filter_map(|part| part["text"].as_str().map(|text| mixdog_core_api::domain::tool::ToolPart::Text(text.to_owned())))
                        .collect();
                    let output = mixdog_core_api::domain::tool::ToolOutput { parts, ..Default::default() };
                    crate::mail_reads::record(server.config(), tool, conversation, &output, mixdog_tools::desktop::mail_links::now_ms());
                }
                result
            }
            Err(error) => {
                let message = server.scrub(&error.to_string());
                if !cancel.is_cancelled() {
                    self.choice.record(&chosen.name, &AccountReport { error: message.clone(), auth_required: server.sign_in_required(), email: None });
                }
                error_result(message)
            }
        };
        if !result["content"].is_array() {
            result["content"] = json!([]);
        }
        result["content"].as_array_mut().expect("content").push(json!({
            "type": "text", "text": format!("({} account: {})", self.service, chosen.label)
        }));
        result
    }
}
