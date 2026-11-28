//! Recall computes the requested vector, including on a cold host. The cold
//! wait and cancellation bound the caller, not the admitted calculation.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
#[cfg(test)]
use futures::future::BoxFuture;
use tokio_util::sync::CancellationToken;

use crate::memory::embed::provider::EmbeddingProvider;
use crate::memory::recall::QueryEmbedder;

/// `RECALL_COLD_EMBED_WAIT_MS`: `envNonNegativeInt('MIXDOG_RECALL_COLD_EMBED_WAIT_MS', 3_000)` (`shared/env.mjs:26`).
pub fn cold_embed_wait() -> Duration {
    let parsed = std::env::var("MIXDOG_RECALL_COLD_EMBED_WAIT_MS").ok().and_then(|text| {
        let n = mixdog_js::string_to_number(&text).floor();
        (n.is_finite() && n >= 0.0).then_some(n)
    });
    Duration::from_millis(parsed.map_or(3_000, |n| n as u64))
}

/// What `embedRecallQuery` resolves to.
#[derive(Debug, Clone, PartialEq)]
#[cfg(test)]
pub enum RecallEmbedding<E> {
    Ready(Vec<f32>),
    Warmed(Vec<f32>),
    Empty,
    Unavailable,
    Timeout,
    Failed(E),
}

#[cfg(test)]
impl<E> RecallEmbedding<E> {
    pub fn into_vector(self) -> Option<Vec<f32>> {
        match self {
            Self::Ready(vector) | Self::Warmed(vector) => Some(vector),
            _ => None,
        }
    }
}

/// The options a recall's embed carries: `{ priority: true, inputType: 'query' }`.
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg(test)]
pub struct EmbedRequest {
    pub priority: bool,
    pub input_type: crate::memory::embed::config::InputType,
}

#[cfg(test)]
const QUERY: EmbedRequest = EmbedRequest { priority: true, input_type: crate::memory::embed::config::InputType::Query };

/// The embedder as the recall's wait sees it (Node's `isReady` / `canWarmup` / `warmup` / `embed` / `onWarmupError`).
#[async_trait]
#[cfg(test)]
pub trait ColdEmbed: Send + Sync + 'static {
    type Error: Clone + std::fmt::Debug + Send + 'static;
    fn is_ready(&self) -> bool;
    fn can_warmup(&self) -> bool;
    /// Loads the model; the returned work runs on after a recall stops waiting for it.
    fn warmup(&self) -> BoxFuture<'static, Result<(), Self::Error>>;
    /// `embed(clean, { priority: true, inputType: 'query' })`.
    async fn embed(&self, text: &str, request: EmbedRequest) -> Result<Vec<f32>, Self::Error>;
    fn on_warmup_error(&self, error: &Self::Error);
}

/// `embedRecallQuery(query, { …, signal, waitMs })`. `cancel` is the request's signal and `abort_reason` its reason (`abortReason`).
#[cfg(test)]
pub async fn embed_recall_query<E: ColdEmbed>(
    embedder: &Arc<E>,
    query: Option<&str>,
    wait: Duration,
    cancel: &CancellationToken,
    abort_reason: impl Fn() -> E::Error,
) -> Result<RecallEmbedding<E::Error>, E::Error> {
    let clean = mixdog_js::js_trim(query.unwrap_or(""));
    if clean.is_empty() {
        return Ok(RecallEmbedding::Empty);
    }
    if cancel.is_cancelled() {
        return Err(abort_reason());
    }
    if embedder.is_ready() {
        return Ok(RecallEmbedding::Ready(embed_owned(embedder, clean, cancel, &abort_reason).await?));
    }
    if !embedder.can_warmup() {
        return Ok(RecallEmbedding::Unavailable);
    }
    let deadline = mixdog_rt::time::Instant::now() + wait;
    timer_event(TimerEvent::Armed(wait));
    // `setTimeout(…, waitMs)` fires on a later turn than the warmup's continuation: a zero wait still lets an already-settled warmup win.
    let timer = async move {
        tokio::task::yield_now().await;
        mixdog_rt::time::sleep_until(deadline).await;
    };
    // `Promise.resolve().then(() => warmup())`: the warmup is called after the caller's turn and runs on when the recall stops waiting.
    let warm: BoxFuture<'static, Result<(), E::Error>> = {
        let embedder = embedder.clone();
        Box::pin(async move {
            tokio::task::yield_now().await;
            embedder.warmup().await
        })
    };
    let mut warm = Some(warm);
    tokio::pin!(timer);
    enum Raced<T> {
        Settled(T),
        Aborted,
        Timeout,
    }
    let raced = {
        let running = warm.as_mut().expect("the warmup");
        tokio::select! {
            biased;
            outcome = running => Raced::Settled(outcome),
            () = cancel.cancelled() => Raced::Aborted,
            () = &mut timer => Raced::Timeout,
        }
    };
    timer_event(TimerEvent::Cleared);
    let settled = matches!(raced, Raced::Settled(_));
    if !settled && let Some(running) = warm.take() {
        // The warmup goes on alone; after a timeout its late failure is reported (`void warmupOutcome.then(…)`).
        let embedder = embedder.clone();
        let report = matches!(raced, Raced::Timeout);
        drop(mixdog_rt::spawn("recall-warmup", mixdog_rt::TaskClass::Work, async move {
            if let Err(error) = running.await
                && report
            {
                embedder.on_warmup_error(&error);
            }
        }));
    }
    match raced {
        Raced::Aborted => Err(abort_reason()),
        Raced::Timeout => {
            timer_event(TimerEvent::Fired);
            Ok(RecallEmbedding::Timeout)
        }
        Raced::Settled(Err(error)) => {
            embedder.on_warmup_error(&error);
            Ok(RecallEmbedding::Failed(error))
        }
        Raced::Settled(Ok(())) if cancel.is_cancelled() => Err(abort_reason()),
        Raced::Settled(Ok(())) => Ok(RecallEmbedding::Warmed(embed_owned(embedder, clean, cancel, &abort_reason).await?)),
    }
}

/// The embedding as work the service owns: a stopped request is released at once (`rpc.mjs:74-78`) and the embedding, with the
/// model load it may wait on, runs on in its own task instead of being dropped with the caller's future.
#[cfg(test)]
async fn embed_owned<E: ColdEmbed>(
    embedder: &Arc<E>,
    text: &str,
    cancel: &CancellationToken,
    abort_reason: &impl Fn() -> E::Error,
) -> Result<Vec<f32>, E::Error> {
    let (embedder, text) = (embedder.clone(), text.to_owned());
    let mut work = mixdog_rt::spawn("recall-embed", mixdog_rt::TaskClass::Work, async move { embedder.embed(&text, QUERY).await });
    tokio::select! {
        biased;
        // The caller is gone; the embedding runs on in its task, whose handle this drops.
        () = cancel.cancelled() => Err(abort_reason()),
        joined = &mut work => match joined {
            Ok(outcome) => outcome,
            Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
            Err(_) => Err(abort_reason()),
        },
    }
}

/// The wait's timer as a replay observes it (Node's recorder wraps `setTimeout` / `clearTimeout`).
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg(test)]
pub(crate) enum TimerEvent {
    Armed(Duration),
    Cleared,
    /// The wait ran out (the timer's callback won the race).
    Fired,
}

#[cfg(test)]
thread_local! {
    pub(crate) static TIMER_SEAM: std::cell::RefCell<Option<std::rc::Rc<dyn Fn(TimerEvent)>>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn timer_event(event: TimerEvent) {
    TIMER_SEAM.with(|seam| {
        if let Some(seam) = seam.borrow().clone() {
            seam(event);
        }
    });
}

/// The product's embedder for recall. Secondary processes cannot submit model work.
#[derive(Clone)]
pub struct RecallEmbedder {
    provider: Arc<EmbeddingProvider>,
    can_compute: bool,
    db: Option<crate::memory::pg::db::Db>,
}

impl RecallEmbedder {
    pub fn new(provider: Arc<EmbeddingProvider>, secondary: bool) -> Self {
        Self { provider, can_compute: crate::tool_state::onnx_runtime_supported() && !secondary, db: None }
    }

    pub(crate) fn with_schema(mut self, db: crate::memory::pg::db::Db) -> Self {
        self.db = Some(db);
        self
    }

    pub(crate) async fn query_vector_with_wait(
        &self,
        text: &str,
        cancel: &CancellationToken,
        wait: Duration,
    ) -> crate::memory::error::Result<Option<Vec<f32>>> {
        if !self.can_compute {
            return Ok(None);
        }
        if cancel.is_cancelled() {
            return Err(crate::memory::recall::aborted());
        }
        let (cold, work) = self.provider.admit_query(text);
        let vector = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(crate::memory::recall::aborted()),
            result = work => match result {
                Ok(vector) => vector,
                Err(error) => {
                    tracing::warn!(%error, "recall embedding failed; searching text");
                    return Ok(None);
                }
            },
            // The provider owns admitted work in a task. Let it compute and
            // cache this query even when the recall goes on with text only.
            () = mixdog_rt::time::sleep(wait), if cold => return Ok(None),
        };
        if let (Some(vector), Some(db)) = (&vector, &self.db) {
            tokio::select! {
                biased;
                () = cancel.cancelled() => return Err(crate::memory::recall::aborted()),
                result = async {
                    let client = db.client().await?;
                    crate::memory::schema::record_vector_dims(&client, vector.len()).await
                } => result?,
            }
        }
        Ok(vector)
    }
}

#[async_trait]
#[cfg(test)]
impl ColdEmbed for RecallEmbedder {
    type Error = String;

    fn is_ready(&self) -> bool {
        self.provider.is_ready()
    }

    fn can_warmup(&self) -> bool {
        self.can_compute
    }

    fn warmup(&self) -> BoxFuture<'static, Result<(), String>> {
        let provider = self.provider.clone();
        Box::pin(async move { provider.warmup().await.map(drop) })
    }

    /// The core's embedder runs one request at a time per model; `priority` has no queue to jump.
    async fn embed(&self, text: &str, request: EmbedRequest) -> Result<Vec<f32>, String> {
        let embedder = self.provider.warmup().await?.ok_or_else(|| "embedding model not installed".to_owned())?;
        embedder.embed(text, request.input_type).await.map(|v| v.to_vec()).map_err(|e| e.message())
    }

    fn on_warmup_error(&self, error: &String) {
        tracing::warn!("[memory-service] embedding warmup after cold recall failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// A cold embedder whose warmup never ends and whose embed is scripted.
    struct Probe {
        ready: bool,
        embed: Mutex<Option<tokio::sync::oneshot::Receiver<Result<Vec<f32>, String>>>>,
    }

    #[async_trait]
    impl ColdEmbed for Probe {
        type Error = String;
        fn is_ready(&self) -> bool {
            self.ready
        }
        fn can_warmup(&self) -> bool {
            true
        }
        fn warmup(&self) -> BoxFuture<'static, Result<(), String>> {
            Box::pin(std::future::pending())
        }
        async fn embed(&self, _: &str, _: EmbedRequest) -> Result<Vec<f32>, String> {
            let gate = self.embed.lock().unwrap().take().expect("embed is called once");
            gate.await.expect("the embed gate is settled")
        }
        fn on_warmup_error(&self, _: &String) {}
    }

    fn probe(ready: bool) -> (Arc<Probe>, tokio::sync::oneshot::Sender<Result<Vec<f32>, String>>) {
        let (release, gate) = tokio::sync::oneshot::channel();
        (Arc::new(Probe { ready, embed: Mutex::new(Some(gate)) }), release)
    }

    /// The wait is measured on the clock the recall runs on: a 30 s wait started after 3 600 s of advancement ends 30 s later, not 3 630 s.
    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn the_cold_wait_counts_virtual_time_once() {
        mixdog_rt::testing::tokens();
        let (embedder, _release) = probe(false);
        tokio::time::advance(Duration::from_secs(3_600)).await;
        let cancel = CancellationToken::new();
        let call = embed_recall_query(&embedder, Some("q"), Duration::from_secs(30), &cancel, String::new);
        tokio::pin!(call);
        assert!(futures::poll!(&mut call).is_pending());
        tokio::time::advance(Duration::from_secs(30)).await;
        let outcome = mixdog_rt::time::timeout(Duration::from_secs(1), call).await.expect("the wait ended 30 s after it began");
        assert_eq!(outcome, Ok(RecallEmbedding::Timeout));
    }
}

#[async_trait]
impl QueryEmbedder for RecallEmbedder {
    async fn query_vector(&self, text: &str, cancel: &CancellationToken) -> crate::memory::error::Result<Option<Vec<f32>>> {
        self.query_vector_with_wait(text, cancel, cold_embed_wait()).await
    }
}
