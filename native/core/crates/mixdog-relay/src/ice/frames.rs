//! The `ice-servers-request` frame of the desktop leg (`requestIceServers` of `lib/ice-legs.mjs`).
//!
//! ```text
//! desktop -> relay: { type: 'ice-servers-request', requestId }
//! relay -> desktop: { type: 'ice-servers', requestId, ok: true, servers, ttlSeconds, expiresAt, remainingMs }
//!                or { type: 'ice-servers', requestId, ok: false, error: 'not-paired' | 'rate-limited', stun, retryAfterMs? }
//! ```
//!
//! The desktop leg is the only way to ask: a phone's side of the connection travels end-to-end encrypted through its desktop and
//! never asks this relay. A device that has paired no phone is refused (a TURN relay moves traffic at this host's expense). A request
//! whose id is not a routing id gets no answer: an id too long to be one is not echoed back, truncated or otherwise. The limit is
//! counted in memory, so a restart resets it.

use std::sync::{Arc, Mutex, PoisonError};

use serde_json::Value;

use super::{IceRefusal, IceService, TurnConfig};
use crate::ids::is_routing_id;
use crate::legs::dispatch::{CapabilityOffer, Dispatch, Handler, HandlerFuture, LegCall, Rejected};
use crate::logline;
use crate::rate_limit::now_ms;

/// The answer to one request, or none when the request is not one the desktop mints.
fn answer(service: &Mutex<IceService>, call: &LegCall) -> Option<Value> {
    let request_id = call.message.get("requestId").and_then(Value::as_str).filter(|id| is_routing_id(id))?;
    let device_id = call.device_id.as_str();
    let mut service = service.lock().unwrap_or_else(PoisonError::into_inner);
    let refuse = |service: &IceService, refusal: IceRefusal, retry_after_ms: Option<i64>| {
        logline::emit(&logline::ice_servers_refused(refusal.name(), device_id));
        service.refusal_reply(request_id, refusal, retry_after_ms)
    };
    if call.hub.store().list_clients(device_id, &|_| false).is_empty() {
        return Some(refuse(&service, IceRefusal::NotPaired, None));
    }
    if !service.limiter.allow(device_id) {
        let wait = service.limiter.retry_after_ms(device_id);
        return Some(refuse(&service, IceRefusal::RateLimited, Some(wait)));
    }
    logline::emit(&logline::ice_servers_issued(device_id));
    let issue = service.issue(device_id, now_ms());
    Some(IceService::issued_reply(request_id, &issue))
}

/// Registers ICE issuance with the desktop leg for a relay that has TURN settings: the `ice` capability and the request frame. A
/// relay without them registers nothing, so it advertises nothing and never answers.
pub fn register(dispatch: &Dispatch, config: TurnConfig) -> Result<(), Rejected> {
    let service = Arc::new(Mutex::new(IceService::new(config)));
    dispatch.register_capability(Arc::new(|| CapabilityOffer { ice: true, ..CapabilityOffer::default() }));
    let handler: Handler = Arc::new(move |call: LegCall| -> HandlerFuture {
        let service = Arc::clone(&service);
        Box::pin(async move {
            if let Some(reply) = answer(&service, &call) {
                call.hub.send_to_desktop(&call.device_id, &reply);
            }
        })
    });
    dispatch.register("ice-servers-request", handler)
}
