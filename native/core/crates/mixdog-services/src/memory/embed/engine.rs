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
use crate::memory::embed::tokenizer::UnigramTokenizer;
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
struct VectorCache {
    entries: HashMap<String, Arc<Vec<f32>>>,
    order: std::collections::VecDeque<String>,
    bytes: usize,
}

impl VectorCache {
    fn get(&self, key: &str) -> Option<Arc<Vec<f32>>> {
        self.entries.get(key).cloned()
    }

    fn insert(&mut self, key: String, vector: Arc<Vec<f32>>) {
        let size = vector.len() * 4 + key.len();
        if self.entries.insert(key.clone(), vector).is_none() {
            self.order.push_back(key);
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

struct Inner {
    model_id: String,
    dtype: String,
    pooling: Pooling,
    tokenizer: UnigramTokenizer,
    sessions: Vec<Mutex<Session>>,
    with_type_ids: bool,
    lane: mixdog_rt::CpuBulk,
    dims: std::sync::atomic::AtomicUsize,
    cache: Mutex<VectorCache>,
}

#[derive(Clone)]
pub struct Embedder {
    inner: Arc<Inner>,
}

impl Embedder {
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
        let count = config.sessions.max(1);
        let library = config.ort_library.clone();
        let (tokenizer, sessions) = run_on_lane(config.lane, move || -> Result<(UnigramTokenizer, Vec<Session>)> {
            let tokenizer = UnigramTokenizer::load(&tokenizer_path, max_length)?;
            let environment = ort_environment(&library)?;
            let mut sessions = Vec::new();
            for _ in 0..count {
                let build = || -> ort::Result<Session> {
                    let mut builder = Session::builder(environment)?
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
        let known = config::known_dims(&model_id);
        let embedder = Self {
            inner: Arc::new(Inner {
                pooling: config::pooling(&model_id),
                model_id,
                dtype,
                tokenizer,
                sessions: sessions.into_iter().map(Mutex::new).collect(),
                with_type_ids,
                lane: config.lane,
                dims: std::sync::atomic::AtomicUsize::new(0),
                cache: Mutex::default(),
            }),
        };
        // `runEmbeddingWarmup`: one embedding measures the model's dimensions (a model the
        // profiles do not list has no other source), and a profiled model must measure what its
        // profile says.
        let measured = embedder.embed("warmup", InputType::Document).await?.len();
        if measured == 0 {
            return Err(MemoryError::Embedding("warmup returned no dims \u{2014} model output missing".into()));
        }
        if let Some(expected) = known.filter(|expected| *expected != measured) {
            return Err(MemoryError::Embedding(format!(
                "embedding dims invariant violation: model={} expected={expected} measured={measured}",
                embedder.inner.model_id
            )));
        }
        embedder.inner.dims.store(measured, std::sync::atomic::Ordering::Release);
        Ok(embedder)
    }

    pub fn model_id(&self) -> &str {
        &self.inner.model_id
    }

    pub fn dtype(&self) -> &str {
        &self.inner.dtype
    }

    /// The measured dimensions of the loaded model.
    pub fn dims(&self) -> usize {
        self.inner.dims.load(std::sync::atomic::Ordering::Acquire)
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
        if data.len() < dims {
            return Err(MemoryError::Runtime(format!("embedding output missing (model={})", inner.model_id)));
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
        let key = format!("{}\n{}\n{input_type:?}\n{prepared}", self.inner.model_id, self.inner.dtype);
        if let Some(hit) = self.inner.cache.lock().expect("vector cache").get(&key) {
            return Ok(hit);
        }
        let this = self.clone();
        let vector = run_on_lane(self.inner.lane, move || this.embed_blocking(&prepared))
            .await
            .map_err(|error| runtime_error("embedding", error))??;
        let vector = Arc::new(vector);
        self.inner.cache.lock().expect("vector cache").insert(key, vector.clone());
        Ok(vector)
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
