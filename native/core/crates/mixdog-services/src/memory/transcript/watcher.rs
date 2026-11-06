//! `ingest/transcript-watcher.mjs`: keeps transcripts flowing into the store while the runtime is
//! up - a debounced per-file ingest on change events and a periodic safety sweep over recently
//! active transcripts. The change source is the core's one OS watcher (`FolderWatcher`), attached
//! recursively to the root on every platform.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
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
use crate::memory::cycles::requests::spawn_work;
use crate::memory::error::{MemoryError, Result};

const SAFETY_POLL: Duration = Duration::from_secs(5 * 60);
const DEBOUNCE: Duration = Duration::from_millis(500);
/// The id of the watch on the shared `FolderWatcher`; the composed sink routes batches carrying it
/// to [`TranscriptSink::change_sink`].
pub const WATCH_ID: &str = "memory-transcripts";

fn log(message: &str) {
    tracing::info!("{}", message.trim_end_matches('\n'));
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
        let cwd = cwd_from_transcript_path(lane, file).await;
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
        let id = {
            let mut next = self.next_timer.lock().expect("timer ids");
            *next += 1;
            *next
        };
        let this = Arc::clone(self);
        let timer_key = key.clone();
        let task = spawn_work("memory-transcript-debounce", async move {
            tokio::time::sleep(DEBOUNCE).await;
            {
                let mut pending = this.pending.lock().expect("pending");
                if pending.get(&timer_key).is_some_and(|(held, _)| *held == id) {
                    pending.remove(&timer_key);
                }
            }
            this.ingest_one(&file).await;
        });
        if let Some((_, old)) = self.pending.lock().expect("pending").insert(key, (id, task.abort_handle())) {
            old.abort();
        }
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
pub async fn start_transcript_watcher(root: PathBuf, ingest: Arc<TranscriptIngest>, folders: Arc<FolderWatcher>, sink: &TranscriptSink) -> TranscriptWatcher {
    let shared = Arc::new(Shared { root: root.clone(), ingest, consumed: Mutex::default(), pending: Mutex::default(), next_timer: Mutex::new(0) });
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
                () = tokio::time::sleep(SAFETY_POLL) => {}
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
    /// `stop()`: pending timers, the sweep and the OS watch end. An ingest already running finishes.
    pub fn stop(&self) {
        self.stop.cancel();
        for (_, (_, timer)) in self.shared.pending.lock().expect("pending").drain() {
            timer.abort();
        }
        self.folders.unwatch(WATCH_ID);
        self.shared.consumed.lock().expect("consumed").clear();
    }

    /// Waits for the watcher's tasks to end after [`Self::stop`].
    pub async fn finished(&self) -> Result<()> {
        let tasks: Vec<_> = self.tasks.lock().expect("tasks").drain(..).collect();
        for task in tasks {
            task.await.map_err(|e| MemoryError::Runtime(e.to_string()))?;
        }
        Ok(())
    }
}
