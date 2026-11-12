//! Node's `feature-tools.test.mjs` case (`fixtures/feature-tools-cases`, `record-feature-tools-cases.mjs`):
//! a media call from a session is attributed to that session and its source. Replayed through the media
//! tool's [`ToolService::call`] with the session id as the calling thread and the test's session table as
//! the source lookup the daemon wires (`getSession(sessionId)?.sourceType`). The job start the graph saw and
//! the reply text must equal Node's whole. Node's own `handed` (the options object its handler builds) has
//! no core counterpart; what it carries reaches the job start, which is compared.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::tool::{SurfaceKind, ToolPart};
use mixdog_protocol::ThreadId;
use mixdog_tools::orch::service::{ServiceCall, ToolService};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::jobs::MediaFailure;
use super::tool::{MediaGraph, MediaToolService};

/// The recorder's graph: one lane, a job that is done on its first read.
struct Graph {
    lane: Value,
    base: PathBuf,
    clock: i64,
    starts: Mutex<Vec<Value>>,
}

#[async_trait]
impl MediaGraph for Graph {
    async fn lanes(&self, _: Option<(&str, &str)>) -> Result<Vec<Value>, String> {
        Ok(vec![self.lane.clone()])
    }
    fn account_provider(&self, _: &str) -> String {
        String::new()
    }
    async fn start(&self, input: &Value) -> Result<Value, MediaFailure> {
        let mut starts = self.starts.lock().unwrap();
        starts.push(input.clone());
        Ok(json!({
            "id": format!("job-{}", starts.len()), "status": "running", "kind": input["kind"], "lane": input["lane"], "model": input["model"],
            "options": input["options"], "progress": 0, "assetId": null, "error": null, "startedAt": self.clock, "endedAt": null,
        }))
    }
    fn get(&self, id: &str) -> Option<Value> {
        let starts = self.starts.lock().unwrap();
        let input = starts.get(id.strip_prefix("job-")?.parse::<usize>().ok()? - 1)?;
        Some(json!({
            "id": id, "status": "done", "kind": input["kind"], "lane": input["lane"], "model": input["model"], "options": input["options"],
            "progress": 100, "assetId": "asset-1", "error": null, "startedAt": self.clock, "endedAt": self.clock + 1234,
        }))
    }
    fn cancel(&self, id: &str) -> Value {
        json!({ "id": id, "canceled": false })
    }
    async fn original_path(&self, asset_id: &str) -> Option<PathBuf> {
        Some(self.base.join("assets").join(format!("{asset_id}.png")))
    }
    async fn remembered(&self, _: &str) -> Option<Value> {
        None
    }
    async fn pin(&self, _: &str) -> Option<Value> {
        None
    }
}

fn fill(value: &Value, root: &str) -> Value {
    match value {
        Value::String(text) => Value::String(text.replace("{root}", root)),
        Value::Array(items) => Value::Array(items.iter().map(|item| fill(item, root)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), fill(item, root))).collect()),
        other => other.clone(),
    }
}

#[tokio::test]
async fn a_media_call_is_attributed_as_nodes_handler_attributes_it() {
    #[allow(clippy::disallowed_methods)] // the recording, read at run time
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/feature-tools-cases/golden.json")).expect("the recording");
    let golden: Value = serde_json::from_str(&text).expect("json");
    let clock = golden["clock"].as_i64().expect("clock");
    let tokens = mixdog_rt::testing::tokens();
    let cases = golden["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 1, "every case of the Node test");
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let scratch = tempfile::tempdir().unwrap();
        let base = scratch.path().to_path_buf();
        let root = base.to_string_lossy().into_owned();
        let cwd = base.join("cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(base.join("assets")).unwrap();
        std::fs::write(base.join("assets").join("asset-1.png"), "asset:asset-1").unwrap();
        let graph = Arc::new(Graph { lane: case["lane"].clone(), base: base.clone(), clock, starts: Mutex::new(Vec::new()) });
        let sessions = case["sessions"].clone();
        let service = MediaToolService::new(graph.clone(), tokens.durability_io, Arc::new(move |session: &str| sessions[session].as_str().unwrap_or_default().to_owned()))
            .with_timing(Arc::new(move || clock), Duration::from_millis(1));
        let thread = ThreadId::from(case["session"].as_str().expect("session"));
        let cwd = AbsPath::new(cwd).expect("absolute");
        let cancel = CancellationToken::new();
        let parts = service.call(ServiceCall { thread: &thread, surface: SurfaceKind::Lead, cwd: &cwd, args: &case["args"], cancel: &cancel }).await;
        assert_eq!(case["isError"], json!(false), "{name}: Node's call succeeded");
        let parts = parts.expect("a reply");
        let [ToolPart::Text(text)] = parts.as_slice() else { panic!("{name}: one text part") };
        let got: Value = serde_json::from_str(text).expect("json");
        assert_eq!(serde_json::to_string(&got).unwrap(), serde_json::to_string(&fill(&case["reply"], &root)).unwrap(), "{name}: the reply");
        assert_eq!(json!(*graph.starts.lock().unwrap()), fill(&case["starts"], &root), "{name}: the job starts");
    }
}
