//! The `agent/` definition and permission methods against the recorded Node twin
//! (`agent-api-twin.json`, `record-agent-api.mjs`): one script of calls over a fresh data folder;
//! each call answers what Node's real handlers answered, and where Node recorded the files the
//! call leaves, so do these.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup: the files are read and seeded on the test thread")]

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::Method;
use mixdog_tools::policy::FileGrantStore;
use serde_json::Value;

use super::*;
use super::tests::writable;

struct Catalog {
    servers: Vec<String>,
    tools: Vec<(String, String)>,
}

#[async_trait]
impl ConnectorCatalog for Catalog {
    async fn installed(&self) -> Result<Vec<String>, String> {
        Ok(self.servers.clone())
    }
    async fn tool_names(&self, connector_id: &str) -> Result<Vec<String>, String> {
        Ok(self.tools.iter().filter(|(server, _)| server == connector_id).map(|(_, tool)| tool.clone()).collect())
    }
    fn connector_of(&self, server: &str) -> Option<String> {
        (server == "gmail" || server == "gmail-2").then(|| "gmail".to_owned())
    }
}

/// A catalog whose installed connectors change while a test runs.
struct Live(std::sync::Mutex<Vec<String>>);

#[async_trait]
impl ConnectorCatalog for Live {
    async fn installed(&self) -> Result<Vec<String>, String> {
        Ok(self.0.lock().unwrap().clone())
    }
    async fn tool_names(&self, _: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn connector_of(&self, _: &str) -> Option<String> {
        None
    }
}

#[tokio::test]
async fn a_connector_installed_while_an_edit_waits_is_not_enabled_by_migrating_a_legacy_policy() {
    let (_dir, agents) = writable(serde_json::json!({})).await;
    let agents = Arc::new(agents);
    agents.save(serde_json::json!({ "name": "Legacy", "body": "Body" }).as_object().unwrap()).await.unwrap();
    // A save refuses a legacy list; one only ever sits on disk.
    let data = dir_data(&agents);
    std::fs::write(data.join("agents/legacy/agent.json"), r#"{"connectors":["gmail"]}"#).unwrap();
    let catalog = Arc::new(Live(std::sync::Mutex::new(vec!["gmail".into()])));
    let connectors = Arc::new(AgentConnectors::new(agents.clone(), catalog.clone()));
    // Another turn of the agent holds its queue; the edit starts behind it.
    let turn = lifecycle(&dir_data(&agents), "legacy").await;
    let edit = tokio::spawn({
        let connectors = connectors.clone();
        async move { connectors.set_enabled("legacy", &Value::String("gmail".into()), &Value::Bool(true), false).await }
    });
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    catalog.0.lock().unwrap().push("drive".into());
    drop(turn);
    edit.await.unwrap().unwrap();
    // `drive` was installed when the edit's turn came, and the legacy list never enabled it.
    let stored = agents.connector_policy("legacy").await.unwrap();
    assert!(stored.enabled("gmail"));
    assert!(!stored.enabled("drive"), "{:?}", stored.json());
}

fn dir_data(agents: &AgentDefinitions) -> std::path::PathBuf {
    agents.folders.data.clone()
}

/// Replaces the data folder's path wherever an answer says it.
fn mask(value: &Value, data: &str) -> Value {
    match value {
        Value::String(text) => Value::String(text.replace(data, "<data>")),
        Value::Array(rows) => Value::Array(rows.iter().map(|row| mask(row, data)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, row)| (key.clone(), mask(row, data))).collect()),
        other => other.clone(),
    }
}

/// The files an edit leaves, as the recorder lists them: definitions and the permission files.
fn snapshot(data: &Path) -> BTreeMap<String, String> {
    let mut files = BTreeMap::new();
    let mut pending = vec![data.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            let rel = path.strip_prefix(data).unwrap().to_string_lossy().replace('\\', "/");
            let parts: Vec<&str> = rel.split('/').collect();
            let definition = parts.len() == 3 && parts[0] == "agents" && matches!(parts[2], "AGENT.md" | "agent.json");
            if !definition && !rel.starts_with("human-gate/") {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap();
            files.insert(rel, text);
        }
    }
    files
}

/// The recorder's non-API steps (`SEEDS`): state the API cannot make. `None` for a real call.
fn seed(data: &Path, name: &str, params: &Value) -> Option<std::io::Result<()>> {
    let manifest = data.join("agents").join(params["agentId"].as_str().unwrap_or("")).join("agent.json");
    match name {
        "seedManifest" => Some(std::fs::write(manifest, format!("{}\n", serde_json::to_string_pretty(&params["manifest"]).unwrap()))),
        "setManifestReadOnly" => Some((|| {
            let mut permissions = std::fs::metadata(&manifest)?.permissions();
            permissions.set_readonly(params["readOnly"].as_bool().unwrap());
            std::fs::set_permissions(&manifest, permissions)
        })()),
        _ => None,
    }
}

#[tokio::test]
async fn the_agent_methods_answer_what_the_recorded_node_handlers_answered() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/settings/agent-api-twin.json");
    let twin: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let strings = |key: &str| -> Vec<String> { twin[key].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect() };
    let tools = twin["tools"].as_array().unwrap().iter().map(|pair| (pair[0].as_str().unwrap().to_owned(), pair[1].as_str().unwrap().to_owned())).collect();
    let (dir, agents) = writable(serde_json::json!({})).await;
    let agents = Arc::new(agents);
    let tokens = mixdog_rt::testing::tokens();
    let data = dir.path().join("data");
    let connectors = AgentConnectors::new(agents.clone(), Arc::new(Catalog { servers: strings("servers"), tools }));
    // The recorder froze Node's `Date.now()` at `now`; the same instant is this store's clock.
    let now = twin["now"].as_i64().unwrap();
    let grants = FileGrantStore::with_clock(data.join("human-gate"), tokens.interactive_io, tokens.durability_io, Arc::new(move || now));
    let service = AgentService::new(agents, connectors, AgentPermissions::new(grants));
    let data_text = data.to_string_lossy().into_owned();
    for (index, step) in twin["steps"].as_array().unwrap().iter().enumerate() {
        let name = step["method"].as_str().unwrap();
        let method = AGENT_METHODS.iter().find(|full| full.ends_with(&format!("/{name}"))).copied().unwrap_or("");
        let request = CoreRequest { method: Method(method), params: step["params"].clone(), op: None, ctx: CallContext::internal("agents") };
        let label = format!("step {index} {name} {}", step["params"]);
        if let Some(outcome) = seed(&data, name, &step["params"]) {
            outcome.unwrap();
            if let Some(files) = step.get("files") {
                let want: BTreeMap<String, String> = files.as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect();
                assert_eq!(snapshot(&data), want, "{label}: files");
            }
            continue;
        }
        match service.call(request).await {
            Ok(Reply::Value(value)) => assert_eq!(Some(&mask(&value, &data_text)), step.get("ok"), "{label}"),
            Ok(_) => panic!("{label}: not a value"),
            Err(CoreError::DomainError { message, .. }) => {
                let got = message.as_deref().map(|text| text.replace(&data_text, "<data>"));
                assert_eq!(got, step["error"].as_str().map(str::to_owned), "{label}");
            }
            Err(other) => panic!("{label}: {other}"),
        }
        if let Some(files) = step.get("files") {
            let want: BTreeMap<String, String> = files.as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect();
            assert_eq!(snapshot(&data), want, "{label}: files");
        }
    }
}
