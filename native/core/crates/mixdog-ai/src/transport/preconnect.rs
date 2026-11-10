//! `preconnect(origin)` (`shared/llm/http-agent.mjs:482-527`): a fire-and-forget `HEAD` to an origin that lands a
//! connection before a provider's first request, gated per origin by one process-wide map of when each origin was last
//! warmed (`_preconnectedAt`). The gate is `MIXDOG_LLM_KEEPALIVE_MS` (60 s) less 10 s, at least 5 s. Any failure only
//! clears the origin's stamp so the next call warms again; nothing is surfaced.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::WireRequest;

use super::HttpSend;
use super::deadlines::PRECONNECT;

/// `_preconnectedAt`: when each origin was last warmed, for the whole process.
static PRECONNECTED_AT: Mutex<Option<HashMap<&'static str, u64>>> = Mutex::new(None);

/// No origin warmed yet, as in a new process.
#[cfg(any(test, feature = "test-support"))]
pub(crate) fn reset() {
    *PRECONNECTED_AT.lock().unwrap_or_else(PoisonError::into_inner) = None;
}

/// What a warm-up reads: its clock and the process setting of the keep-alive window.
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;
pub type Setting = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// The warm-up a provider runs at construction and before its sends, over the provider's own transport.
#[derive(Clone)]
pub struct Preconnect {
    http: Arc<dyn HttpSend>,
    now: Clock,
    var: Setting,
}

impl Preconnect {
    pub fn new(http: Arc<dyn HttpSend>, now: Clock, var: Setting) -> Self {
        Self { http, now, var }
    }

    /// Warms `origin` unless it was warmed within the gate.
    pub fn warm(&self, origin: &'static str) {
        preconnect(&self.http, origin, (self.now)(), (self.var)("MIXDOG_LLM_KEEPALIVE_MS"));
    }
}

/// [`Preconnect::warm`] with the clock reading and the keep-alive setting given.
pub fn preconnect(http: &Arc<dyn HttpSend>, origin: &'static str, now: u64, keepalive: Option<String>) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
    let keepalive = keepalive.and_then(|raw| raw.trim().parse::<u64>().ok()).unwrap_or(60_000);
    let ttl = keepalive.saturating_sub(10_000).max(5_000);
    {
        let mut stamps = PRECONNECTED_AT.lock().unwrap_or_else(PoisonError::into_inner);
        let stamps = stamps.get_or_insert_with(HashMap::new);
        if stamps.get(origin).is_some_and(|last| now.saturating_sub(*last) < ttl) {
            return;
        }
        stamps.insert(origin, now);
    }
    let http = http.clone();
    let _entered = runtime.enter();
    let mut warm = Box::pin(async move {
        let head = WireRequest { transport: TransportKind::Http1, method: "HEAD".into(), url: format!("{origin}/"), headers: Vec::new(), body: Vec::new() };
        let warmed = match http.send(head, PRECONNECT).await {
            Ok(response) => response.read_all().await.is_ok(),
            Err(_) => false,
        };
        if !warmed
            && let Some(stamps) = PRECONNECTED_AT.lock().unwrap_or_else(PoisonError::into_inner).as_mut()
        {
            stamps.remove(origin);
        }
    });
    // Node's `undici.request` starts its connection inside the call, before the caller's next line; polling the
    // warm-up once here does the same, so its connection is the first one the server sees. The task then re-polls it
    // with its own waker.
    if warm.as_mut().poll(&mut std::task::Context::from_waker(std::task::Waker::noop())).is_pending() {
        runtime.spawn(warm);
    }
}
