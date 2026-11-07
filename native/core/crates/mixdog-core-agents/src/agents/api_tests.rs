//! The `agent/` definition and permission methods against the recorded Node twin
//! (`agent-api-twin.json`, `record-agent-api.mjs`): one script of calls over a fresh data folder;
//! each call answers what Node's real handlers answered, and where Node recorded the files the
//! call leaves, so do these.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use futures::FutureExt as _;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::Method;
use mixdog_rt::{DurabilityIo, InLane, LaneToken as _};
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
    write(&data.join("agents/legacy/agent.json"), r#"{"connectors":["gmail"]}"#.as_bytes()).unwrap();
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

// `unconstrained`: inside a tokio test the handle's oneshot would otherwise answer Pending once the task's coop budget is spent.
fn on_lane<R: Send + 'static>(job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
    tokio::task::unconstrained(mixdog_rt::testing::tokens().durability_io.submit(&CancellationToken::new(), job).unwrap())
        .now_or_never()
        .expect("the test backend runs the job inline")
        .unwrap()
}

/// `std::fs::write`, through the statefile publication.
fn write(path: &Path, body: &[u8]) -> std::io::Result<()> {
    let (path, body) = (path.to_owned(), body.to_vec());
    on_lane(move |lane| mixdog_statefile::write_file(lane, &path, &body, &mixdog_statefile::Opts::default()).map(drop).map_err(std::io::Error::other))
}

/// The entries of a folder, each with whether it is a folder; none for a folder that is not there.
fn entries(dir: &Path) -> Option<Vec<(std::path::PathBuf, bool)>> {
    let dir = dir.to_owned();
    on_lane(move |lane| {
        let names = mixdog_statefile::list_dir(lane, &dir).ok()?;
        Some(names.into_iter().map(|name| (dir.join(&name), mixdog_statefile::metadata(lane, &dir.join(&name)).unwrap().is_dir())).collect())
    })
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
        let Some(entries) = entries(&dir) else { continue };
        for (path, is_dir) in entries {
            if is_dir {
                pending.push(path);
                continue;
            }
            let rel = path.strip_prefix(data).unwrap().to_string_lossy().replace('\\', "/");
            let parts: Vec<&str> = rel.split('/').collect();
            let name = parts.get(2).copied().unwrap_or("");
            // The definition files, their backups (`<file>.bak`) and any temp file a write left.
            let kept = name.split(TEMP).next().unwrap_or("");
            let definition = parts.len() == 3 && parts[0] == "agents" && (kept.trim_end_matches(".bak") == "AGENT.md" || kept.trim_end_matches(".bak") == "agent.json");
            if !definition && !rel.starts_with("human-gate/") {
                continue;
            }
            let text = String::from_utf8(mixdog_statefile::read_content(&path).unwrap().unwrap()).unwrap();
            files.insert(rel, text);
        }
    }
    files
}

/// The mark of an atomic write's temp file (`<target>.mixdog-tmp-<16 hex>`).
const TEMP: &str = ".mixdog-tmp-";

/// The random part of the first temp name in `text`, after checking it is 16 hex digits.
fn temp_suffix(text: &str) -> Option<&str> {
    let start = text.find(TEMP)? + TEMP.len();
    let hex = &text[start..start + 16];
    hex.bytes().all(|b| b.is_ascii_hexdigit()).then_some(hex)
}

/// What a call left on disk is what Node left: the same definition files and `.bak` backups with
/// the same bytes, and no temp file of an atomic write survives on either side.
fn same_files(label: &str, got: BTreeMap<String, String>, want: &BTreeMap<String, String>) {
    for side in [&got, want] {
        assert!(side.keys().all(|name| !name.contains(TEMP)), "{label}: a temp file survived: {:?}", side.keys().collect::<Vec<_>>());
    }
    assert_eq!(&got, want, "{label}: files");
}

/// The recorder's non-API steps (`SEEDS`): state the API cannot make. `None` for a real call.
fn seed(data: &Path, name: &str, params: &Value) -> Option<std::io::Result<()>> {
    let manifest = data.join("agents").join(params["agentId"].as_str().unwrap_or("")).join("agent.json");
    match name {
        "seedManifest" => Some(write(&manifest, format!("{}\n", serde_json::to_string_pretty(&params["manifest"]).unwrap()).as_bytes())),
        "setManifestReadOnly" => {
            let read_only = params["readOnly"].as_bool().unwrap();
            Some(on_lane(move |lane| {
                mixdog_statefile::set_readonly(lane, &manifest, read_only)
            }))
        }
        _ => None,
    }
}

#[tokio::test]
async fn the_agent_methods_answer_what_the_recorded_node_handlers_answered() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/settings/agent-api-twin.json");
    let twin: Value = serde_json::from_slice(&mixdog_statefile::read_content(&path).unwrap().unwrap()).unwrap();
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
    let service = AgentService::new(agents, connectors, AgentPermissions::new(grants), super::lifecycle_twin_tests::quiet_lifecycle());
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
                same_files(&label, snapshot(&data), &want);
            }
            continue;
        }
        match service.call(request).await {
            Ok(Reply::Value(value)) => assert_eq!(Some(&mask(&value, &data_text)), step.get("ok"), "{label}"),
            Ok(_) => panic!("{label}: not a value"),
            Err(CoreError::DomainError { message, .. }) => {
                let got = message.as_deref().map(|text| text.replace(&data_text, "<data>"));
                let want = step["error"].as_str().map(str::to_owned);
                match (&got, &want, step.get("failure")) {
                    (Some(got), Some(want), Some(failure)) if got.contains(TEMP) => {
                        // Node names its temp file with a random suffix: everything else must match.
                        let suffix = temp_suffix(got).unwrap_or_else(|| panic!("{label}: no temp suffix in {got}"));
                        assert_eq!(got.replace(suffix, temp_suffix(want).unwrap()), *want, "{label}");
                        assert!(got.starts_with(&format!("{}: ", failure["code"].as_str().unwrap())), "{label}: kind/code of {got}");
                        assert!(got.contains(&format!("{} '", failure["syscall"].as_str().unwrap())), "{label}: syscall of {got}");
                    }
                    _ => assert_eq!(got, want, "{label}"),
                }
            }
            Err(other) => panic!("{label}: {other}"),
        }
        if let Some(files) = step.get("files") {
            let want: BTreeMap<String, String> = files.as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect();
            same_files(&label, snapshot(&data), &want);
        }
    }
}
