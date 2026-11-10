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
use mixdog_core_api::domain::process::ExitStatus;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessExit;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::feed::AttachDecision;
use mixdog_core_api::feed::AttachRequest;
use mixdog_core_api::feed::FeedFrame;
use mixdog_core_api::feed::FeedPosition;
use mixdog_core_api::feed::FeedSource;
use mixdog_core_api::feed::FeedView;
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
use crate::manager::LocalProcessManager;
use crate::terminal::REPLAY_BUFFER_LIMIT;
use crate::terminal::ReplayBuffer;

/// Exited processes whose feed stays attachable (replay of a finished run).
const RETAINED_FEEDS: usize = 256;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

pub(crate) fn encode(method: &str, params: Value, stamp: FeedStamp) -> Bytes {
    let note = JsonRpcNotification {
        method: method.to_owned(),
        params: Some(params),
        emitted_at_ms: Some(now_ms()),
        feed: Some(stamp),
    };
    Bytes::from(serde_json::to_vec(&note).expect("a notification serializes"))
}

/// The read model of a feed; its snapshot is the `feed/snapshot` of that state.
struct StateView {
    id: FeedId,
    state: Value,
}

impl FeedView for StateView {
    fn encode_snapshot(&self, _lane: &InLane<CpuInteractive>, at: FeedPosition, _window: &Window) -> Bytes {
        let params = FeedSnapshotParams {
            feed_id: self.id.clone(),
            state: self.state.clone(),
        };
        encode(
            "feed/snapshot",
            serde_json::to_value(params).expect("snapshot params serialize"),
            FeedStamp {
                id: self.id.clone(),
                epoch: at.epoch,
                seq: at.seq,
            },
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
        let view = Arc::new(StateView {
            id: id.clone(),
            state,
        });
        Self {
            feed: feeds.create(id.clone(), view),
            id,
            producer: Mutex::new(()),
        }
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
        let frame = FeedFrame {
            seq,
            bytes: encode(
                method,
                params,
                FeedStamp {
                    id: self.id.clone(),
                    epoch: position.epoch,
                    seq,
                },
            ),
        };
        let view = Arc::new(StateView {
            id: self.id.clone(),
            state,
        });
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

struct Entry {
    handle: ProcessHandle,
    publisher: FramePublisher,
    /// A terminal tab's output as Node's relay lane sent it to a phone (`process:relay:<tab>`, see [`super::relay_buffer`]); `None` for a
    /// process feed.
    relay: Option<FramePublisher>,
    /// A terminal feed: its snapshot carries the screen text; a process feed's carries only the
    /// run state (its replay is the feed's ring).
    text: bool,
    started: AtomicBool,
    finished: AtomicBool,
    /// Queued for eviction already (see `ProcessFeeds::retire`).
    retired: AtomicBool,
    /// How many holds are out; while any is, the pump publishes nothing more (see [`FeedHold`]).
    hold: tokio::sync::watch::Sender<usize>,
}

/// A call's hold on its tab's feed: the pump publishes nothing until every hold is dropped. Node answered `termEnsure` and `termDispose`
/// in-process before the output they cause (a new shell's first output, a killed shell's last output and exit line: its PTY reports them
/// later, on its own event), so the phone sees the answer first; the hold makes the core's pump wait for the answer instead of racing it.
pub(crate) struct FeedHold(Arc<Entry>);

impl Drop for FeedHold {
    fn drop(&mut self) {
        self.0.hold.send_modify(|holds| *holds -= 1);
    }
}

impl Entry {
    fn hold(self: &Arc<Self>) -> FeedHold {
        self.hold.send_modify(|holds| *holds += 1);
        FeedHold(Arc::clone(self))
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
}

/// What `feed()` hands the server: attaches like the feed and starts its pump once.
struct Gate {
    feeds: Arc<ProcessFeeds>,
    entry: Arc<Entry>,
    /// The tab's relay feed rather than its raw one.
    relay: bool,
}

impl Gate {
    fn publisher(&self) -> &FramePublisher {
        match (&self.entry.relay, self.relay) {
            (Some(relay), true) => relay,
            _ => &self.entry.publisher,
        }
    }
}

impl Entry {
    fn close(&self) {
        self.publisher.close();
        if let Some(relay) = &self.relay {
            relay.close();
        }
    }
}

impl FeedSource for Gate {
    fn feed_id(&self) -> FeedId {
        self.publisher().id().clone()
    }

    fn attach(&self, req: AttachRequest) -> Result<AttachDecision, CoreError> {
        let decision = self.publisher().source().attach(req)?;
        if !self.entry.started.swap(true, Ordering::AcqRel) {
            Arc::clone(&self.feeds).start_pump(Arc::clone(&self.entry));
        }
        Ok(decision)
    }

    fn detach(&self, sub: SubscriptionId) {
        self.publisher().source().detach(sub);
    }
}

impl ProcessFeeds {
    pub fn new(manager: LocalProcessManager, scoped: Arc<dyn ScopedFeeds>) -> Arc<Self> {
        Arc::new(Self {
            manager,
            scoped,
            entries: Mutex::new(HashMap::new()),
            finished: Mutex::new(VecDeque::new()),
            on_exit: OnceLock::new(),
        })
    }

    /// Called with the handle of every process whose feed saw its exit.
    pub fn on_exit(&self, hook: impl Fn(&str) + Send + Sync + 'static) {
        let _ = self.on_exit.set(Arc::new(hook));
    }

    /// The feed of `handle`, created on first use. A terminal feed (`text`) also keeps the screen
    /// text for its snapshot. A finished run's feed is replaced when the same handle runs again.
    pub(crate) fn feed(self: &Arc<Self>, handle: &str, text: bool) -> Arc<dyn FeedSource> {
        self.feed_for(handle, text, false)
    }

    /// The relay feed of a terminal tab (`process:relay:<tab>`): what a phone reads, its output framed by Node's relay rule.
    pub(crate) fn relay_feed(self: &Arc<Self>, handle: &str) -> Arc<dyn FeedSource> {
        self.feed_for(handle, true, true)
    }

    fn feed_for(self: &Arc<Self>, handle: &str, text: bool, relay: bool) -> Arc<dyn FeedSource> {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = entries.get(handle) {
            let rerun = entry.finished.load(Ordering::Acquire)
                && self.manager.info(&entry.handle).is_ok_and(|info| info.exit.is_none());
            if !rerun {
                return Arc::new(Gate {
                    feeds: Arc::clone(self),
                    entry: Arc::clone(entry),
                    relay,
                });
            }
            entry.close();
        }
        let state = if text { json!({ "text": "" }) } else { json!({}) };
        let entry = Arc::new(Entry {
            handle: ProcessHandle::from(handle),
            publisher: FramePublisher::create(self.scoped.as_ref(), FeedId::from(format!("process:{handle}")), state.clone()),
            relay: text.then(|| FramePublisher::create(self.scoped.as_ref(), FeedId::from(format!("process:relay:{handle}")), state)),
            text,
            started: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            retired: AtomicBool::new(false),
            hold: tokio::sync::watch::Sender::new(0),
        });
        entries.insert(handle.to_owned(), Arc::clone(&entry));
        Arc::new(Gate {
            feeds: Arc::clone(self),
            entry,
            relay,
        })
    }

    /// The feed of a terminal tab, live and pumping before anyone subscribes: a `feed/subscribe` attaches the publisher's own source,
    /// which never passes the [`Gate`] that starts the pump, so a tab read only through the feed lane would never be pumped.
    /// Returns a hold taken before the pump starts: the ensure's answer goes ahead of the shell's first output.
    pub(crate) fn open_terminal(self: &Arc<Self>, handle: &str) -> Option<FeedHold> {
        let _ = self.feed(handle, true);
        let entry = self.entries.lock().unwrap_or_else(|e| e.into_inner()).get(handle).cloned()?;
        let held = entry.hold();
        if !entry.started.swap(true, Ordering::AcqRel) {
            Arc::clone(self).start_pump(Arc::clone(&entry));
        }
        Some(held)
    }

    /// Holds the current feed of `handle` (see [`FeedHold`]); `None` when it has none.
    pub(crate) fn hold(&self, handle: &str) -> Option<FeedHold> {
        let entry = self.entries.lock().unwrap_or_else(|e| e.into_inner()).get(handle).cloned()?;
        Some(entry.hold())
    }

    /// Retires the feed of a disposed tab: a new tab of the same id gets a feed of its own, and this one stays attached until it is evicted like
    /// any finished feed, so a subscriber still gets what the shell wrote while it was killed (Node's pty keeps delivering after dispose:
    /// golden.json, trace.order, the output of term_ph2b after its termDispose) and its `process/exited`, which ends the subscriber's
    /// reading (the phone's adapter leaves the feed on it). It is never closed here, finished or not: a close ends the lanes at once and
    /// drops frames a subscriber has not read yet.
    pub(crate) fn close(&self, handle: &str) {
        let removed = self.entries.lock().unwrap_or_else(|e| e.into_inner()).remove(handle);
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

    /// Waits while a call holds the feed.
    async fn unheld(entry: &Entry) {
        let mut held = entry.hold.subscribe();
        let _ = held.wait_for(|holds| *holds == 0).await;
    }

    async fn pump(&self, entry: &Arc<Entry>) {
        let handle = &entry.handle;
        let mut events = match self.manager.subscribe(handle, Some(0)) {
            Ok(events) => events,
            // The ring already dropped its first events: start at the oldest one it holds.
            Err(ProcessError::ReplayUnavailable { oldest }) => match self.manager.subscribe(handle, Some(oldest)) {
                Ok(events) => events,
                Err(_) => return self.finish(entry),
            },
            Err(_) => return self.finish(entry),
        };
        // The window a late subscriber is given: Node's replay buffer, the last 200,000 UTF-16 units (a cut may fall inside a non-BMP
        // character, which then reads as U+FFFD at the window's start).
        let mut screen = ReplayBuffer::new(REPLAY_BUFFER_LIMIT, 0);
        // The relay feed's framing (Node's relay lane), timed on the runtime's clock.
        let mut relay = RelayBuffer::default();
        let output = |publisher: &FramePublisher, bytes: &[u8], state: Value| {
            publisher.publish("process/outputDelta", json!({ "processHandle": handle, "bytesB64": STANDARD.encode(bytes) }), state);
        };
        let relay_out = |frames: Vec<RelayFrame>, state: &Value| {
            if let Some(publisher) = &entry.relay {
                for frame in frames {
                    let mut params = json!({ "processHandle": handle, "bytesB64": STANDARD.encode(&frame.bytes) });
                    // A frame Node cut inside a surrogate pair: the lone units at its edges (see `RelayFrame`).
                    if let Some(lead) = frame.lead {
                        params["leadUnit"] = json!(lead);
                    }
                    if let Some(tail) = frame.tail {
                        params["tailUnit"] = json!(tail);
                    }
                    publisher.publish("process/outputDelta", params, state.clone());
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
            Self::unheld(entry).await;
            let state = if entry.text { json!({ "text": screen.read() }) } else { json!({}) };
            let Some(event) = next else {
                relay_out(relay.flush(tokio::time::Instant::now()), &state);
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
                    output(&entry.publisher, &bytes, state.clone());
                    // Node's relay lane takes output into its buffer only while a phone reads the terminal lane
                    // (remote-relay-push-lanes.ts:98-101): output from before the first reader never reaches it, and with no reader
                    // nothing is buffered. What already waits goes out when due, to whoever reads then.
                    if entry.relay.as_ref().is_some_and(|relay| relay.feed.subscribers() > 0) {
                        relay_out(relay.push(&bytes, tokio::time::Instant::now()), &state);
                    }
                }
                Some(ProcessEvent::Exited { exit, .. }) => {
                    let state = if entry.text {
                        json!({ "text": screen.read(), "exited": true })
                    } else {
                        json!({ "exited": true })
                    };
                    entry.publisher.publish("process/exited", exited_params(handle, &exit), state.clone());
                    // Node's relay lane sends what waits when its 16 ms are up, exit or not; the relay feed ends after it.
                    if let Some(due) = relay.due() {
                        tokio::time::sleep_until(due).await;
                        relay_out(relay.flush(tokio::time::Instant::now()), &state);
                    }
                    if let Some(publisher) = &entry.relay {
                        publisher.publish("process/exited", exited_params(handle, &exit), state);
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
        if let Some(hook) = self.on_exit.get() {
            hook(entry.handle.as_str());
        }
        let current = self
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(entry.handle.as_str())
            .is_some_and(|live| Arc::ptr_eq(live, entry));
        self.retire(if current { vec![Arc::clone(entry)] } else { Vec::new() });
    }
}

#[cfg(all(test, feature = "core-test"))]
mod tests {
    use super::*;

    /// A tab disposed and opened again under the same id before the old pump ended: the old pump's end queues nothing for eviction,
    /// in particular not the new tab's live feed (which the eviction would later close under it).
    #[tokio::test]
    async fn an_old_pump_does_not_retire_its_replacement() {
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, crate::manager::ProcessConfig::default());
        let feeds = ProcessFeeds::new(manager, Arc::new(mixdog_core_api::mock::MockScopedFeeds::new(mixdog_core_api::mock::MockLimits::default())));
        // A handle with no process: its pump ends as soon as it runs (the subscribe fails), which is the pump's end this test needs.
        let _ = feeds.feed("term_reused", true);
        let old = feeds.entries.lock().unwrap().get("term_reused").cloned().unwrap();
        feeds.close("term_reused");
        let _ = feeds.feed("term_reused", true);
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
        let _ = feeds.feed("term_twice", true);
        let entry = feeds.entries.lock().unwrap().get("term_twice").cloned().unwrap();
        // No process under the handle: the pump ends at once and queues its (current) feed.
        feeds.pump(&entry).await;
        feeds.close("term_twice");
        assert_eq!(feeds.finished.lock().unwrap().len(), 1, "the feed is queued once");
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
        let (program, args) = if cfg!(windows) { ("cmd.exe", vec!["/c".to_owned(), "echo held".to_owned()]) } else { ("sh", vec!["-c".to_owned(), "echo held".to_owned()]) };
        manager
            .spawn(SpawnRequest {
                handle: handle.clone(),
                command: CommandSpec::Argv { program: program.to_owned(), args },
                cwd: AbsPath::new(std::env::temp_dir()).unwrap(),
                env: EnvSpec { inherit: true, ..EnvSpec::default() },
                pty: None,
                stdin_piped: false,
                output: OutputMode::Merged,
                owner: ProcessOwner::Internal,
                time_limit: None,
            })
            .await
            .unwrap();
        let mut events = manager.subscribe(&handle, Some(0)).unwrap();
        while let Some(event) = events.next().await {
            if matches!(event, ProcessEvent::Exited { .. }) {
                break;
            }
        }
        let feeds = ProcessFeeds::new(manager, Arc::new(mixdog_core_api::mock::MockScopedFeeds::new(mixdog_core_api::mock::MockLimits::default())));
        let _ = feeds.feed("feed-hold", true);
        let entry = feeds.entries.lock().unwrap().get("feed-hold").cloned().unwrap();
        let hold = feeds.hold("feed-hold").expect("the feed exists");
        let mut pump = std::pin::pin!(feeds.pump(&entry));
        let first = std::future::poll_fn(|cx| std::task::Poll::Ready(pump.as_mut().poll(cx))).await;
        assert!(first.is_pending(), "the pump published the exited process's events while its feed was held");
        assert_eq!(entry.publisher.feed.position().seq, 0, "nothing was published while held");
        drop(hold);
        pump.await;
        assert!(entry.publisher.feed.position().seq >= 2, "the output and the exit are published once the hold goes");
    }

    /// With no phone reading the relay feed, output does not enter the relay buffer (remote-relay-push-lanes.ts:98-101): the raw feed
    /// carries the output and the exit, the relay feed only the exit.
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
        let (program, args) = if cfg!(windows) { ("cmd.exe", vec!["/c".to_owned(), "echo unread".to_owned()]) } else { ("sh", vec!["-c".to_owned(), "echo unread".to_owned()]) };
        manager
            .spawn(SpawnRequest {
                handle: handle.clone(),
                command: CommandSpec::Argv { program: program.to_owned(), args },
                cwd: AbsPath::new(std::env::temp_dir()).unwrap(),
                env: EnvSpec { inherit: true, ..EnvSpec::default() },
                pty: None,
                stdin_piped: false,
                output: OutputMode::Merged,
                owner: ProcessOwner::Internal,
                time_limit: None,
            })
            .await
            .unwrap();
        let feeds = ProcessFeeds::new(manager, Arc::new(mixdog_core_api::mock::MockScopedFeeds::new(mixdog_core_api::mock::MockLimits::default())));
        let _ = feeds.relay_feed("relay-unread");
        let entry = feeds.entries.lock().unwrap().get("relay-unread").cloned().unwrap();
        feeds.pump(&entry).await;
        assert!(entry.publisher.feed.position().seq >= 2, "the raw feed has the output and the exit");
        assert_eq!(entry.relay.as_ref().unwrap().feed.position().seq, 1, "the relay feed has only the exit");
    }
}
