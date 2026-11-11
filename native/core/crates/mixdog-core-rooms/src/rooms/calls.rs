//! The turns other sessions wait on in a room (agent-room-scheduler.ts): a call is one session's
//! request for one member's turn, and a relay is the member relaying its own reported work. This
//! is the one owner of what is owed per room: the exchange in flight, the request that will run
//! next (a new one merges into it and cuts the speaking member off), and the relays held back
//! while the room talks. The exchange itself, the member's turn in it, is `CallRunner`.
//!
//! Every call settles exactly once, whichever path ends it first.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use async_trait::async_trait;
use mixdog_rt::TaskClass;
use tokio::sync::oneshot;

/// The caller's durable record follows the turn that answers (`follow(submissionId)`): the turn
/// is submitted under another id than the call's own.
#[async_trait]
pub trait CallFollow: Send + Sync {
    async fn follow(&self, submission_id: &str) -> Result<(), String>;
}

/// One call. `settle` ends it once with a turn end status (`done`, `failed`, `cancelled`).
#[derive(Clone)]
pub struct RoomCall {
    pub agent_id: String,
    /// The submission id the member's turn runs under; empty for none.
    pub id: String,
    pub hop: u32,
    /// The prompt of a relay (the member's own reported work); empty for any other call.
    pub relay: String,
    pub follow: Option<Arc<dyn CallFollow>>,
    /// The session that asked (`askedBy`); empty for none.
    pub asked_by: String,
    /// A turn cut short was already submitted under `id`: never submitted again.
    used: Arc<AtomicBool>,
    /// Its watch follows another submission id than its own.
    followed: Arc<AtomicBool>,
    settled: Arc<Mutex<Option<oneshot::Sender<String>>>>,
    detail: Arc<Mutex<Option<Settled>>>,
    /// `onSettled(detail)`: told once, when the call ends.
    pub on_settled: Option<Arc<dyn Fn(&Settled) + Send + Sync>>,
}

/// How a call's turn ended, in a session turn's shape (`AgentRoomTurnDetail`): `done` with the
/// posted words (`content`, empty for a pass), `failed` with `error`, or `cancelled`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settled {
    pub status: String,
    pub error: Option<String>,
    pub content: Option<String>,
}

impl RoomCall {
    /// A relay call for `agent_id`, and the receiver of the status its turn ends with.
    pub fn relay(agent_id: &str, prompt: &str, id: &str, hop: u32, follow: Option<Arc<dyn CallFollow>>) -> (Self, oneshot::Receiver<String>) {
        Self::new(agent_id, id, hop, "", prompt, follow)
    }

    /// A call for `agent_id`'s turn: `asked_by` asked for it, or `relay` is the member's own
    /// reported work.
    pub fn new(agent_id: &str, id: &str, hop: u32, asked_by: &str, relay: &str, follow: Option<Arc<dyn CallFollow>>) -> (Self, oneshot::Receiver<String>) {
        let (sender, receiver) = oneshot::channel();
        let call = Self {
            agent_id: agent_id.to_owned(),
            id: id.to_owned(),
            hop,
            relay: relay.to_owned(),
            follow,
            asked_by: asked_by.to_owned(),
            used: Arc::new(AtomicBool::new(false)),
            followed: Arc::new(AtomicBool::new(false)),
            settled: Arc::new(Mutex::new(Some(sender))),
            detail: Arc::new(Mutex::new(None)),
            on_settled: None,
        };
        (call, receiver)
    }

    pub fn is_used(&self) -> bool {
        self.used.load(Ordering::SeqCst)
    }

    pub fn mark_used(&self) {
        self.used.store(true, Ordering::SeqCst);
    }

    pub fn is_followed(&self) -> bool {
        self.followed.load(Ordering::SeqCst)
    }

    pub fn set_followed(&self, followed: bool) {
        self.followed.store(followed, Ordering::SeqCst);
    }

    /// `onSettled(detail)`: ends the call with the detail's status; a call that ended already
    /// ignores it and keeps its first detail.
    pub fn settle_with(&self, detail: &Settled) {
        let Some(sender) = self.settled.lock().unwrap_or_else(|e| e.into_inner()).take() else { return };
        *self.detail.lock().unwrap_or_else(|e| e.into_inner()) = Some(detail.clone());
        if let Some(told) = &self.on_settled {
            told(detail);
        }
        let _ = sender.send(detail.status.clone());
    }

    /// The detail the call ended with, when it ended through `settle_with`.
    pub fn detail(&self) -> Option<Settled> {
        self.detail.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn is_settled(&self) -> bool {
        self.settled.lock().unwrap_or_else(|e| e.into_inner()).is_none()
    }

    /// Ends the call with `status`; a call that ended already ignores it.
    pub fn settle(&self, status: &str) {
        self.settle_with(&Settled { status: status.to_owned(), error: None, content: None });
    }
}

/// A request for turns in a room (`RoomExchangeOptions`).
#[derive(Clone, Default)]
pub struct Request {
    pub to: Vec<String>,
    pub waiting: bool,
    /// The request addressed the whole room (never read off an empty `to`).
    pub everyone: bool,
    /// The called members answer and nobody else follows.
    pub only: bool,
    pub calls: Vec<RoomCall>,
}

/// What an exchange in flight shares with the scheduler (`RunState`).
#[derive(Default)]
pub struct Run {
    stop: AtomicBool,
    pending: Mutex<Option<Request>>,
    /// The calls the exchange in flight answers; shared, so a member that leaves takes its calls
    /// out of it (`cancel_owed_to`).
    calls: Mutex<Vec<RoomCall>>,
}

impl Run {
    /// The live list the exchange in flight answers: a turn takes its member's calls out of it.
    pub(crate) fn calls_lock(&self) -> MutexGuard<'_, Vec<RoomCall>> {
        self.calls.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The calls still waiting on the exchange in flight.
    pub fn calls(&self) -> Vec<RoomCall> {
        self.calls.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub(crate) fn pending(&self) -> MutexGuard<'_, Option<Request>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The stop button was pressed (`RoomCalls::stop`).
    pub(crate) fn set_stopped(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }

    /// The stop button was pressed: no one else gets a turn.
    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    /// A newer request waits and the room was not stopped: the turn in flight answers older rows,
    /// so it is cut short (`interrupted`).
    pub fn interrupted(&self) -> bool {
        self.pending().is_some() && !self.stopped()
    }
}

/// The exchange of one room.
#[async_trait]
pub trait CallRunner: Send + Sync {
    /// Runs `request` as one exchange in the room and settles the calls of `run.calls()` it
    /// answered. A request that arrived meanwhile is left in `run` (`interrupted`): the scheduler
    /// runs it next, and the calls the exchange did not settle ride on to it. `Err`: the exchange
    /// failed, and every call not settled yet ends failed.
    async fn run(&self, room_id: &str, request: &Request, run: &Arc<Run>) -> Result<(), String>;

    /// A request merged into the exchange in flight: abort the member speaking in the room.
    async fn cut_off(&self, room_id: &str);
}

#[derive(Default)]
struct State {
    running: HashMap<String, Arc<Run>>,
    /// Relays held back per room while its talk runs: a relay never cuts a member off.
    relays: HashMap<String, Vec<RoomCall>>,
    /// Per room, the send/ask requests still on their way to `route` (`intakes`): the stop button
    /// cancels them even when no exchange runs yet.
    intakes: HashMap<String, Vec<Arc<AtomicBool>>>,
}

pub struct RoomCalls<R: CallRunner> {
    runner: Arc<R>,
    state: Mutex<State>,
    log: Arc<dyn Fn(&str) + Send + Sync>,
}

fn cancel_all(calls: &[RoomCall]) {
    for call in calls {
        call.settle("cancelled");
    }
}

/// The calls to `gone` end cancelled and leave `calls` (in place: the exchange shares the list).
fn cancel_calls_to(calls: &mut Vec<RoomCall>, gone: &HashSet<String>) {
    calls.retain(|call| {
        let leaves = gone.contains(&call.agent_id);
        if leaves {
            call.settle("cancelled");
        }
        !leaves
    });
}

/// The request in `prior` with `request` merged into it.
fn merged(prior: Option<Request>, request: Request) -> Request {
    let Some(mut prior) = prior else { return request };
    for id in request.to {
        if !prior.to.contains(&id) {
            prior.to.push(id);
        }
    }
    prior.waiting |= request.waiting;
    prior.only &= request.only;
    prior.everyone |= request.everyone;
    prior.calls.extend(request.calls);
    prior
}

impl<R: CallRunner + 'static> RoomCalls<R> {
    pub fn new(runner: Arc<R>, log: Arc<dyn Fn(&str) + Send + Sync>) -> Arc<Self> {
        Arc::new(Self { runner, state: Mutex::new(State::default()), log })
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn is_running(&self, room_id: &str) -> bool {
        self.state().running.contains_key(room_id)
    }

    /// `intake(roomId, run)`: a request on its way to `route`, registered before its first await;
    /// the returned latch reads true once the stop button was pressed. [`Self::release_intake`]
    /// drops it.
    pub fn intake(&self, room_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.state().intakes.entry(room_id.to_owned()).or_default().push(flag.clone());
        flag
    }

    /// The request of `flag` reached `route` or failed.
    pub fn release_intake(&self, room_id: &str, flag: &Arc<AtomicBool>) {
        let mut state = self.state();
        if let Some(pending) = state.intakes.get_mut(room_id) {
            pending.retain(|each| !Arc::ptr_eq(each, flag));
            if pending.is_empty() {
                state.intakes.remove(room_id);
            }
        }
    }

    /// Routes a new request into room `room_id`: it starts an exchange or, while one runs, merges
    /// into the one that runs next (every member any of them called keeps its turn, in the order
    /// named; `only` holds when every merged request is `only`), and the member speaking is cut
    /// off. A stopping exchange hands nothing on: calls that arrive now end cancelled.
    pub fn route(self: &Arc<Self>, room_id: &str, mut request: Request) {
        let active = {
            let mut state = self.state();
            match state.running.get(room_id).cloned() {
                Some(active) => active,
                None => {
                    let run = Arc::new(Run::default());
                    state.running.insert(room_id.to_owned(), run.clone());
                    drop(state);
                    self.start(room_id, request, run);
                    return;
                }
            }
        };
        if active.stopped() {
            cancel_all(&request.calls);
            request.calls.clear();
        }
        {
            let mut pending = active.pending();
            *pending = Some(merged(pending.take(), request));
        }
        let (this, room_id) = (Arc::clone(self), room_id.to_owned());
        mixdog_rt::spawn("room-cut-off", TaskClass::Work, async move { this.runner.cut_off(&room_id).await });
    }

    fn start(self: &Arc<Self>, room_id: &str, first: Request, run: Arc<Run>) {
        let (this, room_id) = (Arc::clone(self), room_id.to_owned());
        mixdog_rt::spawn("room-calls", TaskClass::Work, async move {
            let mut request = first;
            loop {
                *run.calls.lock().unwrap_or_else(|e| e.into_inner()) = request.calls.clone();
                if let Err(error) = this.runner.run(&room_id, &request, &run).await {
                    (this.log)(&format!("room {room_id} exchange failed: {error}"));
                    for call in run.calls() {
                        call.settle("failed");
                    }
                }
                // Taken with the unmarking, so a request routed now starts the next exchange or is
                // seen here, never lost between them.
                let next = {
                    let mut state = this.state();
                    let next = run.pending().take();
                    match next {
                        Some(next) if !run.stopped() => Some(next),
                        other => {
                            if let Some(dropped) = other {
                                cancel_all(&dropped.calls);
                            }
                            state.running.remove(&room_id);
                            None
                        }
                    }
                };
                match next {
                    Some(mut next) => {
                        // A turn the newer request cut short settled none of its calls: they ride on.
                        let mut carried: Vec<RoomCall> = run.calls().into_iter().filter(|call| !call.is_settled()).collect();
                        carried.append(&mut next.calls);
                        next.calls = carried;
                        request = next;
                    }
                    None => break,
                }
            }
            this.drain_relays(&room_id);
        });
    }

    /// A member's relay `call` in `room_id`: a relay never cuts a member off. While the room talks
    /// it waits in the room's queue, which the exchange's end drains.
    pub fn relay_when_idle(self: &Arc<Self>, room_id: &str, call: RoomCall) {
        let (stopping, running) = {
            let state = self.state();
            (state.running.get(room_id).is_some_and(|run| run.stopped()), state.running.contains_key(room_id))
        };
        if stopping {
            call.settle("cancelled");
        } else if running {
            self.state().relays.entry(room_id.to_owned()).or_default().push(call);
        } else {
            let to = vec![call.agent_id.clone()];
            self.route(room_id, Request { to, everyone: false, waiting: false, only: true, calls: vec![call] });
        }
    }

    /// An exchange in `room_id` ended: the relays it held back run as one exchange, each member
    /// once, unless another exchange already took the room (its own end drains them).
    fn drain_relays(self: &Arc<Self>, room_id: &str) {
        let queued = {
            let mut state = self.state();
            if state.running.contains_key(room_id) {
                return;
            }
            match state.relays.remove(room_id) {
                Some(queued) if !queued.is_empty() => queued,
                _ => return,
            }
        };
        let mut to: Vec<String> = Vec::new();
        for call in &queued {
            if !to.contains(&call.agent_id) {
                to.push(call.agent_id.clone());
            }
        }
        self.route(room_id, Request { to, everyone: false, waiting: false, only: true, calls: queued });
    }

    /// The stop button: the relays held back end cancelled, the requests on their way are stopped,
    /// the speaking member's turn is cut off and no one else gets a turn. True when an exchange or
    /// an incoming request was cancelled.
    pub fn stop(self: &Arc<Self>, room_id: &str) -> bool {
        let (queued, active, incoming) = {
            let mut state = self.state();
            let incoming = state.intakes.get(room_id).map_or(0, |pending| {
                for request in pending {
                    request.store(true, Ordering::SeqCst);
                }
                pending.len()
            });
            (state.relays.remove(room_id).unwrap_or_default(), state.running.get(room_id).cloned(), incoming)
        };
        cancel_all(&queued);
        let Some(active) = active else { return incoming > 0 };
        active.set_stopped();
        if let Some(pending) = active.pending().take() {
            cancel_all(&pending.calls);
        }
        let (this, room_id) = (Arc::clone(self), room_id.to_owned());
        mixdog_rt::spawn("room-cut-off", TaskClass::Work, async move { this.runner.cut_off(&room_id).await });
        true
    }

    /// A save the room's talk needed failed (`failRelays`, `dropRelays(roomId, { status: 'failed',
    /// error })`): the relays held back for `room_id` end failed with `error`; the delivery retries
    /// them later.
    pub fn fail_relays(&self, room_id: &str, error: &str) {
        let queued = self.state().relays.remove(room_id).unwrap_or_default();
        let failed = Settled { status: "failed".into(), error: Some(error.to_owned()), content: None };
        for call in &queued {
            call.settle_with(&failed);
        }
    }

    /// `gone` left room `room_id`: what is owed to them ends. Their calls waiting in the relay
    /// queue and in the request that runs next end cancelled, and they are no queued target.
    pub fn cancel_owed_to(&self, room_id: &str, gone: &HashSet<String>) {
        let mut state = self.state();
        if let Some(queued) = state.relays.get_mut(room_id) {
            cancel_calls_to(queued, gone);
            if queued.is_empty() {
                state.relays.remove(room_id);
            }
        }
        if let Some(run) = state.running.get(room_id) {
            cancel_calls_to(&mut run.calls.lock().unwrap_or_else(|e| e.into_inner()), gone);
            if let Some(pending) = run.pending().as_mut() {
                cancel_calls_to(&mut pending.calls, gone);
                pending.to.retain(|id| !gone.contains(id));
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests;
