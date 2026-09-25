// Server lifecycle: the idle reclaim watchdog, the engine loop that turns
// request lines into scheduled searches, and the two transports.
use super::*;

// ── Idle reclaim watchdog ───────────────────────────────────────────────────
// A resident server that has gone quiet must not keep pinning its warm file
// inventory and signature cache. How it lets go depends on who owns the
// process, which is what IdlePolicy selects.
//
// Standalone (`--serve-search`): exit. The server normally dies with its owner
// — when the host's stdin write handle closes, the request loop reads EOF and
// returns — but that signal never arrives if the owner is force-killed while
// another process still holds the pipe's write end, and Windows reaps nothing
// on parent exit, so orphaned servers piled up across restarts. The JS client
// respawns transparently on the next call. Mirrors the mixdog-patch watchdog.
//
// In-process (Node-API addon): the host owns the process, so exiting would
// take the host down with it. Drop the caches instead and keep serving.
//
// Tunable via MIXDOG_SEARCH_SERVER_IDLE_MS (default 300000ms); 0 disables it.
pub(super) const DEFAULT_SERVE_SEARCH_IDLE_MS: u64 = 300_000;

/// How a server reclaims once the idle window expires.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum IdlePolicy {
    /// Owns its process: exit and let the OS reclaim every page.
    ExitProcess,
    /// Hosted inside someone else's process: release caches, keep serving.
    ReleaseCaches,
}

pub(super) static SERVE_SEARCH_STARTED: OnceLock<Instant> = OnceLock::new();
pub(super) static SERVE_SEARCH_LAST_ACTIVITY_MS: AtomicU64 = AtomicU64::new(0);

pub(super) fn serve_search_uptime_ms() -> u64 {
    SERVE_SEARCH_STARTED
        .get_or_init(Instant::now)
        .elapsed()
        .as_millis() as u64
}

pub(super) fn note_serve_search_activity() {
    SERVE_SEARCH_LAST_ACTIVITY_MS.store(serve_search_uptime_ms(), Ordering::Relaxed);
}

pub(super) fn start_serve_search_idle_watchdog(
    file_lists: Arc<FileListStore>,
    policy: IdlePolicy,
    alive: Arc<AtomicBool>,
) {
    let idle_ms = std::env::var("MIXDOG_SEARCH_SERVER_IDLE_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_SERVE_SEARCH_IDLE_MS);
    if idle_ms == 0 {
        return;
    }
    note_serve_search_activity();
    // A long scan is not idleness: the request that started it stamps the clock
    // on the way in and its response stamps it again on the way out, so
    // in-flight work can never age past the window.
    let step = Duration::from_millis(idle_ms.clamp(250, 5_000));
    let _ = std::thread::Builder::new()
        .name("mixdog-search-idle-watchdog".to_string())
        .spawn(move || {
            // Which activity stamp was already reclaimed. A released server
            // stays idle indefinitely, and repeating the release every step
            // would re-persist an empty snapshot on a loop.
            let mut reclaimed: Option<u64> = None;
            while alive.load(Ordering::Acquire) {
                std::thread::sleep(step);
                if !alive.load(Ordering::Acquire) {
                    return;
                }
                let last_activity = SERVE_SEARCH_LAST_ACTIVITY_MS.load(Ordering::Relaxed);
                let idle_for = serve_search_uptime_ms().saturating_sub(last_activity);
                if idle_for < idle_ms {
                    reclaimed = None;
                    continue;
                }
                match policy {
                    IdlePolicy::ExitProcess => {
                        // Exit the same way the normal loop-exit path does, so
                        // the next server starts warm instead of re-walking.
                        persist_file_list_snapshot(&file_lists.ready);
                        flush_responses();
                        std::process::exit(0);
                    }
                    IdlePolicy::ReleaseCaches => {
                        if reclaimed == Some(last_activity) {
                            continue;
                        }
                        reclaimed = Some(last_activity);
                        file_lists.release_caches();
                    }
                }
            }
        });
}

#[cfg(target_os = "windows")]
pub(super) fn process_snapshot(id: u64) -> serde_json::Value {
    use std::ffi::c_void;
    use std::mem;

    type Handle = *mut c_void;
    const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    #[repr(C)]
    #[allow(non_snake_case)]
    struct ProcessEntry32W {
        dwSize: u32,
        cntUsage: u32,
        th32ProcessID: u32,
        th32DefaultHeapID: usize,
        th32ModuleID: u32,
        cntThreads: u32,
        th32ParentProcessID: u32,
        pcPriClassBase: i32,
        dwFlags: u32,
        szExeFile: [u16; 260],
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> Handle;
        fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
        fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> Handle;
        fn GetProcessTimes(
            process: Handle,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    fn creation_identity(pid: u32) -> String {
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return String::new();
        }
        let mut creation = FileTime::default();
        let mut exit = FileTime::default();
        let mut kernel = FileTime::default();
        let mut user = FileTime::default();
        let ok =
            unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) };
        unsafe {
            CloseHandle(process);
        }
        if ok == 0 {
            String::new()
        } else {
            ((u64::from(creation.high) << 32) | u64::from(creation.low)).to_string()
        }
    }

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return serde_json::json!({ "id": id, "error": "process snapshot failed" });
    }
    let mut entry = ProcessEntry32W {
        dwSize: mem::size_of::<ProcessEntry32W>() as u32,
        cntUsage: 0,
        th32ProcessID: 0,
        th32DefaultHeapID: 0,
        th32ModuleID: 0,
        cntThreads: 0,
        th32ParentProcessID: 0,
        pcPriClassBase: 0,
        dwFlags: 0,
        szExeFile: [0; 260],
    };
    let mut rows = Vec::new();
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };
    while ok != 0 {
        if entry.th32ProcessID > 0 {
            rows.push(serde_json::json!({
                "pid": entry.th32ProcessID,
                "parentPid": entry.th32ParentProcessID,
                "identity": creation_identity(entry.th32ProcessID),
            }));
        }
        ok = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe {
        CloseHandle(snapshot);
    }
    serde_json::json!({ "id": id, "rows": rows })
}

#[cfg(not(target_os = "windows"))]
pub(super) fn process_snapshot(id: u64) -> serde_json::Value {
    serde_json::json!({ "id": id, "error": "process snapshot is only available on Windows" })
}

/// The resident search engine, independent of how requests reach it.
///
/// `--serve-search` (stdin lines) and the Node-API addon (host calls) are the
/// same server: request lines go in, JSONL response lines come out. The engine
/// runs on its own thread, so a host sitting on a JavaScript main thread never
/// blocks on snapshot loading, scheduling, or teardown.
pub struct SearchServer {
    /// Dropped on shutdown; that is what ends the engine's receive loop.
    requests: Option<Sender<String>>,
    engine: Option<JoinHandle<()>>,
    /// Present only when this server created the queue (the addon transport).
    /// The standalone process shares the stdout-backed process-wide queue and
    /// must not close it out from under the writer thread.
    owned_queue: Option<Arc<ResponseQueue>>,
    alive: Arc<AtomicBool>,
}

impl SearchServer {
    /// The standalone `--serve-search` process: responses go to stdout and the
    /// idle window ends the process.
    pub fn standalone() -> Self {
        Self::start(stdio_sink(), None, IdlePolicy::ExitProcess)
    }

    /// An in-process host (Node-API addon): responses are written as JSONL
    /// lines into `writer`, and the idle window releases caches rather than
    /// exiting — the host owns this process.
    pub fn embedded<W: Write + Send + 'static>(writer: W) -> Self {
        let queue = spawn_response_writer(writer);
        // Unsolicited watcher events must reach THIS host rather than a stdout
        // the addon does not own. Installed before the engine starts, so no
        // event can escape down the wrong route.
        install_response_queue(Some(Arc::clone(&queue)));
        let sink = ClientSink {
            queue: Arc::clone(&queue),
        };
        Self::start(sink, Some(queue), IdlePolicy::ReleaseCaches)
    }

    pub(super) fn start(
        sink: ClientSink,
        owned_queue: Option<Arc<ResponseQueue>>,
        policy: IdlePolicy,
    ) -> Self {
        std::thread::spawn(ensure_content_signature_cache_loaded);
        // Readiness is announced before the engine touches the disk snapshot,
        // so a host never waits on inventory load to learn the server is up.
        sink.write_control(&serde_json::json!({ "ready": true }));
        let (requests, incoming) = channel::<String>();
        let alive = Arc::new(AtomicBool::new(true));
        let engine_alive = Arc::clone(&alive);
        let engine = std::thread::Builder::new()
            .name("mixdog-search-engine".to_string())
            .spawn(move || run_engine(sink, incoming, policy, engine_alive))
            .expect("mixdog search engine");
        Self {
            requests: Some(requests),
            engine: Some(engine),
            owned_queue,
            alive,
        }
    }

    /// Queue one request line. Returns false once the engine is gone. Never
    /// blocks on search work — the caller may be a JavaScript main thread.
    pub fn dispatch(&self, line: &str) -> bool {
        note_serve_search_activity();
        match self.requests.as_ref() {
            Some(requests) => requests.send(line.to_string()).is_ok(),
            None => false,
        }
    }

    /// Drain, stop, and release. Ordered on purpose: closing the request
    /// channel ends the engine loop, which persists its snapshot and flushes
    /// every queued response BEFORE the writer thread is released.
    pub fn shutdown(&mut self) {
        self.alive.store(false, Ordering::Release);
        self.requests = None;
        if let Some(engine) = self.engine.take() {
            let _ = engine.join();
        }
        let Some(queue) = self.owned_queue.take() else {
            return;
        };
        queue.close();
        // Only retract the route this server installed: a later server may
        // already own it.
        let installed = install_response_queue(None);
        if let Some(installed) = installed {
            if !Arc::ptr_eq(&installed, &queue) {
                install_response_queue(Some(installed));
            }
        }
    }
}

impl Drop for SearchServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub(super) fn run_engine(
    sink: ClientSink,
    incoming: Receiver<String>,
    policy: IdlePolicy,
    alive: Arc<AtomicBool>,
) {
    let file_lists = Arc::new(FileListStore::new_persistent());
    file_lists.schedule_noise_prewarm();
    let cancellations: Arc<Mutex<HashMap<RequestKey, Arc<AtomicBool>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let scheduler = SearchScheduler::new(Arc::clone(&file_lists), Arc::clone(&cancellations));
    start_serve_search_idle_watchdog(Arc::clone(&file_lists), policy, alive);
    // One server serves exactly one client, so it owns the reserved id 0 and a
    // single sink. Request ids are unique only WITHIN a client, which is why
    // cancellation keys pair the client with the id.
    let client_id = STDIO_CLIENT_ID;
    for line in incoming {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<WireRequest>(&line) {
            Ok(WireRequest::ListMetadata {
                id,
                cwd,
                list_metadata,
            }) => {
                let sink = sink.clone();
                std::thread::spawn(move || {
                    sink.write_control(&list_metadata_response(id, &cwd, &list_metadata));
                });
            }
            Ok(WireRequest::Cancel { cancel }) => {
                let inflight = lock_recover(&cancellations)
                    .get(&(client_id, cancel))
                    .cloned();
                // Signalling the flag IS the cancellation of a running search;
                // the queued copy is removed separately.
                if let Some(flag) = &inflight {
                    flag.store(true, Ordering::Relaxed);
                }
                let running = inflight.is_some();
                let removed = scheduler.cancel_queued(client_id, cancel);
                if removed || !running {
                    forget_cancellation(&cancellations, (client_id, cancel));
                    sink.write_cancelled(cancel);
                }
            }
            Ok(WireRequest::ProcessSnapshot {
                id,
                process_snapshot: true,
            }) => sink.write_control(&process_snapshot(id)),
            Ok(WireRequest::ProcessSnapshot { id, .. }) => sink.write_control(
                &serde_json::json!({ "id": id, "error": "invalid process snapshot request" }),
            ),
            Ok(WireRequest::Search(req)) => {
                let id = req.id;
                let cancelled = Arc::new(AtomicBool::new(false));
                lock_recover(&cancellations).insert((client_id, id), Arc::clone(&cancelled));
                let scheduled = ScheduledSearch {
                    req,
                    cancelled,
                    queued_at: Instant::now(),
                    client_id,
                    sink: sink.clone(),
                };
                if let Err(search) = scheduler.enqueue(scheduled) {
                    forget_cancellation(&cancellations, (client_id, id));
                    let telemetry = scheduler.telemetry();
                    sink.write(&serde_json::json!({
                        "id": search.req.id,
                        "error": "native search queue saturated",
                        "saturated": true,
                        "scheduler": telemetry_json(telemetry),
                    }));
                }
            }
            Err(error) => sink
                .write(&serde_json::json!({ "id": 0, "error": format!("bad request: {error}") })),
        }
    }
    scheduler.shutdown();
    persist_file_list_snapshot(&file_lists.ready);
    sink.flush();
}

/// The standalone `--serve-search` transport: one request per stdin line.
pub fn run() {
    let mut server = SearchServer::standalone();
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if !server.dispatch(&line) {
            break;
        }
    }
    server.shutdown();
}
