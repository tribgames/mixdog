//! Embedding inference: model files in the transformers cache layout
//! (`<cache>/<model id>/<path>`, fetched from the Hugging Face Hub when
//! absent or damaged), the tokenizer, an ONNX Runtime session pool, and the
//! pooling and L2 normalisation that produce a stored vector. One text per
//! graph run, never padded, so a vector is the same however it was batched.

use mixdog_js::{js_trim};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::Tensor;

use crate::memory::embed::config::{self, InputType, Pooling};
use crate::memory::embed::install;
use crate::memory::embed::tokenizer::Tokenizer;
use crate::memory::error::{MemoryError, Result};
use crate::model_install::{fsio, run_on_lane};

const QUERY_CACHE_ENTRIES: usize = 1000;
const QUERY_CACHE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct EmbedConfig {
    pub model_id: String,
    /// Directory holding `<model id>/…` (the shared model cache).
    pub cache_dir: PathBuf,
    /// The ONNX Runtime shared library to load.
    pub ort_library: PathBuf,
    pub dtype: Option<String>,
    /// Graph sessions kept so concurrent embeds do not queue on one another.
    pub sessions: usize,
    /// The lane model loading and inference run on.
    pub lane: mixdog_rt::CpuBulk,
}

fn runtime_error(what: &str, error: impl std::fmt::Display) -> MemoryError {
    MemoryError::Runtime(format!("{what}: {error}"))
}

/// Bounded cache of query vectors keyed by model, dtype, input type and text.
#[derive(Default)]
pub(super) struct VectorCache {
    entries: HashMap<String, Arc<Vec<f32>>>,
    order: std::collections::VecDeque<String>,
    bytes: usize,
}

impl VectorCache {
    pub(super) fn get(&self, key: &str) -> Option<Arc<Vec<f32>>> {
        self.entries.get(key).cloned()
    }

    pub(super) fn insert(&mut self, key: String, vector: Arc<Vec<f32>>) {
        let size = vector.len() * 4 + key.len();
        match self.entries.insert(key.clone(), vector) {
            Some(old) => self.bytes -= old.len() * 4 + key.len(),
            None => self.order.push_back(key),
        }
        self.bytes += size;
        while self.order.len() > QUERY_CACHE_ENTRIES || self.bytes > QUERY_CACHE_BYTES {
            let Some(oldest) = self.order.pop_front() else { break };
            if let Some(dropped) = self.entries.remove(&oldest) {
                self.bytes = self.bytes.saturating_sub(dropped.len() * 4 + oldest.len());
            }
        }
    }
}

/// ONNX Runtime allows one environment per process: the first library path
/// that loads is the one every embedder uses.
pub(crate) fn ort_environment(library: &Path) -> Result<&'static ort::environment::Environment> {
    static ENVIRONMENT: std::sync::OnceLock<std::result::Result<ort::environment::Environment, String>> = std::sync::OnceLock::new();
    ENVIRONMENT
        .get_or_init(|| {
            ort::init_from(library)
                .map_err(|error| format!("onnxruntime library: {error}"))?
                .with_name("mixdog-embedding")
                .build()
                .map_err(|error| format!("onnxruntime environment: {error}"))
        })
        .as_ref()
        .map_err(|message| MemoryError::Runtime(message.clone()))
}

/// The worker's `executionProviders` plus its `enableCpuMemArena: false`: ONNX Runtime's CPU arena is on unless the CPU
/// provider is registered with it off, and it keeps every freed activation buffer resident for the model's life.
fn session_providers(gpu: bool) -> Vec<ort::ep::ExecutionProviderDispatch> {
    let mut providers = Vec::new();
    if gpu {
        providers.push(ort::ep::DirectML::default().build().error_on_failure());
    }
    providers.push(ort::ep::CPU::default().with_arena_allocator(false).build());
    providers
}

#[cfg(test)]
mod session_option_tests {
    use super::session_providers;

    #[test]
    fn the_cpu_provider_is_registered_so_its_arena_is_off() {
        let names = |gpu| session_providers(gpu).iter().map(|p| p.name()).collect::<Vec<_>>();
        assert_eq!(names(false), ["CPUExecutionProvider"]);
        assert_eq!(names(true), ["DmlExecutionProvider", "CPUExecutionProvider"]);
    }
}

struct Inner {
    model_id: String,
    dtype: String,
    pooling: Pooling,
    tokenizer: Tokenizer,
    sessions: Vec<Mutex<Session>>,
    with_type_ids: bool,
    device: &'static str,
    lane: mixdog_rt::CpuBulk,
}

#[derive(Clone)]
pub struct Embedder {
    inner: Arc<Inner>,
}


impl Embedder {
    /// Whether a caller holds this model besides the provider's own cell (an embed in flight keeps its own handle).
    pub fn in_use(&self) -> bool {
        Arc::strong_count(&self.inner) > 1
    }

    /// Builds the tokenizer and sessions from the installed files.
    pub async fn load(config: EmbedConfig) -> Result<Self> {
        let model_id = js_trim(&config.model_id).to_owned();
        let dtype = config::normalize_dtype(&model_id, config.dtype.as_deref());
        let files = install::required_files(&config);
        if let Some(missing) = install::missing_on(&config).await.map_err(|e| MemoryError::Embedding(e.to_string()))? {
            return Err(MemoryError::Embedding(format!("model file not installed: {missing}")));
        }
        let tokenizer_path = install::model_path(&config.cache_dir, &model_id, "tokenizer.json");
        let tokenizer_config = install::model_path(&config.cache_dir, &model_id, "tokenizer_config.json");
        let graph = install::model_path(&config.cache_dir, &model_id, &files.graph);
        let max_length = serde_json::from_slice::<serde_json::Value>(&fsio::read(config.lane, &tokenizer_config).await?)
            .ok()
            .and_then(|json| json["model_max_length"].as_u64())
            .filter(|n| *n > 0)
            .unwrap_or(512) as usize;
        // The worker's loadExtractor: DirectML is asked for by name and a failure to register it fails the load.
        let gpu = config::prefers_gpu(&model_id, std::env::var("MIXDOG_MEMORY_EMBED_DEVICE").ok().as_deref(), cfg!(windows));
        let count = config.sessions.max(1);
        let library = config.ort_library.clone();
        let (tokenizer, sessions) = run_on_lane(config.lane, move || -> Result<(Tokenizer, Vec<Session>)> {
            let tokenizer = Tokenizer::load(&tokenizer_path, max_length)?;
            let environment = ort_environment(&library)?;
            let mut sessions = Vec::new();
            for _ in 0..count {
                let build = || -> ort::Result<Session> {
                    let providers = session_providers(gpu);
                    let mut builder = Session::builder(environment)?
                        .with_execution_providers(providers)?
                        .with_intra_threads(1)?
                        .with_inter_threads(1)?
                        .with_optimization_level(GraphOptimizationLevel::Level1)?
                        .with_memory_pattern(false)?;
                    builder.commit_from_file(&graph)
                };
                // The worker reports onnxruntime's own text (`err.message`).
                sessions.push(build().map_err(|error| MemoryError::Embedding(error.to_string()))?);
            }
            Ok((tokenizer, sessions))
        })
        .await
        .map_err(|error| runtime_error("embedding load", error))??;
        let with_type_ids = sessions[0].inputs().iter().any(|input| input.name() == "token_type_ids");
        Ok(Self {
            inner: Arc::new(Inner {
                pooling: config::pooling(&model_id),
                model_id,
                dtype,
                tokenizer,
                sessions: sessions.into_iter().map(Mutex::new).collect(),
                with_type_ids,
                device: if gpu { "dml" } else { "cpu" },
                lane: config.lane,
            }),
        })
    }

    pub fn model_id(&self) -> &str {
        &self.inner.model_id
    }

    pub fn dtype(&self) -> &str {
        &self.inner.dtype
    }

    /// The device the sessions run on, `dml` or `cpu` (the worker's `_device`).
    pub fn device(&self) -> &'static str {
        self.inner.device
    }

    /// The measured dimensions of the loaded model.
    pub fn dims(&self) -> usize {
        config::known_dims(&self.inner.model_id).unwrap_or(0)
    }

    /// Token ids of the prepared text (for the golden check).
    pub fn token_ids(&self, prepared: &str) -> Vec<i64> {
        self.inner.tokenizer.encode(prepared)
    }

    fn embed_blocking(&self, prepared: &str) -> Result<Vec<f32>> {
        let inner = &*self.inner;
        let ids = inner.tokenizer.encode(prepared);
        let n = ids.len();
        let shape = [1usize, n];
        let make = |values: Vec<i64>| Tensor::from_array((shape, values)).map_err(|error| runtime_error("tensor", error));
        let mut feeds = vec![("input_ids", make(ids)?.into_dyn()), ("attention_mask", make(vec![1; n])?.into_dyn())];
        if inner.with_type_ids {
            feeds.push(("token_type_ids", make(vec![0; n])?.into_dyn()));
        }
        // A free session first; when all are busy, wait on the next in turn.
        let guard = inner
            .sessions
            .iter()
            .find_map(|slot| slot.try_lock().ok())
            .map_or_else(
                || {
                    let slot = &inner.sessions[n % inner.sessions.len()];
                    slot.lock().map_err(|_| MemoryError::Runtime("embedding session poisoned".into()))
                },
                Ok,
            )?;
        let mut session = guard;
        let outputs = session.run(feeds).map_err(|error| runtime_error("embedding run", error))?;
        let name = outputs
            .get("last_hidden_state")
            .map(|_| "last_hidden_state".to_owned())
            .or_else(|| outputs.keys().next().map(str::to_owned))
            .ok_or_else(|| MemoryError::Runtime(format!("embedding output missing (model={})", inner.model_id)))?;
        let (shape, data) =
            outputs[name.as_str()].try_extract_tensor::<f32>().map_err(|error| runtime_error("embedding output", error))?;
        let dims = *shape.last().ok_or_else(|| MemoryError::Runtime("embedding output shape".into()))? as usize;
        if dims == 0 || dims > data.len() || inner.pooling == Pooling::Mean && n > data.len() / dims {
            return Err(MemoryError::Runtime(format!("embedding output missing (model={})", inner.model_id)));
        }
        if let Some(expected) = config::known_dims(&inner.model_id).filter(|expected| *expected != dims) {
            return Err(MemoryError::Embedding(format!(
                "embedding dims invariant violation: model={} expected={expected} measured={dims}", inner.model_id
            )));
        }
        let mut vector = vec![0f32; dims];
        match inner.pooling {
            Pooling::Cls => vector.copy_from_slice(&data[..dims]),
            Pooling::Mean => {
                for token in 0..n {
                    for (k, slot) in vector.iter_mut().enumerate() {
                        *slot += data[token * dims + k];
                    }
                }
                for slot in &mut vector {
                    *slot /= n as f32;
                }
            }
        }
        let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
        let norm = if norm == 0.0 { 1.0 } else { norm };
        for slot in &mut vector {
            *slot /= norm;
        }
        Ok(vector)
    }

    /// The vector of one text; empty text has none.
    pub async fn embed(&self, text: &str, input_type: InputType) -> Result<Arc<Vec<f32>>> {
        let prepared = config::prepare_input(text, input_type, &self.inner.model_id);
        if prepared.is_empty() {
            return Ok(Arc::new(Vec::new()));
        }
        let this = self.clone();
        let vector = run_on_lane(self.inner.lane, move || this.embed_blocking(&prepared))
            .await
            .map_err(|error| runtime_error("embedding", error))??;
        Ok(Arc::new(vector))
    }

    /// One vector per text, in order; empty texts give empty vectors.
    pub async fn embed_batch(&self, texts: &[String], input_type: InputType) -> Result<Vec<Arc<Vec<f32>>>> {
        let mut out = Vec::with_capacity(texts.len());
        for text in texts {
            out.push(self.embed(text, input_type).await?);
        }
        Ok(out)
    }
}
