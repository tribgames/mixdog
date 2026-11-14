//! The lifecycle, for the parts of the composition that run before it exists. `serving::start` builds the `Lifecycle` after `compose()`
//! (it needs the ports the composed core provides), and six consumers of it are made inside `compose()`: the service-call count
//! (`CoreHandle::request_started`, Node's `inFlightWork().activeCalls`, `daemon.mjs:444-449`), the memory-agent run watch
//! (`busyMemoryAgents`, `:449`, `:1064`), the fencing ownership (`Ownership::revalidate` failing moves the core to `Fenced`, LR §2.4),
//! the sessions' hold on turn starts ([`LateLifecycle::start_hold`], Node's `daemonWorkGate`), their busy turns and the running
//! background shells (`exec_events`), both running work (Node's `busySessions`, `:452`).
//! They read it through this cell, which `serving::start` binds once, before the listener accepts.
//!
//! Node's `activeCalls` also counts the model-proxy bridge's active requests (`modelProxyBridgeActive`, set by `trackWork`,
//! `daemon.mjs:743-752`, `createModelProxyBridgeServer`). Rust has no server of that bridge (no `ModelProxyBridge` in any crate), so
//! there is nothing to count yet; the port of it takes `ComposedCore::request_started` for its `trackWork`.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

use mixdog_core_api::CoreState;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::BusyHold;
use mixdog_core_session::session::CoreWork;
use mixdog_core_session::session::NoCoreWork;
use mixdog_core_session::session::StartHold;
use mixdog_protocol::ConnectionKind;
use mixdog_rt::CancellationToken;
use tokio::sync::watch;

use mixdog_core::run_host::late::Bound;

use crate::lifecycle::ActivityGuard;
use crate::lifecycle::ActivityInfo;
use crate::lifecycle::ActivityKind;
use crate::lifecycle::BUSY_WORK_SETTLED;
use crate::lifecycle::CancelRegistry;
use crate::lifecycle::CorePort;
use crate::lifecycle::DiscoveryState;
use crate::lifecycle::DrainNotice;
use crate::lifecycle::Exiter;
use crate::lifecycle::ClientKind;
use crate::lifecycle::ConnectionGuard;
use crate::lifecycle::Lifecycle;
use crate::lifecycle::LifecycleConfig;
use crate::lifecycle::Ports;
use crate::lifecycle::Publication;
use crate::lifecycle::Running;
use crate::lifecycle::new_instance_id;

/// The ports of [`LateLifecycle::bind_in_process`]: nothing to publish to, cancel or leave.
struct Inert;

impl CorePort for Inert {
    fn drain_notice(&self, _: &DrainNotice) {}
    fn health(&self, _: u64) {}
    fn cancel_running(&self, _: &[Running]) {}
    fn cut_new_tasks(&self) {}
    fn release_decision(&self, _: u32) {}
    fn final_barriers(&self) {}
    fn close_connections(&self) {}
    fn close_ext_host(&self) {}
    fn close_data_handles(&self) {}
}

impl Publication for Inert {
    fn publish(&self, _: &DiscoveryState) {}
    fn withdraw(&self) {}
}

impl Exiter for Inert {
    fn exit(&self, _: i32) {}
}

/// Where the cell says that running work started before the bind (the daemon log).
pub type WorkLog = Arc<dyn Fn(&str) + Send + Sync>;

/// The bound lifecycle, the open client connections it counts (Node's client registries: the core stops itself when the
/// last one leaves, `maybeSelfShutdown`), the sessions' copy of its hold on turn starts ([`Self::start_hold`]), the tokens
/// a confirmed stop's abort cancels the running work by ([`Self::cancels`]), and where running work that came before the bind
/// is said ([`Self::logging`]).
#[derive(Default)]
pub struct LateLifecycle(OnceLock<Arc<Lifecycle>>, Mutex<HashMap<ConnectionId, ConnectionGuard>>, watch::Sender<StartHold>, Arc<CancelRegistry>, Option<WorkLog>);

impl LateLifecycle {
    /// The cell of a composed core: running work begun before the bind is said in `log` ([`Self::begin_work`]).
    pub fn logging(log: WorkLog) -> Self {
        Self(Default::default(), Default::default(), Default::default(), Default::default(), Some(log))
    }

    /// The cancellation tokens of the running work registered here, by activity: the core port's `cancel_running` (a confirmed stop's
    /// abort) cancels them.
    pub fn cancels(&self) -> &Arc<CancelRegistry> {
        &self.3
    }

    /// `info` is running work until the returned guard drops, and the core that stops when it ends says `settled` (Node's
    /// self-shutdown text for that work: `BUSY_WORK_SETTLED`, `MEMORY_AGENT_ACTIVITY_CHANGED`). Before the bind (a startup bug: the
    /// listener accepts only after it) it is not counted, which is said in the cell's log, the one place every consumer reports it.
    pub fn begin_work(&self, info: ActivityInfo, settled: &'static str) -> Option<ActivityGuard> {
        let Some(lifecycle) = self.0.get() else {
            if let Some(log) = &self.4 {
                log(&format!("running work ({:?}: {}) started before the lifecycle was bound; it is not counted", info.kind, info.title));
            }
            return None;
        };
        Some(lifecycle.begin_activity_settling(info, settled))
    }

    pub fn bind(&self, lifecycle: Arc<Lifecycle>) -> Result<(), &'static str> {
        self.0.set(lifecycle).map_err(|_| "lifecycle")
    }

    /// The lifecycle of a core that serves no daemon (`mixdog exec` composes its core in its own process): it counts the calls in flight,
    /// while nothing publishes, cancels, exits or withdraws on its behalf: the process ends when the exec does.
    pub fn bind_in_process(&self) -> Result<(), &'static str> {
        let ports = Ports { core: Arc::new(Inert), discovery: Arc::new(Inert), exiter: Arc::new(Inert) };
        let config = LifecycleConfig { instance_id: new_instance_id(), version: env!("CARGO_PKG_VERSION").to_owned(), runtime_root: std::path::PathBuf::new() };
        self.bind(Lifecycle::new(config, ports))
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

    /// The hold on turn starts the sessions follow (`Lifecycle::hold_gate`, LR §5.1). The sessions are built before the lifecycle,
    /// so they read this copy, which [`Self::follow`] keeps at the lifecycle's hold; it reads [`StartHold::Open`] until then, and
    /// for good in a core that serves no daemon.
    pub fn start_hold(&self) -> watch::Receiver<StartHold> {
        self.2.subscribe()
    }

    /// Follows `lifecycle` (`serving::attach` spawns it): `on_state` hears each move of its state, which the composed core answers
    /// admission from, and the sessions' copy of the hold is kept at the lifecycle's (`Lifecycle::hold_gate`: closed once the drain
    /// commit dropped a hold, open again when that drain is cancelled), whose latest reading is the whole of it. Subscribed when
    /// called, so a move made before the future first runs is not missed.
    pub fn follow<F: Fn(CoreState) + Send + 'static>(self: &Arc<Self>, lifecycle: &Lifecycle, on_state: F) -> impl Future<Output = ()> + Send + 'static + use<F> {
        let (late, mut state, mut hold) = (self.clone(), lifecycle.state(), lifecycle.hold_gate());
        async move {
            loop {
                let read = *hold.borrow_and_update();
                late.2.send_if_modified(|gate| std::mem::replace(gate, read) != read);
                tokio::select! {
                    moved = state.changed() => match moved {
                        Ok(()) => on_state(state.borrow().clone()),
                        Err(_) => break,
                    },
                    moved = hold.changed() => {
                        if moved.is_err() {
                            break;
                        }
                    }
                }
            }
        }
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

/// `SessionDeps.core_work`: a busy session is a `Turn` of the lifecycle (Node's `busySessions`, `daemon.mjs:452`, which
/// `maybeSelfShutdown` defers on, `:551-560`), listed by its thread.
impl CoreWork for LateLifecycle {
    fn busy(&self, thread: &ThreadId, title: &str) -> Box<dyn BusyHold> {
        let info = ActivityInfo { kind: ActivityKind::Turn, thread_id: Some(thread.as_str().to_owned()), turn_id: None, title: title.to_owned() };
        match self.begin_work(info, BUSY_WORK_SETTLED) {
            Some(activity) => Box::new(BusySession { activity, cancels: self.3.clone() }),
            None => Box::new(NoCoreWork),
        }
    }
}

/// A busy session's activity, and the tokens its runs are cancelled by.
struct BusySession {
    activity: ActivityGuard,
    cancels: Arc<CancelRegistry>,
}

impl BusyHold for BusySession {
    fn run(&self, cancel: &CancellationToken) -> Box<dyn Send + Sync> {
        Box::new(self.cancels.track(self.activity.id(), cancel.clone()))
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

    /// Node's `maybeSelfShutdown` defers on a busy session ("A turn in flight outlives every view", `daemon.mjs:551-560`): the session's
    /// busy period is a `Turn` listed by its thread, the core stays up with nobody attached while it lasts, a stop that waits for an
    /// idle core waits for it and a confirmed abort names it to be cancelled; the core stops once it ends.
    #[test]
    fn a_busy_session_is_running_work_of_the_lifecycle() {
        use crate::lifecycle::StopMode;
        use crate::lifecycle::StopReason;
        let fx = fixture();
        fx.lifecycle.set_serving().unwrap();
        let late = LateLifecycle::default();
        late.bind(fx.lifecycle.clone()).unwrap();
        let client = fx.lifecycle.connection(ClientKind::Session);
        let busy = late.busy(&ThreadId::from("thread-1"), "a turn");
        let run = busy.run(&CancellationToken::new());
        drop(client);
        assert!(!fx.recorder.has_exited(), "the busy session keeps the core alive");
        let running = fx.lifecycle.status().running.clone();
        assert_eq!(running.len(), 1);
        assert_eq!((running[0].kind, running[0].thread_id.as_deref(), running[0].title.as_str()), (ActivityKind::Turn, Some("thread-1"), "a turn"));
        fx.lifecycle.stop(StopMode::WhenIdle, StopReason::UserStop, None).unwrap();
        assert!(!fx.recorder.has_exited(), "the user's stop waits for the turn");
        let token = fx.lifecycle.status().drain.as_ref().expect("draining").confirm_token.clone();
        fx.lifecycle.stop(StopMode::AbortConfirmed, StopReason::UserStop, Some(&token)).unwrap();
        assert_eq!(fx.recorder.cancelled().last().map(|work| work.len()), Some(1), "the abort cancels the busy session's run");
        drop(run);
        drop(busy);
        fx.recorder.wait_exit();
    }

    /// Waits for the sessions' copy of the hold to read `expected`.
    async fn reads(gate: &mut watch::Receiver<StartHold>, expected: StartHold) {
        mixdog_rt::time::timeout(std::time::Duration::from_secs(5), gate.wait_for(|hold| *hold == expected))
            .await
            .unwrap_or_else(|_| panic!("the copy of the hold never read {expected:?}"))
            .expect("the cell keeps its sender");
    }

    /// LR §5.1, as [`LateLifecycle::follow`] keeps it: the sessions' copy of the hold reads held while the lifecycle holds turn
    /// starts and open once it is released; the drain commit that drops a hold closes it with the drain's reason, so what it held
    /// is refused rather than started, and a cancelled drain opens it again, telling the core the state it is back in.
    #[tokio::test]
    async fn the_sessions_copy_of_the_hold_follows_the_lifecycle_through_a_drain_and_its_cancel() {
        use crate::lifecycle::StopMode;
        use crate::lifecycle::StopReason;
        let fx = fixture();
        fx.lifecycle.set_serving().unwrap();
        let _client = fx.lifecycle.connection(ClientKind::Session);
        let late = Arc::new(LateLifecycle::default());
        let mut gate = late.start_hold();
        let heard = Arc::new(Mutex::new(Vec::new()));
        let told = heard.clone();
        tokio::spawn(late.follow(&fx.lifecycle, move |state| told.lock().unwrap().push(state)));
        fx.lifecycle.hold(true).unwrap();
        reads(&mut gate, StartHold::Held).await;
        fx.lifecycle.hold(false).unwrap();
        reads(&mut gate, StartHold::Open).await;
        let work = fx.lifecycle.begin_activity(crate::lifecycle::ActivityInfo {
            kind: crate::lifecycle::ActivityKind::Turn,
            thread_id: Some("thread-1".into()),
            turn_id: Some("turn-1".into()),
            title: "a turn".into(),
        });
        fx.lifecycle.hold(true).unwrap();
        reads(&mut gate, StartHold::Held).await;
        fx.lifecycle.stop(StopMode::WhenIdle, StopReason::Update, None).unwrap();
        reads(&mut gate, StartHold::Closed(mixdog_protocol::DrainReason::Update)).await;
        let drain_id = fx.lifecycle.status().drain.as_ref().expect("draining").drain_id.clone();
        fx.lifecycle.cancel_drain(&drain_id).unwrap();
        reads(&mut gate, StartHold::Open).await;
        assert_eq!(heard.lock().unwrap().last(), Some(&CoreState::Serving), "the core is told it serves again");
        fx.lifecycle.stop(StopMode::WhenIdle, StopReason::Update, None).unwrap();
        drop(work);
        fx.recorder.wait_exit();
    }

    /// A hold released and a drain committed before the follower wakes again: the copy reads open, so the client prompts the
    /// release let go start and an in-core start that waited is admitted, rather than being refused as starts the commit held.
    #[tokio::test]
    async fn a_release_and_a_drain_commit_in_one_wake_leave_the_starts_open() {
        use crate::lifecycle::StopMode;
        use crate::lifecycle::StopReason;
        let fx = fixture();
        fx.lifecycle.set_serving().unwrap();
        let _client = fx.lifecycle.connection(ClientKind::Session);
        let work = fx.lifecycle.begin_activity(crate::lifecycle::ActivityInfo {
            kind: crate::lifecycle::ActivityKind::Turn,
            thread_id: Some("thread-1".into()),
            turn_id: Some("turn-1".into()),
            title: "a turn".into(),
        });
        let late = Arc::new(LateLifecycle::default());
        let mut gate = late.start_hold();
        tokio::spawn(late.follow(&fx.lifecycle, |_| {}));
        fx.lifecycle.hold(true).unwrap();
        reads(&mut gate, StartHold::Held).await;
        // Both moves with no await between: the follower, on this test's one thread, wakes once after them.
        fx.lifecycle.hold(false).unwrap();
        fx.lifecycle.stop(StopMode::WhenIdle, StopReason::Update, None).unwrap();
        reads(&mut gate, StartHold::Open).await;
        assert_eq!(*fx.lifecycle.state().borrow(), CoreState::Draining { reason: mixdog_protocol::DrainReason::Update });
        drop(work);
        fx.recorder.wait_exit();
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
