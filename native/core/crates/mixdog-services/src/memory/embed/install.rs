//! Embedding model files in the transformers cache layout
//! (`<cache>/<model id>/<path>`): what counts as installed, and the install
//! that fetches what is missing or damaged from the Hugging Face Hub.

use mixdog_js::{js_trim};
use std::path::{Path, PathBuf};

use tokio_util::sync::CancellationToken;

use crate::memory::embed::config;
use crate::memory::embed::engine::EmbedConfig;
use crate::lane::on_lane;
use crate::model_install::{DownloadError, InstallError, ProgressSink, Spec, download_once, fsio};
use mixdog_rt::CpuBulk;

pub const HUB: &str = "https://huggingface.co";
const PROBE_BYTES: usize = 4096;
/// Largest model file accepted (the fp32 bge-m3 graph is about 2.3 GB).
const MAX_FILE_BYTES: u64 = 4 << 30;

pub struct RequiredFiles {
    /// The ONNX graph, relative to the model directory.
    pub graph: String,
}

pub fn required_files(config: &EmbedConfig) -> RequiredFiles {
    RequiredFiles { graph: config::graph_file(js_trim(&config.model_id), config.dtype.as_deref()) }
}

pub fn model_path(cache_dir: &Path, model_id: &str, file: &str) -> PathBuf {
    let mut path = cache_dir.to_path_buf();
    path.extend(model_id.split('/'));
    path.extend(file.split('/'));
    path
}

/// A file counts as present when its first bytes hold data: empty or
/// NUL-filled (a crash that committed the size but not the bytes) is absent.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "a lane-job body: async callers go through the `_on` forms")]
pub(crate) fn holds_data(path: &Path) -> bool {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(path) else { return false };
    let mut head = vec![0u8; PROBE_BYTES];
    let read = file.read(&mut head).unwrap_or(0);
    head[..read].iter().any(|byte| *byte != 0)
}

#[allow(clippy::disallowed_methods, reason = "a lane-job body, reached through `missing`")]
fn usable(path: &Path) -> bool {
    if !holds_data(path) {
        return false;
    }
    if path.extension().is_some_and(|ext| ext == "json") {
        return std::fs::read(path).ok().is_some_and(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).is_ok());
    }
    true
}

fn weights_of(graph: &Path) -> PathBuf {
    PathBuf::from(format!("{}_data", graph.display()))
}

/// The first required file that is absent or damaged. Reads files: a lane-job body.
#[allow(clippy::disallowed_methods, reason = "a lane-job body: async callers use `missing_on`")]
pub fn missing(config: &EmbedConfig) -> Option<String> {
    let model_id = js_trim(&config.model_id);
    let graph = required_files(config).graph;
    for file in ["tokenizer.json", "tokenizer_config.json"] {
        if !usable(&model_path(&config.cache_dir, model_id, file)) {
            return Some(file.to_owned());
        }
    }
    let graph_path = model_path(&config.cache_dir, model_id, &graph);
    if !holds_data(&graph_path) {
        return Some(graph);
    }
    let weights = weights_of(&graph_path);
    (weights.exists() && !holds_data(&weights)).then(|| format!("{graph}_data"))
}

pub fn installed(config: &EmbedConfig) -> bool {
    missing(config).is_none()
}

/// [`missing`] as a job on the config's lane.
pub async fn missing_on(config: &EmbedConfig) -> Result<Option<String>, InstallError> {
    let owned = config.clone();
    on_lane(config.lane, move || missing(&owned)).await.map_err(InstallError::io)
}

async fn holds_data_on(lane: CpuBulk, path: &Path) -> Result<bool, InstallError> {
    let path = path.to_owned();
    on_lane(lane, move || holds_data(&path)).await.map_err(InstallError::io)
}

async fn usable_on(lane: CpuBulk, path: &Path) -> Result<bool, InstallError> {
    let path = path.to_owned();
    on_lane(lane, move || usable(&path)).await.map_err(InstallError::io)
}

/// Where model files are fetched from: the hub, and where the bytes and the cancel go.
pub struct Hub<'a> {
    pub lane: CpuBulk,
    /// The hub's origin ([`HUB`] outside tests).
    pub url: &'a str,
    pub progress: Option<&'a ProgressSink>,
    pub cancel: &'a CancellationToken,
}

impl Hub<'_> {
    /// One request, as Node's `download` (no retry); a non-ok answer fails with Node's text, except a 404 for an
    /// optional file, which leaves it absent.
    async fn download(&self, model_id: &str, file: &str, target: &Path, optional: bool) -> Result<(), InstallError> {
        let Hub { lane, url: hub, progress, cancel } = *self;
        let mut partial_name = target.file_name().unwrap_or_default().to_owned();
        partial_name.push(format!(".{}.part", std::process::id()));
        let partial = target.with_file_name(partial_name);
        let url = format!("{hub}/{model_id}/resolve/main/{file}");
        let label = format!("embedding model {model_id}/{file}");
        let spec = Spec { url: &url, dest: &partial, max_bytes: MAX_FILE_BYTES, expected_bytes: 0, label: &label, lane };
        match download_once(&spec, progress, cancel).await {
            Ok(_) => fsio::rename(lane, &partial, target).await.map_err(InstallError::io),
            Err(DownloadError::Http { status: 404, .. }) if optional => Ok(()),
            Err(DownloadError::Http { status, .. }) => {
                Err(InstallError::Hub(format!("embedding model download failed: {model_id}/{file} HTTP {status}")))
            }
            Err(DownloadError::Cancelled) => Err(InstallError::Cancelled),
            Err(error) => Err(error.into()),
        }
    }
}

/// `ensureModelFile`: the local path of `file`, fetched first when absent or damaged.
pub async fn ensure_model_file(hub: &Hub<'_>, cache_dir: &Path, model_id: &str, file: &str) -> Result<PathBuf, InstallError> {
    let target = model_path(cache_dir, model_id, file);
    if !usable_on(hub.lane, &target).await? {
        hub.download(model_id, file, &target, false).await?;
    }
    Ok(target)
}

/// `ensureModelGraph`: the local path of an ONNX graph. Its external weights
/// (when the model publishes them) are fetched before it, so a present graph
/// implies its weights finished downloading; weights a crash left empty are
/// fetched again even when the graph is intact.
pub async fn ensure_model_graph(hub: &Hub<'_>, cache_dir: &Path, model_id: &str, file: &str) -> Result<PathBuf, InstallError> {
    let lane = hub.lane;
    let target = model_path(cache_dir, model_id, file);
    let weights = weights_of(&target);
    let graph_present = holds_data_on(lane, &target).await?;
    if !graph_present || (fsio::exists(lane, &weights).await.map_err(InstallError::io)? && !holds_data_on(lane, &weights).await?) {
        hub.download(model_id, &format!("{file}_data"), &weights, true).await?;
    }
    if !graph_present {
        hub.download(model_id, file, &target, false).await?;
    }
    Ok(target)
}

/// Fetches what is missing or damaged, in the embedding worker's order
/// (`embedding-worker.mjs`): the tokenizer files, then the graph.
pub async fn install(
    config: &EmbedConfig,
    hub: &str,
    progress: Option<&ProgressSink>,
    cancel: &CancellationToken,
) -> Result<(), InstallError> {
    let model_id = js_trim(&config.model_id);
    let hub = Hub { lane: config.lane, url: hub, progress, cancel };
    for file in ["tokenizer.json", "tokenizer_config.json"] {
        ensure_model_file(&hub, &config.cache_dir, model_id, file).await?;
    }
    ensure_model_graph(&hub, &config.cache_dir, model_id, &required_files(config).graph).await?;
    Ok(())
}
