//! The local provider as one object: catalog, serialized request queue with idle unload, the
//! llama-server child, shared installations, Hugging Face inspection and model maintenance
//! (details, verify, repair, delete). Deleting or repairing a model never touches a loaded one
//! that is answering a conversation.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::assets::{AssetError, DownloadOptions, Fetcher, discard_downloads, download_verified_asset, install_model, install_runtime, probe, resumable_installations, sha256_file};
use super::catalog::{Catalog, exact_file, file_has_data};
use super::change::ChangeSignal;
use super::context::{local_context_settings, save_local_context, validate_local_context};
use super::hardware::{HardwareProbe, host_platform_key, select_gpu};
use super::hugging_face::{HfHttp, HuggingFaceCatalog};
use super::installations::{Installations, Progress, wait};
use super::model_state::ModelState;
use super::request_queue::{DEFAULT_LOCAL_IDLE_TTL_SECONDS, QueueError, RequestQueue, Unload};
use crate::tidy::process::Processes;
use super::server_process::{Health, Launch, Launcher, Ready, ServerProcess, StartSpec, Timing, fetch_props};

const CONFIRMATION_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_CONFIRMATIONS: usize = 100;

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("{0}")]
    Failed(String),
    #[error("{0}")]
    Invalid(String),
}

fn failed<T>(m: impl Into<String>) -> Result<T, ProviderError> {
    Err(ProviderError::Failed(m.into()))
}

impl From<AssetError> for ProviderError {
    fn from(e: AssetError) -> Self {
        Self::Failed(e.to_string())
    }
}
impl From<QueueError> for ProviderError {
    fn from(e: QueueError) -> Self {
        Self::Failed(e.to_string())
    }
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn remove_blocking(path: PathBuf) -> std::io::Result<()> {
    std::fs::remove_file(path)
}

/// The model's weights and partial file as they are on disk; a link or a non-regular file is refused.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn model_files_blocking(path: &std::path::Path) -> Result<Value, ProviderError> {
    let mut files = Vec::new();
    for file in [path.to_path_buf(), PathBuf::from(format!("{}.part", path.display()))] {
        let meta = match std::fs::symlink_metadata(&file) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return failed(e.to_string()),
        };
        if !meta.is_file() || meta.file_type().is_symlink() {
            return failed("[local-provider] refusing a non-regular or redirected model file");
        }
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0);
        files.push(json!({"path": file.to_string_lossy(), "size": meta.len(), "mtimeMs": mtime}));
    }
    Ok(Value::Array(files))
}

struct ServerUnloader(Arc<ServerProcess>);

#[async_trait]
impl Unload for ServerUnloader {
    async fn unload(&self) -> Result<(), String> {
        self.0.stop().await
    }
}

struct Receipt {
    model_id: String,
    files: Value,
    expires: Instant,
}

pub struct LocalProvider {
    pub catalog: Arc<Catalog>,
    pub installs: Arc<Installations>,
    pub queue: RequestQueue,
    pub server: Arc<ServerProcess>,
    pub hf: HuggingFaceCatalog,
    fetcher: Arc<dyn Fetcher>,
    durability: mixdog_rt::DurabilityIo,
    processes: Processes,
    confirmations: Mutex<HashMap<String, Receipt>>,
    platform_key: String,
    signal: ChangeSignal,
}

pub struct Parts {
    pub data_dir: PathBuf,
    pub fetcher: Arc<dyn Fetcher>,
    /// The one process manager every child runs under (GPU probes, archive extraction) and the
    /// io-durability lane the composition root hands this module: partial downloads are written on it.
    pub processes: Processes,
    pub hf_http: Box<dyn HfHttp>,
    pub launcher: Arc<dyn Launcher>,
    pub health: Arc<dyn Health>,
    pub timing: Timing,
    pub idle_ttl_seconds: Option<u64>,
    pub platform_key: Option<String>,
}

impl LocalProvider {
    pub fn new(parts: Parts) -> Arc<Self> {
        let signal = ChangeSignal::default();
        let durability = parts.processes.durability();
        let hardware = HardwareProbe::with_signal(std::env::consts::OS, std::env::consts::ARCH, None, signal.clone(), parts.processes.clone());
        let state = Arc::new(ModelState::with_signal(signal.clone()));
        let catalog = Arc::new(Catalog::new(&parts.data_dir, hardware, state, durability));
        let on_exit: Arc<dyn Fn(&Value) + Send + Sync> = Arc::new(|d| {
            if d["expected"] != true {
                eprintln!("[local-provider] llama-server exit {d}");
            }
        });
        let server = Arc::new(ServerProcess::new(parts.launcher, parts.health, parts.timing, on_exit).with_signal(signal.clone()));
        let queue = RequestQueue::with_signal(Arc::new(ServerUnloader(server.clone())), parts.idle_ttl_seconds.unwrap_or(DEFAULT_LOCAL_IDLE_TTL_SECONDS), None, signal.clone());
        let hf = HuggingFaceCatalog::new(parts.hf_http, catalog.registry.clone());
        Arc::new(Self {
            catalog,
            installs: Arc::new(Installations::with_signal(signal.clone())),
            queue,
            server,
            hf,
            fetcher: parts.fetcher,
            durability,
            processes: parts.processes,
            confirmations: Mutex::default(),
            platform_key: parts.platform_key.unwrap_or_else(|| host_platform_key().to_owned()),
            signal,
        })
    }

    /// The change signal: a counter that ticks whenever the value `status()` returns may have
    /// changed (installations, server running or idle, runtime and model catalog, queue). Read
    /// `status()` after a tick; ticks coalesce.
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<u64> {
        self.signal.subscribe()
    }

    /// Registers a previewed Hugging Face model (the license must be accepted) and signals the
    /// catalog change.
    pub async fn register_model(&self, preview_id: &str, license_accepted: bool) -> Result<Value, super::hugging_face::HfError> {
        let out = self.hf.register(preview_id, license_accepted).await?;
        self.signal.notify();
        Ok(out)
    }

    pub fn hardware(&self) -> &Arc<HardwareProbe> {
        &self.catalog.hardware
    }

    pub fn server_status(&self) -> Value {
        let mut merged = self.server.status();
        if let (Some(m), Value::Object(q)) = (merged.as_object_mut(), self.queue.status()) {
            m.extend(q);
        }
        merged
    }

    /// Catalog, server and resumable installations: what the settings dialog polls.
    pub async fn status(&self) -> Result<Value, ProviderError> {
        let mut status = self.catalog.status(Some(&self.platform_key)).await?;
        let installations = resumable_installations(&self.catalog, &status, self.installs.status()).await?;
        if let (Some(m), Value::Object(s)) = (status.as_object_mut(), self.server_status()) {
            m.extend(s);
        }
        status["installations"] = json!(installations);
        Ok(status)
    }

    /// The model's context settings, read on the durability lane.
    async fn context_settings(&self, entry: &Value) -> Result<Value, ProviderError> {
        let (entry, data_dir) = (entry.clone(), self.catalog.data_dir.clone());
        probe(self.durability, move || local_context_settings(&Catalog::context_limits(&entry), &data_dir)).await?.map_err(|e| ProviderError::Failed(e.to_string()))
    }

    /// Saves the model's context window on the durability lane.
    async fn save_context(&self, entry: &Value, tokens: Option<i64>) -> Result<(), ProviderError> {
        let (entry, data_dir) = (entry.clone(), self.catalog.data_dir.clone());
        probe(self.durability, move || save_local_context(&Catalog::context_limits(&entry), tokens, &data_dir)).await?.map_err(|e| ProviderError::Failed(e.to_string()))
    }

    pub async fn stop(&self) {
        self.queue.stop().await;
    }

    fn entry_of(&self, id: &str) -> Result<Value, ProviderError> {
        self.catalog.model_entry(id).ok_or_else(|| ProviderError::Failed("[local-provider] unknown model".into()))
    }

    /// Starts (or reuses) llama-server for the model at its configured context window.
    pub async fn ensure_server(self: &Arc<Self>, model_id: &str, cancel: Option<CancellationToken>) -> Result<Value, ProviderError> {
        if cancel.as_ref().is_some_and(CancellationToken::is_cancelled) {
            return failed("aborted");
        }
        let Some(entry) = self.catalog.model_entry(model_id) else { return failed(format!("[local-provider] unknown model: {model_id}")) };
        let ctx = self.context_settings(&entry).await?;
        let context_window = ctx["contextWindow"].as_i64().unwrap_or(0);
        let candidate = self.catalog.runtime_executable(&self.platform_key);
        let executable = match candidate {
            Some(path) => probe(self.durability, move || file_has_data(&path).then_some(path)).await?,
            None => None,
        };
        let Some(executable) = executable else { return failed("[local-provider] runtime is not installed") };
        let weights = self.catalog.model_path(&entry);
        let size = entry["size"].as_i64().unwrap_or(0);
        let installed = {
            let weights = weights.clone();
            probe(self.durability, move || exact_file(&weights, size)).await?
        };
        if !installed {
            return failed(format!("[local-provider] model is not installed: {}", entry["name"].as_str().unwrap_or("")));
        }
        let (this, entry_for_gpu, id) = (self.clone(), entry.clone(), entry["id"].as_str().unwrap_or("").to_owned());
        let spec = StartSpec {
            key: format!("{}|{}|{context_window}", executable.display(), weights.display()),
            model_id: id.clone(),
            executable: executable.to_string_lossy().into_owned(),
            cwd: self.catalog.runtime_directory().to_string_lossy().into_owned(),
            prepare: Box::new(move |cancel| {
                Box::pin(async move {
                    let hardware = this.catalog.hardware.detect(true).await;
                    if cancel.is_cancelled() {
                        return Err("aborted".to_owned());
                    }
                    let gpu = select_gpu(&hardware, entry_for_gpu["estimatedVramBytes"].as_i64().unwrap_or(0), entry_for_gpu["minimumVramBytes"].as_i64().unwrap_or(0)).map_err(|e| e.to_string())?;
                    let env = if gpu.vendor == "NVIDIA" { vec![("CUDA_VISIBLE_DEVICES".to_owned(), gpu.uuid.clone())] } else { vec![] };
                    Ok(Launch { gpu: Some(gpu), env })
                })
            }),
            on_ready: {
                let (catalog, id) = (self.catalog.clone(), id.clone());
                Box::new(move |ready: Ready, cancel| {
                    Box::pin(async move {
                        let props = fetch_props(&ready.base_url, &ready.api_key, &cancel).await;
                        catalog.state.record_load(&id, &props, Some(ready.load_time_ms));
                    })
                })
            },
            args: {
                let model = weights.to_string_lossy().into_owned();
                Box::new(move |port, key| {
                    let mut a: Vec<String> = ["--host", "127.0.0.1", "--port"].map(String::from).to_vec();
                    a.push(port.to_string());
                    for (k, v) in [("--api-key", key), ("--model", model.as_str()), ("--alias", id.as_str()), ("--ctx-size", &context_window.to_string()), ("--parallel", "1"), ("--split-mode", "none"), ("--main-gpu", "0"), ("--n-gpu-layers", "99"), ("--flash-attn", "on"), ("--cache-type-k", "q8_0"), ("--cache-type-v", "q8_0")] {
                        a.push(k.into());
                        a.push(v.into());
                    }
                    a.extend(["--jinja", "--no-webui"].map(String::from));
                    a
                })
            },
        };
        self.server.ensure(spec, cancel).await.map_err(ProviderError::Failed)
    }

    /// Saves the model's context window and reloads it when it is the loaded one; a failed
    /// reload restores the previous setting.
    pub async fn set_context(self: &Arc<Self>, model_id: &str, tokens: Option<i64>) -> Result<(), ProviderError> {
        let Some(entry) = self.catalog.model_entry(model_id) else { return Err(ProviderError::Invalid("Unknown local model.".into())) };
        let limits = Catalog::context_limits(&entry);
        validate_local_context(&limits, tokens).map_err(|e| ProviderError::Invalid(e.to_string()))?;
        let this = self.clone();
        let id = model_id.to_owned();
        self.queue
            .run(None, move |cancel| async move {
                let entry = this.catalog.model_entry(&id).ok_or_else(|| ProviderError::Failed("Unknown local model.".into()))?;
                let previous = this.context_settings(&entry).await.ok().and_then(|s| s["configuredContextWindow"].as_i64());
                let status = this.server.status();
                let reload = status["activeModel"] == id.as_str() && (status["running"] == true || status["starting"] == true);
                this.save_context(&entry, tokens).await?;
                this.signal.notify();
                if reload {
                    if let Err(e) = this.ensure_server(&id, Some(cancel)).await {
                        // `server.mjs:52-56`: the restoring save is bare in the `catch`, so its failure is thrown in
                        // place of the reload's error.
                        this.save_context(&entry, previous).await?;
                        this.signal.notify();
                        return Err(e);
                    }
                }
                Ok(())
            })
            .await?
    }

    /// Starts the tracked runtime or model install and returns the job's current status.
    pub fn start_installation(self: &Arc<Self>, phase: &str, model_id: Option<&str>) -> Result<(Value, super::installations::Completion), ProviderError> {
        let this = self.clone();
        match phase {
            "runtime" => {
                if model_id.is_some_and(|m| !m.is_empty()) {
                    return Err(ProviderError::Invalid("runtime installation does not accept modelId.".into()));
                }
                Ok(self.installs.track("runtime", None, move |progress: Progress, cancel| async move {
                    install_runtime(&this.catalog, this.fetcher.as_ref(), &this.processes, &this.platform_key, progress, cancel).await.map_err(|e| e.to_string())
                }))
            }
            "model" => {
                let entry = model_id
                    .and_then(|id| self.catalog.model_entry(id))
                    .ok_or_else(|| ProviderError::Invalid("modelId must identify a model in the Local Provider catalog.".into()))?;
                let id = entry["id"].as_str().unwrap_or("").to_owned();
                Ok(self.installs.track("model", Some(&id), move |progress: Progress, cancel| async move {
                    install_model(&this.catalog, this.fetcher.as_ref(), this.durability, &entry, progress, cancel).await.map_err(|e| e.to_string())
                }))
            }
            _ => Err(ProviderError::Invalid("phase must be runtime or model.".into())),
        }
    }

    /// Installs a model and waits for the outcome.
    pub async fn install_model_and_wait(self: &Arc<Self>, model_id: &str) -> Result<Value, ProviderError> {
        if self.catalog.model_entry(model_id).is_none() {
            return failed(format!("[local-provider] unknown model: {model_id}"));
        }
        let (_, done) = self.start_installation("model", Some(model_id))?;
        wait(done).await.map_err(ProviderError::Failed)
    }

    pub async fn discard_installation(&self, phase: &str, model_id: Option<&str>) -> Result<(), ProviderError> {
        let owner = if phase == "runtime" { None } else { model_id };
        let live = self.installs.status().iter().any(|job| {
            (job["phase"] == "runtime") == (phase == "runtime") && job["modelId"].as_str() == owner && matches!(job["state"].as_str(), Some("running" | "cancelling"))
        });
        if live {
            return failed("[local-provider] stop the installation before discarding it");
        }
        self.installs.forget(phase, owner).map_err(|e| ProviderError::Failed(e.to_string()))?;
        let discarded = discard_downloads(&self.catalog, phase, model_id).await.map_err(|e| ProviderError::Failed(e.to_string()));
        // Removed partial files change the remaining-download bytes the catalog reports.
        self.signal.notify();
        discarded
    }

    // ---- Model maintenance

    async fn model_files(&self, entry: &Value) -> Result<Value, ProviderError> {
        let path = self.catalog.model_path(entry);
        let root = self.catalog.model_root();
        if path.parent() != Some(root.as_path()) {
            return failed("[local-provider] model path escapes managed storage");
        }
        probe(self.durability, move || model_files_blocking(&path)).await?
    }

    fn loaded(&self, entry: &Value) -> bool {
        let s = self.server.status();
        (s["running"] == true || s["starting"] == true) && s["activeModel"] == entry["id"]
    }

    fn guard(&self, entry: &Value, own_phase: Option<&str>, allow_idle_loaded: bool, own_requests: i64) -> Result<(), ProviderError> {
        let q = self.queue.status();
        let requests = q["activeRequests"].as_i64().unwrap_or(0) + q["queuedRequests"].as_i64().unwrap_or(0);
        if self.loaded(entry) && (!allow_idle_loaded || requests > own_requests) {
            return failed(if allow_idle_loaded {
                "[local-provider] this model is answering a request; wait for it to finish before deleting it"
            } else {
                "[local-provider] unload this model before repairing or deleting it; active conversations are protected"
            });
        }
        let busy = self.installs.status().iter().any(|j| j["modelId"] == entry["id"] && matches!(j["state"].as_str(), Some("running" | "cancelling")) && Some(j["phase"].as_str().unwrap_or("")) != own_phase);
        if busy {
            return failed("[local-provider] this model has an active installation or maintenance job");
        }
        Ok(())
    }

    /// What a deletion would remove, with a five-minute confirmation token.
    pub async fn model_details(&self, model_id: &str) -> Result<Value, ProviderError> {
        let entry = self.entry_of(model_id)?;
        let files = self.model_files(&entry).await?;
        let mut confirmations = self.confirmations.lock().unwrap();
        confirmations.retain(|_, r| r.expires > Instant::now());
        if confirmations.len() >= MAX_CONFIRMATIONS {
            return failed("[local-provider] too many pending deletion confirmations");
        }
        let token = uuid::Uuid::new_v4().to_string();
        confirmations.insert(token.clone(), Receipt { model_id: model_id.to_owned(), files: files.clone(), expires: Instant::now() + CONFIRMATION_TTL });
        let size: u64 = files.as_array().into_iter().flatten().filter_map(|f| f["size"].as_u64()).sum();
        Ok(json!({
            "modelId": model_id, "name": entry["name"], "files": files, "sizeBytes": size, "source": entry["source"], "sha256": entry["sha256"],
            "confirmationToken": token,
            "recoverability": "Files are permanently deleted, not moved to the Recycle Bin. Recovery requires downloading the model again.",
        }))
    }

    /// Starts a nonblocking `verify` or `repair` job; the job status owns completion and errors.
    pub fn start_maintenance(self: &Arc<Self>, model_id: &str, operation: &str) -> Result<Value, ProviderError> {
        if operation != "verify" && operation != "repair" {
            return Err(ProviderError::Invalid("operation must be verify or repair.".into()));
        }
        let entry = self.entry_of(model_id)?;
        if operation == "repair" {
            self.guard(&entry, None, false, 0)?;
        } else if self.installs.status().iter().any(|j| j["modelId"] == model_id && matches!(j["state"].as_str(), Some("running" | "cancelling"))) {
            return failed("[local-provider] wait for the current model job");
        }
        let (this, op, id) = (self.clone(), operation.to_owned(), model_id.to_owned());
        let (status, _done) = self.installs.track(operation, Some(model_id), move |publish: Progress, cancel| {
            let queue = this.queue.clone();
            async move {
                queue
                    .run(Some(cancel), move |cancel| async move { this.maintenance_body(&entry, &op, publish, cancel).await.map_err(|e| e.to_string()) })
                    .await
                    .map_err(|e| e.to_string())?
            }
        });
        let _ = id;
        Ok(status)
    }

    async fn maintenance_body(&self, entry: &Value, operation: &str, publish: Progress, cancel: CancellationToken) -> Result<Value, ProviderError> {
        let id = entry["id"].as_str().unwrap_or("");
        let path = self.catalog.model_path(entry);
        let size = entry["size"].as_i64().unwrap_or(0);
        if operation == "repair" {
            self.guard(entry, Some(operation), false, 0)?;
            self.model_files(entry).await?;
            download_verified_asset(self.fetcher.as_ref(), entry, &path, DownloadOptions { on_progress: Some(publish), cancel, force: true, ..DownloadOptions::new(self.durability) }).await?;
            self.catalog.state.record_verification(id, json!({"valid": true, "sizeBytes": size, "sha256": entry["sha256"]}));
            return Ok(json!({"modelId": id, "valid": true}));
        }
        publish(serde_json::Map::from_iter([("stage".to_owned(), json!("verifying")), ("percent".into(), Value::Null)]));
        let files = self.model_files(entry).await?;
        let file = files.as_array().into_iter().flatten().find(|f| f["path"].as_str() == Some(&path.to_string_lossy())).cloned();
        let Some(file) = file else { return failed("[local-provider] model file is missing") };
        let actual = sha256_file(self.durability, &path, &cancel).await?;
        let file_size = file["size"].as_i64().unwrap_or(-1);
        let valid = file_size == size && Some(actual.as_str()) == entry["sha256"].as_str();
        self.catalog.state.record_verification(id, json!({"valid": valid, "sizeBytes": file_size, "sha256": actual}));
        if !valid {
            return failed("[local-provider] model integrity check failed; use Repair to download the pinned asset again");
        }
        Ok(json!({"modelId": id, "valid": valid}))
    }

    /// Deletes the model's files after a details confirmation; an idle loaded model is unloaded
    /// inside the request slot first.
    pub async fn delete_model(self: &Arc<Self>, confirmation_token: &str) -> Result<Value, ProviderError> {
        let (model_id, files) = {
            let confirmations = self.confirmations.lock().unwrap();
            let r = confirmations.get(confirmation_token).filter(|r| r.expires > Instant::now());
            match r {
                Some(r) => (r.model_id.clone(), r.files.clone()),
                None => return failed("[local-provider] deletion confirmation expired; inspect the model again"),
            }
        };
        let entry = self.entry_of(&model_id)?;
        self.guard(&entry, None, true, 0)?;
        let (this, token) = (self.clone(), confirmation_token.to_owned());
        self.queue
            .run(None, move |_| async move {
                if !this.confirmations.lock().unwrap().get(&token).is_some_and(|r| r.expires > Instant::now()) {
                    return failed("[local-provider] deletion confirmation expired or was already consumed");
                }
                this.guard(&entry, None, true, 1)?;
                if this.loaded(&entry) {
                    this.server.stop().await.map_err(ProviderError::Failed)?;
                }
                let current = this.model_files(&entry).await?;
                if current != files {
                    return failed("[local-provider] model files changed; request a new deletion confirmation");
                }
                this.confirmations.lock().unwrap().remove(&token);
                let mut deleted = Vec::new();
                for f in current.as_array().into_iter().flatten() {
                    let p = f["path"].as_str().unwrap_or("");
                    let path = PathBuf::from(p);
                    probe(this.durability, move || remove_blocking(path)).await?.map_err(|e| ProviderError::Failed(e.to_string()))?;
                    deleted.push(p.to_owned());
                    this.signal.notify();
                }
                let id = entry["id"].as_str().unwrap_or("");
                this.hf.registry().forget(id).await.map_err(|e| ProviderError::Failed(e.to_string()))?;
                this.installs.forget_model(id).map_err(|e| ProviderError::Failed(e.to_string()))?;
                this.catalog.state.forget(id);
                Ok(json!({"modelId": id, "deletedFiles": deleted, "recoverability": "Redownload required; no Recycle Bin copy."}))
            })
            .await?
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::assets::{Body, Fetched};
    use super::super::hugging_face::RangeResponse;
    use super::*;

    struct NoNet;
    #[async_trait]
    impl Fetcher for NoNet {
        async fn get(&self, _: &str, _: i64) -> Result<Fetched, String> {
            struct Empty;
            #[async_trait]
            impl Body for Empty {
                async fn next(&mut self) -> Result<Option<Vec<u8>>, String> {
                    Ok(None)
                }
            }
            Ok(Fetched { status: 200, content_length: None, https: true, body: Box::new(Empty) })
        }
    }
    #[async_trait]
    impl HfHttp for NoNet {
        async fn get_json(&self, _: &str, _: usize) -> Result<Value, String> {
            Err("offline".into())
        }
        async fn get_range(&self, _: &str, _: u64) -> Result<RangeResponse, String> {
            Err("offline".into())
        }
    }
    struct NoLaunch;
    #[async_trait]
    impl Launcher for NoLaunch {
        async fn launch(&self, _: &str, _: &[String], _: &str, _: &[(String, String)], _: super::super::server_process::LogSink) -> Result<Arc<dyn super::super::server_process::RunningProcess>, String> {
            Err("no process in tests".into())
        }
    }
    #[async_trait]
    impl Health for NoNet {
        async fn check(&self, _: u16, _: &str) -> bool {
            false
        }
        async fn free_port(&self) -> Result<u16, String> {
            Ok(1)
        }
    }

    pub(crate) fn provider(dir: &std::path::Path) -> Arc<LocalProvider> {
        provider_with(dir, Processes::for_tests(), Arc::new(NoLaunch), Arc::new(NoNet))
    }

    /// A provider whose children, launcher and health probe are the caller's.
    pub(crate) fn provider_with(dir: &std::path::Path, processes: Processes, launcher: Arc<dyn Launcher>, health: Arc<dyn Health>) -> Arc<LocalProvider> {
        LocalProvider::new(Parts {
            data_dir: dir.to_owned(),
            fetcher: Arc::new(NoNet),
            processes,
            hf_http: Box::new(NoNet),
            launcher,
            health,
            timing: Timing::default(),
            idle_ttl_seconds: Some(0),
            platform_key: Some("win32-x64-nvidia".into()),
        })
    }

    pub(crate) async fn install_fake_model(p: &LocalProvider, content: &[u8]) -> (Value, PathBuf) {
        // Register a model whose pinned digest is that of `content`.
        let mut m = super::super::registered_models::tests::model(7, 16384);
        m["size"] = json!(content.len());
        m["estimatedVramBytes"] = json!(content.len() + 1);
        m["minimumVramBytes"] = json!(content.len() + 1);
        m["sha256"] = json!(sha2::Sha256::digest(content).iter().map(|b| format!("{b:02x}")).collect::<String>());
        let registered = p.hf.registry().register(&m).await.unwrap();
        let path = p.catalog.model_path(&registered);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, content).unwrap();
        (registered, path)
    }
    use sha2::Digest;

    #[tokio::test]
    async fn details_then_delete_removes_files_and_forgets_the_model() {
        let dir = tempfile::tempdir().unwrap();
        let p = provider(dir.path());
        let (entry, path) = install_fake_model(&p, b"weights").await;
        let id = entry["id"].as_str().unwrap();
        let details = p.model_details(id).await.unwrap();
        assert_eq!(details["sizeBytes"], 7);
        let token = details["confirmationToken"].as_str().unwrap().to_owned();
        let deleted = p.delete_model(&token).await.unwrap();
        assert_eq!(deleted["deletedFiles"].as_array().unwrap().len(), 1);
        assert!(!path.exists());
        assert!(p.catalog.model_entry(id).is_none());
        assert!(p.delete_model(&token).await.is_err(), "a token is single use");
        assert!(p.model_details("hf-unknown").await.is_err());
    }

    #[tokio::test]
    async fn a_changed_file_invalidates_the_confirmation() {
        let dir = tempfile::tempdir().unwrap();
        let p = provider(dir.path());
        let (entry, path) = install_fake_model(&p, b"weights").await;
        let token = p.model_details(entry["id"].as_str().unwrap()).await.unwrap()["confirmationToken"].as_str().unwrap().to_owned();
        std::fs::write(&path, b"weights!!").unwrap();
        let error = p.delete_model(&token).await.unwrap_err().to_string();
        assert!(error.contains("model files changed"), "{error}");
        assert!(path.exists());
    }

    #[tokio::test]
    async fn verify_reports_integrity_through_the_job_and_model_state() {
        let dir = tempfile::tempdir().unwrap();
        let p = provider(dir.path());
        let (entry, path) = install_fake_model(&p, b"weights").await;
        let id = entry["id"].as_str().unwrap().to_owned();
        let job = p.start_maintenance(&id, "verify").unwrap();
        assert_eq!(job["phase"], "verify");
        for _ in 0..200 {
            if p.installs.status().iter().all(|j| j["state"] != "running") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(p.installs.status()[0]["state"], "complete");
        assert_eq!(p.catalog.state.get(&id)["verification"]["valid"], true);
        std::fs::write(&path, b"corrupt").unwrap();
        p.start_maintenance(&id, "verify").unwrap();
        for _ in 0..200 {
            if p.installs.status().iter().all(|j| j["state"] != "running") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let status = p.installs.status();
        assert_eq!(status[0]["state"], "failed");
        assert!(status[0]["error"].as_str().unwrap().contains("integrity check failed"));
        assert!(matches!(p.start_maintenance(&id, "bogus"), Err(ProviderError::Invalid(_))));
    }

    #[tokio::test]
    async fn context_is_validated_saved_and_reflected_in_status() {
        let dir = tempfile::tempdir().unwrap();
        let p = provider(dir.path());
        let (entry, _) = install_fake_model(&p, b"weights").await;
        let id = entry["id"].as_str().unwrap();
        assert!(matches!(p.set_context(id, Some(1000)).await, Err(ProviderError::Invalid(_))));
        assert!(matches!(p.set_context("nope", None).await, Err(ProviderError::Invalid(_))));
        let m = p.status().await.unwrap()["models"].as_array().unwrap().iter().find(|m| m["id"] == id).cloned().unwrap();
        assert_eq!(m["contextWindow"], 16384);
        assert_eq!(m["installed"], true);
        // The runtime is not installed, so the server cannot start.
        assert!(p.ensure_server(id, None).await.unwrap_err().to_string().contains("runtime is not installed"));
    }

    #[tokio::test]
    async fn every_kind_of_status_change_ticks_the_subscription() {
        let dir = tempfile::tempdir().unwrap();
        let p = provider(dir.path());
        let (entry, _) = install_fake_model(&p, b"weights").await;
        let id = entry["id"].as_str().unwrap().to_owned();
        let mut rx = p.subscribe();
        let ticked = |rx: &mut tokio::sync::watch::Receiver<u64>| {
            let changed = rx.has_changed().unwrap();
            rx.borrow_and_update();
            changed
        };
        assert!(!ticked(&mut rx), "nothing happened yet");
        // Catalog: a context-window change.
        p.set_context(&id, Some(16_384)).await.unwrap();
        assert!(ticked(&mut rx));
        // Queue: the idle TTL.
        p.queue.configure(30);
        assert!(ticked(&mut rx));
        // Installations and model state: a verify job runs to completion.
        p.start_maintenance(&id, "verify").unwrap();
        for _ in 0..200 {
            if p.installs.status().iter().all(|j| j["state"] != "running") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(ticked(&mut rx));
        // Installations: a discard removes the finished row.
        p.discard_installation("verify", Some(&id)).await.unwrap();
        assert!(ticked(&mut rx));
        // The status a subscriber re-reads after the tick reflects the change.
        let model = p.status().await.unwrap()["models"].as_array().unwrap().iter().find(|m| m["id"] == id.as_str()).cloned().unwrap();
        assert_eq!(model["configuredContextWindow"], 16_384);
        assert_eq!(p.status().await.unwrap()["idleTtlSeconds"], 30);
        // Catalog: deleting the model.
        let token = p.model_details(&id).await.unwrap()["confirmationToken"].as_str().unwrap().to_owned();
        p.delete_model(&token).await.unwrap();
        assert!(ticked(&mut rx));
        assert!(p.status().await.unwrap()["models"].as_array().unwrap().iter().all(|m| m["id"] != id.as_str()));
    }

    #[tokio::test]
    async fn installation_arguments_are_checked() {
        let dir = tempfile::tempdir().unwrap();
        let p = provider(dir.path());
        assert!(matches!(p.start_installation("runtime", Some("m")), Err(ProviderError::Invalid(_))));
        assert!(matches!(p.start_installation("model", Some("nope")), Err(ProviderError::Invalid(_))));
        assert!(matches!(p.start_installation("verify", None), Err(ProviderError::Invalid(_))));
        assert!(p.discard_installation("bogus", None).await.is_err());
    }
}
