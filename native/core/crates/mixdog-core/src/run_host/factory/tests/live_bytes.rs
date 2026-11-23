//! A manual probe, not a test of the suite (feature `live-bytes-probe`): the live heap of a worked session against the
//! bytes of its transcript, over the real store and the run host. Run it alone:
//! `nextest run --manifest-path crates/mixdog-core/Cargo.toml --features live-bytes-probe --lib -E 'test(/live_bytes/)' --success-output immediate`.
//!
//! With the feature the test binary's allocator counts live bytes, and live blocks by size for the sizes a row's text
//! takes: each tool result of the session has a length of its own, so the blocks of that length are the copies of that
//! row's text held at once. The counts are the process's: the figures mean one session's only when nothing else runs in
//! the process, they move with what is in flight when they are read, and nothing is asserted of them. What the suite
//! pins of the sharing is in `text_sharing.rs`.
#![allow(unsafe_code, reason = "the counting allocator wraps the system allocator")]

use std::alloc::GlobalAlloc;
use std::alloc::Layout;
use std::alloc::System;
use std::sync::atomic::AtomicI32;
use std::sync::atomic::AtomicIsize;

use mixdog_core_session::session::StoreThreads;
use mixdog_store::sqlite::SqliteStore;

use super::*;

const TURNS: usize = 6;
const ROUNDS: usize = 4;
const CALLS: usize = 5;
const ROWS: usize = TURNS * ROUNDS * CALLS;
/// Row `n`'s text is `ROW_BASE + ROW_STEP * n` bytes.
const ROW_BASE: usize = 8193;
const ROW_STEP: usize = 24;
const SIZES: usize = ROWS * ROW_STEP;

static LIVE: AtomicIsize = AtomicIsize::new(0);
static BLOCKS: [AtomicI32; SIZES] = [const { AtomicI32::new(0) }; SIZES];

fn note(size: usize, by: i32) {
    LIVE.fetch_add(size as isize * by as isize, Ordering::Relaxed);
    if let Some(slot) = size.checked_sub(ROW_BASE).and_then(|at| BLOCKS.get(at)) {
        slot.fetch_add(by, Ordering::Relaxed);
    }
}

struct Counting;

// SAFETY: every request goes to `System` with the caller's layout and its answer is returned unchanged; the counters only observe.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        note(layout.size(), 1);
        // SAFETY: the caller upholds `GlobalAlloc::alloc`'s contract, which `System` shares.
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        note(layout.size(), 1);
        // SAFETY: the caller upholds `GlobalAlloc::alloc_zeroed`'s contract, which `System` shares.
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        note(layout.size(), -1);
        note(new_size, 1);
        // SAFETY: the caller upholds `GlobalAlloc::realloc`'s contract, which `System` shares.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        note(layout.size(), -1);
        // SAFETY: the caller upholds `GlobalAlloc::dealloc`'s contract, which `System` shares.
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

fn live() -> isize {
    LIVE.load(Ordering::Relaxed)
}

/// The blocks held now of each row's text.
fn copies() -> Vec<i32> {
    (0..ROWS).map(|n| BLOCKS[n * ROW_STEP].load(Ordering::Relaxed)).collect()
}

/// Row `n` of thread `thread`: no two threads of the process hold the same text, which they would share.
fn row_text(thread: usize, n: usize) -> String {
    const WORDS: [&str; 8] = ["transcript", "window", "reducer", "worker", "cursor", "token", "result", "lane"];
    let mut text = format!("row {n:04} of session {thread}:");
    let mut word = n;
    while text.len() < ROW_BASE + ROW_STEP * n {
        text.push(' ');
        text.push_str(WORDS[word % WORDS.len()]);
        word = word.wrapping_mul(31).wrapping_add(7);
    }
    text.truncate(ROW_BASE + ROW_STEP * n);
    // The text is moved into what holds it: its block is as long as it is.
    text.shrink_to_fit();
    text
}

/// Answers with the text of the row its call names.
struct Wide(ToolSpec, usize);

static THREADS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[async_trait]
impl Tool for Wide {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, _ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        Ok(ToolOutput { parts: vec![ToolPart::Text(row_text(self.1, args["n"].as_u64().unwrap_or(0) as usize))], ..ToolOutput::default() })
    }
}

/// What is held as the thread's last request goes out: live bytes and the blocks of each row's text.
type Sample = (isize, Vec<i32>);

/// The scripted provider, which keeps no request it was sent (the session's bytes, not the test's) and samples the heap as
/// the last one goes out: the turn then holds its whole context and the request built from it.
struct Sampling {
    inner: Arc<Scripted>,
    sample: Mutex<Option<Sample>>,
}

#[async_trait]
impl ProviderAdapter for Sampling {
    fn release_send(&self, group: &str) {
        self.inner.release_send(group);
    }
    fn id(&self) -> &ProviderId {
        self.inner.id()
    }
    fn codec(&self) -> &dyn WireCodec {
        self.inner.codec()
    }
    fn retry_policy(&self) -> &RetryPolicy {
        self.inner.retry_policy()
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        self.inner.keepalive()
    }
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        lock(&self.inner.requests).clear();
        let stream = self.inner.attempt(request).await?;
        if lock(&self.inner.script).is_empty() {
            *lock(&self.sample) = Some((live(), copies()));
        }
        Ok(stream)
    }
}

/// The rig's own ingest and warmth keep every turn's context for a test to read: the session's bytes are measured without them.
struct Unkept;

impl mixdog_core_session::session::TurnIngest for Unkept {
    fn ingest_turn(&self, _: &ThreadId, _: &mixdog_store::schema::record::Header, _: Vec<Value>) {}
}

impl mixdog_core_session::session::turn_warm::TurnWarmth for Unkept {
    fn begin(&self, _: &ThreadId, _: &Value, _: Option<&Value>) -> Box<dyn Send> {
        Box::new(())
    }
}

#[derive(Debug)]
struct Measured {
    transcript: usize,
    stored: u64,
    /// Live bytes over the level before the thread began: as the last request of its last turn goes out (the turn holds its
    /// context and the request built from it), as that turn ended, and a second later.
    in_run: isize,
    worked: isize,
    settled: isize,
    /// The blocks each row's text is held in, over those before the thread began.
    in_run_copies: Vec<i32>,
    settled_copies: Vec<i32>,
}

/// The most blocks any one row's text is held in, and the blocks of all rows.
fn summed(rows: &[i32]) -> (i32, i32) {
    (rows.iter().copied().max().unwrap_or_default(), rows.iter().sum())
}

fn stored_bytes(dir: &std::path::Path) -> u64 {
    std::fs::read_dir(dir)
        .map(|entries| entries.flatten().map(|entry| if entry.path().is_dir() { stored_bytes(&entry.path()) } else { entry.metadata().map_or(0, |meta| meta.len()) }).sum())
        .unwrap_or(0)
}

/// One thread worked for `turns` turns of `ROUNDS` rounds of `CALLS` tool results, over the real store, with a feed ring of `ring` bytes.
async fn worked(turns: usize, ring: usize) -> Measured {
    let data = tempfile::tempdir().expect("data dir");
    let tokens = mixdog_rt::testing::tokens();
    let root = data.path().to_path_buf();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
        SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index");
    let store: Arc<dyn mixdog_core_session::session::ThreadStore> = Arc::new(
        StoreThreads::over_data_dir(data.path(), index, Arc::new(mixdog_core_api::domain::mock::MockOwnership::default()), tokens.maintenance_io)
            .await
            .expect("the thread store"),
    );
    let spec = ToolSpec {
        name: "wide".into(),
        title: None,
        trigger: None,
        public: true,
        aliases: Vec::new(),
        description: "wide".into(),
        input_schema: json!({ "type": "object" }),
        annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
        parallel_safe: true,
        exclusive_with: Vec::new(),
    };
    let thread = THREADS.fetch_add(1, Ordering::Relaxed);
    let mut transcript = 0;
    let mut rounds = Vec::new();
    for turn in 0..turns {
        for round in 0..ROUNDS {
            let said = format!("turn {turn} round {round}: the next five rows of the session are read now, one call for each of them.");
            transcript += said.len();
            let mut events = vec![StreamEvent::TextDelta(said)];
            for call in 0..CALLS {
                let n = (turn * ROUNDS + round) * CALLS + call;
                transcript += ROW_BASE + ROW_STEP * n;
                events.push(StreamEvent::ToolCallDone(ToolCall { id: format!("call-{n}"), name: "wide".into(), arguments: json!({ "n": n }), native_type: None }));
            }
            events.push(tool_use());
            rounds.push(events);
        }
        let answer = format!("turn {turn} is answered");
        transcript += answer.len();
        rounds.push(answer_events(&answer));
    }
    let provider = scripted_rounds(rounds);
    let (rig, workspace) = (Rig::new(), tempfile::tempdir().unwrap());
    let sampling = Arc::new(Sampling { inner: provider.clone(), sample: Mutex::new(None) });
    let directory_over = |rig: &Rig, provider: Arc<dyn ProviderAdapter>| {
        let mut deps = rig.deps_parts(store.clone());
        deps.transcript = Arc::new(mixdog_core_session::session::testing::RecordTranscript::new());
        deps.search = Arc::new(Unkept);
        deps.warm = Arc::new(Unkept);
        deps.feeds = Arc::new(mixdog_core_session::session::CoreThreadFeeds {
            limits: mixdog_core_base::feed::FeedLimits { ring_bytes: ring, max_snapshot_bytes: 3 * 1024 * 1024 },
            cpu: tokens.cpu_interactive,
        });
        deps.runs = Arc::new(RunHostFactory::new(
            mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(),
            mixdog_tools::web::NativeSearchUsageSinks::new(),
            Arc::new(Parts { provider, workspace: workspace.path().to_path_buf(), more: vec![Arc::new(Wide(spec.clone(), thread))], settle: None, effort: None }),
        ));
        SessionDirectory::new(Arc::new(deps))
    };
    let directory = directory_over(&rig, sampling.clone());
    let (base, base_copies) = (live(), copies());
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    for turn in 0..turns {
        let (op, prompt) = (format!("op-{turn}"), format!("continue with turn {turn}"));
        transcript += prompt.len();
        handle.request(request("turn/start", json!({ "threadId": id, "opId": op, "input": { "prompt": prompt } }), &op)).await.expect("turn/start");
        let left = (turns - turn - 1) * (ROUNDS + 1);
        eventually_on_awaiting(|| format!("the end of turn {turn}"), &[handle.stepped()], || (lock(&provider.script).len() == left && !handle.turn_busy()).then_some(()))
            .await;
    }
    // The scripted provider keeps the last request it was sent: the test's, not the session's.
    lock(&provider.requests).clear();
    let over = |now: &[i32]| -> Vec<i32> { now.iter().zip(&base_copies).map(|(now, base)| now - base).collect() };
    let worked = live() - base;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let (settled, settled_copies) = (live() - base, over(&copies()));
    let (in_run, in_run_copies) = lock(&sampling.sample).take().expect("the last request was sampled");
    Measured { transcript, stored: stored_bytes(data.path()), in_run: in_run - base, worked, settled, in_run_copies: over(&in_run_copies), settled_copies }
}

/// Prints, for a session worked for six turns of twenty tool results each (about 1 MB of transcript), its live bytes per
/// transcript byte and the blocks its rows' texts are held in: while its last request goes out, as that turn ended and a
/// second later, with the feed ring at 4 MiB and bounded at 64 KiB.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_bytes_of_a_worked_session() {
    // What the process builds once (compiled patterns, schema checks) is built by a first thread.
    let warm = worked(1, 64 * 1024).await;
    let ringed = worked(TURNS, 4 * 1024 * 1024).await;
    let bounded = worked(TURNS, 64 * 1024).await;
    let per = |bytes: isize, of: &Measured| bytes as f64 / of.transcript as f64;
    for (name, measured) in [("warm-up", &warm), ("ring 4 MiB", &ringed), ("ring 64 KiB", &bounded)] {
        eprintln!(
            "{name}: transcript {} bytes, stored {} bytes; live per transcript byte: in run {:.2}, worked {:.2}, a second later {:.2}; row text blocks (most of one row, all rows): in run {:?}, a second later {:?}",
            measured.transcript,
            measured.stored,
            per(measured.in_run, measured),
            per(measured.worked, measured),
            per(measured.settled, measured),
            summed(&measured.in_run_copies),
            summed(&measured.settled_copies),
        );
    }
}
