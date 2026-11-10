//! `preconnect(origin)` (`shared/llm/http-agent.mjs:496-527`): a fire-and-forget HEAD that lands a kept-alive socket
//! before a provider's turn, once per origin and keep-alive window for the whole process (`_preconnectedAt`, a module
//! Map), whichever provider asks.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::WireRequest;

use super::deadlines::PRECONNECT;
use super::link::HttpSend;

/// `_preconnectedAt` (`shared/llm/http-agent.mjs:482`): when each origin was last warmed, per process.
static PRECONNECTED_AT: Mutex<Option<HashMap<&'static str, u64>>> = Mutex::new(None);

/// `_preconnectTtlMs()`: `MIXDOG_LLM_KEEPALIVE_MS` (60 s when unset or not a number) less 10 s, at least 5 s.
fn ttl_ms(keepalive: Option<String>) -> u64 {
    let keepalive = keepalive.and_then(|raw| raw.trim().parse::<u64>().ok()).unwrap_or(60_000);
    keepalive.saturating_sub(10_000).max(5_000)
}

/// Warms `origin` at `now` (epoch ms) unless it was warmed within the window `keepalive` (the value of
/// `MIXDOG_LLM_KEEPALIVE_MS`) gives. Any failure only clears the stamp so the next call warms again; nothing is surfaced.
pub fn preconnect(http: Arc<dyn HttpSend>, origin: &'static str, now: u64, keepalive: Option<String>) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
    let ttl = ttl_ms(keepalive);
    {
        let mut stamps = PRECONNECTED_AT.lock().unwrap_or_else(PoisonError::into_inner);
        let stamps = stamps.get_or_insert_with(HashMap::new);
        if stamps.get(origin).is_some_and(|last| now.saturating_sub(*last) < ttl) {
            return;
        }
        stamps.insert(origin, now);
    }
    let _entered = runtime.enter();
    let mut warm = Box::pin(async move {
        let head = WireRequest { transport: TransportKind::Http1, method: "HEAD".into(), url: format!("{origin}/"), headers: Vec::new(), body: Vec::new() };
        let warmed = match http.send(head, PRECONNECT).await {
            Ok(response) => response.read_all().await.is_ok(),
            Err(_) => false,
        };
        if !warmed && let Some(stamps) = PRECONNECTED_AT.lock().unwrap_or_else(PoisonError::into_inner).as_mut() {
            stamps.remove(origin);
        }
    });
    // Node's `undici.request` starts its connection inside the call, before the caller's next line; polling the warm-up
    // once here does the same, so its connection is the first one the server sees. The task then re-polls it with its
    // own waker.
    if warm.as_mut().poll(&mut std::task::Context::from_waker(std::task::Waker::noop())).is_pending() {
        runtime.spawn(warm);
    }
}
