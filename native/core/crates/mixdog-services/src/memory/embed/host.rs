//! Embedding client and the embedding host's wire protocol. Only the host loads the runtime.

use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::config::{self, InputType};
use super::engine::EmbedConfig;
use crate::memory::error::{MemoryError, Result};
use crate::model_host::{HostLaunch, Pipes};
use crate::model_install::run_on_lane;

pub const HOST_COMMAND: &str = "embedding-host";
const TAG: &str = "MIXDOG-EMBEDDING ";
const START_LIMIT: Duration = Duration::from_secs(60);

#[derive(Serialize, Deserialize)]
struct Request {
    text: String,
    query: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Reply {
    Ready { dims: usize, device: String },
    Vector { vector: Vec<f32> },
    Failed { message: String },
}

fn error(message: impl std::fmt::Display) -> MemoryError {
    MemoryError::Embedding(format!("embedding host: {message}"))
}

#[cfg(not(test))]
fn launch(config: &EmbedConfig) -> Result<HostLaunch> {
    let mut args = vec![
        HOST_COMMAND.into(), "--cache-dir".into(), config.cache_dir.clone().into_os_string(),
        "--model-id".into(), config.model_id.clone().into(),
        "--ort-library".into(), config.ort_library.clone().into_os_string(),
    ];
    if let Some(dtype) = &config.dtype {
        args.extend(["--dtype".into(), dtype.into()]);
    }
    Ok(HostLaunch { program: std::env::current_exe().map_err(error)?, args, env: Vec::new() })
}

#[cfg(test)]
fn launch(config: &EmbedConfig) -> Result<HostLaunch> {
    Ok(tests::real_launch(config))
}

struct Inner {
    pipes: Pipes,
    exchange: Mutex<()>,
    dims: usize,
    device: &'static str,
    model_id: String,
    dtype: String,
    lane: mixdog_rt::CpuBulk,
}

/// A handle to the child, never to an ONNX session in the core.
#[derive(Clone)]
pub struct Embedder {
    inner: Arc<Inner>,
}

impl Embedder {
    pub async fn load(config: EmbedConfig) -> Result<Self> {
        let launch = launch(&config)?;
        Self::start(config, launch).await
    }

    pub(crate) async fn start(config: EmbedConfig, launch: HostLaunch) -> Result<Self> {
        let runtime = tokio::runtime::Handle::current();
        run_on_lane(config.lane, move || {
            let pipes = Pipes::start(&launch, TAG, &runtime).map_err(error)?;
            let ready = Arc::new(AtomicBool::new(false));
            let kill = pipes.kill.clone();
            let loaded = ready.clone();
            let _alarm = mixdog_rt::ticker().register(std::time::Instant::now() + START_LIMIT, Box::new(move || {
                if !loaded.load(Ordering::Acquire) {
                    kill.cancel();
                }
            }));
            let first = pipes.receive().map_err(error)?;
            let (dims, device) = match serde_json::from_str::<Reply>(&first).map_err(error)? {
                Reply::Ready { dims, device } => (dims, device),
                Reply::Failed { message } => return Err(MemoryError::Embedding(message)),
                _ => return Err(error("unexpected reply while loading")),
            };
            ready.store(true, Ordering::Release);
            let model_id = mixdog_js::js_trim(&config.model_id).to_owned();
            Ok(Self { inner: Arc::new(Inner {
                pipes, exchange: Mutex::new(()), dims,
                device: match device.as_str() { "cpu" => "cpu", "dml" => "dml", _ => return Err(error("unknown device")) },
                dtype: config::normalize_dtype(&model_id, config.dtype.as_deref()),
                model_id, lane: config.lane,
            }) })
        }).await.map_err(error)?
    }

    pub fn in_use(&self) -> bool { Arc::strong_count(&self.inner) > 1 }
    pub fn alive(&self) -> bool { self.inner.pipes.alive() }
    pub fn dims(&self) -> usize { self.inner.dims }
    pub fn device(&self) -> &'static str { self.inner.device }
    pub fn model_id(&self) -> &str { &self.inner.model_id }
    pub fn dtype(&self) -> &str { &self.inner.dtype }

    pub async fn embed(&self, text: &str, input_type: InputType) -> Result<Arc<Vec<f32>>> {
        let request = Request { text: text.to_owned(), query: input_type == InputType::Query };
        let this = self.clone();
        run_on_lane(self.inner.lane, move || {
            let _exchange = this.inner.exchange.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let outcome = (|| {
                this.inner.pipes.send(serde_json::to_string(&request).map_err(error)?).map_err(error)?;
                let reply = this.inner.pipes.receive().map_err(error)?;
                match serde_json::from_str::<Reply>(&reply).map_err(error)? {
                    Reply::Vector { vector } => Ok(Arc::new(vector)),
                    Reply::Failed { message } => Err(MemoryError::Embedding(message)),
                    _ => Err(error("unexpected inference reply")),
                }
            })();
            if outcome.is_err() {
                // A failed exchange cannot leave a response for a later caller.
                this.inner.pipes.kill.cancel();
            }
            outcome
        }).await.map_err(error)?
    }

    pub async fn embed_batch(&self, texts: &[String], input_type: InputType) -> Result<Vec<Arc<Vec<f32>>>> {
        let mut vectors = Vec::with_capacity(texts.len());
        for text in texts {
            vectors.push(self.embed(text, input_type).await?);
        }
        Ok(vectors)
    }
}

fn send(output: &mut impl Write, reply: &Reply) -> bool {
    let json = serde_json::to_string(reply).expect("embedding reply serializes");
    writeln!(output, "{TAG}{json}").and_then(|()| output.flush()).is_ok()
}

/// Runs on the host's main thread; its executors carry model loading and inference.
pub fn serve(config: EmbedConfig, runtime: &tokio::runtime::Handle, input: impl BufRead, output: impl Write) -> i32 {
    crate::effort_judge::host::end_with_parent();
    serve_model(
        || runtime.block_on(super::engine::Embedder::load(config)),
        |model, request| runtime.block_on(model.embed(&request.text, if request.query { InputType::Query } else { InputType::Document })),
        input, output,
    )
}

fn serve_model<M>(
    load: impl FnOnce() -> Result<M>,
    embed: impl Fn(&M, &Request) -> Result<Arc<Vec<f32>>>,
    input: impl BufRead,
    mut output: impl Write,
) -> i32
where M: Metadata {
    let model = match load() {
        Ok(model) => model,
        Err(error) => {
            send(&mut output, &Reply::Failed { message: error.message() });
            return 1;
        }
    };
    if !send(&mut output, &Reply::Ready { dims: model.dims(), device: model.device().to_owned() }) { return 1; }
    for line in input.lines() {
        let Ok(line) = line else { return 1 };
        let Ok(request) = serde_json::from_str(&line) else { return 1 };
        let reply = match embed(&model, &request) {
            Ok(vector) => Reply::Vector { vector: vector.as_ref().clone() },
            Err(error) => Reply::Failed { message: error.message() },
        };
        if !send(&mut output, &reply) { return 1; }
    }
    0
}

trait Metadata {
    fn dims(&self) -> usize;
    fn device(&self) -> &'static str;
}

impl Metadata for super::engine::Embedder {
    fn dims(&self) -> usize { self.dims() }
    fn device(&self) -> &'static str { self.device() }
}

#[cfg(test)]
mod tests;
