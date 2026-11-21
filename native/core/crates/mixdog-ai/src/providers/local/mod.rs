//! `mixdog-local`: the managed llama.cpp server on the Chat Completions wire. llama.cpp chat templates accept one
//! system message at position zero, so the instructions are merged on the wire copy.
#![allow(clippy::result_large_err, reason = "ProviderError is the contract's error type")]

pub mod listing;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::SendEnd;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use self::listing::InstalledModels;
use self::listing::LocalListing;
use crate::providers::compat::CompatChatCodec;
use crate::providers::compat::CompatConfig;
use crate::providers::compat::CompatProfile;
use crate::providers::compat::profile::CredentialKind;
use crate::providers::connect::rewrite::HttpAdapter;
use crate::providers::connect::rewrite::RewriteCodec;
use crate::providers::connect::rewrite::Rewriter;
use crate::providers::connect::rewrite::StaticCredential;
use crate::transport::http::HttpSend;

pub const PROVIDER_ID: &str = "mixdog-local";

fn refusal(message: &str) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
    error.message = message.to_owned();
    error
}

fn instruction_text(content: &Value) -> Result<String, ProviderError> {
    match content {
        Value::String(text) => Ok(text.clone()),
        Value::Null => Ok(String::new()),
        Value::Array(parts) => {
            let mut texts = Vec::new();
            for part in parts {
                match (part.get("type").and_then(Value::as_str), part.get("text").and_then(Value::as_str)) {
                    (Some("text"), Some(text)) => texts.push(text),
                    _ => return Err(refusal("Local Provider system instructions must contain text only.")),
                }
            }
            Ok(texts.join("\n\n"))
        }
        _ => Err(refusal("Local Provider system instructions must contain text only.")),
    }
}

/// Merges every system/developer message into one leading system message.
pub fn merge_instructions(body: &mut Value) -> Result<(), ProviderError> {
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    let mut instructions = Vec::new();
    let mut conversation = Vec::new();
    for message in messages.drain(..) {
        match message.get("role").and_then(Value::as_str) {
            Some("system" | "developer") => {
                instructions.push(instruction_text(message.get("content").unwrap_or(&Value::Null))?);
            }
            _ => conversation.push(message),
        }
    }
    if !instructions.is_empty() {
        messages.push(json!({"role": "system", "content": instructions.join("\n\n")}));
    }
    messages.extend(conversation);
    Ok(())
}

/// Merges the instructions of the Chat request into one system message.
pub struct LocalRewriter;

impl Rewriter for LocalRewriter {
    fn rewrite(&self, mut wire: WireRequest, _request: &ModelRequest) -> Result<WireRequest, ProviderError> {
        let mut body: Value = serde_json::from_slice(&wire.body).map_err(|_| refusal("Local Provider body is not JSON"))?;
        merge_instructions(&mut body)?;
        wire.body = serde_json::to_vec(&body).map_err(|_| refusal("Local Provider body is not JSON"))?;
        Ok(wire)
    }
}

/// The Chat codec aimed at the endpoint the managed runtime reported.
pub fn codec(base_url: &str) -> Arc<dyn WireCodec> {
    codec_with(base_url, Vec::new())
}

/// [`codec`] carrying the provider's configured `extraHeaders` (the inner provider takes `...this.config`).
pub fn codec_with(base_url: &str, extra_headers: Vec<(String, String)>) -> Arc<dyn WireCodec> {
    let profile = CompatProfile::plain(PROVIDER_ID, "http://127.0.0.1/v1", CredentialKind::Keyless);
    let config = CompatConfig { base_url: Some(base_url.to_owned()), extra_headers, ..CompatConfig::for_profile(&profile) };
    Arc::new(CompatChatCodec::new(profile, config))
}

/// Where the managed llama.cpp server listens once it is up (`ensureLocalProviderServer`'s `{ baseURL, apiKey }`).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Endpoint {
    pub base_url: String,
    pub api_key: String,
}

/// One request's turn in the runtime's request queue with its inference measurement (`beginLocalInference`): the slot is held
/// until this is dropped.
pub trait Inference: Send + Sync {
    /// The managed slot's stop token, shared by startup and the active exchange.
    fn startup_cancel(&self) -> Option<CancellationToken> {
        None
    }
    /// Stop waits for the active attempt to drop its body and release this lock.
    fn attempt_cleanup(&self) -> Option<Arc<tokio::sync::Semaphore>> {
        None
    }
    /// A stream event of visible progress: the first one is the first response.
    fn progress(&self, kind: &str);
    /// The request ended: the usage it reported and the failure that ended it, if any.
    fn finish(&self, input_tokens: Option<u64>, output_tokens: Option<u64>, error: Option<&str>);
}

/// The managed runtime as the registered provider needs it: the installed models, the server started (or reused)
/// for a model, and the queue every request goes through.
#[async_trait]
pub trait LocalRuntime: InstalledModels {
    /// `ensureLocalProviderServer(model)`.
    async fn ensure_server(&self, model: &str, cancel: Option<CancellationToken>) -> Result<Endpoint, ProviderError>;

    /// The loaded server has now had a chance to report what its template actually supports.
    fn supports_tools(&self, model: &str) -> Option<bool>;

    /// `runLocalProviderRequest` and `beginLocalInference(model, queuedAt)`: waits for the request slot (one request at a
    /// time, in the order they arrived; the wait is measured from this call), then starts the measurement.
    async fn begin(&self, model: &str) -> Result<Box<dyn Inference>, ProviderError>;

    /// `installedLocalProviderModels()` as of now, for `getCachedModelInfo` (read synchronously, from disk, in Node); `None`
    /// until the runtime has read them once.
    fn installed_now(&self) -> Option<Vec<Value>>;
}

/// Registry entry of `mixdog-local`: registered with no endpoint, because the server starts on a send; text-only.
pub struct RegisteredAdapter {
    id: ProviderId,
    codec: Arc<dyn WireCodec>,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    http: Arc<dyn HttpSend>,
    runtime: Arc<dyn LocalRuntime>,
    listing: LocalListing,
    current: Mutex<Option<(Endpoint, Arc<HttpAdapter>)>>,
    /// The sends in flight by send group: each holds its queue slot across its retries.
    groups: Groups,
    /// The provider's configured `extraHeaders`, sent on every request to the managed server.
    extra_headers: Vec<(String, String)>,
}

/// The unprofiled compat rows without recovery: a local server that answers 5xx surfaces after the request
/// row (about 15 s), not after minutes of recovery laps (B-11).
fn local_policy() -> RetryPolicy {
    RetryPolicy { recovery: None, ..crate::providers::compat::retry::unprofiled() }
}

impl RegisteredAdapter {
    pub fn new(http: Arc<dyn HttpSend>, runtime: Arc<dyn LocalRuntime>) -> Self {
        Self {
            id: ProviderId::from(PROVIDER_ID),
            codec: codec("http://127.0.0.1/v1"),
            policy: local_policy(),
            keepalive: KeepaliveSchedule::SPEC,
            http,
            listing: LocalListing::new(runtime.clone()),
            runtime,
            current: Mutex::new(None),
            groups: Groups::default(),
            extra_headers: Vec::new(),
        }
    }

    /// Sends `extra_headers` (the provider config's `extraHeaders`) with every request.
    #[must_use]
    pub fn with_extra_headers(mut self, extra_headers: Vec<(String, String)>) -> Self {
        self.extra_headers = extra_headers;
        self
    }

    fn inner_for(&self, endpoint: Endpoint) -> Arc<HttpAdapter> {
        let mut current = self.current.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((kept, adapter)) = current.as_ref()
            && *kept == endpoint
        {
            return adapter.clone();
        }
        let built = Arc::new(adapter(
            self.http.clone(),
            endpoint.base_url.clone(),
            &endpoint.api_key,
            self.policy.clone(),
            self.runtime.clone(),
            self.extra_headers.clone(),
        ));
        *current = Some((endpoint, built.clone()));
        built
    }
}

#[async_trait]
impl ProviderAdapter for RegisteredAdapter {
    fn id(&self) -> &ProviderId {
        &self.id
    }

    fn codec(&self) -> &dyn WireCodec {
        &*self.codec
    }

    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }

    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }

    /// The managed local runtime is text-only (1.4.5 `MixdogLocalProvider.takesImages = false`): it declares no vision, so no
    /// image is sent to it.
    async fn image_route(&self, request: &ModelRequest) -> mixdog_image_egress::route::RouteFacts {
        mixdog_image_egress::route::RouteFacts::declared(
            self.id.as_str(),
            &request.model,
            mixdog_image_egress::route::WireBranch::Local,
            mixdog_image_egress::route::Vision::No,
        )
    }

    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let group = request.options.send_group.clone();
        let state = self.send_state(&request.model, group.as_ref()).await?;
        let stop = state.inference.startup_cancel();
        let cleanup = cleanup_permit(state.inference.as_ref(), stop.as_ref()).await?;
        match self.open_stream(request, stop.as_ref()).await {
            Ok(stream) => {
                let measured =
                    Measured { inner: stream, state, group: group.map(|id| (id, self.groups.clone())), usage: None, ended: false, _cleanup: cleanup };
                match stop {
                    Some(stop) => Ok(Box::new(Interruptible::new(measured, stop))),
                    None => Ok(Box::new(measured)),
                }
            }
            Err(error) => {
                state.failed(&error.message);
                Err(error)
            }
        }
    }

    /// The send group ended without an answer: its measurement ends with the last failure and the slot is let go.
    async fn settle_send(&self, group: &str, _end: SendEnd) {
        self.release_send(group);
    }

    /// The group's guard dropped (on any exit, in or out of a runtime): the same release, which needs no runtime.
    fn release_send(&self, group: &str) {
        let state = self.groups.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(group);
        if let Some(state) = state {
            state.abandon();
        }
    }

    fn models(&self) -> Option<&dyn ModelListing> {
        Some(&self.listing)
    }

    /// `nativePdf = false`: the managed runtime is text-only.
    fn native_pdf(&self) -> bool {
        false
    }

    /// `static inputExcludesCache = false`.
    fn input_excludes_cache(&self) -> Option<bool> {
        Some(false)
    }
}

/// The state the attempts of one send group share, begun by the first attempt.
impl RegisteredAdapter {
    async fn send_state(&self, model: &str, group: Option<&String>) -> Result<Arc<SendState>, ProviderError> {
        let kept = group.and_then(|id| self.groups.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(id).cloned());
        if let Some(state) = kept {
            return Ok(state);
        }
        let state = Arc::new(SendState::new(self.runtime.begin(model).await?, group.is_some()));
        if let Some(id) = group {
            self.groups.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(id.clone(), state.clone());
        }
        Ok(state)
    }

    async fn open_stream(&self, request: Arc<ModelRequest>, stop: Option<&CancellationToken>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let endpoint = self.runtime.ensure_server(&request.model, stop.cloned()).await?;
        if let Some(error) = self.tool_refusal(&request) {
            return Err(error);
        }
        let adapter = self.inner_for(endpoint);
        match stop {
            Some(stop) => tokio::select! {
                biased;
                _ = stop.cancelled() => Err(stopped(DeliveryState::Ambiguous)),
                result = adapter.attempt(request) => result,
            },
            None => adapter.attempt(request).await,
        }
    }

    fn tool_refusal(&self, request: &ModelRequest) -> Option<ProviderError> {
        if request.tools.is_empty() || self.runtime.supports_tools(&request.model) != Some(false) {
            return None;
        }
        let row = self.runtime.installed_now();
        let name = row
            .as_ref()
            .and_then(|rows| rows.iter().find(|row| row["id"].as_str() == Some(request.model.as_str())))
            .and_then(|row| row["name"].as_str())
            .unwrap_or(&request.model);
        Some(refusal(&format!("[local-provider] {name} does not support the requested tool interface. Choose a tool-capable model.")))
    }
}

/// The lock that makes a stop wait for the active attempt to drop its body, taken unless the stop comes first.
async fn cleanup_permit(inference: &dyn Inference, stop: Option<&CancellationToken>) -> Result<Option<tokio::sync::OwnedSemaphorePermit>, ProviderError> {
    let cleanup = match (inference.attempt_cleanup(), stop) {
        (Some(cleanup), Some(stop)) => Some(tokio::select! {
            biased;
            _ = stop.cancelled() => return Err(stopped(DeliveryState::NotSent)),
            guard = cleanup.acquire_owned() => guard.expect("the cleanup gate is never closed"),
        }),
        (Some(cleanup), None) => Some(cleanup.acquire_owned().await.expect("the cleanup gate is never closed")),
        (None, _) => None,
    };
    if stop.is_some_and(CancellationToken::is_cancelled) {
        return Err(stopped(DeliveryState::NotSent));
    }
    Ok(cleanup)
}

fn stopped(delivery: DeliveryState) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::InvalidRequest, delivery);
    error.message = "aborted".into();
    error
}

type Groups = Arc<Mutex<HashMap<String, Arc<SendState>>>>;

/// One send's slot in the request queue and its measurement, shared by the attempts of the send. The slot is let go when the
/// state is dropped, which is when the send ends.
struct SendState {
    inference: Box<dyn Inference>,
    /// The attempts of a send group share it: a failure waits for the retry or `settle_send`.
    grouped: bool,
    last_error: Mutex<Option<String>>,
    done: Mutex<bool>,
}

impl SendState {
    fn new(inference: Box<dyn Inference>, grouped: bool) -> Self {
        Self { inference, grouped, last_error: Mutex::new(None), done: Mutex::new(false) }
    }

    fn end(&self, usage: Option<(u64, u64)>, error: Option<&str>) {
        let mut done = self.done.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if !std::mem::replace(&mut *done, true) {
            self.inference.finish(usage.map(|(input, _)| input), usage.map(|(_, output)| output), error);
        }
    }

    /// An attempt failed: alone it ends the measurement; in a group the retry may still answer.
    fn failed(&self, message: &str) {
        *self.last_error.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(message.to_owned());
        if !self.grouped {
            self.end(None, Some(message));
        }
    }

    /// The send ended without an answer: with the last failure, or as aborted.
    fn abandon(&self) {
        let error = self.last_error.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        self.end(None, Some(error.as_deref().unwrap_or("aborted")));
    }
}

impl Drop for SendState {
    fn drop(&mut self) {
        self.abandon();
    }
}

/// The answer's stream while it holds the request slot: visible progress, the usage and the end are the measurement's
/// (`onStreamDelta` and `measurement.finish`), and the slot is let go when the send ends.
struct Measured {
    inner: Box<dyn ModelStream>,
    state: Arc<SendState>,
    group: Option<(String, Groups)>,
    usage: Option<(u64, u64)>,
    /// The attempt ended on its own, answered or failed.
    ended: bool,
    // Drop the body before releasing the cleanup lock.
    _cleanup: Option<tokio::sync::OwnedSemaphorePermit>,
}

impl Measured {
    fn answered(&mut self) {
        self.ended = true;
        self.state.end(self.usage, None);
        if let Some((id, groups)) = self.group.take() {
            groups.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&id);
        }
    }
}

#[async_trait]
impl ModelStream for Measured {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        let item = self.inner.next().await;
        match &item {
            Some(Ok(event)) => {
                if event.progress_kind().is_some() {
                    self.state.inference.progress("progress");
                }
                match event {
                    StreamEvent::Usage(usage) => self.usage = Some((usage.input_tokens, usage.output_tokens)),
                    StreamEvent::Completed { .. } => self.answered(),
                    _ => {}
                }
            }
            Some(Err(error)) => {
                self.ended = true;
                self.state.failed(&error.message);
            }
            None => self.answered(),
        }
        item
    }

    fn delivery(&self) -> DeliveryState {
        self.inner.delivery()
    }

    fn on_wire_left(&mut self, left: Arc<dyn Fn() + Send + Sync>) {
        self.inner.on_wire_left(left);
    }
}

impl Drop for Measured {
    fn drop(&mut self) {
        // A stream dropped before its end (a cancel) is an aborted attempt.
        if !self.ended {
            self.state.failed("aborted");
        }
    }
}

type ReadItem = Option<Result<StreamEvent, ProviderError>>;
type ReadReply = tokio::sync::oneshot::Sender<ReadItem>;

/// The worker owns the body even when its consumer never polls it. Reads still follow consumer demand.
struct Interruptible {
    read: Option<tokio::sync::mpsc::Sender<ReadReply>>,
    pending: Option<tokio::sync::oneshot::Receiver<ReadItem>>,
    _leaving: tokio_util::sync::DropGuard,
    stop: CancellationToken,
    delivery: DeliveryState,
}

impl Interruptible {
    fn new(mut stream: Measured, stop: CancellationToken) -> Self {
        let delivery = stream.delivery();
        let (read, mut reads) = tokio::sync::mpsc::channel::<ReadReply>(1);
        let lifetime = stop.child_token();
        let leaving = lifetime.clone().drop_guard();
        let stopped = stop.clone();
        tokio::spawn(async move {
            loop {
                let reply = tokio::select! {
                    biased;
                    _ = lifetime.cancelled() => break,
                    reply = reads.recv() => reply,
                };
                let Some(reply) = reply else { break };
                let item = tokio::select! {
                    biased;
                    _ = lifetime.cancelled() => break,
                    item = stream.next() => item,
                };
                let ended = !matches!(&item, Some(Ok(event)) if !matches!(event, StreamEvent::Completed { .. }));
                if reply.send(item).is_err() || ended {
                    break;
                }
            }
            if stopped.is_cancelled() && !stream.ended {
                stream.ended = true;
                stream.state.end(stream.usage, Some("aborted"));
            }
        });
        Self { read: Some(read), pending: None, _leaving: leaving, stop, delivery }
    }
}

#[async_trait]
impl ModelStream for Interruptible {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        if self.pending.is_none() {
            let (reply, received) = tokio::sync::oneshot::channel();
            if self.read.as_ref()?.send(reply).await.is_err() {
                self.read = None;
                return self.stop.is_cancelled().then(|| Err(stopped(self.delivery)));
            }
            // The stream, not one poll of next(), owns the event in flight.
            self.pending = Some(received);
        }
        let received = self.pending.as_mut().expect("one read is in flight").await;
        self.pending = None;
        match received {
            Ok(item) => {
                if !matches!(&item, Some(Ok(event)) if !matches!(event, StreamEvent::Completed { .. })) {
                    self.read = None;
                }
                item
            }
            Err(_) => {
                self.read = None;
                self.stop.is_cancelled().then(|| Err(stopped(self.delivery)))
            }
        }
    }

    fn delivery(&self) -> DeliveryState {
        self.delivery
    }

    // The local HTTP decoder is a leaf: no asynchronous work follows its terminal event.
    fn on_wire_left(&mut self, _left: Arc<dyn Fn() + Send + Sync>) {}
}

/// The adapter for the endpoint the managed runtime reported for this turn.
/// Its model listing is the runtime's installed models, not the endpoint's.
pub fn adapter(
    http: Arc<dyn HttpSend>,
    base_url: String,
    api_key: &str,
    retry_policy: RetryPolicy,
    installed: Arc<dyn InstalledModels>,
    extra_headers: Vec<(String, String)>,
) -> HttpAdapter {
    let credential = (!api_key.is_empty()).then(|| ("authorization".to_owned(), format!("Bearer {api_key}")));
    HttpAdapter::new(
        ProviderId::from(PROVIDER_ID),
        Arc::new(RewriteCodec::new(codec_with(&base_url, extra_headers), LocalRewriter)),
        http,
        Arc::new(StaticCredential(credential)),
        retry_policy,
    )
    .with_listing(Arc::new(LocalListing::new(installed)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stopping_an_unpolled_stream_drops_the_body() {
        struct NoInference;
        impl Inference for NoInference {
            fn progress(&self, _: &str) {}
            fn finish(&self, _: Option<u64>, _: Option<u64>, _: Option<&str>) {}
        }
        struct Held(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for Held {
            fn drop(&mut self) {
                let _ = self.0.take().unwrap().send(());
            }
        }
        #[async_trait]
        impl ModelStream for Held {
            async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
                std::future::pending().await
            }
            fn delivery(&self) -> DeliveryState {
                DeliveryState::Accepted
            }
            fn on_wire_left(&mut self, _: Arc<dyn Fn() + Send + Sync>) {}
        }
        let (dropped, released) = tokio::sync::oneshot::channel();
        let stop = CancellationToken::new();
        let mut stream = Interruptible::new(
            Measured {
                inner: Box::new(Held(Some(dropped))),
                state: Arc::new(SendState::new(Box::new(NoInference), false)),
                group: None,
                usage: None,
                ended: false,
                _cleanup: None,
            },
            stop.clone(),
        );
        stop.cancel();
        released.await.unwrap();
        assert_eq!(stream.next().await.unwrap().unwrap_err().message, "aborted");
        assert!(stream.next().await.is_none());
    }

    #[tokio::test]
    async fn dropping_one_next_keeps_the_event_for_the_next_poll() {
        struct NoInference;
        impl Inference for NoInference {
            fn progress(&self, _: &str) {}
            fn finish(&self, _: Option<u64>, _: Option<u64>, _: Option<&str>) {}
        }
        struct PausedRead {
            entered: Arc<tokio::sync::Notify>,
            resume: Arc<tokio::sync::Notify>,
        }
        #[async_trait]
        impl ModelStream for PausedRead {
            async fn next(&mut self) -> ReadItem {
                self.entered.notify_one();
                self.resume.notified().await;
                Some(Ok(StreamEvent::TextDelta("still here".into())))
            }
            fn delivery(&self) -> DeliveryState {
                DeliveryState::Accepted
            }
            fn on_wire_left(&mut self, _: Arc<dyn Fn() + Send + Sync>) {}
        }
        let entered = Arc::new(tokio::sync::Notify::new());
        let resume = Arc::new(tokio::sync::Notify::new());
        let mut stream = Interruptible::new(
            Measured {
                inner: Box::new(PausedRead { entered: entered.clone(), resume: resume.clone() }),
                state: Arc::new(SendState::new(Box::new(NoInference), false)),
                group: None,
                usage: None,
                ended: false,
                _cleanup: None,
            },
            CancellationToken::new(),
        );
        let mut read = Box::pin(stream.next());
        tokio::select! {
            biased;
            _ = &mut read => panic!("read was not paused"),
            _ = entered.notified() => {},
        }
        drop(read);
        resume.notify_one();
        assert!(matches!(stream.next().await, Some(Ok(StreamEvent::TextDelta(text))) if text == "still here"));
    }

    #[test]
    fn instructions_merge_to_one_leading_system_message() {
        let mut body = json!({"messages": [
            {"role": "system", "content": "a"},
            {"role": "user", "content": "hi"},
            {"role": "developer", "content": [{"type": "text", "text": "b"}, {"type": "text", "text": "c"}]},
        ]});
        merge_instructions(&mut body).unwrap();
        assert_eq!(body["messages"], json!([{"role": "system", "content": "a\n\nb\n\nc"}, {"role": "user", "content": "hi"}]));
    }

    #[test]
    fn a_local_server_has_no_recovery_laps() {
        assert!(local_policy().recovery.is_none());
        assert!(crate::providers::compat::retry::unprofiled().recovery.is_some());
    }

    #[test]
    fn non_text_instructions_are_refused() {
        let mut body = json!({"messages": [{"role": "system", "content": [{"type": "image_url"}]}]});
        assert!(merge_instructions(&mut body).is_err());
    }

    struct Cold(std::sync::atomic::AtomicBool);
    impl Inference for Cold {
        fn progress(&self, _: &str) {}
        fn finish(&self, _: Option<u64>, _: Option<u64>, _: Option<&str>) {}
    }
    #[async_trait]
    impl InstalledModels for Cold {
        async fn installed(&self) -> Result<Vec<Value>, ProviderError> {
            Ok(Vec::new())
        }
    }
    #[async_trait]
    impl LocalRuntime for Cold {
        async fn ensure_server(&self, _: &str, _: Option<CancellationToken>) -> Result<Endpoint, ProviderError> {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(Endpoint { base_url: "http://127.0.0.1/v1".into(), api_key: String::new() })
        }
        async fn begin(&self, _: &str) -> Result<Box<dyn Inference>, ProviderError> {
            Ok(Box::new(Self(std::sync::atomic::AtomicBool::new(false))))
        }
        fn installed_now(&self) -> Option<Vec<Value>> {
            None
        }
        fn supports_tools(&self, _: &str) -> Option<bool> {
            self.0.load(std::sync::atomic::Ordering::SeqCst).then_some(false)
        }
    }

    fn cold_request(with_tool: bool) -> ModelRequest {
        use mixdog_core_api::domain::provider::{Content, Message, Role, ToolDefinition};
        ModelRequest {
            model: "cold".into(),
            messages: vec![Message::new(Role::User, Content::Text("hi".into()))],
            tools: if with_tool {
                vec![ToolDefinition {
                    name: "read".into(),
                    description: "Read".into(),
                    input_schema: json!({"type":"object","properties":{}}),
                    defer_loading: false,
                    freeform: None,
                }]
            } else {
                Vec::new()
            },
            options: Default::default(),
        }
    }

    fn replay_400() -> Arc<crate::providers::listing_row::testing::Replay> {
        Arc::new(crate::providers::listing_row::testing::Replay::new(|_| (400, b"{}".to_vec())))
    }

    #[tokio::test]
    async fn a_tool_refusal_learned_during_cold_start_prevents_the_post() {
        let http = replay_400();
        let adapter = RegisteredAdapter::new(http.clone(), Arc::new(Cold(std::sync::atomic::AtomicBool::new(false))));
        let error = adapter.attempt(Arc::new(cold_request(true))).await.err().expect("tools refused");
        assert_eq!(error.delivery, DeliveryState::NotSent);
        assert!(error.message.contains("does not support the requested tool interface"));
        assert!(http.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_text_only_request_still_reaches_chat_completions_after_a_tool_refusal() {
        let http = replay_400();
        let adapter = RegisteredAdapter::new(http.clone(), Arc::new(Cold(std::sync::atomic::AtomicBool::new(false))));
        let _ = adapter.attempt(Arc::new(cold_request(true))).await;
        let _ = adapter.attempt(Arc::new(cold_request(false))).await;
        assert_eq!(http.requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn the_configured_extra_headers_ride_every_request_to_the_managed_server() {
        let http = replay_400();
        let adapter = RegisteredAdapter::new(http.clone(), Arc::new(Cold(std::sync::atomic::AtomicBool::new(false))))
            .with_extra_headers(vec![("x-team".into(), "blue".into())]);
        let _ = adapter.attempt(Arc::new(cold_request(false))).await;
        let sent = http.requests.lock().unwrap()[0].clone();
        assert!(sent.headers.iter().any(|(name, value)| name.eq_ignore_ascii_case("x-team") && value == "blue"), "{:?}", sent.headers);
    }
}

/// `getCachedModelInfo`: `installedLocalProviderModels().find(entry => entry.id === model) || null`.
impl crate::catalog::CachedModelInfo for RegisteredAdapter {
    fn cached_row(&self, model: &str) -> Option<Arc<Value>> {
        self.runtime.installed_now()?.into_iter().find(|row| row.get("id").and_then(Value::as_str) == Some(model)).map(Arc::new)
    }
}
