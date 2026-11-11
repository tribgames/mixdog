//! The lifecycle, for the parts of the composition that run before it exists. `serving::start` builds the `Lifecycle` after `compose()`
//! (it needs the ports the composed core provides), and three consumers of it are made inside `compose()`: the service-call count
//! (`CoreHandle::request_started`, Node's `inFlightWork().activeCalls`, `daemon.mjs:444-449`), the memory-agent run watch
//! (`busyMemoryAgents`, `:449`, `:1064`) and the fencing ownership (`Ownership::revalidate` failing moves the core to `Fenced`, LR §2.4).
//! They read it through this cell, which `serving::start` binds once, before the listener accepts.
//!
//! Node's `activeCalls` also counts the model-proxy bridge's active requests (`modelProxyBridgeActive`, set by `trackWork`,
//! `daemon.mjs:743-752`, `createModelProxyBridgeServer`). Rust has no server of that bridge (no `ModelProxyBridge` in any crate), so
//! there is nothing to count yet; the port of it takes `ComposedCore::request_started` for its `trackWork`.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

use mixdog_core_api::ids::ConnectionId;
use mixdog_protocol::ConnectionKind;

use mixdog_core::run_host::late::Bound;

use crate::lifecycle::ClientKind;
use crate::lifecycle::ConnectionGuard;
use crate::lifecycle::Lifecycle;

/// The bound lifecycle, and the open client connections it counts (Node's client registries: the core stops itself when the
/// last one leaves, `maybeSelfShutdown`).
#[derive(Default)]
pub struct LateLifecycle(OnceLock<Arc<Lifecycle>>, Mutex<HashMap<ConnectionId, ConnectionGuard>>);

impl LateLifecycle {
    pub fn bind(&self, lifecycle: Arc<Lifecycle>) -> Result<(), &'static str> {
        self.0.set(lifecycle).map_err(|_| "lifecycle")
    }

    /// `None` before the bind: a startup bug (the listener accepts only after it), which each reader reports in its own words.
    pub fn get(&self) -> Option<&Arc<Lifecycle>> {
        self.0.get()
    }

    /// A client connection finished its handshake (`CoreHandle::connection_opened`): counted until [`Self::client_closed`].
    pub fn client_opened(&self, connection: ConnectionId, kind: ConnectionKind) -> Result<(), &'static str> {
        let lifecycle = self.0.get().ok_or("a connection opened before the lifecycle was bound; it is not counted")?;
        let guard = lifecycle.connection(client_kind(kind));
        self.1.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(connection, guard);
        Ok(())
    }

    /// The connection closed (`CoreHandle::connection_closed`); the last one to leave lets the core stop itself.
    pub fn client_closed(&self, connection: ConnectionId) {
        let guard = self.1.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&connection);
        drop(guard);
    }
}

/// The registry a connection is in on Node's side: the channel bridge's, the remote clients' (phone, remote desktop), or the
/// session transport's.
fn client_kind(kind: ConnectionKind) -> ClientKind {
    match kind {
        ConnectionKind::ChannelBridge => ClientKind::Channel,
        ConnectionKind::RemoteDesktop | ConnectionKind::Phone => ClientKind::Remote,
        ConnectionKind::Desktop | ConnectionKind::Tui | ConnectionKind::Cli => ClientKind::Session,
    }
}

impl Bound for LateLifecycle {
    fn cell(&self) -> &'static str {
        "lifecycle"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifecycle::ClientKind;
    use crate::lifecycle::testing::fixture;

    #[test]
    fn a_call_in_flight_keeps_an_unattended_core_alive_and_the_last_one_ends_it_with_nodes_text() {
        let fx = fixture();
        fx.lifecycle.set_serving().unwrap();
        let late = LateLifecycle::default();
        assert!(late.get().is_none());
        late.bind(fx.lifecycle.clone()).unwrap();
        assert!(late.bind(fx.lifecycle.clone()).is_err(), "bound once");
        let client = fx.lifecycle.connection(ClientKind::Session);
        let call = late.get().unwrap().begin_call();
        drop(client);
        assert!(!fx.recorder.has_exited(), "the call keeps the core alive");
        drop(call);
        fx.recorder.wait_exit();
        let events = fx.recorder.events();
        assert!(events.iter().any(|e| e == "release_started:service calls settled"), "{events:?}");
    }

    fn recorded(path: &str) -> serde_json::Value {
        let path = format!("{}/../../fixtures/{path}", env!("CARGO_MANIFEST_DIR"));
        #[allow(clippy::disallowed_methods, reason = "the recording is read at run time")]
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
        serde_json::from_str(&text).unwrap()
    }

    fn released(events: &[String]) -> Vec<&str> {
        events.iter().filter_map(|e| e.strip_prefix("release_started:")).collect()
    }

    /// `session-transport-state-lanes` case 428: an external client and an in-daemon one attach; the in-daemon one does not hold
    /// the daemon's lifetime, so the external one closing empties the clients. Each recorded step is compared whole as the core
    /// has it after the same calls the server makes at handshake and close (`ComposedCore::connection_opened` /
    /// `connection_closed` -> `client_opened` / `client_closed`): `clientCount` is the lifecycle's client count, `clientsEmpty`
    /// is the self-stop with Node's text. Node's `connectionCount` also counts its in-daemon transport connection
    /// (`lifecycle:false`); the core's in-daemon callers send through `CallContext::internal`, never a connection, which the
    /// manifest declares: it is the external connections alone here.
    #[test]
    fn the_last_client_connection_closing_stops_the_core_as_nodes_clients_empty() {
        let recording = recorded("session-transport-state-lanes/recording.json");
        let node = recording["cases"].as_array().unwrap().iter().find(|case| case["testLine"] == 428).unwrap();
        let fx = fixture();
        fx.lifecycle.set_serving().unwrap();
        let late = LateLifecycle::default();
        assert!(late.client_opened(ConnectionId(1), ConnectionKind::Desktop).is_err(), "not counted before the bind");
        late.bind(fx.lifecycle.clone()).unwrap();
        let state = |late: &LateLifecycle, fx: &crate::lifecycle::testing::Fixture| {
            let empty = released(&fx.recorder.events()).contains(&"no live session clients");
            serde_json::json!({ "clientCount": late.get().unwrap().status().clients, "connectionCount": late.get().unwrap().status().clients, "clientsEmpty": if empty { serde_json::json!("empty") } else { serde_json::Value::Null } })
        };
        let in_daemon = |step: &serde_json::Value| {
            let mut step = step.clone();
            step["connectionCount"] = serde_json::json!(step["connectionCount"].as_u64().unwrap() - 1);
            step.as_object_mut().unwrap().remove("step");
            step
        };
        let steps = node["result"]["steps"].as_array().unwrap();
        late.client_opened(ConnectionId(2), ConnectionKind::Desktop).unwrap();
        assert_eq!(state(&late, &fx), in_daemon(&steps[0]), "{}", steps[0]["step"]);
        late.client_closed(ConnectionId(2));
        fx.recorder.wait_exit();
        assert_eq!(state(&late, &fx), in_daemon(&steps[1]), "{}", steps[1]["step"]);
        assert_eq!(steps.len(), 2);
    }

    /// Node's `POST /shutdown` with and without a client attached (`fixtures/self-shutdown-deferral`), with the clients attached
    /// through the connection entry the server calls (`client_opened` / `client_closed`): a request with a client is put off
    /// with the clients kept, and the stop that ends each case carries the text Node logged. Each case's outcome is compared
    /// whole: whether the core is alive after the request, the clients it counts, the stop it ended with.
    #[test]
    fn a_quit_waits_for_the_counted_connections_as_node_s_shutdown_does() {
        use crate::lifecycle::StopMode;
        use crate::lifecycle::StopReason;
        let twin = recorded("self-shutdown-deferral/twin.json");
        let reason_of = |line: &str| line.split_once('(').and_then(|(_, rest)| rest.split_once(')')).map(|(reason, _)| reason.to_owned()).unwrap();
        for case in twin["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let fx = fixture();
            fx.lifecycle.set_serving().unwrap();
            let late = LateLifecycle::default();
            late.bind(fx.lifecycle.clone()).unwrap();
            let clients = case["clients"].as_u64().unwrap();
            for n in 0..clients {
                late.client_opened(ConnectionId(n), ConnectionKind::Desktop).unwrap();
            }
            let work = case["running"].is_string().then(|| fx.lifecycle.begin_activity(crate::lifecycle::ActivityInfo {
                kind: crate::lifecycle::ActivityKind::Turn,
                thread_id: Some("thread-1".into()),
                turn_id: Some("turn-1".into()),
                title: "a turn".into(),
            }));
            fx.lifecycle.request_stop(StopMode::WhenIdle, StopReason::Quit, None).unwrap();
            let counted = fx.lifecycle.status().clients;
            let alive = clients > 0 && !fx.recorder.has_exited();
            for n in 0..clients {
                late.client_closed(ConnectionId(n));
            }
            drop(work);
            fx.recorder.wait_exit();
            let ended = case["log"].as_array().unwrap().iter().filter_map(|l| l.as_str()).rfind(|l| l.starts_with("shutting down")).unwrap_or_else(|| case["log"][0].as_str().unwrap());
            let core = serde_json::json!({ "aliveAfter": alive, "clients": counted, "ended": released(&fx.recorder.events()) });
            let node = serde_json::json!({ "aliveAfter": case["aliveAfter"], "clients": case["clients"], "ended": [reason_of(ended)] });
            assert_eq!(core, node, "{name}");
        }
    }
}
