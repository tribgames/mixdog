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
use mixdog_protocol::Origin;
use mixdog_rt::CancellationToken;
use tokio::sync::watch;

use mixdog_core::run_host::late::Bound;

use crate::lifecycle::ActivityGuard;
use crate::lifecycle::ActivityInfo;
use crate::lifecycle::ActivityKind;
use crate::lifecycle::BUSY_WORK_SETTLED;
use crate::lifecycle::CancelRegistry;
use crate::lifecycle::ClientKind;
use crate::lifecycle::ConnectionGuard;
use crate::lifecycle::CorePort;
use crate::lifecycle::DiscoveryState;
use crate::lifecycle::DrainNotice;
use crate::lifecycle::Exiter;
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
    fn close_data_handles(&self, _: &crate::lifecycle::ManagedDrain) {}
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

#[derive(Default)]
pub struct LateLifecycle(
    OnceLock<Arc<Lifecycle>>,
    Mutex<HashMap<ConnectionId, ConnectionGuard>>,
    watch::Sender<StartHold>,
    Arc<CancelRegistry>,
    Option<WorkLog>,
);

fn client_kind(origin: Origin, kind: ConnectionKind) -> ClientKind {
    match kind {
        ConnectionKind::ChannelBridge => ClientKind::Channel,
        ConnectionKind::RemoteDesktop | ConnectionKind::Phone => ClientKind::Remote,
        ConnectionKind::Desktop | ConnectionKind::Tui | ConnectionKind::Cli if origin == Origin::Ssh => ClientKind::Remote,
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
    pub fn client_opened(&self, connection: ConnectionId, origin: Origin, kind: ConnectionKind) -> Result<(), &'static str> {
        let lifecycle = self.0.get().ok_or("a connection opened before the lifecycle was bound; it is not counted")?;
        let guard = lifecycle.connection(client_kind(origin, kind));
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

    pub fn follow<F: Fn(CoreState) + Send + 'static>(
        self: &Arc<Self>,
        lifecycle: &Lifecycle,
        on_state: F,
    ) -> impl Future<Output = ()> + Send + 'static + use<F> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifecycle::ClientKind;
    use crate::lifecycle::testing::fixture;

    /// Two server windows are two counted ssh clients: closing one starts no idle shutdown, closing the last arms the remote grace, and a
    /// client back inside it cancels the grace (virtual time).
    #[test]
    fn two_ssh_windows_hold_the_core_until_the_last_one_leaves_and_a_return_cancels_the_grace() {
        use crate::lifecycle::ClientGrace;
        use std::time::Duration;
        let grace = ClientGrace { local: ClientGrace::NODE_LOCAL, remote: Some(ClientGrace::NODE_REMOTE) };
        let timer = crate::lifecycle::testing::ManualTimer::new();
        let fx = crate::lifecycle::testing::fixture_with_grace(grace, timer.clone());
        fx.lifecycle.set_serving().unwrap();
        let late = LateLifecycle::default();
        late.bind(fx.lifecycle.clone()).unwrap();
        late.client_opened(ConnectionId(1), Origin::Ssh, ConnectionKind::Desktop).unwrap();
        late.client_opened(ConnectionId(2), Origin::Ssh, ConnectionKind::Desktop).unwrap();
        late.client_closed(ConnectionId(1));
        assert!(timer.armed().is_empty(), "one window left: no idle shutdown");
        late.client_closed(ConnectionId(2));
        assert_eq!(timer.armed(), [ClientGrace::NODE_REMOTE]);
        late.client_opened(ConnectionId(3), Origin::Ssh, ConnectionKind::Desktop).unwrap();
        timer.advance(ClientGrace::NODE_REMOTE + Duration::from_secs(1));
        assert!(!fx.recorder.has_exited(), "a reconnect inside the window cancelled the pending shutdown");
    }

    /// A desktop attached through the ssh tunnel is a remote client: its leaving arms the long grace (1.4.5: `remote: true`); a
    /// local one, or one that came through the relay, does not change what it was: the 10 s.
    #[test]
    fn a_desktop_that_came_through_the_ssh_tunnel_leaves_the_core_up_for_the_remote_grace() {
        use crate::lifecycle::ClientGrace;
        use std::time::Duration;
        let grace = ClientGrace { local: ClientGrace::NODE_LOCAL, remote: Some(ClientGrace::NODE_REMOTE) };
        for (origin, expected) in [(Origin::Ssh, ClientGrace::NODE_REMOTE), (Origin::Relay, ClientGrace::NODE_LOCAL), (Origin::Local, ClientGrace::NODE_LOCAL)]
        {
            let timer = crate::lifecycle::testing::ManualTimer::new();
            let fx = crate::lifecycle::testing::fixture_with_grace(grace, timer.clone());
            fx.lifecycle.set_serving().unwrap();
            let late = LateLifecycle::default();
            late.bind(fx.lifecycle.clone()).unwrap();
            late.client_opened(ConnectionId(1), origin, ConnectionKind::Desktop).unwrap();
            late.client_closed(ConnectionId(1));
            assert_eq!(timer.armed(), [expected], "{origin:?}");
            timer.advance(expected - Duration::from_secs(1));
            assert!(!fx.recorder.has_exited(), "{origin:?}: the core outlives its last client until the grace is over");
        }
    }

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
        fx.lifecycle.hold(true, None).unwrap();
        reads(&mut gate, StartHold::Held).await;
        fx.lifecycle.hold(false, None).unwrap();
        reads(&mut gate, StartHold::Open).await;
        fx.lifecycle.hold(true, None).unwrap();
        reads(&mut gate, StartHold::Held).await;
        let work = fx.lifecycle.begin_activity(crate::lifecycle::ActivityInfo {
            kind: crate::lifecycle::ActivityKind::Turn,
            thread_id: Some("thread-1".into()),
            turn_id: Some("turn-1".into()),
            title: "a turn".into(),
        });
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
        let late = Arc::new(LateLifecycle::default());
        let mut gate = late.start_hold();
        tokio::spawn(late.follow(&fx.lifecycle, |_| {}));
        fx.lifecycle.hold(true, None).unwrap();
        reads(&mut gate, StartHold::Held).await;
        let work = fx.lifecycle.begin_activity(crate::lifecycle::ActivityInfo {
            kind: crate::lifecycle::ActivityKind::Turn,
            thread_id: Some("thread-1".into()),
            turn_id: Some("turn-1".into()),
            title: "a turn".into(),
        });
        // Both moves with no await between: the follower, on this test's one thread, wakes once after them.
        fx.lifecycle.hold(false, None).unwrap();
        fx.lifecycle.stop(StopMode::WhenIdle, StopReason::Update, None).unwrap();
        reads(&mut gate, StartHold::Open).await;
        assert_eq!(*fx.lifecycle.state().borrow(), CoreState::Draining { reason: mixdog_protocol::DrainReason::Update });
        drop(work);
        fx.recorder.wait_exit();
    }
}
