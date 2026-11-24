//! Scoped feeds of the process layer: one frame publisher per feed, and the `process:<handle>`
//! feeds that carry a process's (or a terminal tab's) output.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use bytes::Bytes;
use mixdog_app_protocol::rpc::FeedStamp;
use mixdog_app_protocol::rpc::JsonRpcNotification;
use mixdog_app_protocol::v2::feed::FeedSnapshotParams;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::process::ExitStatus;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessExit;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::feed::AttachDecision;
use mixdog_core_api::feed::AttachRequest;
use mixdog_core_api::feed::FeedFrame;
use mixdog_core_api::feed::FeedPosition;
use mixdog_core_api::feed::FeedSource;
use mixdog_core_api::feed::FeedView;
use mixdog_core_api::feed::ResumeFrom;
use mixdog_core_api::feed::ScopedFeed;
use mixdog_core_api::feed::ScopedFeeds;
use mixdog_core_api::feed::Window;
use mixdog_core_api::ids::SubscriptionId;
use mixdog_protocol::FeedId;
use mixdog_protocol::ProcessHandle;
use mixdog_rt::CpuInteractive;
use mixdog_rt::InLane;
use mixdog_rt::TaskClass;
use serde_json::Value;
use serde_json::json;

use super::relay_buffer::RelayBuffer;
use super::relay_buffer::RelayFrame;
use super::terminal::terminal_json;
use crate::feed::Feed;
use crate::manager::LocalProcessManager;
use crate::terminal::PumpPoint;
use crate::terminal::PumpTell;
use crate::terminal::REPLAY_BUFFER_LIMIT;
use crate::terminal::ReplayBuffer;
use crate::terminal::TerminalId;

/// Exited processes whose feed stays attachable (replay of a finished run).
const RETAINED_FEEDS: usize = 256;

/// The terminal lane: every terminal tab's output as Node's relay lane sent it to a phone, each frame naming its tab (`processHandle`).
/// Node's relay pushed `termData` of every running terminal to every phone reading the terminal lane, the tabs the desktop or another
/// phone opened included, from their first output (remote-relay-push-lanes.ts:85-100): a phone that reads the lane subscribes this one
/// feed, which a tab's first output finds subscribed whoever opened the tab.
pub const TERMINAL_LANE_FEED: &str = "process:relay";

/// How long the pump waits for a change to reach the clients before the output that follows it (see `PumpTell`).
const ORDER_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

pub(crate) fn encode(method: &str, params: Value, stamp: FeedStamp) -> Bytes {
    let note =
        JsonRpcNotification { method: method.to_owned(), params: Some(params), emitted_at_ms: Some(now_ms()), feed: Some(stamp), lone_surrogates: Vec::new() };
    Bytes::from(serde_json::to_vec(&note).expect("a notification serializes"))
}

/// The read model of a feed; its snapshot is the `feed/snapshot` of that state.
struct StateView {
    id: FeedId,
    state: Value,
}

impl FeedView for StateView {
    fn encode_snapshot(&self, _lane: &InLane<CpuInteractive>, at: FeedPosition, _window: &Window) -> Bytes {
        let params = FeedSnapshotParams { feed_id: self.id.clone(), state: self.state.clone() };
        encode(
            "feed/snapshot",
            serde_json::to_value(params).expect("snapshot params serialize"),
            FeedStamp { id: self.id.clone(), epoch: at.epoch, seq: at.seq, from: None },
        )
    }
}

/// The single producer of one scoped feed.
pub(crate) struct FramePublisher {
    feed: Arc<dyn ScopedFeed>,
    id: FeedId,
    producer: Mutex<()>,
}

impl FramePublisher {
    pub(crate) fn create(feeds: &dyn ScopedFeeds, id: FeedId, state: Value) -> Self {
        let view = Arc::new(StateView { id: id.clone(), state });
        Self { feed: feeds.create(id.clone(), view), id, producer: Mutex::new(()) }
    }

    pub(crate) fn source(&self) -> Arc<dyn FeedSource> {
        let feed: Arc<dyn ScopedFeed> = self.feed.clone();
        feed
    }

    pub(crate) fn id(&self) -> &FeedId {
        &self.id
    }

    /// Appends one notification and moves the read model to `state`.
    pub(crate) fn publish(&self, method: &str, params: Value, state: Value) {
        let _one_producer = self.producer.lock().unwrap_or_else(|e| e.into_inner());
        let position = self.feed.position();
        let seq = position.seq + 1;
        let frame = FeedFrame::new(seq, encode(method, params, FeedStamp { id: self.id.clone(), epoch: position.epoch, seq, from: None }));
        let view = Arc::new(StateView { id: self.id.clone(), state });
        // The only failure is a seq gap, impossible under the producer lock.
        let _ = self.feed.publish(&[frame], Some(view));
    }

    pub(crate) fn close(&self) {
        self.feed.close();
    }
}

fn signal_name(signal: i32) -> String {
    match signal {
        1 => "SIGHUP".to_owned(),
        2 => "SIGINT".to_owned(),
        3 => "SIGQUIT".to_owned(),
        6 => "SIGABRT".to_owned(),
        9 => "SIGKILL".to_owned(),
        11 => "SIGSEGV".to_owned(),
        13 => "SIGPIPE".to_owned(),
        14 => "SIGALRM".to_owned(),
        15 => "SIGTERM".to_owned(),
        other => format!("SIG{other}"),
    }
}

/// `process/exited` params: `{processHandle, code}` or `{processHandle, signal}`.
fn exited_params(handle: &ProcessHandle, exit: &ProcessExit) -> Value {
    match exit.status {
        ExitStatus::Code(code) => json!({ "processHandle": handle, "code": code }),
        ExitStatus::Signal(signal) => json!({ "processHandle": handle, "signal": signal_name(signal) }),
    }
}

/// Where the relay feed's pump tells a terminal how far it has taken the output (see [`PumpTell`]); asked once, by the pump that starts.
pub(crate) type RelayOrderOf = Box<dyn FnOnce() -> Option<PumpTell> + Send>;

/// The terminal a tab's feed carries, fixed when its spawn opens the feed ([`ProcessFeeds::terminal_opened`]).
struct TerminalOutput {
    id: TerminalId,
    /// That terminal's own process output: the pump and a cut read it, never whatever process the handle names by then.
    output: Arc<Feed>,
    order: Mutex<Option<RelayOrderOf>>,
}

struct Entry {
    handle: ProcessHandle,
    publisher: FramePublisher,
    /// A terminal tab: its output also goes on the terminal lane ([`TERMINAL_LANE_FEED`]) as Node's relay lane sent it to a phone (see
    /// [`super::relay_buffer`]).
    relay: bool,
    /// A terminal feed: its snapshot carries the screen text; a process feed's carries only the
    /// run state (its replay is the feed's ring).
    text: bool,
    /// The terminal a tab's feed carries; none for a process's feed. Every frame the feed and the terminal lane carry of it names it, as
    /// the answers and the tab list do.
    terminal: Option<TerminalOutput>,
    started: AtomicBool,
    finished: AtomicBool,
    /// Queued for eviction already (see `ProcessFeeds::retire`).
    retired: AtomicBool,
    /// The holds out, each as the output offset the pump may still publish up to (see [`FeedHold`]).
    hold: tokio::sync::watch::Sender<Vec<u64>>,
    /// How often the pump has stopped for a hold. Tests only.
    #[cfg(test)]
    stopped: tokio::sync::watch::Sender<u64>,
    /// How often the pump has waited for a change to reach the clients before going on (see `PumpTell`). Tests only.
    #[cfg(test)]
    ordered: tokio::sync::watch::Sender<u64>,
    /// Runs once a claim's hold is taken (`ProcessFeeds::hold_new_output`). Tests only.
    #[cfg(test)]
    after_mark: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /// Told the bytes of output the pump has taken, after each output event went through the relay buffer (`u64::MAX` when it ends):
    /// a terminal tab's activity changes wait for it (`SpawnedTerminal::order`).
    taken: OnceLock<PumpTell>,
    /// The output offset the pump has published up to (`u64::MAX` once it ended): a terminal attach waits for it to reach the tab's
    /// replay position, so the replay and the frames that follow the subscription meet without a gap or an overlap.
    published: tokio::sync::watch::Sender<u64>,
}

/// A terminal's feed, for an attach that cuts the replay and the subscription at one output offset (see
/// [`ProcessFeeds::terminal_cut`]).
pub(crate) struct TerminalCut {
    feeds: Arc<ProcessFeeds>,
    entry: Arc<Entry>,
}

/// How long an attach waits for the pump to publish what its replay holds (the pump is held back by another call's hold, or is stuck).
const CUT_DEADLINE: std::time::Duration = std::time::Duration::from_secs(2);

impl TerminalCut {
    pub(crate) fn position(&self) -> FeedPosition {
        self.entry.publisher.feed.position()
    }

    /// Holds the pump from publishing output past `offset` (taken by the caller under the lock that appends the output).
    pub(crate) fn hold_at(&self, offset: u64) -> FeedHold {
        self.entry.hold_from(offset)
    }

    /// Returns once the pump has published the output up to `offset` (or ended, or [`CUT_DEADLINE`] passed).
    pub(crate) async fn published(&self, offset: u64) {
        let mut seen = self.entry.published.subscribe();
        let _ = tokio::time::timeout(CUT_DEADLINE, seen.wait_for(|at| *at >= offset)).await;
    }

    /// The feed the cut is of, for the subscription that goes on from it: never the id's feed as it is by then, which may be another
    /// terminal's.
    pub(crate) fn source(&self) -> Arc<dyn FeedSource> {
        Arc::new(Gate { feeds: Arc::clone(&self.feeds), entry: Arc::clone(&self.entry) })
    }
}

/// A call's hold on its tab's feed: until it is dropped, the pump publishes no output past the hold's offset (on the feed or in a relay
/// flush) and no exit.
/// Node answered `termEnsure` and `termDispose` in-process before the output they cause (a new shell's first output, a killed shell's last
/// output and exit line: its PTY reports them later, on its own event), so the phone sees the answer first; the hold (offset 0: nothing
/// at all) makes the core's pump wait for the answer instead of racing it. A claim's hold (see [`ProcessFeeds::hold_new_output`]) lets
/// the output already in the feed through.
pub(crate) struct FeedHold(Arc<Entry>, u64);

impl Drop for FeedHold {
    fn drop(&mut self) {
        let offset = self.1;
        self.0.hold.send_modify(|holds| {
            if let Some(at) = holds.iter().position(|held| *held == offset) {
                holds.swap_remove(at);
            }
        });
    }
}

impl Entry {
    fn hold(self: &Arc<Self>) -> FeedHold {
        self.hold_from(0)
    }

    fn hold_from(self: &Arc<Self>, offset: u64) -> FeedHold {
        self.hold.send_modify(|holds| holds.push(offset));
        FeedHold(Arc::clone(self), offset)
    }
}

/// The `process:<handle>` feeds. A feed is pumped from its process's event stream, starting at
/// the first attach, so the first subscriber is registered before any frame exists and the
/// process's whole retained output reaches it as live frames.
pub struct ProcessFeeds {
    manager: LocalProcessManager,
    scoped: Arc<dyn ScopedFeeds>,
    entries: Mutex<HashMap<String, Arc<Entry>>>,
    finished: Mutex<VecDeque<Arc<Entry>>>,
    on_exit: OnceLock<Arc<dyn Fn(&str) + Send + Sync>>,
    /// The terminal lane ([`TERMINAL_LANE_FEED`]), live for the life of the core.
    lane: FramePublisher,
}

/// What `feed()` hands the server: attaches like the feed and starts its pump once.
struct Gate {
    feeds: Arc<ProcessFeeds>,
    entry: Arc<Entry>,
}

impl Entry {
    fn close(&self) {
        self.publisher.close();
    }
}

impl FeedSource for Gate {
    fn feed_id(&self) -> FeedId {
        self.entry.publisher.id().clone()
    }

    fn position(&self) -> FeedPosition {
        self.entry.publisher.feed.position()
    }

    fn attach(&self, req: AttachRequest) -> Result<AttachDecision, CoreError> {
        let decision = self.entry.publisher.source().attach(req)?;
        self.feeds.start_once(&self.entry);
        Ok(decision)
    }

    fn carries(&self, sub: &SubscriptionId, window: &Window, resume: &ResumeFrom) -> Option<AttachDecision> {
        self.entry.publisher.source().carries(sub, window, resume)
    }

    fn detach(&self, sub: SubscriptionId) {
        self.entry.publisher.source().detach(sub);
    }
}

impl ProcessFeeds {
    pub fn new(manager: LocalProcessManager, scoped: Arc<dyn ScopedFeeds>) -> Arc<Self> {
        let lane = FramePublisher::create(scoped.as_ref(), FeedId::from(TERMINAL_LANE_FEED), json!({}));
        Arc::new(Self { manager, scoped, entries: Mutex::new(HashMap::new()), finished: Mutex::new(VecDeque::new()), on_exit: OnceLock::new(), lane })
    }

    /// Called with the handle of every process whose feed saw its exit.
    pub fn on_exit(&self, hook: impl Fn(&str) + Send + Sync + 'static) {
        let _ = self.on_exit.set(Arc::new(hook));
    }

    /// The feed of `handle`, created on first use. A terminal feed (`text`) also keeps the screen
    /// text for its snapshot. A finished run's feed is replaced when the same handle runs again.
    pub(crate) fn feed(self: &Arc<Self>, handle: &str, text: bool) -> Arc<dyn FeedSource> {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = entries.get(handle) {
            let rerun = entry.finished.load(Ordering::Acquire) && self.manager.info(&entry.handle).is_ok_and(|info| info.exit.is_none());
            if !rerun {
                return Arc::new(Gate { feeds: Arc::clone(self), entry: Arc::clone(entry) });
            }
            entry.close();
        }
        let entry = self.new_entry(handle, text, None);
        entries.insert(handle.to_owned(), Arc::clone(&entry));
        Arc::new(Gate { feeds: Arc::clone(self), entry })
    }

    fn new_entry(&self, handle: &str, text: bool, terminal: Option<TerminalOutput>) -> Arc<Entry> {
        let state = if text { json!({ "text": "" }) } else { json!({}) };
        Arc::new(Entry {
            handle: ProcessHandle::from(handle),
            publisher: FramePublisher::create(self.scoped.as_ref(), FeedId::from(format!("process:{handle}")), state),
            relay: text,
            text,
            terminal,
            started: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            retired: AtomicBool::new(false),
            hold: tokio::sync::watch::Sender::new(Vec::new()),
            #[cfg(test)]
            stopped: tokio::sync::watch::Sender::new(0),
            #[cfg(test)]
            ordered: tokio::sync::watch::Sender::new(0),
            #[cfg(test)]
            after_mark: Mutex::new(None),
            taken: OnceLock::new(),
            published: tokio::sync::watch::Sender::new(0),
        })
    }

    /// The terminal lane's source, for a reader that makes the pump fill the relay buffer. Tests only.
    #[cfg(test)]
    pub(crate) fn lane_source(&self) -> Arc<dyn FeedSource> {
        self.lane.source()
    }

    /// How many frames the terminal lane has published. Tests only.
    #[cfg(test)]
    pub(crate) fn lane_seq(&self) -> u64 {
        self.lane.feed.position().seq
    }

    /// A new terminal of the tab `handle`, opened by its spawn once and before the tab is listed, so the spawns of an id open their
    /// terminals in their own order. Its feed carries that terminal's own process output (`output`) and is the handle's feed from now
    /// on; the earlier terminal's (ended, or still publishing its end) is retired, as a disposed tab's is.
    pub(crate) fn terminal_opened(&self, handle: &str, terminal: TerminalId, output: Arc<Feed>, order: RelayOrderOf) {
        let entry = self.new_entry(handle, true, Some(TerminalOutput { id: terminal, output, order: Mutex::new(Some(order)) }));
        let replaced = self.entries.lock().unwrap_or_else(|e| e.into_inner()).insert(handle.to_owned(), entry);
        if let Some(replaced) = replaced {
            self.retire(vec![replaced]);
        }
    }

    /// The feed of `terminal` while it is the handle's: `None` once a later terminal of the id was opened, or the tab was disposed.
    fn terminal_feed(&self, handle: &str, terminal: &TerminalId) -> Option<Arc<Entry>> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner()).get(handle).filter(|entry| entry.terminal.as_ref().is_some_and(|of| &of.id == terminal)).cloned()
    }

    /// Starts the pump of `entry` unless it runs; a terminal's relay order is asked once, for the pump that starts.
    fn start_once(self: &Arc<Self>, entry: &Arc<Entry>) {
        if !entry.started.swap(true, Ordering::AcqRel) {
            let order = entry.terminal.as_ref().and_then(|of| of.order.lock().unwrap_or_else(|e| e.into_inner()).take());
            if let Some(tell) = order.and_then(|order| order()) {
                let _ = entry.taken.set(tell);
            }
            Arc::clone(self).start_pump(Arc::clone(entry));
        }
    }

    /// The feed of `terminal`, pumping, with a hold taken before its pump can publish anything; `None` when it is no longer the
    /// handle's.
    pub(crate) fn open_terminal(self: &Arc<Self>, handle: &str, terminal: &TerminalId) -> Option<FeedHold> {
        let entry = self.terminal_feed(handle, terminal)?;
        let held = entry.hold();
        self.start_once(&entry);
        Some(held)
    }

    /// The feed of `terminal`, live and pumping (as [`Self::open_terminal`], without a hold), for an attach that cuts its replay and its
    /// subscription at one output offset.
    pub(crate) fn terminal_cut(self: &Arc<Self>, handle: &str, terminal: &TerminalId) -> Option<TerminalCut> {
        let entry = self.terminal_feed(handle, terminal)?;
        self.start_once(&entry);
        Some(TerminalCut { feeds: Arc::clone(self), entry })
    }

    /// Holds the feed of `terminal` (see [`FeedHold`]); `None` when it is no longer the handle's.
    pub(crate) fn hold(&self, handle: &str, terminal: &TerminalId) -> Option<FeedHold> {
        Some(self.terminal_feed(handle, terminal)?.hold())
    }

    /// Holds back what the terminal of `handle` writes from now on, and every relay flush and the exit, but not the output already in its
    /// feed (see [`FeedHold`]); `None` when it has no terminal's feed. A process that is gone writes nothing more.
    /// The cut and the hold are one step under the lock of the terminal's output: output the shell writes after the cut is never taken
    /// unheld.
    pub(crate) fn hold_new_output(&self, handle: &str) -> Option<FeedHold> {
        let entry = self.entries.lock().unwrap_or_else(|e| e.into_inner()).get(handle).cloned()?;
        let held = entry.terminal.as_ref()?.output.mark_then(|offset| entry.hold_from(offset));
        #[cfg(test)]
        if let Some(seam) = entry.after_mark.lock().unwrap().take() {
            seam();
        }
        Some(held)
    }

    /// Retires the feed of `terminal`, a disposed tab's: a new tab of the same id gets a feed of its own, and this one stays attached until
    /// it is evicted like any finished feed, so a subscriber still gets what the shell wrote while it was killed (Node's pty keeps
    /// delivering after dispose: golden.json, trace.order, the output of term_ph2b after its termDispose) and its `process/exited`, which
    /// ends the subscriber's reading (the phone's adapter leaves the feed on it). It is never closed here, finished or not: a close ends
    /// the lanes at once and drops frames a subscriber has not read yet.
    pub(crate) fn close(&self, handle: &str, terminal: &TerminalId) {
        let removed = {
            let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            let own = entries.get(handle).is_some_and(|entry| entry.terminal.as_ref().is_some_and(|of| &of.id == terminal));
            if own { entries.remove(handle) } else { None }
        };
        if let Some(entry) = removed {
            self.retire(vec![entry]);
        }
    }

    /// Queues finished or retired feeds for eviction; the oldest beyond [`RETAINED_FEEDS`] are closed.
    fn retire(&self, entries: Vec<Arc<Entry>>) {
        let evicted = {
            let mut finished = self.finished.lock().unwrap_or_else(|e| e.into_inner());
            let mut current = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            // An entry is queued once: a finished feed that is then closed (or closed while its pump ends) takes one slot.
            finished.extend(entries.into_iter().filter(|entry| !entry.retired.swap(true, Ordering::AcqRel)));
            let mut evicted = Vec::new();
            while finished.len() > RETAINED_FEEDS {
                let Some(old) = finished.pop_front() else { break };
                if current.get(old.handle.as_str()).is_some_and(|live| Arc::ptr_eq(live, &old)) {
                    current.remove(old.handle.as_str());
                }
                evicted.push(old);
            }
            evicted
        };
        for old in evicted {
            old.close();
        }
    }

    fn start_pump(self: Arc<Self>, entry: Arc<Entry>) {
        mixdog_rt::spawn("process-feed", TaskClass::Work, async move {
            self.pump(&entry).await;
        });
    }

    /// Waits while a hold keeps back what the pump has next: output ending at `end` (a relay flush's ends where the pump has taken), or
    /// (`None`) the exit or the end.
    async fn unheld(entry: &Entry, end: Option<u64>) {
        let passes = |holds: &Vec<u64>| holds.iter().all(|held| end.is_some_and(|end| end <= *held));
        let mut held = entry.hold.subscribe();
        if passes(&held.borrow_and_update()) {
            return;
        }
        #[cfg(test)]
        entry.stopped.send_modify(|stops| *stops += 1);
        let _ = held.wait_for(passes).await;
    }

    async fn pump(&self, entry: &Arc<Entry>) {
        let handle = &entry.handle;
        // `taken` counts from the output offset of the first event, so it is the feed's own offset (the tab's `emitted`) even when the
        // ring has dropped the start.
        // From the oldest event the ring holds, found and subscribed in one step: an eviction in between cannot end the pump. A terminal's
        // feed reads its own process's output, a process's feed the process its handle names.
        let subscribed = match &entry.terminal {
            Some(of) => {
                let events = of.output.subscribe_oldest();
                let start = events.start();
                Ok((events, start))
            }
            None => self.manager.subscribe_oldest(handle),
        };
        let Ok((mut events, mut taken)) = subscribed else {
            return self.finish(entry);
        };
        entry.published.send_replace(taken);
        let terminal = entry.terminal.as_ref().map(|of| terminal_json(&of.id));
        let named = |mut params: Value| {
            if let Some(terminal) = &terminal {
                params["terminal"] = terminal.clone();
            }
            params
        };
        // The window a late subscriber is given: Node's replay buffer, the last 200,000 UTF-16 units (a cut may fall inside a non-BMP
        // character, which then reads as U+FFFD at the window's start).
        let mut screen = ReplayBuffer::new(REPLAY_BUFFER_LIMIT, 0);
        // The relay feed's framing (Node's relay lane), timed on the runtime's clock.
        let mut relay = RelayBuffer::default();
        // Each delta names where its bytes start in the process's output, as a relay frame does: a client sees the output a pump
        // the ring overtook lost as a gap in the offsets.
        let output = |publisher: &FramePublisher, bytes: &[u8], offset: u64, state: Value| {
            let params = named(json!({ "processHandle": handle, "bytesB64": STANDARD.encode(bytes), "outputOffset": offset }));
            publisher.publish("process/outputDelta", params, state);
        };
        let mut relay_start = taken;
        let mut relay_end = taken;
        let stream = entry.publisher.feed.position().epoch;
        let relay_out = |frames: Vec<RelayFrame>, start: &mut u64| {
            if entry.relay {
                for frame in frames {
                    let mut params = named(json!({
                        "processHandle": handle, "bytesB64": STANDARD.encode(&frame.bytes),
                        "outputStream": stream, "outputOffset": *start,
                    }));
                    *start += frame.bytes.len() as u64;
                    // A frame Node cut inside a surrogate pair: the lone units at its edges (see `RelayFrame`).
                    if let Some(lead) = frame.lead {
                        params["leadUnit"] = json!(lead);
                    }
                    if let Some(tail) = frame.tail {
                        params["tailUnit"] = json!(tail);
                        // A split non-BMP character occupies four bytes at the cut; its low unit leads the next frame.
                        *start += 4;
                    }
                    self.lane.publish("process/outputDelta", params, json!({}));
                }
            }
        };
        loop {
            let next = match relay.due() {
                Some(due) => tokio::select! {
                    biased;
                    event = events.next() => Some(event),
                    () = tokio::time::sleep_until(due) => None,
                },
                None => Some(events.next().await),
            };
            // A pump the ring overtook (its clients held it past the process's end) goes on from the oldest event left: its offsets
            // follow the feed's, so what the clients see skips the output it lost instead of mislabelling what follows.
            if let Some(Some(ProcessEvent::Output { bytes, .. })) = &next {
                taken = events.taken() - bytes.len() as u64;
            }
            let end = match &next {
                Some(Some(ProcessEvent::Output { bytes, .. })) => Some(taken + bytes.len() as u64),
                _ => None,
            };
            // A relay flush sends only output the pump has taken already.
            Self::unheld(entry, if next.is_none() { Some(taken) } else { end }).await;
            // No hold keeps this output back any more: a change that waits for the pump to reach it (a shell's end before its exit
            // line) goes before it enters the relay buffer.
            let published = match (end, entry.taken.get()) {
                (Some(_), Some(tell)) => tell(PumpPoint::Reaching(taken)),
                _ => None,
            };
            if let Some(published) = published {
                #[cfg(test)]
                entry.ordered.send_modify(|waits| *waits += 1);
                // The change this output follows (a shell's end, before its exit line) reaches the clients first: the same order a
                // client got from Node. Bounded like a reply's wait for its events (a section worker that is stuck downstream).
                let _ = tokio::time::timeout(ORDER_DEADLINE, published).await;
            }
            let Some(event) = next else {
                relay_out(relay.flush(tokio::time::Instant::now()), &mut relay_start);
                continue;
            };
            match event {
                Some(ProcessEvent::Output { bytes, .. }) => {
                    let state = if entry.text {
                        screen.append(&String::from_utf8_lossy(&bytes));
                        json!({ "text": screen.read() })
                    } else {
                        json!({})
                    };
                    output(&entry.publisher, &bytes, taken, state);
                    // Node's relay lane takes output into its buffer only while a phone reads the terminal lane
                    // (remote-relay-push-lanes.ts:98-101): output from before the first reader never reaches it, and with no reader
                    // nothing is buffered. What already waits goes out when due, to whoever reads then.
                    if entry.relay && self.lane.feed.subscribers() > 0 {
                        let now = tokio::time::Instant::now();
                        if relay_end != taken {
                            // An interval without readers is not part of the buffered byte range.
                            relay_out(relay.flush(now), &mut relay_start);
                            relay_start = taken;
                        }
                        relay_end = taken + bytes.len() as u64;
                        relay_out(relay.push(&bytes, now), &mut relay_start);
                    }
                    taken += bytes.len() as u64;
                    entry.published.send_replace(taken);
                    // The changes this chunk's markers caused go now, and reach the clients before the relay buffer sends the chunk's
                    // text (Node broadcast them before its 16 ms flush); bounded as the wait above.
                    if let Some(published) = entry.taken.get().and_then(|tell| tell(PumpPoint::Taken(taken))) {
                        let _ = tokio::time::timeout(ORDER_DEADLINE, published).await;
                    }
                }
                Some(ProcessEvent::Exited { exit, .. }) => {
                    let state = if entry.text { json!({ "text": screen.read(), "exited": true }) } else { json!({ "exited": true }) };
                    entry.publisher.publish("process/exited", named(exited_params(handle, &exit)), state);
                    // Node's relay lane sends what waits when its 16 ms are up, exit or not; the tab's exit on the lane follows it.
                    if let Some(due) = relay.due() {
                        tokio::time::sleep_until(due).await;
                        relay_out(relay.flush(tokio::time::Instant::now()), &mut relay_start);
                    }
                    if entry.relay {
                        let mut params = named(exited_params(handle, &exit));
                        params["outputStream"] = json!(stream);
                        self.lane.publish("process/exited", params, json!({}));
                    }
                    break;
                }
                None => break,
            }
        }
        self.finish(entry);
    }

    /// The pump of `entry` ended. It is queued for eviction only while it is still the handle's feed: a feed [`Self::close`] retired
    /// is queued already, and the handle's feed now may be a new tab's, which this pump must not retire (Node's exit handler captured
    /// its own terminal entry, terminal-manager.ts `spawnTerminal`).
    fn finish(&self, entry: &Arc<Entry>) {
        entry.finished.store(true, Ordering::Release);
        entry.published.send_replace(u64::MAX);
        // Nothing more is taken: whatever still waits for it goes.
        if let Some(tell) = entry.taken.get() {
            let _ = tell(PumpPoint::Taken(u64::MAX));
        }
        if let Some(hook) = self.on_exit.get() {
            hook(entry.handle.as_str());
        }
        let current = self.entries.lock().unwrap_or_else(|e| e.into_inner()).get(entry.handle.as_str()).is_some_and(|live| Arc::ptr_eq(live, entry));
        self.retire(if current { vec![Arc::clone(entry)] } else { Vec::new() });
    }
}

#[cfg(test)]
impl ProcessFeeds {
    /// Opens `terminal` on the process running under `handle` (spawned outside the tab layer), as a tab's spawn does, and holds its feed
    /// as an ensure does.
    pub(crate) fn open_spawned(self: &Arc<Self>, handle: &str, terminal: &TerminalId, order: impl FnOnce() -> Option<PumpTell> + Send + 'static) -> FeedHold {
        let output = self.manager.feed_of(&ProcessHandle::from(handle)).expect("a process runs under the handle");
        self.terminal_opened(handle, terminal.clone(), output, Box::new(order));
        self.open_terminal(handle, terminal).expect("the terminal just opened is the handle's")
    }

    /// The holds out on the current feed of `handle`, as they change.
    pub(crate) fn holds_of(&self, handle: &str) -> tokio::sync::watch::Receiver<Vec<u64>> {
        self.entries.lock().unwrap().get(handle).expect("the feed exists").hold.subscribe()
    }

    /// How often the pump of the current feed of `handle` has waited for a change to reach the clients, as it changes.
    #[cfg(all(test, feature = "core-test", windows))]
    pub(crate) fn orderings_of(&self, handle: &str) -> tokio::sync::watch::Receiver<u64> {
        self.entries.lock().unwrap().get(handle).expect("the feed exists").ordered.subscribe()
    }

    /// Where the current feed of `handle` stands.
    pub(crate) fn position_of(&self, handle: &str) -> FeedPosition {
        self.entries.lock().unwrap().get(handle).expect("the feed exists").publisher.feed.position()
    }

    /// Whether `handle` has a feed now.
    pub(crate) fn has_feed(&self, handle: &str) -> bool {
        self.entries.lock().unwrap().contains_key(handle)
    }

    /// The output offset the pump of the current feed of `handle` has published up to, as it changes.
    pub(crate) fn published_of(&self, handle: &str) -> tokio::sync::watch::Receiver<u64> {
        self.entries.lock().unwrap().get(handle).expect("the feed exists").published.subscribe()
    }

    /// How often the pump of the current feed of `handle` has stopped for a hold, as it changes.
    pub(crate) fn stops_of(&self, handle: &str) -> tokio::sync::watch::Receiver<u64> {
        self.entries.lock().unwrap().get(handle).expect("the feed exists").stopped.subscribe()
    }

    /// The next claim's hold on `handle` runs `seam` once it is taken.
    pub(crate) fn after_mark(&self, handle: &str, seam: impl FnOnce() + Send + 'static) {
        *self.entries.lock().unwrap().get(handle).expect("the feed exists").after_mark.lock().unwrap() = Some(Box::new(seam));
    }
}

#[cfg(all(test, feature = "core-test"))]
mod tests {
    use mixdog_core_api::domain::process::ProcessManager;

    use super::*;

    /// The output of a terminal whose shell ended without writing anything.
    fn ended_output() -> Arc<Feed> {
        let output = Feed::new(1 << 20);
        output.push_exit(ProcessExit { status: ExitStatus::Code(0), killed: None });
        output
    }

    fn terminal(incarnation: u64) -> TerminalId {
        TerminalId { core: "test".into(), incarnation }
    }

    /// A tab disposed and opened again under the same id before the old pump ended: the old pump's end queues nothing for eviction,
    /// in particular not the new tab's live feed (which the eviction would later close under it).
    #[tokio::test]
    async fn an_old_pump_does_not_retire_its_replacement() {
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, crate::manager::ProcessConfig::default());
        let feeds = ProcessFeeds::new(manager, Arc::new(mixdog_core_api::mock::MockScopedFeeds::new(mixdog_core_api::mock::MockLimits::default())));
        feeds.terminal_opened("term_reused", terminal(1), ended_output(), Box::new(|| None));
        let old = feeds.entries.lock().unwrap().get("term_reused").cloned().unwrap();
        feeds.close("term_reused", &terminal(1));
        feeds.terminal_opened("term_reused", terminal(2), ended_output(), Box::new(|| None));
        let replacement = feeds.entries.lock().unwrap().get("term_reused").cloned().unwrap();
        assert!(!Arc::ptr_eq(&old, &replacement));
        feeds.pump(&old).await;
        let queued: Vec<Arc<Entry>> = feeds.finished.lock().unwrap().iter().cloned().collect();
        assert!(queued.iter().all(|queued| !Arc::ptr_eq(queued, &replacement)), "the old pump queued the new tab's live feed for eviction");
        assert_eq!(queued.len(), 1, "the retired feed is queued once");
    }

    /// A feed whose pump finished and which a dispose then closes is queued for eviction once: it takes one slot of the retained feeds.
    #[tokio::test]
    async fn a_finished_then_closed_feed_is_queued_once() {
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, crate::manager::ProcessConfig::default());
        let feeds = ProcessFeeds::new(manager, Arc::new(mixdog_core_api::mock::MockScopedFeeds::new(mixdog_core_api::mock::MockLimits::default())));
        feeds.terminal_opened("term_twice", terminal(1), ended_output(), Box::new(|| None));
        let entry = feeds.entries.lock().unwrap().get("term_twice").cloned().unwrap();
        // The shell has ended: the pump ends as soon as it runs and queues its (current) feed.
        feeds.pump(&entry).await;
        feeds.close("term_twice", &terminal(1));
        assert_eq!(feeds.finished.lock().unwrap().len(), 1, "the feed is queued once");
    }

    /// A caller that still names an earlier terminal of the id (an attach or ensure that read the tab before its shell was respawned)
    /// finds no feed for it: it never makes one that would pump that terminal a second time, and never takes the id's feed from the
    /// later terminal.
    #[tokio::test]
    async fn an_earlier_terminal_of_the_id_never_gets_a_feed_again() {
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, crate::manager::ProcessConfig::default());
        let feeds = ProcessFeeds::new(manager, Arc::new(mixdog_core_api::mock::MockScopedFeeds::new(mixdog_core_api::mock::MockLimits::default())));
        feeds.terminal_opened("term_stale", terminal(1), ended_output(), Box::new(|| None));
        feeds.terminal_opened("term_stale", terminal(2), ended_output(), Box::new(|| None));
        let later = feeds.entries.lock().unwrap().get("term_stale").cloned().unwrap();
        assert!(feeds.open_terminal("term_stale", &terminal(1)).is_none());
        assert!(feeds.terminal_cut("term_stale", &terminal(1)).is_none());
        assert!(feeds.hold("term_stale", &terminal(1)).is_none());
        feeds.close("term_stale", &terminal(1));
        let current = feeds.entries.lock().unwrap().get("term_stale").cloned().unwrap();
        assert!(Arc::ptr_eq(&current, &later), "the later terminal's feed stays the id's");
        assert!(!current.started.load(Ordering::Acquire), "nothing the earlier terminal's callers did started the later one's pump");
    }

    /// A disposal's hold keeps the pump from publishing (the killed shell's last output and its exit come after the dispose's answer,
    /// as in Node). The process has exited and all its events are in the ring before the pump runs, so an unheld pump publishes them
    /// and ends in its first poll; a held one is pending, and ends once the hold goes.
    #[tokio::test]
    async fn a_held_feed_publishes_nothing_until_the_hold_goes() {
        use std::future::Future;

        use mixdog_core_api::domain::common::AbsPath;
        use mixdog_core_api::domain::process::CommandSpec;
        use mixdog_core_api::domain::process::EnvSpec;
        use mixdog_core_api::domain::process::OutputMode;
        use mixdog_core_api::domain::process::ProcessOwner;
        use mixdog_core_api::domain::process::SpawnRequest;
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, crate::manager::ProcessConfig::default());
        let handle = ProcessHandle::from("feed-hold");
        let (program, args) =
            if cfg!(windows) { ("cmd.exe", vec!["/c".to_owned(), "echo held".to_owned()]) } else { ("sh", vec!["-c".to_owned(), "echo held".to_owned()]) };
        manager
            // As a terminal tab's process: its output stays in the ring for the pump that subscribes after this reader.
            .spawn_with(
                SpawnRequest {
                    handle: handle.clone(),
                    command: CommandSpec::Argv { program: program.to_owned(), args },
                    cwd: AbsPath::new(std::env::temp_dir()).unwrap(),
                    env: EnvSpec { inherit: true, ..EnvSpec::default() },
                    pty: None,
                    stdin_piped: false,
                    output: OutputMode::Merged,
                    owner: ProcessOwner::Internal,
                    time_limit: None,
                },
                crate::manager::SpawnOptions { replays_after_exit: true, ..Default::default() },
            )
            .await
            .unwrap();
        let mut events = manager.subscribe(&handle, Some(0)).unwrap();
        while let Some(event) = events.next().await {
            if matches!(event, ProcessEvent::Exited { .. }) {
                break;
            }
        }
        let output = manager.feed_of(&handle).expect("the process is listed");
        let feeds = ProcessFeeds::new(manager, Arc::new(mixdog_core_api::mock::MockScopedFeeds::new(mixdog_core_api::mock::MockLimits::default())));
        feeds.terminal_opened("feed-hold", terminal(1), output, Box::new(|| None));
        let entry = feeds.entries.lock().unwrap().get("feed-hold").cloned().unwrap();
        let hold = feeds.hold("feed-hold", &terminal(1)).expect("the feed exists");
        let mut pump = std::pin::pin!(feeds.pump(&entry));
        let first = std::future::poll_fn(|cx| std::task::Poll::Ready(pump.as_mut().poll(cx))).await;
        assert!(first.is_pending(), "the pump published the exited process's events while its feed was held");
        assert_eq!(entry.publisher.feed.position().seq, 0, "nothing was published while held");
        drop(hold);
        pump.await;
        assert!(entry.publisher.feed.position().seq >= 2, "the output and the exit are published once the hold goes");
    }

    /// A process that printed `text` and exited, its events all in the manager's ring.
    async fn exited(name: &str, text: &str) -> LocalProcessManager {
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, crate::manager::ProcessConfig::default());
        run_to_exit(&manager, name, text).await;
        manager
    }

    /// Runs a process under `name` in `manager` that prints `text` and exits, and waits until its events are all in the manager's ring.
    async fn run_to_exit(manager: &LocalProcessManager, name: &str, text: &str) {
        use mixdog_core_api::domain::common::AbsPath;
        use mixdog_core_api::domain::process::CommandSpec;
        use mixdog_core_api::domain::process::EnvSpec;
        use mixdog_core_api::domain::process::OutputMode;
        use mixdog_core_api::domain::process::ProcessOwner;
        use mixdog_core_api::domain::process::SpawnRequest;
        let handle = ProcessHandle::from(name);
        let echo = format!("echo {text}");
        let (program, args) = if cfg!(windows) { ("cmd.exe", vec!["/c".to_owned(), echo]) } else { ("sh", vec!["-c".to_owned(), echo]) };
        manager
            // As a terminal tab's process: its output stays in the ring for the pump that subscribes after this reader.
            .spawn_with(
                SpawnRequest {
                    handle: handle.clone(),
                    command: CommandSpec::Argv { program: program.to_owned(), args },
                    cwd: AbsPath::new(std::env::temp_dir()).unwrap(),
                    env: EnvSpec { inherit: true, ..EnvSpec::default() },
                    pty: None,
                    stdin_piped: false,
                    output: OutputMode::Merged,
                    owner: ProcessOwner::Internal,
                    time_limit: None,
                },
                crate::manager::SpawnOptions { replays_after_exit: true, ..Default::default() },
            )
            .await
            .unwrap();
        let mut events = manager.subscribe(&handle, Some(0)).unwrap();
        while let Some(event) = events.next().await {
            if matches!(event, ProcessEvent::Exited { .. }) {
                break;
            }
        }
    }

    /// A terminal's feed carries that one terminal: the id's next terminal (a respawn under the same handle) gets a feed of its own,
    /// pumping the new process, whether the earlier terminal's pump has ended or is still held when the next process runs under the
    /// handle (a natural-exit respawn, or a `dispose_under` and an ensure at once); each feed carries only its own terminal's output, and
    /// every frame of it, the exit on the terminal lane included, names that terminal.
    async fn a_respawned_terminal_gets_a_feed_of_its_own(earlier_ended: bool) {
        use mixdog_core_api::mock::FeedTap;
        const DEADLINE: std::time::Duration = std::time::Duration::from_secs(60);
        let name = if earlier_ended { "term_respawned_after" } else { "term_respawned_during" };
        let manager = exited(name, "first").await;
        let feeds = ProcessFeeds::new(manager.clone(), Arc::new(mixdog_core_api::mock::MockScopedFeeds::new(mixdog_core_api::mock::MockLimits::default())));
        let lane = FeedTap::attach(&feeds.lane.feed);
        let exit_of = |frames: &[Value], terminal: &TerminalId| {
            frames.iter().any(|frame| frame["method"] == "process/exited" && frame["params"]["terminal"] == terminal_json(terminal))
        };
        let text = |frames: &[Value]| {
            let output: Vec<&Value> = frames.iter().filter(|frame| frame["method"] == "process/outputDelta").collect();
            let text = output
                .iter()
                .map(|frame| String::from_utf8(STANDARD.decode(frame["params"]["bytesB64"].as_str().unwrap()).unwrap()).unwrap())
                .collect::<String>();
            (text, output.iter().map(|frame| frame["params"]["terminal"].clone()).collect::<Vec<_>>())
        };
        let current = || feeds.entries.lock().unwrap().get(name).cloned().unwrap();
        let first = TerminalId { core: "run".into(), incarnation: 1 };
        let earlier = feeds.open_spawned(name, &first, || None);
        let first_feed = FeedTap::attach(&current().publisher.feed);
        let earlier = if earlier_ended {
            drop(earlier);
            tokio::time::timeout(DEADLINE, lane.notifications_until(|frames| exit_of(frames, &first))).await.expect("the earlier terminal's exit");
            None
        } else {
            Some(earlier)
        };
        run_to_exit(&manager, name, "second").await;
        let second = TerminalId { core: "run".into(), incarnation: 2 };
        let later = feeds.open_spawned(name, &second, || None);
        let second_feed = FeedTap::attach(&current().publisher.feed);
        drop(later);
        tokio::time::timeout(DEADLINE, lane.notifications_until(|frames| exit_of(frames, &second)))
            .await
            .expect("the respawned terminal's feed was never pumped, or its exit does not name it");
        drop(earlier);
        let frames = tokio::time::timeout(DEADLINE, lane.notifications_until(|frames| exit_of(frames, &first))).await.expect("the earlier terminal's exit");
        let exits: Vec<&Value> = frames.iter().filter(|frame| frame["method"] == "process/exited").collect();
        assert_eq!(exits.len(), 2, "one exit for each terminal: {exits:?}");
        for (feed, own, other, terminal) in [(&first_feed, "first", "second", &first), (&second_feed, "second", "first", &second)] {
            let frames = tokio::time::timeout(DEADLINE, feed.notifications_until(|frames| frames.iter().any(|frame| frame["method"] == "process/exited")))
                .await
                .expect("each terminal's feed ends with its exit");
            let (text, named) = text(&frames);
            assert!(text.contains(own) && !text.contains(other), "the feed of the {own} terminal carried {text:?}");
            assert!(named.iter().all(|named| *named == terminal_json(terminal)), "every output frame names its terminal: {named:?}");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_terminal_respawned_while_the_earlier_ones_end_is_held_gets_a_feed_of_its_own() {
        a_respawned_terminal_gets_a_feed_of_its_own(false).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_terminal_respawned_after_the_earlier_one_ended_gets_a_feed_of_its_own() {
        a_respawned_terminal_gets_a_feed_of_its_own(true).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_chunk_reaches_the_first_relay_reader_exactly_once() {
        use mixdog_core_api::feed::subscribe;
        use mixdog_core_api::ids::ConnectionId;
        use mixdog_core_api::mock::MockConnection;
        use mixdog_core_api::mock::MockLimits;
        use mixdog_core_api::sink::ConnectionSink;
        let manager = exited("relay-once", "once").await;
        let feeds = ProcessFeeds::new(manager, Arc::new(mixdog_core_api::mock::MockScopedFeeds::new(MockLimits::default())));
        let (ended, end) = tokio::sync::oneshot::channel();
        let ended = Mutex::new(Some(ended));
        feeds.on_exit(move |_| {
            if let Some(ended) = ended.lock().unwrap().take() {
                let _ = ended.send(());
            }
        });
        let conn = MockConnection::new(ConnectionId(1), MockLimits::default());
        let attached = subscribe(&feeds.lane.source(), SubscriptionId::from("s"), Window::Fixed, None, &conn).unwrap();
        conn.send_control_release(Bytes::from_static(b"ok"), attached.release).unwrap();
        drop(feeds.open_spawned("relay-once", &terminal(1), || None));
        tokio::time::timeout(std::time::Duration::from_secs(60), end).await.expect("the pump ended within 60 s").unwrap();
        let mut got = Vec::new();
        for line in conn.drain_text() {
            let Some(frame) = line.strip_prefix("s:") else { continue };
            let note: Value = serde_json::from_str(frame).unwrap();
            if note["method"] == "process/outputDelta" {
                got.extend(STANDARD.decode(note["params"]["bytesB64"].as_str().unwrap()).unwrap());
            }
        }
        let expected = if cfg!(windows) { "once\r\n" } else { "once\n" };
        assert_eq!(String::from_utf8(got).unwrap(), expected, "the output, once");
    }

    /// The ensure's hold is bounded by its request: kept in `after_answer`, it ends when the answer is queued, and also when the request
    /// goes unanswered (cancelled, its connection gone: the last clone of `after_answer` dropped without a release).
    #[tokio::test]
    async fn an_ensure_hold_ends_with_an_unanswered_request() {
        use std::future::Future;
        let manager = exited("ensure-hold", "held").await;
        let feeds = ProcessFeeds::new(manager, Arc::new(mixdog_core_api::mock::MockScopedFeeds::new(mixdog_core_api::mock::MockLimits::default())));
        let _ = feeds.feed("ensure-hold", true);
        let entry = feeds.entries.lock().unwrap().get("ensure-hold").cloned().unwrap();
        let after = mixdog_core_api::call::AfterAnswer::default();
        after.keep(entry.hold());
        let mut pump = std::pin::pin!(feeds.pump(&entry));
        let first = std::future::poll_fn(|cx| std::task::Poll::Ready(pump.as_mut().poll(cx))).await;
        assert!(first.is_pending(), "held while the request lives");
        drop(after);
        pump.await;
        assert!(entry.publisher.feed.position().seq >= 2, "published once the unanswered request went");
    }

    /// A claim's cut and hold are one step: output the shell writes right after the cut (the seam writes it as soon as the hold is
    /// taken, and waits until the pump has either sent it or stopped for the hold) does not reach the feed before the owner's
    /// announcement can go, as in Node, which resized and announced before it read any later output (terminal-manager.ts:485-488).
    #[tokio::test(flavor = "multi_thread")]
    async fn output_written_right_after_a_claims_cut_is_held() {
        use mixdog_core_api::domain::common::AbsPath;
        use mixdog_core_api::domain::process::CommandSpec;
        use mixdog_core_api::domain::process::EnvSpec;
        use mixdog_core_api::domain::process::OutputMode;
        use mixdog_core_api::domain::process::ProcessOwner;
        use mixdog_core_api::domain::process::SpawnRequest;
        use mixdog_core_api::mock::FeedTap;
        const DEADLINE: std::time::Duration = std::time::Duration::from_secs(60);
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, crate::manager::ProcessConfig::default());
        let handle = ProcessHandle::from(format!("claim-cut-{}", std::process::id()));
        let command = if cfg!(windows) {
            let script = "$null = [Console]::In.ReadLine(); [Console]::Out.Write('before'); $null = [Console]::In.ReadLine(); \
                          [Console]::Out.Write('after'); $null = [Console]::In.ReadLine()";
            CommandSpec::Argv { program: "powershell".to_owned(), args: vec!["-NoProfile".to_owned(), "-Command".to_owned(), script.to_owned()] }
        } else {
            CommandSpec::Argv { program: "sh".to_owned(), args: vec!["-c".to_owned(), "read a; printf before; read b; printf after; read c".to_owned()] }
        };
        manager
            // As a terminal tab's process: its output stays in the ring for the pump that subscribes after this reader.
            .spawn_with(
                SpawnRequest {
                    handle: handle.clone(),
                    command,
                    cwd: AbsPath::new(std::env::temp_dir()).unwrap(),
                    env: EnvSpec { inherit: true, ..EnvSpec::default() },
                    pty: None,
                    stdin_piped: true,
                    output: OutputMode::Merged,
                    owner: ProcessOwner::Internal,
                    time_limit: None,
                },
                crate::manager::SpawnOptions { replays_after_exit: true, ..Default::default() },
            )
            .await
            .unwrap();
        let scoped = Arc::new(mixdog_core_api::mock::MockScopedFeeds::new(mixdog_core_api::mock::MockLimits::default()));
        let feeds = ProcessFeeds::new(manager.clone(), Arc::clone(&scoped) as Arc<dyn ScopedFeeds>);
        drop(feeds.open_spawned(handle.as_str(), &terminal(1), || None));
        let raw = scoped.find(&FeedId::from(format!("process:{handle}"))).expect("the raw feed exists");
        let tap = Arc::new(FeedTap::attach(&raw));
        let text = |frames: &[Value]| {
            frames
                .iter()
                .filter(|frame| frame["method"] == "process/outputDelta")
                .map(|frame| String::from_utf8(STANDARD.decode(frame["params"]["bytesB64"].as_str().unwrap()).unwrap()).unwrap())
                .collect::<String>()
        };
        manager.write_input(&handle, b"1\n".to_vec()).unwrap();
        tokio::time::timeout(DEADLINE, tap.notifications_until(|frames| text(frames).contains("before"))).await.expect("the first output went");

        let mut stops = feeds.stops_of(handle.as_str());
        let stopped = *stops.borrow_and_update();
        let (settled, settle) = std::sync::mpsc::channel();
        let watcher = Arc::clone(&tap);
        tokio::spawn(async move {
            tokio::select! {
                _ = stops.wait_for(|stops| *stops > stopped) => {}
                _ = watcher.notifications_until(|frames| text(frames).contains("after")) => {}
            }
            let _ = settled.send(());
        });
        let writer = manager.clone();
        let written = handle.clone();
        feeds.after_mark(handle.as_str(), move || {
            writer.write_input(&written, b"2\n".to_vec()).unwrap();
            settle.recv_timeout(DEADLINE).expect("the pump sent the later output or stopped for the hold within 60 s");
        });
        let held = feeds.hold_new_output(handle.as_str()).expect("the feed exists");
        let now = tokio::time::timeout(DEADLINE, tap.notifications_until(|_| true)).await.unwrap();
        assert!(!text(&now).contains("after"), "output written after the cut went out before the hold: {}", text(&now));
        drop(held);
        tokio::time::timeout(DEADLINE, tap.notifications_until(|frames| text(frames).contains("after")))
            .await
            .expect("the later output goes once the hold ends");
        let _ = manager.kill(&handle);
    }

    /// With no phone reading the terminal lane, output does not enter the relay buffer (remote-relay-push-lanes.ts:98-101): the raw feed
    /// carries the output and the exit, the lane only the exit.
    #[tokio::test]
    async fn output_with_no_relay_reader_never_enters_the_relay_buffer() {
        use mixdog_core_api::domain::common::AbsPath;
        use mixdog_core_api::domain::process::CommandSpec;
        use mixdog_core_api::domain::process::EnvSpec;
        use mixdog_core_api::domain::process::OutputMode;
        use mixdog_core_api::domain::process::ProcessOwner;
        use mixdog_core_api::domain::process::SpawnRequest;
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, crate::manager::ProcessConfig::default());
        let handle = ProcessHandle::from("relay-unread");
        let (program, args) =
            if cfg!(windows) { ("cmd.exe", vec!["/c".to_owned(), "echo unread".to_owned()]) } else { ("sh", vec!["-c".to_owned(), "echo unread".to_owned()]) };
        manager
            // As a terminal tab's process: its output stays in the ring for the pump that subscribes after this reader.
            .spawn_with(
                SpawnRequest {
                    handle: handle.clone(),
                    command: CommandSpec::Argv { program: program.to_owned(), args },
                    cwd: AbsPath::new(std::env::temp_dir()).unwrap(),
                    env: EnvSpec { inherit: true, ..EnvSpec::default() },
                    pty: None,
                    stdin_piped: false,
                    output: OutputMode::Merged,
                    owner: ProcessOwner::Internal,
                    time_limit: None,
                },
                crate::manager::SpawnOptions { replays_after_exit: true, ..Default::default() },
            )
            .await
            .unwrap();
        let feeds = ProcessFeeds::new(manager, Arc::new(mixdog_core_api::mock::MockScopedFeeds::new(mixdog_core_api::mock::MockLimits::default())));
        let _ = feeds.feed("relay-unread", true);
        let entry = feeds.entries.lock().unwrap().get("relay-unread").cloned().unwrap();
        feeds.pump(&entry).await;
        assert!(entry.publisher.feed.position().seq >= 2, "the raw feed has the output and the exit");
        assert_eq!(feeds.lane.feed.position().seq, 1, "the lane has only the exit");
    }
}
