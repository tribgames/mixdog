//! `embedRecallQuery` (`recall-embedding-readiness.mjs:28-68`): the vector of a recall query. A ready model embeds at once; a cold one
//! that can warm up is warmed while the recall waits at most `wait` (`MIXDOG_RECALL_COLD_EMBED_WAIT_MS`, 3 s); past that the recall
//! goes on lexically and the warmup keeps running, its late failure reported. A cancelled request ends the wait at once.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
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
pub enum RecallEmbedding<E> {
    Ready(Vec<f32>),
    Warmed(Vec<f32>),
    Empty,
    Unavailable,
    Timeout,
    Failed(E),
}

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
pub struct EmbedRequest {
    pub priority: bool,
    pub input_type: crate::memory::embed::config::InputType,
}

const QUERY: EmbedRequest = EmbedRequest { priority: true, input_type: crate::memory::embed::config::InputType::Query };

/// The embedder as the recall's wait sees it (Node's `isReady` / `canWarmup` / `warmup` / `embed` / `onWarmupError`).
#[async_trait]
pub trait ColdEmbed: Send + Sync + 'static {
    type Error: Clone + Send + 'static;
    fn is_ready(&self) -> bool;
    fn can_warmup(&self) -> bool;
    /// Loads the model; the returned work runs on after a recall stops waiting for it.
    fn warmup(&self) -> BoxFuture<'static, Result<(), Self::Error>>;
    /// `embed(clean, { priority: true, inputType: 'query' })`.
    async fn embed(&self, text: &str, request: EmbedRequest) -> Result<Vec<f32>, Self::Error>;
    fn on_warmup_error(&self, error: &Self::Error);
}

/// `embedRecallQuery(query, { …, signal, waitMs })`. `cancel` is the request's signal and `abort_reason` its reason (`abortReason`).
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
        return Ok(RecallEmbedding::Ready(embedder.embed(clean, QUERY).await?));
    }
    if !embedder.can_warmup() {
        return Ok(RecallEmbedding::Unavailable);
    }
    let deadline = tokio::time::Instant::now() + wait;
    timer_event(TimerEvent::Armed(wait));
    // `setTimeout(…, waitMs)` fires on a later turn than the warmup's continuation: a zero wait still lets an already-settled warmup win.
    let timer = async move {
        tokio::task::yield_now().await;
        tokio::time::sleep_until(deadline).await;
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
        tokio::spawn(async move {
            if let Err(error) = running.await
                && report
            {
                embedder.on_warmup_error(&error);
            }
        });
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
        Raced::Settled(Ok(())) => Ok(RecallEmbedding::Warmed(embedder.embed(clean, QUERY).await?)),
    }
}

/// The wait's timer as a replay observes it (Node's recorder wraps `setTimeout` / `clearTimeout`).
#[derive(Debug, Clone, Copy, PartialEq)]
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

fn timer_event(event: TimerEvent) {
    #[cfg(test)]
    TIMER_SEAM.with(|seam| {
        if let Some(seam) = seam.borrow().clone() {
            seam(event);
        }
    });
    let _ = event;
}

/// The product's embedder for recall: the provider, warmable on demand unless this process is secondary
/// (`embeddingOnDemandCanStart`, `memory-config-flags.mjs:53`).
#[derive(Clone)]
pub struct RecallEmbedder {
    provider: Arc<EmbeddingProvider>,
    can_warmup: bool,
}

impl RecallEmbedder {
    pub fn new(provider: Arc<EmbeddingProvider>, secondary: bool) -> Self {
        Self { provider, can_warmup: crate::tool_state::onnx_runtime_supported() && !secondary }
    }
}

#[async_trait]
impl ColdEmbed for RecallEmbedder {
    type Error = String;

    fn is_ready(&self) -> bool {
        self.provider.is_ready()
    }

    fn can_warmup(&self) -> bool {
        self.can_warmup
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

#[async_trait]
impl QueryEmbedder for RecallEmbedder {
    /// `embedQuery(retrievalQuery, signal, …)` (`query-hybrid-search.mjs:39-52`): the request's signal ends the cold wait at once and the
    /// recall with it (`abortReason(signal)`); the warmup goes on. An embed failure leaves the recall lexical, as Node's `embedText` answers.
    async fn query_vector(&self, text: &str, cancel: &CancellationToken) -> crate::memory::error::Result<Option<Vec<f32>>> {
        let embedder = Arc::new(self.clone());
        let aborted = || crate::memory::recall::aborted().message();
        match embed_recall_query(&embedder, Some(text), cold_embed_wait(), cancel, aborted).await {
            Ok(embedding) => Ok(embedding.into_vector().filter(|vector| !vector.is_empty())),
            Err(_) if cancel.is_cancelled() => Err(crate::memory::recall::aborted()),
            Err(_) => Ok(None),
        }
    }
}
