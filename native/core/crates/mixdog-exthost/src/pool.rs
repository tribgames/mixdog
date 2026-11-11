//! The worker pool behind [`ExtPool`] (RL §11): a dispatcher task that owns the queues, the
//! workers and their slots, and nothing else. Workers are single-call processes started on
//! demand; every wait is on a fact (a result, a credit, a process exit), except the one bound
//! on a cancelled call: a worker still on it after [`CANCEL_GRACE`] is ended.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use arc_swap::ArcSwap;
use mixdog_core_api::domain::ext::ExtCall;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::ExtFrame;
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_core_api::domain::ext::ExtWorkerId;
use mixdog_core_api::domain::ext::ExtWorkerState;
use mixdog_core_api::domain::ext::ExtWorkerStatus;
use mixdog_core_api::domain::common::EventSource;
use mixdog_protocol::ThreadId;
use mixdog_rt::LaneToken;
use mixdog_rt::SpawnIo;
use mixdog_rt::TaskClass;
use tokio::runtime::Handle;
use tokio::sync::mpsc;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::browser;
use crate::browser::BrowserHandle;
use crate::browser::RenderBrowser;
use crate::browser::RenderBrowserConfig;
use crate::exits::ChildExits;
use crate::exits::ExtHostError;
use crate::frame;
use crate::process;
use crate::process::WorkerIo;
use crate::schedule::Schedule;
use crate::shared::CallOut;
use crate::shared::Event;
use crate::shared::Queued;
use crate::stream::CallStream;

/// How long a worker may keep a call after its caller dropped it and the cancel was sent, before the
/// worker is ended.
pub const CANCEL_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

/// Calls accepted and not yet released by their consumer; beyond it a call is `Overloaded`.
pub const DEFAULT_PENDING_CAP: usize = 64;

#[derive(Clone, Debug)]
pub struct ExtHostConfig {
    /// The JavaScript runtime and the worker entry (`node src/ext-host/worker.mjs`).
    pub program: PathBuf,
    pub args: Vec<OsString>,
    /// `program` is an Electron binary run in node mode (`JsRuntime.electron`): workers are
    /// started with `ELECTRON_RUN_AS_NODE=1`.
    pub electron: bool,
    /// Worker processes at most (W).
    pub workers: usize,
    pub pending_cap: usize,
    pub spawn_io: SpawnIo,
    pub render_browser: RenderBrowserConfig,
}

/// W = min(4, max(1, cores/4)); the `office.workers` setting is clamped to 1..=cores.
pub fn worker_count(configured: Option<usize>, cores: usize) -> usize {
    let cores = cores.max(1);
    match configured {
        Some(n) => n.clamp(1, cores),
        None => (cores / 4).clamp(1, 4),
    }
}

pub struct ExtHostPool {
    events: UnboundedSender<Event>,
    status: Arc<ArcSwap<Vec<ExtWorkerStatus>>>,
    pending: Arc<AtomicUsize>,
    pending_cap: usize,
    next_call: AtomicU32,
    browser_launches: Arc<AtomicU64>,
    browser: BrowserHandle,
    /// Every accepted call's window counter, to observe the core reader's side of the windows.
    #[cfg(feature = "test-support")]
    windows: std::sync::Mutex<Vec<std::sync::Weak<AtomicU64>>>,
}

impl ExtHostPool {
    /// Starts the dispatcher on the work executor. No worker process exists until a call needs
    /// one (the host is never on the boot path). Must run inside the Tokio runtime; fails when the
    /// child-exit signal cannot be registered.
    pub fn new(config: ExtHostConfig) -> Result<Self, ExtHostError> {
        let exits = ChildExits::watch()?;
        let (events, inbox) = mpsc::unbounded_channel();
        let status = Arc::new(ArcSwap::from_pointee(Vec::new()));
        let pending_cap = config.pending_cap;
        let dispatcher_events = events.clone();
        let dispatcher_status = status.clone();
        let browser_launches = Arc::new(AtomicU64::new(0));
        let rt = Handle::current();
        let browser = browser::start(
            config.render_browser.clone(),
            config.spawn_io,
            rt.clone(),
            browser_launches.clone(),
            exits.clone(),
        );
        let dispatcher_browser = browser.clone();
        mixdog_rt::spawn("exthost.dispatch", TaskClass::Work, async move {
            Dispatcher::new(config, rt, dispatcher_events, dispatcher_browser, dispatcher_status, exits)
                .run(inbox)
                .await;
        });
        Ok(Self {
            events,
            status,
            pending: Arc::new(AtomicUsize::new(0)),
            pending_cap,
            next_call: AtomicU32::new(1),
            browser_launches,
            browser,
            #[cfg(feature = "test-support")]
            windows: std::sync::Mutex::default(),
        })
    }

    /// Chunk bytes the core's reader has delivered and the consumer has not yet taken, for each
    /// call still alive. A call whose window is full shows `CALL_WINDOW_BYTES`.
    #[cfg(feature = "test-support")]
    pub fn outstanding_window_bytes(&self) -> Vec<u64> {
        let mut windows = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        windows.retain(|w| w.strong_count() > 0);
        windows
            .iter()
            .filter_map(std::sync::Weak::upgrade)
            .map(|w| w.load(Ordering::Acquire))
            .collect()
    }

    /// The shared render browser, for in-process users (the web renderer): the same browser the
    /// workers lay HTML out in, launched on first need and closed when idle.
    pub fn render_browser(&self) -> RenderBrowser {
        RenderBrowser(self.browser.clone())
    }

    /// Shared render browsers launched so far: one while it is reused, more only after it exited.
    pub fn browser_launches(&self) -> u64 {
        self.browser_launches.load(Ordering::Relaxed)
    }

    /// Closes the host: every worker's owner is asked to kill its worker's group, and this returns
    /// when each owner has signalled and reaped, and the shared render browser has too. The core's
    /// stop procedure must await this before the runtime is dropped, so no owner is cut off
    /// mid-wait. Calls still queued end `Unavailable`.
    pub async fn close(&self) {
        let (done, closed) = oneshot::channel();
        if self.events.send(Event::Shutdown(Some(done))).is_ok() {
            let _ = closed.await;
        }
    }
}

impl Drop for ExtHostPool {
    fn drop(&mut self) {
        let _ = self.events.send(Event::Shutdown(None));
    }
}

impl ExtPool for ExtHostPool {
    fn call(&self, call: ExtCall) -> Result<Box<dyn EventSource<ExtFrame>>, ExtError> {
        if self.pending.fetch_add(1, Ordering::AcqRel) >= self.pending_cap {
            self.pending.fetch_sub(1, Ordering::AcqRel);
            return Err(ExtError::Overloaded);
        }
        let id = self.next_call.fetch_add(1, Ordering::Relaxed).max(1);
        let (frames_tx, frames) = mpsc::unbounded_channel();
        let outstanding = Arc::new(AtomicU64::new(0));
        #[cfg(feature = "test-support")]
        self.windows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(Arc::downgrade(&outstanding));
        let route = Arc::new(OnceLock::new());
        let queued = Queued {
            call,
            out: Arc::new(CallOut {
                frames: frames_tx,
                outstanding: outstanding.clone(),
            }),
            route: route.clone(),
        };
        let stream = CallStream {
            id,
            frames,
            outstanding,
            route,
            events: self.events.clone(),
            pending: self.pending.clone(),
            finished: false,
        };
        // On failure `stream` drops here and gives the pending slot back.
        self.events
            .send(Event::Enqueue { id, queued })
            .map_err(|_| ExtError::Unavailable {
                reason: "extension host stopped".to_owned(),
            })?;
        Ok(Box::new(stream))
    }

    fn status(&self) -> Vec<ExtWorkerStatus> {
        self.status.load().as_ref().clone()
    }

    fn stop_worker(&self, worker: ExtWorkerId) -> Result<(), ExtError> {
        if !self.status.load().iter().any(|s| s.id == worker) {
            return Err(ExtError::UnknownWorker);
        }
        self.events
            .send(Event::Stop(worker.0))
            .map_err(|_| ExtError::UnknownWorker)
    }
}

enum WorkerState {
    /// Spawned (or being spawned) and not yet `ready`.
    Starting,
    Idle,
    Busy {
        call: u32,
        thread: ThreadId,
        since_seq: u64,
    },
}

struct Worker {
    state: WorkerState,
    /// Present once the process exists.
    io: Option<WorkerIo>,
    /// "Stop worker" arrived before the process existed; applied the moment it does.
    stop_requested: bool,
}

struct Dispatcher {
    config: ExtHostConfig,
    rt: Handle,
    events: UnboundedSender<Event>,
    browser: BrowserHandle,
    status: Arc<ArcSwap<Vec<ExtWorkerStatus>>>,
    exits: ChildExits,
    workers: BTreeMap<u32, Worker>,
    next_worker: u32,
    schedule: Schedule<Queued>,
    running: HashMap<u32, u32>,
    seq: u64,
    /// The last spawn failed; no new spawn until another call arrives.
    spawn_failed: bool,
    shutting_down: bool,
    closers: Vec<oneshot::Sender<()>>,
}

impl Dispatcher {
    fn new(
        config: ExtHostConfig,
        rt: Handle,
        events: UnboundedSender<Event>,
        browser: BrowserHandle,
        status: Arc<ArcSwap<Vec<ExtWorkerStatus>>>,
        exits: ChildExits,
    ) -> Self {
        let per_thread_cap = config.workers.div_ceil(2).max(1);
        Self {
            config,
            rt,
            events,
            browser,
            status,
            exits,
            workers: BTreeMap::new(),
            next_worker: 0,
            schedule: Schedule::new(per_thread_cap),
            running: HashMap::new(),
            seq: 0,
            spawn_failed: false,
            shutting_down: false,
            closers: Vec::new(),
        }
    }

    async fn run(mut self, mut inbox: mpsc::UnboundedReceiver<Event>) {
        while let Some(event) = inbox.recv().await {
            self.on(event);
            if self.shutting_down && self.workers.is_empty() {
                break;
            }
        }
        // Every worker owner has reaped; the shared browser's owner is next, so nothing of the
        // host is left running when `close` returns.
        self.browser.shutdown().await;
        for closer in self.closers.drain(..) {
            let _ = closer.send(());
        }
    }

    fn on(&mut self, event: Event) {
        match event {
            Event::Enqueue { id, queued } => {
                if self.shutting_down {
                    fail(&queued, closing());
                    return;
                }
                self.spawn_failed = false;
                let thread = queued.call.thread.clone();
                self.schedule.enqueue(thread, id, queued);
                self.pump();
            }
            Event::Dropped(call) => self.on_dropped(call),
            Event::Spawned { worker, result } => self.on_spawned(worker, result),
            Event::Ready(worker) => {
                if let Some(entry) = self.workers.get_mut(&worker)
                    && matches!(entry.state, WorkerState::Starting)
                    && !entry.stop_requested
                {
                    entry.state = WorkerState::Idle;
                    self.pump();
                }
            }
            Event::Finished { worker, call, pin } => {
                self.running.remove(&call);
                if let Some(entry) = self.workers.get_mut(&worker)
                    && let WorkerState::Busy { thread, .. } =
                        std::mem::replace(&mut entry.state, WorkerState::Idle)
                {
                    self.schedule.finished(&thread, worker, Some(pin));
                }
                self.pump();
            }
            Event::Exited(worker) => self.on_exited(worker),
            Event::Stop(worker) => {
                if let Some(entry) = self.workers.get_mut(&worker) {
                    match &entry.io {
                        Some(io) => stop(io),
                        None => entry.stop_requested = true,
                    }
                }
            }
            Event::CancelGrace { worker, call } => {
                // The worker is still on the call whose caller walked away: its parser ignored the cancel.
                if let Some(entry) = self.workers.get(&worker)
                    && matches!(entry.state, WorkerState::Busy { call: busy, .. } if busy == call)
                    && let Some(io) = &entry.io
                {
                    stop(io);
                }
            }
            Event::Shutdown(closer) => {
                self.closers.extend(closer);
                self.shutdown();
            }
        }
    }

    fn on_dropped(&mut self, call: u32) {
        if self.schedule.remove_queued(call).is_some() {
            return;
        }
        // Running: ask the worker to stop. Its slot stays occupied until it answers or exits, and for
        // at most `CANCEL_GRACE`: a parser that never looks at the cancel (a PDF read in synchronous
        // code) is ended with its process group, so no abandoned call keeps a worker and its CPU.
        if let Some(&worker) = self.running.get(&call)
            && let Some(io) = self.workers.get(&worker).and_then(|w| w.io.as_ref())
        {
            let _ = io.writer.send(frame::cancel(call));
            let events = self.events.clone();
            drop(mixdog_rt::spawn("exthost.cancel-grace", TaskClass::Work, async move {
                tokio::time::sleep(CANCEL_GRACE).await;
                let _ = events.send(Event::CancelGrace { worker, call });
            }));
        }
    }

    fn on_spawned(&mut self, worker: u32, result: Result<process::Proc, String>) {
        match result {
            Ok(proc) => {
                let io = process::start_worker(worker, proc, self.events.clone(), self.browser.clone(), self.exits.clone());
                if self.shutting_down {
                    io.kill.kill();
                }
                if let Some(entry) = self.workers.get_mut(&worker) {
                    if entry.stop_requested {
                        stop(&io);
                    }
                    entry.io = Some(io);
                }
            }
            Err(reason) => {
                tracing::warn!(worker, %reason, "extension worker failed to start");
                self.workers.remove(&worker);
                self.spawn_failed = true;
                if self.workers.is_empty() {
                    for queued in self.schedule.drain() {
                        fail(&queued, ExtError::Unavailable { reason: reason.clone() });
                    }
                }
            }
        }
        self.publish();
    }

    fn on_exited(&mut self, worker: u32) {
        if let Some(entry) = self.workers.remove(&worker) {
            if let WorkerState::Busy { call, thread, .. } = entry.state {
                self.running.remove(&call);
                self.schedule.finished(&thread, worker, None);
            }
            self.schedule.worker_gone(worker);
        }
        self.pump();
    }

    fn shutdown(&mut self) {
        self.shutting_down = true;
        for queued in self.schedule.drain() {
            fail(&queued, closing());
        }
        // Every owner is asked to end its worker (a worker still spawning is asked when its
        // process exists, in `on_spawned`); `run` returns only after each has signalled and reaped.
        for entry in self.workers.values() {
            if let Some(io) = &entry.io {
                io.kill.kill();
            }
        }
        self.publish();
    }

    /// Starts every call that has a free worker, starts workers for the rest, and publishes the
    /// pool's status.
    fn pump(&mut self) {
        loop {
            let ready: Vec<u32> = self
                .workers
                .iter()
                .filter(|(_, w)| matches!(w.state, WorkerState::Idle) && w.io.is_some())
                .map(|(id, _)| *id)
                .collect();
            let Some(assignment) = self.schedule.next(&ready) else { break };
            self.start_call(assignment.worker, assignment.thread, assignment.id, assignment.item);
        }
        self.grow();
        self.publish();
    }

    fn start_call(&mut self, worker: u32, thread: ThreadId, id: u32, queued: Queued) {
        let Some(entry) = self.workers.get_mut(&worker) else { return };
        let Some(io) = &entry.io else { return };
        let paths: Vec<String> = queued
            .call
            .paths
            .iter()
            .map(|p| p.as_path().to_string_lossy().into_owned())
            .collect();
        // The slot is set before the call is written, so no frame of the call can find it empty.
        io.slot.set(id, queued.out.clone());
        let _ = queued.route.set(io.writer.clone());
        let _ = io.writer.send(frame::call(
            id,
            &queued.call.method,
            &queued.call.params,
            &paths,
            thread.as_str(),
        ));
        self.seq += 1;
        entry.state = WorkerState::Busy {
            call: id,
            thread,
            since_seq: self.seq,
        };
        self.running.insert(id, worker);
    }

    /// Starts workers for queued calls that no live worker will take, up to W.
    fn grow(&mut self) {
        if self.shutting_down || self.spawn_failed {
            return;
        }
        let starting = self
            .workers
            .values()
            .filter(|w| matches!(w.state, WorkerState::Starting))
            .count();
        let wanted = self.schedule.demand().saturating_sub(starting);
        let room = self.config.workers.saturating_sub(self.workers.len());
        for _ in 0..wanted.min(room) {
            self.spawn_worker();
        }
    }

    fn spawn_worker(&mut self) {
        let worker = self.next_worker;
        self.next_worker += 1;
        self.workers.insert(
            worker,
            Worker {
                state: WorkerState::Starting,
                io: None,
                stop_requested: false,
            },
        );
        let program = self.config.program.clone();
        let args = self.config.args.clone();
        // An Electron binary runs a script only in node mode.
        let node_mode: &'static [(&str, &str)] =
            if self.config.electron { &[("ELECTRON_RUN_AS_NODE", "1")] } else { &[] };
        let rt = self.rt.clone();
        let events = self.events.clone();
        let submitted = self
            .config
            .spawn_io
            .submit(&CancellationToken::new(), move |_lane| {
                process::spawn_command(&program, &args, node_mode, &rt).map_err(|e| e.to_string())
            });
        mixdog_rt::spawn("exthost.spawn", TaskClass::Work, async move {
            let result = match submitted {
                Ok(job) => job.await.map_err(|e| e.to_string()).and_then(|r| r),
                Err(full) => Err(full.to_string()),
            };
            let _ = events.send(Event::Spawned { worker, result });
        });
    }

    fn publish(&self) {
        let statuses = self
            .workers
            .iter()
            .filter(|(_, w)| w.io.is_some() && !matches!(w.state, WorkerState::Starting))
            .map(|(id, w)| ExtWorkerStatus {
                id: ExtWorkerId(*id),
                state: match &w.state {
                    WorkerState::Busy { call, since_seq, .. } => ExtWorkerState::Busy {
                        call: u64::from(*call),
                        since_seq: *since_seq,
                    },
                    _ => ExtWorkerState::Idle,
                },
            })
            .collect();
        self.status.store(Arc::new(statuses));
    }
}

/// Ends the worker's job or group; its exit reads as `Stopped`.
fn stop(io: &WorkerIo) {
    io.stopped.store(true, Ordering::Release);
    io.kill.kill();
}

fn closing() -> ExtError {
    ExtError::Unavailable {
        reason: "extension host is closing".to_owned(),
    }
}

fn fail(queued: &Queued, error: ExtError) {
    let _ = queued.out.frames.send(ExtFrame::Done(Err(error)));
}

#[cfg(test)]
mod tests {

    use super::*;

    /// Drives a dispatcher by hand so the order of events is the test's, not the scheduler's.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stop_that_arrives_while_the_worker_is_spawning_is_applied_when_it_exists() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(4).unwrap();
        let spawn_io = mixdog_rt::testing::tokens().spawn_io;
        let render_browser = RenderBrowserConfig {
            command: None,
            profile_root: std::env::temp_dir().join("mixdog-exthost-unit"),
            no_sandbox: false,
        };
        let config = ExtHostConfig {
            program: "node".into(),
            args: vec![root.join("src/ext-host/test/fake-worker.mjs").into_os_string()],
            electron: false,
            workers: 1,
            pending_cap: 4,
            spawn_io,
            render_browser: render_browser.clone(),
        };
        let (events, mut inbox) = mpsc::unbounded_channel();
        let status = Arc::new(ArcSwap::from_pointee(Vec::new()));
        let exits = ChildExits::watch().unwrap();
        let browser = browser::start(
            render_browser,
            spawn_io,
            Handle::current(),
            Arc::new(AtomicU64::new(0)),
            exits.clone(),
        );
        let mut dispatcher = Dispatcher::new(config, Handle::current(), events, browser, status.clone(), exits);

        dispatcher.spawn_worker();
        // The stop is handled before the spawn's completion is: no process exists yet.
        dispatcher.on(Event::Stop(0));
        assert!(dispatcher.workers[&0].io.is_none());

        async {
            loop {
                let event = inbox.recv().await.expect("dispatcher events");
                let exited = matches!(event, Event::Exited(0));
                let ready = matches!(event, Event::Ready(0));
                dispatcher.on(event);
                if ready {
                    assert!(status.load().is_empty(), "a stopped worker never serves");
                }
                if let Some(io) = dispatcher.workers.get(&0).and_then(|w| w.io.as_ref()) {
                    assert!(io.stopped.load(Ordering::Acquire), "the stop was applied once the process existed");
                }
                if exited {
                    break;
                }
            }
        }
        .await;
        assert!(dispatcher.workers.is_empty());
        assert!(status.load().is_empty());
    }
}
