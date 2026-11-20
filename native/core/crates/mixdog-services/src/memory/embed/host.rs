//! Embedding client and the embedding host's wire protocol. Only the host loads the runtime.

use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::config::{self, InputType};
use super::engine::EmbedConfig;
use crate::memory::error::{MemoryError, Result};
pub(crate) use crate::model_host::Lifecycle;
use crate::model_host::{HostLaunch, Pipes};
use crate::model_install::run_on_lane;

pub const HOST_COMMAND: &str = "embedding-host";
const TAG: &str = "MIXDOG-EMBEDDING ";
/// How long a host may take: Node's worker timeouts.
#[derive(Clone, Copy)]
pub(crate) struct Limits {
    /// `EMBED_WORKER_COLD_TIMEOUT_MS`: a host that has not loaded yet has this long to answer ready (the first load may download the model).
    cold: Duration,
    /// `EMBED_WORKER_TIMEOUT_MS`: a request to a loaded host; past it the host is terminated and the next request starts another.
    request: Duration,
}

impl Limits {
    pub(crate) const NODE: Self = Self { cold: Duration::from_secs(180), request: Duration::from_secs(60) };

    #[cfg(test)]
    pub(crate) const fn new(cold: Duration, request: Duration) -> Self {
        Self { cold, request }
    }
}

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

async fn run_pipe_job<R: Send + 'static>(
    lane: mixdog_rt::CpuBulk,
    job: impl FnOnce() -> R + Send + 'static,
) -> std::result::Result<R, String> {
    #[cfg(not(test))]
    return run_on_lane(lane, job).await;

    // Unlike production's bulk lane, the test backend executes lane jobs
    // inline. A pipe wait must not block a Tokio worker that owns the local
    // queue where its writer/reader task was just scheduled.
    #[cfg(test)]
    {
        let runtime = tokio::runtime::Handle::current();
        match tokio::task::spawn_blocking(move || runtime.block_on(run_on_lane(lane, job))).await {
            Ok(outcome) => outcome,
            Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
            Err(error) => Err(error.to_string()),
        }
    }
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
    #[cfg(test)]
    dims: usize,
    device: &'static str,
    model_id: String,
    dtype: String,
    lane: mixdog_rt::CpuBulk,
    request_limit: Duration,
    /// Identities handed to exchanges.
    next_exchange: std::sync::atomic::AtomicU64,
    /// The exchange whose alarm may still kill the host (0: none), and whether its alarm did.
    armed: Mutex<(u64, bool)>,
}

impl Inner {
    /// An exchange's alarm: kills the host only when `identity` is still the armed exchange.
    fn expire(&self, identity: u64) {
        let mut armed = self.armed.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if armed.0 == identity {
            armed.1 = true;
            self.pipes.kill.cancel();
        }
    }
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
        Self::start_within(config, launch, Limits::NODE).await
    }

    pub(crate) async fn start_within(config: EmbedConfig, launch: HostLaunch, limits: Limits) -> Result<Self> {
        let runtime = tokio::runtime::Handle::current();
        run_pipe_job(config.lane, move || {
            let pipes = Pipes::start_below_normal(&launch, TAG, &runtime).map_err(error)?;
            let ready = Arc::new(AtomicBool::new(false));
            let kill = pipes.kill.clone();
            let loaded = ready.clone();
            let _alarm = mixdog_rt::ticker().register(std::time::Instant::now() + limits.cold, Box::new(move || {
                if !loaded.load(Ordering::Acquire) {
                    kill.cancel();
                }
            }));
            let first = pipes.receive().map_err(error)?;
            let (_dims, device) = match serde_json::from_str::<Reply>(&first).map_err(error)? {
                Reply::Ready { dims, device } => (dims, device),
                Reply::Failed { message } => return Err(MemoryError::Embedding(message)),
                _ => return Err(error("unexpected reply while loading")),
            };
            ready.store(true, Ordering::Release);
            let model_id = mixdog_js::js_trim(&config.model_id).to_owned();
            Ok(Self { inner: Arc::new(Inner {
                pipes, exchange: Mutex::new(()),
                #[cfg(test)]
                dims: _dims,
                device: match device.as_str() { "cpu" => "cpu", "dml" => "dml", _ => return Err(error("unknown device")) },
                dtype: config::normalize_dtype(&model_id, config.dtype.as_deref()),
                model_id, lane: config.lane, request_limit: limits.request,
                next_exchange: std::sync::atomic::AtomicU64::new(0), armed: Mutex::new((0, false)),
            }) })
        }).await.map_err(error)?
    }

    pub fn alive(&self) -> bool { self.inner.pipes.alive() }
    /// The host's lifecycle (Rule B): `Ended` only once its reaper read the exit.
    pub(crate) fn lifecycle(&self) -> Lifecycle { self.inner.pipes.lifecycle() }
    /// Resolves with the host's `Ended`.
    pub(crate) async fn ended(&self) -> Lifecycle { self.inner.pipes.ended().await }
    /// The provider ends this host by its own choice (idle release, disposal): Node's retired worker, whose exit is not counted.
    pub(crate) fn retire(&self) { self.inner.pipes.retire() }
    #[cfg(test)]
    pub(crate) fn generation(&self) -> u64 { self.inner.pipes.generation() }
    #[cfg(test)]
    pub(crate) fn dims(&self) -> usize { self.inner.dims }
    pub fn device(&self) -> &'static str { self.inner.device }
    pub fn model_id(&self) -> &str { &self.inner.model_id }
    pub fn dtype(&self) -> &str { &self.inner.dtype }

    pub async fn embed(&self, text: &str, input_type: InputType) -> Result<Arc<Vec<f32>>> {
        let request = Request { text: text.to_owned(), query: input_type == InputType::Query };
        let this = self.clone();
        run_pipe_job(self.inner.lane, move || {
            let _exchange = this.inner.exchange.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            // A host that never answers would hold the exchange for good: the alarm ends the host, which ends the wait below.
            // The alarm kills only the exchange it was armed for: the check and the kill are one step under `armed`, which the exchange's end also takes,
            // so a callback already dispatched when the reply returns finds another identity (or none) and does nothing.
            let identity = this.inner.next_exchange.fetch_add(1, Ordering::AcqRel) + 1;
            *this.inner.armed.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = (identity, false);
            let inner = this.inner.clone();
            let alarm = mixdog_rt::ticker().register(std::time::Instant::now() + this.inner.request_limit, move || inner.expire(identity));
            let outcome = (|| {
                this.inner.pipes.send(serde_json::to_string(&request).map_err(error)?).map_err(error)?;
                let reply = this.inner.pipes.receive().map_err(error)?;
                match serde_json::from_str::<Reply>(&reply).map_err(error)? {
                    Reply::Vector { vector } => Ok(Arc::new(vector)),
                    Reply::Failed { message } => Err(MemoryError::Embedding(message)),
                    _ => Err(error("unexpected inference reply")),
                }
            })();
            let _ = alarm.cancel();
            let timed_out = std::mem::take(&mut *this.inner.armed.lock().unwrap_or_else(std::sync::PoisonError::into_inner)).1;
            if outcome.is_err() {
                // A failed exchange cannot leave a response for a later caller.
                this.inner.pipes.kill.cancel();
            }
            if timed_out {
                return Err(error(format!("request timed out after {}ms", this.inner.request_limit.as_millis())));
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
    let loaded = {
        let _capped = affinity::cap_for_load();
        load()
    };
    let model = match loaded {
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

/// Node's cap on the load's CPU affinity (`embedding-worker.mjs`, `LOAD_AFFINITY_CORES` 1): graph compilation and weight dequantization cannot saturate every
/// core, and the full mask is restored the instant the load resolves, so inference is unaffected. Node set it on Windows only.
mod affinity {
    #[cfg(windows)]
    pub(super) struct Capped(usize);

    #[cfg(windows)]
    impl Drop for Capped {
        fn drop(&mut self) {
            // SAFETY: the current process's pseudo handle and a mask it already held.
            unsafe { windows_sys::Win32::System::Threading::SetProcessAffinityMask(windows_sys::Win32::System::Threading::GetCurrentProcess(), self.0) };
        }
    }

    #[cfg(windows)]
    pub(super) fn cap_for_load() -> Option<Capped> {
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessAffinityMask, SetProcessAffinityMask};
        // SAFETY: the current process's pseudo handle and two out-parameters.
        unsafe {
            let process = GetCurrentProcess();
            let (mut held, mut system) = (0usize, 0usize);
            if GetProcessAffinityMask(process, &mut held, &mut system) == 0 || SetProcessAffinityMask(process, held.isolate_lowest_one()) == 0 {
                return None;
            }
            Some(Capped(held))
        }
    }

    #[cfg(not(windows))]
    pub(super) fn cap_for_load() -> Option<()> {
        None
    }
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
