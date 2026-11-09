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

use crate::manager::LocalProcessManager;

/// Exited processes whose feed stays attachable (replay of a finished run).
const RETAINED_FEEDS: usize = 256;
/// The screen text a terminal feed's snapshot carries: the tail of the output.
const SNAPSHOT_TEXT_BYTES: usize = 256 * 1024;

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
    /// A terminal feed: its snapshot carries the screen text; a process feed's carries only the
    /// run state (its replay is the feed's ring).
    text: bool,
    started: AtomicBool,
    finished: AtomicBool,
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
}

impl FeedSource for Gate {
    fn feed_id(&self) -> FeedId {
        self.entry.publisher.id().clone()
    }

    fn attach(&self, req: AttachRequest) -> Result<AttachDecision, CoreError> {
        let decision = self.entry.publisher.source().attach(req)?;
        if !self.entry.started.swap(true, Ordering::AcqRel) {
            Arc::clone(&self.feeds).start_pump(Arc::clone(&self.entry));
        }
        Ok(decision)
    }

    fn detach(&self, sub: SubscriptionId) {
        self.entry.publisher.source().detach(sub);
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
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = entries.get(handle) {
            let rerun = entry.finished.load(Ordering::Acquire)
                && self.manager.info(&entry.handle).is_ok_and(|info| info.exit.is_none());
            if !rerun {
                return Arc::new(Gate {
                    feeds: Arc::clone(self),
                    entry: Arc::clone(entry),
                });
            }
            entry.publisher.close();
        }
        let state = if text { json!({ "text": "" }) } else { json!({}) };
        let entry = Arc::new(Entry {
            handle: ProcessHandle::from(handle),
            publisher: FramePublisher::create(self.scoped.as_ref(), FeedId::from(format!("process:{handle}")), state),
            text,
            started: AtomicBool::new(false),
            finished: AtomicBool::new(false),
        });
        entries.insert(handle.to_owned(), Arc::clone(&entry));
        Arc::new(Gate {
            feeds: Arc::clone(self),
            entry,
        })
    }

    /// The feed of a terminal tab, live and pumping before anyone subscribes: a `feed/subscribe` attaches the publisher's own source,
    /// which never passes the [`Gate`] that starts the pump, so a tab read only through the feed lane would never be pumped.
    pub(crate) fn open_terminal(self: &Arc<Self>, handle: &str) {
        let _ = self.feed(handle, true);
        let entry = self.entries.lock().unwrap_or_else(|e| e.into_inner()).get(handle).cloned();
        let Some(entry) = entry else { return };
        if !entry.started.swap(true, Ordering::AcqRel) {
            Arc::clone(self).start_pump(entry);
        }
    }

    /// Ends the feed of a disposed tab: its subscribers are detached.
    pub(crate) fn close(&self, handle: &str) {
        let removed = self.entries.lock().unwrap_or_else(|e| e.into_inner()).remove(handle);
        if let Some(entry) = removed {
            entry.publisher.close();
        }
    }

    fn start_pump(self: Arc<Self>, entry: Arc<Entry>) {
        mixdog_rt::spawn("process-feed", TaskClass::Work, async move {
            self.pump(&entry).await;
        });
    }

    async fn pump(&self, entry: &Entry) {
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
        let mut screen = String::new();
        while let Some(event) = events.next().await {
            match event {
                ProcessEvent::Output { bytes, .. } => {
                    let state = if entry.text {
                        screen.push_str(&String::from_utf8_lossy(&bytes));
                        if screen.len() > SNAPSHOT_TEXT_BYTES {
                            let mut cut = screen.len() - SNAPSHOT_TEXT_BYTES;
                            while !screen.is_char_boundary(cut) {
                                cut += 1;
                            }
                            screen.drain(..cut);
                        }
                        json!({ "text": screen })
                    } else {
                        json!({})
                    };
                    entry.publisher.publish(
                        "process/outputDelta",
                        json!({ "processHandle": handle, "bytesB64": STANDARD.encode(&bytes) }),
                        state,
                    );
                }
                ProcessEvent::Exited { exit, .. } => {
                    let state = if entry.text {
                        json!({ "text": screen, "exited": true })
                    } else {
                        json!({ "exited": true })
                    };
                    entry.publisher.publish("process/exited", exited_params(handle, &exit), state);
                    break;
                }
            }
        }
        self.finish(entry);
    }

    fn finish(&self, entry: &Entry) {
        entry.finished.store(true, Ordering::Release);
        if let Some(hook) = self.on_exit.get() {
            hook(entry.handle.as_str());
        }
        let evicted = {
            let mut finished = self.finished.lock().unwrap_or_else(|e| e.into_inner());
            let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(current) = entries.get(entry.handle.as_str()) {
                finished.push_back(Arc::clone(current));
            }
            let mut evicted = Vec::new();
            while finished.len() > RETAINED_FEEDS {
                let Some(old) = finished.pop_front() else { break };
                if entries.get(old.handle.as_str()).is_some_and(|current| Arc::ptr_eq(current, &old)) {
                    entries.remove(old.handle.as_str());
                }
                evicted.push(old);
            }
            evicted
        };
        for old in evicted {
            old.publisher.close();
        }
    }
}
