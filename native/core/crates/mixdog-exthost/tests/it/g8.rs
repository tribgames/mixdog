//! RL G8, office throughput, through the real pool, the real Node worker and the real shared render
//! browser. Heavy (LibreOffice and Chromium), so it only runs when asked for:
//!
//!   G8_SCALE=smoke  cargo test -p mixdog-exthost --features test-support --test it g8:: -- --ignored --nocapture   (1 call per session)
//!   G8_SCALE=full   cargo test -p mixdog-exthost --features test-support --test it g8:: -- --ignored --nocapture  (32 calls, 4 sessions)
//!
//! `G8_SPIN_MS` is the synchronous-spin call's length (full: 60000 unless set; smoke: 600000, freed
//! by "stop worker"). `G8_WORKERS` overrides W. Run nothing else heavy beside the full scale.
//!
//! The single-worker baseline, the throughput ratio and the fairness ratio are only asserted at
//! full scale; the smoke run proves every call kind and the spin/stop mechanics work.
#![allow(
    clippy::disallowed_methods,
    reason = "a test driver: temp directories and process-wide environment"
)]

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::ext::ExtCall;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::ExtExit;
use mixdog_core_api::domain::ext::ExtFrame;
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_core_api::domain::ext::ExtWorkerId;
use mixdog_core_api::domain::ext::ExtWorkerState;
use mixdog_exthost::CALL_WINDOW_BYTES;
use mixdog_exthost::ExtHostConfig;
use mixdog_exthost::ExtHostPool;
use mixdog_exthost::RenderBrowserConfig;
use mixdog_exthost::worker_count;
use mixdog_protocol::ThreadId;
use serde_json::Value;
use serde_json::json;

const SESSIONS: usize = 4;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    DocxRender,
    XlsxRecalc,
    PdfRender,
    HtmlToPdf,
}

const KINDS: [Kind; 4] = [Kind::DocxRender, Kind::XlsxRecalc, Kind::PdfRender, Kind::HtmlToPdf];

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(4).unwrap().to_owned()
}

fn env_usize(name: &str) -> Option<usize> {
    std::env::var(name).ok().and_then(|v| v.parse().ok())
}

fn workers() -> usize {
    let cores = std::thread::available_parallelism().map_or(1, usize::from);
    env_usize("G8_WORKERS").unwrap_or_else(|| worker_count(None, cores).max(2))
}

/// Everything the run writes lives under one directory, removed on every exit path (a failed
/// assertion unwinds through this guard). Processes still holding files inside it are given
/// time to exit: the pool, the workers and the render browser end asynchronously.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!("g8-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        Self(base)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(30);
        while let Err(error) = std::fs::remove_dir_all(&self.0) {
            if !self.0.exists() {
                return;
            }
            if Instant::now() > deadline {
                eprintln!("g8: could not remove {}: {error}", self.0.display());
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

fn pool(scratch: &Scratch, workers: usize) -> Arc<ExtHostPool> {
    Arc::new(ExtHostPool::new(ExtHostConfig {
        program: "node".into(),
        args: vec![repo_root().join("src/ext-host/test/g8-worker.mjs").into_os_string()],
        electron: false,
        workers,
        pending_cap: 64,
        spawn_io: mixdog_rt::testing::tokens().spawn_io,
        render_browser: RenderBrowserConfig {
            command: None,
            profile_root: scratch.0.join("browsers"),
            no_sandbox: false,
        },
    }).expect("the pool starts"))
}

/// Everything a call produces: its chunk bytes and its outcome.
async fn finish(stream: &mut Box<dyn EventSource<ExtFrame>>) -> (usize, Result<Value, ExtError>) {
    let mut bytes = 0;
    loop {
        match stream.next().await.expect("stream ended without Done") {
            ExtFrame::Chunk(chunk) => bytes += chunk.len(),
            ExtFrame::Done(outcome) => return (bytes, outcome),
        }
    }
}

struct Session {
    thread: ThreadId,
    root: PathBuf,
    data: PathBuf,
}

impl Session {
    fn call(&self, method: &str, params: Value) -> ExtCall {
        ExtCall {
            thread: self.thread.clone(),
            method: method.into(),
            params,
            paths: vec![AbsPath::new(self.root.clone()).unwrap()],
        }
    }

    fn office(&self, args: Value) -> ExtCall {
        self.call("office.run", json!({"args": args, "cwd": self.root, "dataDir": self.data}))
    }

    /// One office action to completion; its parsed JSON text.
    async fn office_json(&self, pool: &ExtHostPool, args: Value) -> Value {
        let mut stream = pool.call(self.office(args.clone())).expect("accepted");
        let (_, outcome) = finish(&mut stream).await;
        let value = outcome.unwrap_or_else(|e| panic!("office {args} failed: {e:?}"));
        let text = value["result"]["content"][0]["text"].as_str().expect("text block");
        serde_json::from_str(text).unwrap_or_else(|_| json!({"text": text}))
    }

    /// The open document sessions a measured call renders: one docx, one xlsx, one source pdf.
    async fn setup(&self, pool: &ExtHostPool) -> (String, String) {
        let docx = self
            .office_json(pool, json!({"action": "create", "path": "d.docx", "format": "docx", "mode": "portable"}))
            .await["session"]
            .as_str()
            .unwrap()
            .to_owned();
        self.office_json(
            pool,
            json!({"action": "batch", "session": docx, "operations": [{"op": "add_paragraph", "text": "G8 document"}]}),
        )
        .await;
        self.office_json(pool, json!({"action": "save", "session": docx})).await;
        let xlsx = self
            .office_json(pool, json!({"action": "create", "path": "x.xlsx", "format": "xlsx", "mode": "portable"}))
            .await["session"]
            .as_str()
            .unwrap()
            .to_owned();
        self.office_json(
            pool,
            json!({"action": "batch", "session": xlsx, "operations": [
                {"op": "set_range", "sheet": "Sheet1", "range": "A1:A3", "values": [[1], [2], ["=SUM(A1:A2)"]]}
            ]}),
        )
        .await;
        self.office_json(pool, json!({"action": "save", "session": xlsx})).await;
        self.office_json(
            pool,
            json!({"action": "create", "path": "s.pdf", "format": "pdf", "blocks": [{"type": "heading", "text": "G8 source"}]}),
        )
        .await;
        (docx, xlsx)
    }

    fn measured(&self, kind: Kind, n: usize, docx: &str, xlsx: &str) -> ExtCall {
        match kind {
            Kind::DocxRender => self.office(json!({"action": "render", "session": docx, "output": format!("d{n}.pdf")})),
            Kind::XlsxRecalc => self.office(json!({"action": "render", "session": xlsx, "output": format!("x{n}.pdf")})),
            Kind::PdfRender => self.call("pdf.render", json!({"path": self.root.join("s.pdf"), "pages": [1]})),
            Kind::HtmlToPdf => self.office(json!({
                "action": "author",
                "path": format!("h{n}.pdf"),
                "overwrite": true,
                "script": format!("<!doctype html><html><body><h1>G8 {n}</h1><p>{}</p></body></html>", "lorem ipsum ".repeat(40)),
            })),
        }
    }
}

fn sessions(scratch: &Scratch, label: &str) -> Vec<Session> {
    let base = scratch.0.join(label);
    let data = base.join("data");
    std::fs::create_dir_all(&data).unwrap();
    (0..SESSIONS)
        .map(|i| {
            let root = base.join(format!("s{i}"));
            std::fs::create_dir_all(&root).unwrap();
            Session { thread: ThreadId::from(format!("g8-{label}-{i}").as_str()), root, data: data.clone() }
        })
        .collect()
}

struct Phase {
    wall: Duration,
    calls: usize,
    /// Completion latency of each session's calls, all submitted together.
    per_session: Vec<Vec<Duration>>,
}

fn p95(latencies: &[Duration]) -> Duration {
    let mut sorted = latencies.to_vec();
    sorted.sort();
    sorted[((sorted.len() * 95).div_ceil(100)).max(1) - 1]
}

/// Opens each session's documents, then submits every measured call at once and times them.
/// `per_kind[s]` is how many calls of each kind session `s` makes (smoke: one kind per session).
async fn run_phase(pool: &Arc<ExtHostPool>, sessions: &[Session], plan: &[Vec<(Kind, usize)>]) -> Phase {
    let mut setups = Vec::new();
    for session in sessions {
        setups.push(session.setup(pool).await);
    }
    let start = Instant::now();
    let mut tasks = Vec::new();
    for (index, session) in sessions.iter().enumerate() {
        let (docx, xlsx) = &setups[index];
        let mut n = 0;
        for &(kind, count) in &plan[index] {
            for _ in 0..count {
                n += 1;
                let call = session.measured(kind, n, docx, xlsx);
                let mut stream = pool.call(call).expect("accepted");
                tasks.push(tokio::spawn(async move {
                    let (bytes, outcome) = finish(&mut stream).await;
                    (index, kind, start.elapsed(), bytes, outcome)
                }));
            }
        }
    }
    let mut per_session = vec![Vec::new(); sessions.len()];
    let calls = tasks.len();
    for task in tasks {
        let (index, kind, at, bytes, outcome) = task.await.unwrap();
        let value = outcome.unwrap_or_else(|e| panic!("{kind:?} failed: {e:?}"));
        if kind == Kind::PdfRender {
            assert!(bytes > 0, "pdf.render sends its page image as chunks");
        }
        if matches!(kind, Kind::DocxRender | Kind::XlsxRecalc | Kind::HtmlToPdf) {
            assert!(value["result"]["content"][0]["text"].is_string(), "{kind:?}: office envelope");
        }
        println!("  session {index} {kind:?} done at {at:?}");
        per_session[index].push(at);
    }
    // Every HTML→PDF call connected to the one shared browser; none launched its own.
    assert_eq!(pool.browser_launches(), 1, "the shared render browser is launched once and reused");
    Phase { wall: start.elapsed(), calls, per_session }
}

fn rate(phase: &Phase) -> f64 {
    phase.calls as f64 / phase.wall.as_secs_f64()
}

fn plan_for(smoke: bool, per_kind: usize) -> Vec<Vec<(Kind, usize)>> {
    (0..SESSIONS)
        .map(|s| {
            if smoke {
                vec![(KINDS[s], 1)]
            } else {
                KINDS.iter().map(|&k| (k, per_kind)).collect()
            }
        })
        .collect()
}

/// A call spinning synchronous JS holds one slot while the rest proceed; "stop worker" frees it
/// with `HostExited{Stopped}`.
async fn spin_phase(scratch: &Scratch, smoke: bool) {
    let workers = workers();
    let pool = pool(scratch, workers);
    let spin_ms = env_usize("G8_SPIN_MS").unwrap_or(if smoke { 600_000 } else { 60_000 });
    let spinner = Session {
        thread: ThreadId::from("g8-spin"),
        root: std::env::temp_dir(),
        data: std::env::temp_dir(),
    };
    let mut stream = pool.call(spinner.call("test.spin", json!({"ms": spin_ms}))).expect("accepted");
    let spin = tokio::spawn(async move { finish(&mut stream).await.1 });
    let stuck = loop {
        let busy: Vec<ExtWorkerId> = pool
            .status()
            .iter()
            .filter(|s| matches!(s.state, ExtWorkerState::Busy { .. }))
            .map(|s| s.id)
            .collect();
        if let Some(id) = busy.first() {
            break *id;
        }
        mixdog_rt::time::sleep(Duration::from_millis(10)).await;
    };

    let sessions = sessions(scratch, "spin");
    let rest = run_phase(&pool, &sessions, &plan_for(true, 1)).await;
    println!("spin phase: {} calls finished in {:?} beside the spinning worker", rest.calls, rest.wall);

    if pool.status().iter().any(|s| s.id == stuck && matches!(s.state, ExtWorkerState::Busy { .. })) {
        pool.stop_worker(stuck).expect("worker known");
        let outcome = spin.await.unwrap();
        assert_eq!(outcome, Err(ExtError::HostExited { exit: ExtExit::Stopped }), "stop frees the slot");
        println!("spin phase: stop worker freed the spinning slot as ext_host_exited");
    } else {
        spin.await.unwrap().expect("the spin finished by itself");
        println!("spin phase: the {spin_ms} ms spin ended before the others finished");
    }
    pool.close().await;
}

/// `result` reaches the consumer ≤ 50 ms after the worker writes it, while other calls' chunk
/// windows are full: W-1 workers each emit more than a window nobody is taking, and a probe call
/// on the remaining worker stamps the time it produced its result. The reader of every worker keeps
/// demultiplexing, so the stalled windows must not delay it. Worker and core share a wall clock.
async fn result_latency_phase(scratch: &Scratch, smoke: bool) {
    let w = workers();
    let pool = pool(scratch, w);
    let idle = Session { thread: ThreadId::from("g8-idle"), root: scratch.0.clone(), data: scratch.0.clone() };
    // Unpolled streams: no chunk is consumed, so no credit comes back and each window stays full.
    // Each filler writes a marker once it has emitted (and flushed) a whole window, then blocks on
    // one more byte; the markers are the observed "window full" fact.
    let markers = scratch.0.join("full-windows");
    std::fs::create_dir_all(&markers).unwrap();
    let mut fillers = Vec::new();
    for i in 0..w - 1 {
        let filler = Session { thread: ThreadId::from(format!("g8-fill-{i}").as_str()), ..clone_dirs(&idle) };
        let params = json!({"marker": markers.join(format!("filler-{i}"))});
        fillers.push(pool.call(filler.call("test.fill", params)).expect("accepted"));
    }
    // The precondition, observed on the core's side: W-1 calls each have a whole window delivered
    // and untaken (the markers say the worker sent them; this says the core's reader has them).
    while std::fs::read_dir(&markers).unwrap().count() < w - 1
        || pool.outstanding_window_bytes().iter().filter(|&&b| b == CALL_WINDOW_BYTES).count() < w - 1
    {
        mixdog_rt::time::sleep(Duration::from_millis(10)).await;
    }

    let samples = if smoke { 5 } else { 50 };
    let mut latencies = Vec::new();
    for _ in 0..samples {
        let mut stream = pool.call(idle.call("test.stamp", json!(null))).expect("accepted");
        let wrote_at_ms = loop {
            match stream.next().await.expect("stream ended without Done") {
                ExtFrame::Chunk(_) => {}
                ExtFrame::Done(outcome) => break outcome.expect("probe succeeds")["wroteAtMs"].as_f64().unwrap(),
            }
        };
        let since_epoch = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap();
        let latency_ms = since_epoch.as_secs_f64() * 1000.0 - wrote_at_ms;
        // Both clocks are this machine's wall clock; a result cannot arrive before it was written.
        assert!(latency_ms >= 0.0, "the clocks disagree ({latency_ms} ms): the system clock stepped during the run");
        latencies.push(Duration::from_secs_f64(latency_ms / 1000.0));
    }
    let max = *latencies.iter().max().unwrap();
    println!("result latency with {} full windows: max {max:?} over {samples} calls (needs every result <= 50ms)", w - 1);
    println!("  samples: {latencies:?}");
    drop(fillers);
    pool.close().await;
    if !smoke {
        assert!(max <= Duration::from_millis(50), "a result took {max:?}, above 50 ms");
    }
}

fn clone_dirs(session: &Session) -> Session {
    Session { thread: session.thread.clone(), root: session.root.clone(), data: session.data.clone() }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "heavy: LibreOffice and Chromium; run on a quiet machine"]
async fn office_throughput() {
    let smoke = std::env::var("G8_SCALE").map_or(true, |v| v != "full");
    let w = workers();
    println!("G8 {} W={w}", if smoke { "smoke" } else { "full" });
    // Declared first, so it drops last: after the pools, whatever the outcome.
    let scratch = Scratch::new();
    if std::env::var("G8_ONLY").is_ok_and(|v| v == "latency") {
        return result_latency_phase(&scratch, smoke).await;
    }

    // Throughput phase: the whole mix over W workers (full: 32 calls, 8 per kind, 8 per session).
    let main_pool = pool(&scratch, w);
    let main_sessions = sessions(&scratch, "main");
    let main = run_phase(&main_pool, &main_sessions, &plan_for(smoke, 2)).await;
    main_pool.close().await;
    println!("W={w}: {} calls in {:?} = {:.3} calls/s", main.calls, main.wall, rate(&main));

    if !smoke {
        // Baseline: one worker, the same mix at 8 calls (2 per kind).
        let base_pool = pool(&scratch, 1);
        let base_sessions = sessions(&scratch, "base");
        let base = run_phase(&base_pool, &base_sessions, &plan_for(false, 1)).await;
        base_pool.close().await;
        println!("W=1: {} calls in {:?} = {:.3} calls/s", base.calls, base.wall, rate(&base));

        let ratio = rate(&main) / (w as f64 * rate(&base));
        println!("throughput ratio vs W x single worker: {ratio:.2} (needs >= 0.80)");
        let p95s: Vec<Duration> = main.per_session.iter().map(|l| p95(l)).collect();
        let fairness = p95s.iter().max().unwrap().as_secs_f64() / p95s.iter().min().unwrap().as_secs_f64();
        println!("per-session p95: {p95s:?}; max/min = {fairness:.2} (needs <= 1.50)");
        assert!(ratio >= 0.8, "throughput {ratio:.2} below 0.8 x W x single worker");
        assert!(fairness <= 1.5, "per-session p95 spread {fairness:.2} above 1.5");
    }

    result_latency_phase(&scratch, smoke).await;
    spin_phase(&scratch, smoke).await;
}
