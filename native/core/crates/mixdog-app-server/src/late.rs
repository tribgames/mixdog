//! The core's `ServerRequestSink` when the server does not exist yet.
//!
//! Compose builds the core before the server. It is handed one [`LateServerRequests`]; the
//! server's router is bound to it exactly once, when the server is built. There is one path:
//! until the bind, calls are kept in order and replayed to the router at the bind, so none is
//! lost and none is answered some other way.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;

use bytes::Bytes;
use mixdog_core_api::CoreError;
use mixdog_core_api::ServerRequestSink;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::ServerRequestId;
use mixdog_core_api::server_request::PendingServerRequest;

/// A second [`LateServerRequests::bind`].
#[derive(Debug, PartialEq, Eq)]
pub struct AlreadyBound;

impl std::fmt::Display for AlreadyBound {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the server-request sink is already bound")
    }
}

impl std::error::Error for AlreadyBound {}

enum Call {
    Publish(PendingServerRequest),
    Resolved(ServerRequestId, Bytes),
    Rejected(ConnectionId, CoreError),
}

enum State {
    Waiting(Vec<Call>),
    Bound(Arc<dyn ServerRequestSink>),
}

pub struct LateServerRequests {
    state: Mutex<State>,
}

impl LateServerRequests {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State::Waiting(Vec::new())),
        })
    }

    /// Binds the server's router and replays what the core sent before it, in order. A second
    /// bind is refused and changes nothing.
    pub fn bind(&self, sink: Arc<dyn ServerRequestSink>) -> Result<(), AlreadyBound> {
        let mut state = self.lock();
        let State::Waiting(calls) = &mut *state else {
            return Err(AlreadyBound);
        };
        // Replayed under the lock so a concurrent call cannot overtake an earlier one.
        for call in std::mem::take(calls) {
            match call {
                Call::Publish(req) => sink.publish(req),
                Call::Resolved(id, frame) => sink.resolved(&id, frame),
                Call::Rejected(to, error) => sink.response_rejected(to, error),
            }
        }
        *state = State::Bound(sink);
        Ok(())
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Keeps `call` when waiting; otherwise gives back the bound sink to call outside the lock.
    fn route(&self, call: Call) -> Option<Arc<dyn ServerRequestSink>> {
        match &mut *self.lock() {
            State::Waiting(calls) => {
                calls.push(call);
                None
            }
            State::Bound(sink) => Some(sink.clone()),
        }
    }
}

impl ServerRequestSink for LateServerRequests {
    fn publish(&self, req: PendingServerRequest) {
        if let Some(sink) = self.route(Call::Publish(req.clone())) {
            sink.publish(req);
        }
    }

    fn resolved(&self, id: &ServerRequestId, frame: Bytes) {
        if let Some(sink) = self.route(Call::Resolved(id.clone(), frame.clone())) {
            sink.resolved(id, frame);
        }
    }

    fn response_rejected(&self, to: ConnectionId, error: CoreError) {
        if let Some(sink) = self.route(Call::Rejected(to, error.clone())) {
            sink.response_rejected(to, error);
        }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::ids::Method;
    use mixdog_core_api::mock::MockServerRequests;
    use mixdog_core_api::mock::ServerRequestEvent;

    use super::*;

    fn request(id: &str) -> PendingServerRequest {
        PendingServerRequest {
            id: ServerRequestId(id.into()),
            method: Method("item/tool/requestApproval"),
            thread: "t1".into(),
            surface: "t1".into(),
            order: 1,
            frame: Bytes::from_static(b"{}"),
        }
    }

    #[test]
    fn calls_before_the_bind_reach_the_router_in_order_and_later_ones_go_straight() {
        let late = LateServerRequests::new();
        late.publish(request("a"));
        late.resolved(&ServerRequestId("a".into()), Bytes::from_static(b"r"));
        late.publish(request("b"));

        let router = Arc::new(MockServerRequests::default());
        late.bind(router.clone()).expect("first bind");
        late.publish(request("c"));

        assert_eq!(
            router.events(),
            vec![
                ServerRequestEvent::Published(request("a")),
                ServerRequestEvent::Resolved(ServerRequestId("a".into()), Bytes::from_static(b"r")),
                ServerRequestEvent::Published(request("b")),
                ServerRequestEvent::Published(request("c")),
            ]
        );
    }

    #[test]
    fn a_second_bind_is_refused_and_leaves_the_first_router_in_place() {
        let late = LateServerRequests::new();
        let first = Arc::new(MockServerRequests::default());
        let second = Arc::new(MockServerRequests::default());
        late.bind(first.clone()).expect("first bind");
        assert_eq!(late.bind(second.clone()), Err(AlreadyBound));

        late.publish(request("a"));
        assert_eq!(first.events().len(), 1);
        assert!(second.events().is_empty());
    }
}
