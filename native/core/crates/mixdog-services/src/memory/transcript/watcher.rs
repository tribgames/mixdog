//! `ingest/transcript-watcher.mjs`: keeps transcripts flowing into the store while the runtime is
//! up - a debounced per-file ingest on change events and a periodic safety sweep over recently
//! active transcripts. The change source is the core's one OS watcher (`FolderWatcher`), attached
//! recursively to the root on every platform.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mixdog_rt::{CancellationToken, LaneToken};
use mixdog_statefile::metadata;
use mixdog_workspace::watcher::{ChangeKind, ChangeSink, FolderWatcher};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use tokio::task::{AbortHandle, JoinHandle};

use super::discovery::{discover_active_transcripts, is_watchable, mtime_ms};
use super::rows::cwd_from_transcript_path;
use super::TranscriptIngest;
use crate::bots::delivery::env::RetryTimer;
use crate::memory::cycles::requests::{spawn_work, wait};
use crate::memory::error::{MemoryError, Result};

const SAFETY_POLL: Duration = Duration::from_secs(5 * 60);
const DEBOUNCE: Duration = Duration::from_millis(500);
/// The id of the watch on the shared `FolderWatcher`; the composed sink routes batches carrying it
/// to [`TranscriptSink::change_sink`].
pub const WATCH_ID: &str = "memory-transcripts";

fn log(message: &str) {
    mixdog_rt::memory_stderr!("{}", message.trim_end_matches('\n'));
}

struct Sink(UnboundedSender<Vec<String>>);

impl ChangeSink for Sink {
    fn changed(&self, _watch_id: &str, paths: Vec<String>, _kind: ChangeKind) {
        let _ = self.0.send(paths);
    }
}

struct Shared {
    root: PathBuf,
    ingest: Arc<TranscriptIngest>,
    /// `consumedMtime`: a file whose mtime was fully consumed is not read again until it changes.
    consumed: Mutex<HashMap<String, f64>>,
    pending: Mutex<HashMap<String, (u64, AbortHandle)>>,
    next_timer: Mutex<u64>,
    /// Every debounce task, sleeping or ingesting: shutdown joins them before the store closes.
    ingests: Mutex<Vec<JoinHandle<()>>>,
    /// Set by `stop` under the `pending` lock: no timer is armed after it.
    closed: AtomicBool,
    timer: Arc<dyn RetryTimer>,
}

impl Shared {
    /// `ingestOne`: ingests one file unless its mtime was already fully consumed.
    async fn ingest_one(&self, file: &Path) {
        let lane = self.ingest.io.maintenance;
        let key = file.to_string_lossy().into_owned();
        let stat = {
            let file = file.to_owned();
            match lane.submit_wait(&CancellationToken::new(), move |lane| metadata(lane, &file).ok().map(|m| (m.len() as f64, mtime_ms(&m)))).await {
                Ok(job) => job.await.ok().flatten(),
                Err(_) => None,
            }
        };
        let Some((size, Some(mtime))) = stat else { return };
        if self.consumed.lock().expect("consumed").get(&key).is_some_and(|prev| *prev >= mtime) {
            return;
        }
        let Ok(cwd) = cwd_from_transcript_path(lane, file).await else {
            // Not consumed: the next sweep reads this file again.
            return;
        };
        let ingested = self.ingest.ingest_transcript_file(file, cwd.as_deref()).await;
        match ingested {
            Ok(n) => {
                // Marked consumed only once the persisted offset has passed the observed size: on a
                // transient insert error the offset stays before the failed line, and caching the
                // mtime would hide the retry until the file changed again.
                if self.ingest.get_offset(file).is_some_and(|off| off.bytes >= size) {
                    self.consumed.lock().expect("consumed").insert(key, mtime);
                }
                if n > 0 {
                    let base = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    log(&format!("[transcript-watch] ingested {n} entries from {base}\n"));
                }
            }
            Err(error) => log(&format!("[transcript-watch] ingest error: {}\n", error.message())),
        }
    }

    fn prune(&self, active: &[PathBuf]) {
        let keep: std::collections::HashSet<String> = active.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        self.consumed.lock().expect("consumed").retain(|key, _| keep.contains(key));
    }

    /// `safetySweep`: every recently active transcript, concurrently.
    async fn safety_sweep(&self) {
        let now = (self.ingest.now)() as f64;
        let active = discover_active_transcripts(self.ingest.io.maintenance, &self.root, now).await;
        let paths: Vec<PathBuf> = active.into_iter().map(|a| a.path).collect();
        self.prune(&paths);
        futures::future::join_all(paths.iter().map(|path| self.ingest_one(path))).await;
    }

    /// `scheduleIngest`: a burst of events for one file becomes one ingest, 500 ms after the last.
    fn schedule_ingest(self: &Arc<Self>, file: PathBuf) {
        let key = file.to_string_lossy().into_owned();
        // Held until the timer is registered, so `stop` either sees it or it sees `closed`.
        let mut pending = self.pending.lock().expect("pending");
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        let id = {
            let mut next = self.next_timer.lock().expect("timer ids");
            *next += 1;
            *next
        };
        let this = Arc::clone(self);
        let timer_key = key.clone();
        let task = spawn_work("memory-transcript-debounce", async move {
            wait(this.timer.as_ref(), DEBOUNCE).await;
            {
                let mut pending = this.pending.lock().expect("pending");
                if pending.get(&timer_key).is_some_and(|(held, _)| *held == id) {
                    pending.remove(&timer_key);
                }
            }
            this.ingest_one(&file).await;
        });
        if let Some((_, old)) = pending.insert(key, (id, task.abort_handle())) {
            old.abort();
        }
        drop(pending);
        let mut ingests = self.ingests.lock().expect("ingests");
        ingests.retain(|task| !task.is_finished());
        ingests.push(task);
    }
}

/// A running watcher; [`TranscriptWatcher::stop`] ends it.
pub struct TranscriptWatcher {
    shared: Arc<Shared>,
    folders: Arc<FolderWatcher>,
    stop: CancellationToken,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

/// `startTranscriptWatcher`: resolves after the first active-transcript sweep.
pub async fn start_transcript_watcher(root: PathBuf, ingest: Arc<TranscriptIngest>, folders: Arc<FolderWatcher>, sink: &TranscriptSink, timer: Arc<dyn RetryTimer>) -> TranscriptWatcher {
    let shared = Arc::new(Shared {
        root: root.clone(),
        ingest,
        consumed: Mutex::default(),
        pending: Mutex::default(),
        next_timer: Mutex::new(0),
        ingests: Mutex::default(),
        closed: AtomicBool::new(false),
        timer,
    });
    let stop = CancellationToken::new();
    let mut tasks = Vec::new();
    match folders.watch(WATCH_ID, &root, true) {
        Ok(()) => {
            log(&format!("[transcript-watch] fs.watch(recursive) active on {}\n", root.display()));
            let (events, mut changes) = (Arc::clone(&shared), sink.receiver());
            let stopped = stop.clone();
            tasks.push(spawn_work("memory-transcript-events", async move {
                loop {
                    let paths = tokio::select! {
                        () = stopped.cancelled() => break,
                        paths = changes.recv() => match paths { Some(paths) => paths, None => break },
                    };
                    for path in paths {
                        let path = PathBuf::from(path);
                        let Ok(relative) = path.strip_prefix(&events.root) else { continue };
                        if is_watchable(&relative.to_string_lossy()) {
                            events.schedule_ingest(path);
                        }
                    }
                }
            }));
        }
        Err(error) => log(&format!("[transcript-watch] fs.watch setup failed: {} \u{2014} relying on safety sweep only\n", error.message)),
    }
    let (sweeper, stopped) = (Arc::clone(&shared), stop.clone());
    tasks.push(spawn_work("memory-transcript-sweep", async move {
        loop {
            tokio::select! {
                () = stopped.cancelled() => break,
                () = wait(sweeper.timer.as_ref(), SAFETY_POLL) => {}
            }
            sweeper.safety_sweep().await;
        }
    }));
    // Runtime readiness includes the first sweep: without it a lazily started memory service can
    // answer recall before the current session's persisted rows exist.
    shared.safety_sweep().await;
    TranscriptWatcher { shared, folders, stop, tasks: Mutex::new(tasks) }
}

/// The channel between the OS watcher's thread and the watcher's event task. Build it first, hand
/// [`TranscriptSink::change_sink`] to the `FolderWatcher`, then pass it to
/// [`start_transcript_watcher`].
pub struct TranscriptSink {
    tx: UnboundedSender<Vec<String>>,
    rx: Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<Vec<String>>>>,
}

impl Default for TranscriptSink {
    fn default() -> Self {
        let (tx, rx) = unbounded_channel();
        Self { tx, rx: Mutex::new(Some(rx)) }
    }
}

impl TranscriptSink {
    /// The sink the shared `FolderWatcher` routes this watcher's batches to.
    pub fn change_sink(&self) -> Arc<dyn ChangeSink> {
        Arc::new(Sink(self.tx.clone()))
    }

    fn receiver(&self) -> tokio::sync::mpsc::UnboundedReceiver<Vec<String>> {
        self.rx.lock().expect("sink receiver").take().expect("a transcript sink serves one watcher")
    }
}

impl TranscriptWatcher {
    /// `stop()`: no timer is armed from now on, those waiting end, and the sweep and the OS
    /// watch end. An ingest already running finishes: [`Self::finished`] waits for it.
    pub fn stop(&self) {
        self.stop.cancel();
        self.close_timers();
        self.folders.unwatch(WATCH_ID);
        self.shared.consumed.lock().expect("consumed").clear();
    }

    fn close_timers(&self) {
        let mut pending = self.shared.pending.lock().expect("pending");
        self.shared.closed.store(true, Ordering::SeqCst);
        for (_, (_, timer)) in pending.drain() {
            timer.abort();
        }
    }

    /// Waits, after [`Self::stop`], for everything the watcher started: first the event and sweep
    /// tasks (so nothing new is armed), then the timers still waiting, then the ingestions
    /// running. The caller persists offsets and closes the store only after this returns.
    pub async fn finished(&self) -> Result<()> {
        // The first failure is kept and returned only after every task has been joined.
        let mut first: Option<MemoryError> = None;
        let tasks: Vec<_> = self.tasks.lock().expect("tasks").drain(..).collect();
        // A wait abandoned at the stop's bound ends what it took; what it had not taken yet is [`Self::abandon`]'s.
        let _abandoned: Vec<_> = tasks.iter().map(|task| crate::memory::AbortOnDrop(task.abort_handle())).collect();
        for task in tasks {
            if let Err(error) = task.await {
                first.get_or_insert_with(|| MemoryError::Runtime(error.to_string()));
            }
        }
        self.close_timers();
        let ingests: Vec<_> = self.shared.ingests.lock().expect("ingests").drain(..).collect();
        let _abandoned_ingests: Vec<_> = ingests.iter().map(|task| crate::memory::AbortOnDrop(task.abort_handle())).collect();
        for task in ingests {
            // A timer cut short by `stop` is cancelled, not failed.
            if let Err(error) = task.await
                && !error.is_cancelled()
            {
                first.get_or_insert_with(|| MemoryError::Runtime(error.to_string()));
            }
        }
        first.map_or(Ok(()), Err)
    }

    /// The stop's bound passed: everything the watcher started and [`Self::finished`] had not taken yet (its tasks, the ingestions running) is aborted.
    pub fn abandon(&self) {
        self.stop();
        for task in self.tasks.lock().expect("tasks").drain(..) {
            task.abort();
        }
        for task in self.shared.ingests.lock().expect("ingests").drain(..) {
            task.abort();
        }
    }
}

#[cfg(test)]
impl TranscriptWatcher {
    /// Debounce timers armed and not yet fired.
    pub(crate) fn timers_waiting(&self) -> usize {
        self.shared.pending.lock().expect("pending").len()
    }
}
