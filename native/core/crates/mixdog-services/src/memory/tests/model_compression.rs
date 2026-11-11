//! The model-cache compression after the embedding model's first load, replayed from Node's embedding worker
//! (`record-memory-model-compression.mjs`, `fixtures/memory-model-compression`): the recorded model files (a tiny real
//! graph and tokenizer) in a fresh cache, the provider the composition builds (`EmbeddingProvider` with
//! `compress::compact_with` over the process manager), loaded for real through its `warmup`. The seam is the process
//! manager, as the recording's was `execFile`: each spawn is recorded and run as a command that ends as the recorded
//! answer did (`cmd.exe /C exit 0`, or `exit 1` for the failed compression).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use base64::Engine;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::process::{CommandSpec, ProcessError, ProcessEvent, ProcessInfo, ProcessManager, PtySize, SpawnRequest, SpawnedProcess};
use mixdog_protocol::ProcessHandle;
use serde_json::{Value, json};

use super::awaiting::awaiting;
use crate::memory::embed::compress::compact_with;
use crate::memory::embed::engine::EmbedConfig;
use crate::memory::embed::provider::EmbeddingProvider;
use crate::tidy::process::Processes;

/// The real manager; a spawn is recorded and runs a command ending as the recorded `execFile` answer did.
struct Recorded {
    inner: mixdog_spawn::LocalProcessManager,
    fail: bool,
    calls: Mutex<Vec<(String, Vec<String>)>>,
    called: tokio::sync::Notify,
}

#[async_trait::async_trait]
impl ProcessManager for Recorded {
    async fn spawn(&self, mut request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
        if let CommandSpec::Argv { program, args } = &request.command {
            self.calls.lock().unwrap().push((program.clone(), args.clone()));
        }
        let code = if self.fail { "1" } else { "0" };
        request.command = CommandSpec::Argv { program: "cmd.exe".into(), args: vec!["/C".into(), format!("exit {code}")] };
        let spawned = self.inner.spawn(request).await;
        self.called.notify_one();
        spawned
    }
    fn subscribe(&self, handle: &ProcessHandle, from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
        self.inner.subscribe(handle, from_seq)
    }
    async fn write_stdin(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
        self.inner.write_stdin(handle, bytes).await
    }
    fn close_stdin(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
        self.inner.close_stdin(handle)
    }
    fn resize_pty(&self, handle: &ProcessHandle, size: PtySize) -> Result<(), ProcessError> {
        self.inner.resize_pty(handle, size)
    }
    fn kill(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
        self.inner.kill(handle)
    }
    fn list(&self) -> Vec<ProcessInfo> {
        self.inner.list()
    }
}

/// Recorded on Windows, the one platform that compresses.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: needs the staged ONNX Runtime (MIXDOG_ORT_LIBRARY)"]
async fn the_model_cache_is_compressed_as_nodes_worker_does() {
    let golden: Value = serde_json::from_str(include_str!("../../../../../fixtures/memory-model-compression/golden.json")).expect("golden");
    let model_id = golden["modelId"].as_str().expect("model id");
    let tokens = mixdog_rt::testing::tokens();
    for case in golden["cases"].as_array().expect("cases") {
        let cache = tempfile::tempdir().expect("cache");
        let model_dir = model_id.split('/').fold(cache.path().to_path_buf(), |dir, part| dir.join(part));
        for (file, body) in golden["modelFiles"].as_object().expect("files") {
            let path = model_dir.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, base64::engine::general_purpose::STANDARD.decode(body.as_str().unwrap()).unwrap()).unwrap();
        }
        if case["damaged"] == json!(true) {
            std::fs::write(model_dir.join("onnx").join("model_quantized.onnx"), "not a graph").unwrap();
        }
        let manager = Arc::new(Recorded {
            inner: mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()),
            fail: case["compact"] == "fail",
            calls: Mutex::default(),
            called: tokio::sync::Notify::new(),
        });
        let provider = EmbeddingProvider::new(EmbedConfig {
            model_id: model_id.to_owned(),
            cache_dir: cache.path().to_path_buf(),
            ort_library: PathBuf::from(std::env::var_os("MIXDOG_ORT_LIBRARY").expect("MIXDOG_ORT_LIBRARY")),
            dtype: Some("q8".into()),
            sessions: 1,
            lane: tokens.cpu_bulk,
        })
        .with_compaction(compact_with(Processes::new(manager.clone(), tokens.durability_io)));

        let (mut outcomes, mut calls, mut expected_outcomes) = (Vec::new(), Vec::new(), Vec::new());
        for outcome in case["outcomes"].as_array().expect("outcomes") {
            let step = outcome["step"].as_str().expect("step");
            // The provider has no dispose: its one load serves every later warmup.
            if !step.starts_with("warmup") {
                continue;
            }
            let reply = provider.warmup().await;
            outcomes.push(match reply {
                Ok(Some(embedder)) => json!({ "step": step, "type": "result", "dims": embedder.dims() }),
                Ok(None) => json!({ "step": step, "type": "not installed" }),
                Err(_) => json!({ "step": step, "type": "error" }),
            });
            let recorded = &outcome["reply"];
            expected_outcomes.push(if recorded["type"] == "error" {
                json!({ "step": step, "type": "error" })
            } else {
                json!({ "step": step, "type": recorded["type"], "dims": recorded["dims"] })
            });
            // A compression, if this load starts one, runs after it: its spawn is awaited where the recording had one.
            let recorded_here = case["calls"].as_array().unwrap().iter().filter(|c| c["step"] == step).count();
            while manager.calls.lock().unwrap().len() < recorded_here {
                awaiting("the compression's spawn", manager.called.notified()).await;
            }
            let shown = model_dir.display().to_string();
            for (program, args) in manager.calls.lock().unwrap().drain(..) {
                calls.push(json!({ "step": step, "command": program, "args": args.iter().map(|a| a.replace(&shown, "<modelDir>")).collect::<Vec<_>>() }));
            }
        }
        let expected_calls: Vec<Value> = case["calls"].as_array().unwrap().iter().map(|c| json!({ "step": c["step"], "command": c["command"], "args": c["args"] })).collect();
        assert_eq!(json!({ "outcomes": outcomes, "calls": calls }), json!({ "outcomes": expected_outcomes, "calls": expected_calls }), "{}", case["name"]);
    }
}
