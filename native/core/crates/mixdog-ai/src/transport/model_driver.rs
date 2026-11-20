//! The one driver of a model exchange's phase deadlines, at the transport boundary: wrapped around the injected
//! [`HttpSend`], so no adapter, mock or other implementation can bypass it. Every model submission passes through
//! [`ModelDriver::send`] (or, for a WebSocket request, [`ModelCall::begin`]), which begins the attempt's own clock
//! ([`SendIdentity::begin_attempt`]) and then governs connect, send and head, and the body or frames that follow, against the
//! deadline the clock has installed for the phase the attempt is in. Adapters report decoded payload and semantic boundaries
//! on the attempt; they keep protocol detection, the classification of an expiry and the retry bookkeeping, and run no timer of
//! their own. Operations that are not model attempts (token refreshes, pings, cache management, listings) use
//! [`ModelDriver::aux`] and begin none.
//!
//! One expiry gives one failure: the adapter's classification of the phase that expired, counted once. A failure that was
//! already decoded is never replaced by a later timeout: a body that has data ready answers before its deadline is looked at.

use std::future::Future;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::provider::AttemptHandle;
use mixdog_core_api::domain::provider::AttemptPhase;
use mixdog_core_api::domain::provider::Boundary;
use mixdog_core_api::domain::provider::ConnectionInfo;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::Exposure;
use mixdog_core_api::domain::provider::PhaseOwner;
use mixdog_core_api::domain::provider::PhaseWindows;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::SendIdentity;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_rt::Liveness;

use super::link::BodyStream;
use super::link::Exchange;
use super::link::HttpResponse;
use super::link::HttpSend;

tokio::task_local! {
    /// The attempt whose transport send is being polled on this task: the transport tells it when it has its connection.
    static CONNECTING: AttemptHandle;
}

/// `work` under the attempt the task that calls this is connecting ([`crate::task_context::carry`]).
pub(crate) fn carry<F: Future>(work: F) -> impl Future<Output = F::Output> {
    mixdog_rt::within_local(&CONNECTING, CONNECTING.try_with(Clone::clone).ok(), work)
}

/// The transport has the connection the request in flight goes out on: the attempt being sent on this task stops connecting
/// and the provider's silence is timed from now. Outside a driven send it does nothing.
pub(crate) fn connected() {
    let _ = CONNECTING.try_with(|attempt| attempt.observe(Boundary::Connected));
}

/// A phase's deadline passed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Expiry {
    pub phase: AttemptPhase,
    pub window: Duration,
    pub source: PhaseOwner,
}

/// The adapter's failure for an expiry: its protocol's message and code, the delivery state the exchange had reached and what
/// the decoder says was exposed. It also does the adapter's retry bookkeeping (a first-byte count), so the driver calls it once
/// per expiry.
pub type Classify = Arc<dyn Fn(Expiry, DeliveryState, Exposure) -> ProviderError + Send + Sync>;

/// What one model submission is: the send it belongs to, the windows its provider declares (the rest fall back to the common
/// policy) and how its expiries read.
#[derive(Clone)]
pub struct ModelCall {
    identity: SendIdentity,
    windows: PhaseWindows,
    recovery: bool,
    classify: Classify,
}

impl ModelCall {
    pub fn new(identity: &SendIdentity, windows: PhaseWindows, classify: Classify) -> Self {
        Self { identity: identity.clone(), windows, recovery: false, classify }
    }

    /// The non-streaming recovery: one generation total over head and whole body, with no head phase to reset it.
    pub fn recovery(mut self) -> Self {
        self.recovery = true;
        self
    }

    /// Begins the attempt: a fresh identity and a full window, whatever attempt came before.
    pub fn begin(&self) -> ModelAttempt {
        ModelAttempt { handle: self.identity.begin_attempt(self.windows, self.recovery), classify: Arc::clone(&self.classify) }
    }

    /// [`Self::begin`] over a transport that reports its connection: a streaming attempt starts connecting (a recovery's
    /// generation total covers its connection as it covers its head).
    fn begin_on(&self, transport: &dyn HttpSend) -> ModelAttempt {
        if self.recovery || !transport.reports_connection() {
            return self.begin();
        }
        ModelAttempt { handle: self.identity.begin_connecting_attempt(self.windows), classify: Arc::clone(&self.classify) }
    }
}

/// One attempt as the driver enforces it. It is the attempt's one owner: every exit retires it (an expiry, a transport failure, a clean
/// end, and, as the last resort, being dropped with the body, the future or the WebSocket exchange that held it), so no finished
/// attempt stays open in a phase.
pub struct ModelAttempt {
    handle: AttemptHandle,
    classify: Classify,
}

impl ModelAttempt {
    /// The handle adapters report decoded payload and semantic boundaries on.
    pub fn handle(&self) -> &AttemptHandle {
        &self.handle
    }

    /// `op` against the deadline of the phase the attempt is in: `Err` when it passed first. An attempt a later one replaced, or
    /// one that retired, has no deadline and `op` runs on.
    pub async fn bound<T>(&self, op: impl Future<Output = T>) -> Result<T, Expiry> {
        let mut op = std::pin::pin!(op);
        loop {
            let Some(ctx) = self.handle.context() else { return Ok(op.await) };
            let Some(deadline) = ctx.deadline else { return Ok(op.await) };
            if let Some(done) = deadline.bound(&mut op).await {
                return Ok(done);
            }
            match self.handle.context() {
                Some(now) if now.deadline != Some(deadline) => {}
                Some(now) => return Err(Expiry { phase: now.phase, window: now.window, source: now.source }),
                None => return Ok(op.await),
            }
        }
    }

    /// The failure of `expiry`; the attempt retires with it. A connection that never came is the transport's failure, never the
    /// provider's silence: the adapter's classification (and its first-byte bookkeeping) is for the provider's phases only.
    pub fn error(&self, expiry: Expiry, delivery: DeliveryState, exposure: Exposure) -> ProviderError {
        self.handle.observe(Boundary::AttemptFailed);
        if expiry.phase == AttemptPhase::Connect {
            let mut err = ProviderError::transport(TransportFault::Connect { os_code: None }, DeliveryState::NotSent);
            err.code = Some("UND_ERR_CONNECT_TIMEOUT".into());
            err.message = format!("Connect Timeout Error (no connection within {}ms)", expiry.window.as_millis());
            err.timed_out = true;
            return err;
        }
        (self.classify)(expiry, delivery, exposure)
    }

    /// The response head arrived: the payload wait begins. The transport mark is health information the adapter raises for the
    /// statuses its protocol marks; it moves no phase.
    pub fn head_received(&self) {
        self.handle.observe(Boundary::HeadReceived);
    }

    /// The response ended cleanly or failed outside the driver's timers: no deadline remains.
    pub fn end(&self) {
        self.handle.observe(Boundary::AttemptEnded);
    }

    pub fn fail(&self) {
        self.handle.observe(Boundary::AttemptFailed);
    }
}

impl Drop for ModelAttempt {
    fn drop(&mut self) {
        // A no-op once the attempt retired or a later one replaced it.
        self.handle.observe(Boundary::AttemptEnded);
    }
}

/// The transport an adapter sends model exchanges through.
#[derive(Clone)]
pub struct ModelDriver {
    transport: Arc<dyn HttpSend>,
}

impl ModelDriver {
    pub fn new(transport: Arc<dyn HttpSend>) -> Self {
        Self { transport }
    }

    /// The transport for what is not a model attempt: it begins none and is timed by the call's own `Exchange`.
    pub fn aux(&self) -> &dyn HttpSend {
        &*self.transport
    }

    /// One model submission: its own attempt (the handle returned reports the response's boundaries), governed from connect to the last body byte. The `exchange`'s own liveness is
    /// folded into the attempt's phase windows, not left running underneath them.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    pub async fn send(&self, call: &ModelCall, request: WireRequest, exchange: Exchange) -> Result<(HttpResponse, AttemptHandle), ProviderError> {
        let attempt = call.begin_on(&*self.transport);
        let exchange = Exchange { liveness: Liveness::cancel_only(), ..exchange };
        let response = match attempt.bound(CONNECTING.scope(attempt.handle.clone(), self.transport.send(request, exchange))).await {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                attempt.fail();
                return Err(error);
            }
            // Still connecting: nothing was sent, and the provider was never waited on.
            Err(expiry) if expiry.phase == AttemptPhase::Connect => return Err(attempt.error(expiry, DeliveryState::NotSent, Exposure::default())),
            Err(expiry) => return Err(attempt.error(expiry, DeliveryState::Ambiguous, Exposure::default())),
        };
        attempt.head_received();
        let handle = attempt.handle.clone();
        Ok((HttpResponse { body: Box::new(DrivenBody { inner: response.body, attempt, expiry: None, failure: OnceLock::new(), done: false }), ..response }, handle))
    }
}

/// A response body whose reads wait under the attempt's current deadline. It is terminal once: it yields its one terminal result (the
/// deadline's expiry, the wire's fault, or the end of the body) and returns `None` for ever after, without polling the underlying
/// body again; the attempt retires when it terminates, whether or not anyone asks for the expiry's failure.
pub struct DrivenBody {
    inner: Box<dyn BodyStream>,
    attempt: ModelAttempt,
    expiry: Option<Expiry>,
    failure: OnceLock<ProviderError>,
    done: bool,
}

#[async_trait]
impl BodyStream for DrivenBody {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        if self.done {
            return None;
        }
        match self.attempt.bound(self.inner.next()).await {
            Ok(None) => {
                self.done = true;
                self.attempt.end();
                None
            }
            Ok(Some(Err(fault))) => {
                self.done = true;
                self.attempt.fail();
                Some(Err(fault))
            }
            Ok(read) => read,
            Err(expiry) => {
                self.done = true;
                self.expiry = Some(expiry);
                self.attempt.fail();
                Some(Err(TransportFault::Io { os_code: None }))
            }
        }
    }

    fn hold_connection(&mut self) {
        self.inner.hold_connection();
    }

    fn connection(&self) -> Option<ConnectionInfo> {
        self.inner.connection()
    }

    fn expired(&self, exposure: Exposure) -> Option<ProviderError> {
        let expiry = self.expiry?;
        Some(self.failure.get_or_init(|| self.attempt.error(expiry, DeliveryState::Accepted, exposure)).clone())
    }
}