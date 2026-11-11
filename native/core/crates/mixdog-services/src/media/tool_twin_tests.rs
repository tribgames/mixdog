//! `fixtures/services/media-tool-twin.json` (`record-media-tool.mjs`): Node's `executeMediaTool`
//! over an injected media graph. The reply text of every call (key order included), the job
//! starts and cancels the graph saw, the account scopes it was listed under and the files left
//! behind must equal Node's. The recording holds `{root}` for its scratch folder: in a call's
//! arguments and a scenario's files it is the scenario's own folder; in what Node answered, the
//! scratch root.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::accounts::AccountScope;
use super::jobs::MediaFailure;
use super::tool::{MediaGraph, MediaToolService, namespaced};

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/services/media-tool-twin.json");

fn fill(value: &Value, root: &str) -> Value {
    match value {
        Value::String(text) => Value::String(text.replace("{root}", root)),
        Value::Array(items) => Value::Array(items.iter().map(|item| fill(item, root)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), fill(item, root))).collect()),
        other => other.clone(),
    }
}

struct Rec {
    job: Value,
    gets: i64,
    script: Option<Value>,
}

#[derive(Default)]
struct State {
    starts: Vec<Value>,
    cancels: Vec<String>,
    scopes: Vec<Value>,
    jobs: HashMap<String, Rec>,
}

/// The recorder's fake graph: the same lanes, remembered choices and job script.
struct Fake {
    scenario: Value,
    lanes: Vec<Value>,
    base: PathBuf,
    state: Mutex<State>,
    skew: Arc<AtomicI64>,
    clock: i64,
    abort: CancellationToken,
}

impl Fake {
    fn now(&self) -> i64 {
        self.clock + self.skew.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl MediaGraph for Fake {
    async fn lanes(&self, account: Option<(&str, &str)>) -> Result<Vec<Value>, String> {
        if let Some((provider, name)) = account {
            self.state.lock().unwrap().scopes.push(json!([provider, name]));
            // Node's `withProviderAccount` refuses a provider without accounts and a malformed id.
            AccountScope::default().with(Path::new("data"), provider, name)?;
        }
        Ok(self.lanes.clone())
    }

    fn account_provider(&self, lane: &str) -> String {
        self.scenario["accountProviders"][lane].as_str().unwrap_or_default().to_owned()
    }

    async fn start(&self, input: &Value) -> Result<Value, MediaFailure> {
        let mut state = self.state.lock().unwrap();
        state.starts.push(input.clone());
        let script = self.scenario.get("job").cloned().unwrap_or_else(|| json!({}));
        if script["outcome"] == "start-error" {
            return Err(MediaFailure { message: script["message"].as_str().unwrap().to_owned(), code: script["code"].as_str().map(str::to_owned), usage: None });
        }
        let id = format!("job-{}", state.starts.len());
        let job = json!({
            "id": id, "status": "running", "kind": input["kind"], "lane": input["lane"], "model": input["model"], "options": input["options"],
            "progress": 0, "assetId": null, "error": null, "startedAt": self.now(), "endedAt": null,
        });
        state.jobs.insert(id, Rec { job: job.clone(), gets: 0, script: Some(script) });
        Ok(job)
    }

    fn get(&self, id: &str) -> Option<Value> {
        let mut state = self.state.lock().unwrap();
        let rec = state.jobs.get_mut(id)?;
        rec.gets += 1;
        if let Some(script) = &rec.script {
            if script["outcome"] == "never" {
                self.skew.fetch_add(100_000, Ordering::SeqCst);
            } else if rec.gets >= script["polls"].as_i64().unwrap_or(1) {
                let job = rec.job.as_object_mut().unwrap();
                match script["outcome"].as_str() {
                    Some("done") => {
                        job.insert("status".into(), json!("done"));
                        job.insert("progress".into(), json!(100));
                        job.insert("assetId".into(), script["assetId"].clone());
                        job.insert("endedAt".into(), json!(self.clock + 1234));
                    }
                    Some("failed") => {
                        job.insert("status".into(), json!("failed"));
                        job.insert("error".into(), script["error"].clone());
                        job.insert("endedAt".into(), json!(self.clock + 1234));
                    }
                    _ => {}
                }
            }
        }
        if self.scenario["abortAfterGets"].as_i64().is_some_and(|after| rec.gets >= after) {
            self.abort.cancel();
        }
        Some(rec.job.clone())
    }

    fn cancel(&self, id: &str) -> Value {
        let mut state = self.state.lock().unwrap();
        state.cancels.push(id.to_owned());
        match state.jobs.get_mut(id) {
            Some(rec) if rec.job["status"] == "running" => {
                let job = rec.job.as_object_mut().unwrap();
                job.insert("status".into(), json!("canceled"));
                job.insert("error".into(), json!("canceled"));
                job.insert("endedAt".into(), json!(self.clock + 500));
                json!({ "id": id, "canceled": true })
            }
            _ => json!({ "id": id, "canceled": false }),
        }
    }

    async fn original_path(&self, asset_id: &str) -> Option<PathBuf> {
        let missing = self.scenario["missingAssets"].as_array().is_some_and(|ids| ids.iter().any(|m| m == asset_id));
        (!missing).then(|| self.base.join("assets").join(format!("{asset_id}.png")))
    }

    async fn remembered(&self, kind: &str) -> Option<Value> {
        self.scenario["remembered"].get(kind).cloned()
    }

    async fn pin(&self, kind: &str) -> Option<Value> {
        self.scenario["pins"].get(kind).cloned()
    }
}

fn listing(root: &Path) -> Value {
    fn walk(root: &Path, dir: &Path, out: &mut serde_json::Map<String, Value>) {
        let Ok(read) = std::fs::read_dir(dir) else { return };
        for entry in read.flatten() {
            let path = entry.path();
            let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            if path.is_dir() {
                out.insert(format!("{rel}/"), Value::Null);
                walk(root, &path, out);
            } else {
                let data = std::fs::read(&path).unwrap();
                let sha: String = Sha256::digest(&data).iter().map(|b| format!("{b:02x}")).collect();
                out.insert(rel, json!({ "size": data.len(), "sha256": sha }));
            }
        }
    }
    let mut out = serde_json::Map::new();
    walk(root, root, &mut out);
    Value::Object(out)
}

#[tokio::test]
async fn the_tool_answers_what_nodes_does() {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path().to_string_lossy().into_owned();
    let tokens = mixdog_rt::testing::tokens();
    let clock = golden["clock"].as_i64().unwrap();
    let lane_sets: BTreeMap<String, Vec<Value>> = golden["laneSets"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_array().unwrap().clone())).collect();
    for recorded in golden["scenarios"].as_array().unwrap() {
        let name = recorded["name"].as_str().unwrap();
        let base = scratch.path().join("s").join(name);
        let cwd = base.join("cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(base.join("assets")).unwrap();
        std::fs::write(base.join("assets").join("asset-1.png"), "asset:asset-1").unwrap();
        let own = base.to_string_lossy().into_owned();
        // The scenario as the recorder defined it, `{root}` its own folder.
        let scenario = fill(&recorded["scenario"], &own);
        for file in scenario["files"].as_array().into_iter().flatten() {
            let path = PathBuf::from(file["path"].as_str().unwrap());
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            match file["size"].as_u64() {
                Some(size) => std::fs::write(&path, vec![0u8; size as usize]).unwrap(),
                None => std::fs::write(&path, file["text"].as_str().unwrap()).unwrap(),
            }
        }
        let mut jobs = HashMap::new();
        for seed in scenario["seeds"].as_array().into_iter().flatten() {
            jobs.insert(seed["id"].as_str().unwrap().to_owned(), Rec { job: seed.clone(), gets: 0, script: None });
        }
        let skew = Arc::new(AtomicI64::new(0));
        let abort = CancellationToken::new();
        let fake = Arc::new(Fake {
            scenario: scenario.clone(),
            lanes: lane_sets[scenario["lanes"].as_str().unwrap()].clone(),
            base: base.clone(),
            state: Mutex::new(State { jobs, ..State::default() }),
            skew: skew.clone(),
            clock,
            abort: abort.clone(),
        });
        let now: Arc<dyn Fn() -> i64 + Send + Sync> = {
            let skew = skew.clone();
            Arc::new(move || clock + skew.load(Ordering::SeqCst))
        };
        let service = MediaToolService::new(fake.clone(), tokens.durability_io, Arc::new(|_| "lead".to_owned())).with_timing(now, Duration::from_millis(1));
        for (index, call) in recorded["calls"].as_array().unwrap().iter().enumerate() {
            let args = fill(&call["args"], &own);
            let envelope = service.execute(&args, &cwd, "sess-1", &abort).await;
            let text = envelope["content"][0]["text"].as_str().unwrap();
            let got: Value = serde_json::from_str(text).unwrap();
            let want = fill(&call["reply"], &root);
            // Compact text compares key order too: the model reads the keys in the order sent.
            assert_eq!(serde_json::to_string(&got).unwrap(), serde_json::to_string(&want).unwrap(), "{name} call {index}: {args}");
            assert_eq!(envelope["isError"] == true, call["isError"] == true, "{name} call {index}: isError");
        }
        let state = fake.state.lock().unwrap();
        assert_eq!(json!(state.starts), fill(&recorded["starts"], &root), "{name}: starts");
        assert_eq!(json!(state.cancels), recorded["cancels"], "{name}: cancels");
        assert_eq!(json!(state.scopes), recorded["scopes"], "{name}: account scopes");
        // Node's recorder lists through `fs`, which namespaces: a file named `dotted.` is found by its name.
        assert_eq!(listing(&namespaced(&base)), recorded["tree"], "{name}: files");
    }
}
