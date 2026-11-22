//! `migration_steps <base> [--serving]`: migrates the 1.4.5 profile `<base>/home` (`<base>/home/data` the data dir) and
//! `<base>/profile` (the desktop profile, when present), and prints where the time and the heap went: every interval
//! between two of the migration's step points, named by the step that ends it. The profile is consumed: run it on a copy.
//!
//! Without `--serving` it is the one-shot run of `mixdogd migrate` (four converters, the index built whole), which stops
//! after the front when a home history is left, as the command does. With it, the path of a core's first start: the front
//! it blocks on, the home histories and the catalog rows it reads, the core's session index opened and the sessions still to
//! convert listed in it as boot lists them, then the rest behind it on half the machine, each verified session adopted into
//! that index and the sources disposed of as a serving core disposes of them. `MIGRATION_WORKERS` overrides the converters.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "measurement binary")]

use std::alloc::GlobalAlloc;
use std::alloc::Layout;
use std::alloc::System;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Instant;

use mixdog_core_api::domain::ext::DocumentText;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::PdfIntake;
use mixdog_core_session::session::sub_agent_retention;
use mixdog_migrate::framework::MigrationRoots;
use mixdog_migrate::index::IndexProjector;
use mixdog_migrate::index::ServingIndex;
use mixdog_migrate::run::Front;
use mixdog_migrate::run::MigrateOptions;
use mixdog_migrate::run::Migrator;
use mixdog_migrate::run::product_drivers;
use mixdog_migrate::session::context_blobs::OfficeExtractor;
use mixdog_protocol::ThreadId;

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

fn grow(bytes: usize) {
    let now = LIVE.fetch_add(bytes, Ordering::Relaxed) + bytes;
    PEAK.fetch_max(now, Ordering::Relaxed);
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        grow(l.size());
        unsafe { System.alloc(l) }
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        grow(l.size());
        unsafe { System.alloc_zeroed(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        LIVE.fetch_sub(l.size(), Ordering::Relaxed);
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        if new > l.size() {
            grow(new - l.size());
        } else {
            LIVE.fetch_sub(l.size() - new, Ordering::Relaxed);
        }
        unsafe { System.realloc(p, l, new) }
    }
}

#[global_allocator]
static A: Counting = Counting;

/// The profile's office parts are answered with no text, counted.
struct NoDocs(AtomicUsize);

#[async_trait::async_trait]
impl DocumentText for NoDocs {
    async fn office_text(&self, _: &ThreadId, _: &str, _: &str) -> Result<Option<String>, ExtError> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Ok(None)
    }
    async fn pdf_text(&self, _: &ThreadId, _: &str) -> Result<String, ExtError> {
        unreachable!("the migration extracts no PDF text")
    }
    async fn pdf_counts(&self, _: &ThreadId, _: &str) -> Result<PdfIntake, ExtError> {
        unreachable!("the migration counts no PDF")
    }
}

/// The one-shot run's catalog writer; with `index` bound, the serving core's open index (as the core's boot binds it).
#[derive(Default)]
struct Projector {
    serving: bool,
    index: std::sync::OnceLock<Arc<mixdog_store::sqlite::SqliteStore>>,
}

impl IndexProjector for Projector {
    fn project(&self, data: &Path, db: &Path, sessions: &[String]) -> Result<(), String> {
        mixdog_store::sqlite::project_index(data, db, sessions)
    }

    fn serving(&self) -> Option<&dyn ServingIndex> {
        self.serving.then_some(self as &dyn ServingIndex)
    }
}

impl ServingIndex for Projector {
    fn adopt(&self, data: &Path, session: &str) -> Result<(), String> {
        let index = self.index.get().ok_or("the core's index is not open")?;
        index.adopt(data, session).map_err(|error| error.to_string())
    }
}

/// One step point reached: when, on which thread, and the most heap held since the point before it.
struct Event {
    at: Instant,
    thread: usize,
    point: String,
    peak: usize,
}

static EVENTS: Mutex<Vec<Event>> = Mutex::new(Vec::new());
static THREADS: AtomicUsize = AtomicUsize::new(0);

thread_local! {
    static THREAD: usize = THREADS.fetch_add(1, Ordering::Relaxed);
}

fn mark(point: &str) {
    let peak = PEAK.swap(LIVE.load(Ordering::Relaxed), Ordering::Relaxed);
    let event = Event { at: Instant::now(), thread: THREAD.with(|t| *t), point: point.to_owned(), peak };
    EVENTS.lock().unwrap().push(event);
}

/// `(step, key)` of a point: the key's first segment stands for its kind.
fn split(point: &str) -> (String, String) {
    let (body, edge) = point.rsplit_once(':').filter(|(_, e)| matches!(*e, "before" | "after")).unwrap_or((point, ""));
    let (verb, key) = if let Some(rest) = body.strip_prefix("journal:") {
        rest.split_once(':').map_or((format!("journal:{rest}"), String::new()), |(v, k)| (format!("journal:{v}"), k.to_owned()))
    } else if let Some((verb, key)) =
        body.split_once(':').filter(|(v, _)| matches!(*v, "publish" | "delete" | "purge" | "reason" | "move" | "delete-shared" | "adopt"))
    {
        (verb.to_owned(), key.to_owned())
    } else {
        (body.to_owned(), String::new())
    };
    (if edge.is_empty() { verb } else { format!("{verb}:{edge}") }, key)
}

fn kind(key: &str) -> &str {
    key.split('/').next().unwrap_or(key)
}

/// What the interval that ends at `point` did.
fn label(point: &str) -> (String, String) {
    let (step, key) = split(point);
    let what = match step.as_str() {
        s if s.starts_with("journal:") && s.ends_with(":after") => format!("journal append+sync ({})", &s["journal:".len()..s.len() - ":after".len()]),
        "journal:sources:before" => "hash its sources".into(),
        "journal:staged:before" => "stage (read, fold, write the stage)".into(),
        "journal:verified:before" => "verify (read the target back)".into(),
        "journal:disposed:before" => "dispose (remove sources)".into(),
        "journal:published:before" => "after publish".into(),
        "journal:quarantined:before" => "quarantine".into(),
        "publish:before" => "after the staged journal".into(),
        "publish:after" => "publish (rename the stage)".into(),
        "adopt:after" => "adopt into the serving index".into(),
        "adopt:before" => "after the verified journal".into(),
        "delete:before" => "dispose (rehash before delete)".into(),
        "manifest:before" => "plan (list every source, hash all but the sessions' own)".into(),
        other => other.into(),
    };
    let kind = if key.is_empty() { String::new() } else { kind(&key).to_owned() };
    (if kind.is_empty() { what } else { format!("{kind}: {what}") }, key)
}

#[derive(Default)]
struct Row {
    count: usize,
    total: f64,
    max: f64,
    max_key: String,
    peak: usize,
}

fn mib(bytes: usize) -> f64 {
    bytes as f64 / f64::from(1 << 20)
}

fn main() {
    let base = std::path::PathBuf::from(std::env::args().nth(1).expect("the base dir"));
    let home = base.join("home");
    let profile = base.join("profile");
    let roots = MigrationRoots { data: home.join("data"), home, profile: profile.is_dir().then_some(profile) };
    let serving = std::env::args().any(|arg| arg == "--serving");
    // The serving core's boot takes half the machine (`boot.rs` `migrate_data`); `mixdogd migrate` the default four.
    let workers = std::env::var("MIGRATION_WORKERS").ok().map(|w| w.parse().expect("a worker count")).unwrap_or_else(|| {
        if serving { std::thread::available_parallelism().map_or(4, usize::from).div_ceil(2).clamp(4, 12) } else { MigrateOptions::default().workers }
    });
    let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
    let docs = Arc::new(NoDocs(AtomicUsize::new(0)));
    let office = OfficeExtractor { docs: docs.clone(), runtime: runtime.handle().clone() };
    let fault: mixdog_migrate::framework::FaultHook = Arc::new(|point| {
        mark(point);
        Ok(())
    });
    let projector = Arc::new(Projector { serving, ..Projector::default() });
    let verified: Option<mixdog_migrate::run::VerifiedHook> = serving.then(|| {
        let (projector, data) = (projector.clone(), roots.data.clone());
        Arc::new(move |session: &str| {
            mark(&format!("adopt:session/{session}:before"));
            projector.adopt(&data, session).expect("the session is adopted");
            mark(&format!("adopt:session/{session}:after"));
        }) as mixdog_migrate::run::VerifiedHook
    });
    // `MIGRATION_RETENTION_NOW=<epoch ms>|now`: the sessions retention deletes at that time are removed unconverted.
    let retention = std::env::var("MIGRATION_RETENTION_NOW").ok().filter(|_| serving).map(|at| {
        let now = if at == "now" {
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
        } else {
            at.parse().expect("epoch ms")
        };
        // `MIGRATION_EXPIRED_OUT=<file>`: each session removed unconverted, with the header it was judged by, one a line.
        let removed = std::env::var_os("MIGRATION_EXPIRED_OUT").map(|path| Mutex::new(std::fs::File::create(path).expect("the list of the sessions removed")));
        Arc::new(ProductRule { now, archive: std::sync::OnceLock::new(), removed })
    });
    let rule = retention.clone();
    let retention = retention.map(|rule| rule as Arc<dyn mixdog_migrate::framework::Retention>);
    let options = MigrateOptions { workers, fault: Some(fault), verified, retention };
    let migrator = Migrator::new(roots.clone(), product_drivers(projector.clone(), office), options);

    if std::env::args().any(|arg| arg == "--plan") {
        // Planning reads and never writes: each kind group's plan timed on its own, over the profile as it lies.
        let mut sink = mixdog_migrate::plan::PlanSink::new(&roots);
        for driver in product_drivers(Arc::new(Projector::default()), OfficeExtractor { docs: docs.clone(), runtime: runtime.handle().clone() }) {
            let (t, before) = (Instant::now(), sink.items().count());
            PEAK.store(LIVE.load(Ordering::Relaxed), Ordering::Relaxed);
            driver.plan(&roots, &mut sink).expect("the plan");
            println!(
                "plan {:>6.2} s {:>6} items {:>6.0} MiB peak",
                t.elapsed().as_secs_f64(),
                sink.items().count() - before,
                mib(PEAK.load(Ordering::Relaxed))
            );
        }
        return;
    }
    let began = Instant::now();
    mark("start");
    let front = migrator.front().expect("the front");
    mark("front:end");
    let front_at = Instant::now();
    let complete = match front {
        Front::Complete(complete) => Some(complete),
        Front::Pending(back) if !serving && back.has_pending_home_history() => {
            // `mixdogd migrate` (`run::cli::main`) stops here: the home histories wait for a serving core.
            eprintln!("refused after the front, as mixdogd migrate refuses: a home history waits for a serving core's bot classification");
            None
        }
        Front::Pending(back) if !serving => {
            let _entered = runtime.enter();
            let complete = back.run().expect("the rest");
            mark("back:end");
            Some(complete)
        }
        Front::Pending(back) => {
            let homes = back.home_evidence(|_, messages| messages.len()).expect("the home histories");
            mark("home-evidence:end");
            let listed = mixdog_migrate::session::listed::rows(&roots.data);
            mark("listed-rows:end");
            eprintln!("{} home histories, {} listed rows, {} sessions to convert", homes.len(), listed.len(), back.sessions());
            {
                // The core composes after the front and opens its index, an empty one, before the sessions convert.
                let tokens = mixdog_rt::testing::tokens();
                let data = roots.data.clone();
                let index = runtime
                    .block_on(
                        mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
                            mixdog_store::sqlite::SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &data)
                        })
                        .expect("lane"),
                    )
                    .expect("job ran")
                    .expect("the core's index");
                let index = Arc::new(index);
                let _ = projector.index.set(index.clone());
                mark("core-index-open:end");
                // The archive authority as the core composes it (`compose.rs` `open_core_state`): the state database the front
                // left, set aside and marked lost when it is not usable.
                if let Some(rule) = &rule {
                    let state_dir = roots.data.join("state");
                    std::fs::create_dir_all(&state_dir).expect("the state dir");
                    let existed = state_dir.join("core.sqlite").is_file();
                    let (state, _, set_aside) =
                        mixdog_store::state::CoreState::open_or_set_aside(tokens.sqlite_writer_thread, tokens.interactive_io, &state_dir.join("core.sqlite"))
                            .expect("the core's state");
                    if set_aside.file.is_some() {
                        runtime.block_on(mixdog_store::archive_state::ArchiveStates::mark_lost(&state)).expect("the lost mark");
                    }
                    let archive = runtime.block_on(mixdog_store::archive_state::ArchiveStates::open(state)).expect("the archive authority");
                    eprintln!(
                        "archive authority: state/core.sqlite existed after the front: {existed}; set aside: {:?}; entries lost: {}",
                        set_aside.file.as_ref().map(|(kept, why)| format!("{} ({why})", kept.display())),
                        archive.snapshot().lost()
                    );
                    let _ = rule.archive.set(archive);
                }
                // `Behind::list` (boot.rs): every session still to convert listed by the row the earlier version kept of it.
                let waiting: std::collections::BTreeSet<String> = back.waiting().pending().into_iter().collect();
                let rows: Vec<_> = listed.into_iter().filter(|(session, _)| waiting.contains(session)).collect();
                let ids: Vec<String> = rows.iter().map(|(session, _)| session.clone()).collect();
                let kept = back.listed_meta(&ids);
                let sessions = rows
                    .into_iter()
                    .zip(kept)
                    .map(|((session, mut row), kept)| {
                        if let Some(kept) = mixdog_migrate::session::without_outranked_title(&row, kept) {
                            row.extend(kept);
                        }
                        pending_row(session, row)
                    })
                    .collect();
                runtime.block_on(index.list_pending(sessions)).expect("the pending rows");
                mark("pending-rows-listed:end");
            }
            let _entered = runtime.enter();
            let complete = back.run().expect("the rest");
            mark("back:end");
            Some(complete)
        }
    };
    let end = Instant::now();

    let events = std::mem::take(&mut *EVENTS.lock().unwrap());
    let mut last: BTreeMap<usize, Instant> = BTreeMap::new();
    let mut rows: BTreeMap<String, Row> = BTreeMap::new();
    let mut overall_peak = 0;
    for event in &events {
        overall_peak = overall_peak.max(event.peak);
        let Some(from) = last.insert(event.thread, event.at) else { continue };
        let (what, key) = label(&event.point);
        let secs = event.at.duration_since(from).as_secs_f64();
        let row = rows.entry(what).or_default();
        row.count += 1;
        row.total += secs;
        row.peak = row.peak.max(event.peak);
        if secs > row.max {
            row.max = secs;
            row.max_key = key;
        }
    }
    let at = |pick: &dyn Fn(&str) -> bool, first: bool| {
        let mut found = events.iter().filter(|e| pick(&e.point)).map(|e| e.at.duration_since(began).as_secs_f64());
        if first { found.next() } else { found.last() }
    };
    let session = |p: &str| split(p).1.starts_with("session/") && !p.starts_with("journal:disposed") && !p.starts_with("delete:");
    let timeline: [(&str, Option<f64>); 15] = [
        (
            "blob import done (first supplement/plan point)",
            at(&|p| p.starts_with("supplement:") || p == "manifest:before" || p.starts_with("journal:plan"), true),
        ),
        ("plan done (manifest:before)", at(&|p| p == "manifest:before" || p == "journal:plan:before", true)),
        ("front waves done (front:end)", at(&|p| p == "front:end", true)),
        ("home histories read", at(&|p| p == "home-evidence:end", true)),
        ("catalog rows read", at(&|p| p == "listed-rows:end", true)),
        ("serving index opened", at(&|p| p == "core-index-open:end", true)),
        ("pending rows listed", at(&|p| p == "pending-rows-listed:end", true)),
        ("first session point", at(&session, true)),
        ("retention verdicts journaled", at(&|p| p.starts_with("journal:expired"), false)),
        ("last session point", at(&session, false)),
        ("index done", at(&|p| p.starts_with("journal:verified:index"), false)),
        ("counts written", at(&|p| p == "counts:after", true)),
        ("first disposal", at(&|p| p.starts_with("journal:disposed") || p.starts_with("delete:"), true)),
        ("complete.json", at(&|p| p == "complete:after", true)),
        ("end", at(&|p| p == "back:end", true)),
    ];
    for (name, secs) in timeline {
        println!("  {:>8} s  {name}", secs.map_or_else(|| "-".to_owned(), |s| format!("{s:.1}")));
    }
    let mut rows: Vec<_> = rows.into_iter().collect();
    rows.sort_by(|a, b| b.1.total.total_cmp(&a.1.total));
    let mode = if serving { "serving core (a first start)" } else { "one-shot (mixdogd migrate)" };
    println!(
        "{mode}, workers {workers}; front {:.1}s, all {:.1}s; heap peak {:.0} MiB",
        front_at.duration_since(began).as_secs_f64(),
        end.duration_since(began).as_secs_f64(),
        mib(overall_peak)
    );
    println!("{:<58} {:>7} {:>10} {:>8} {:>9}  slowest", "interval ended by", "count", "thread-s", "max s", "peak MiB");
    for (what, row) in rows.iter().filter(|(_, r)| r.total >= 0.05) {
        println!("{what:<58} {:>7} {:>10.2} {:>8.2} {:>9.0}  {}", row.count, row.total, row.max, mib(row.peak), row.max_key);
    }
    let outcome = complete.map_or_else(|| "refused after the front".to_owned(), |complete| serde_json::to_string(&complete.kinds).unwrap());
    println!("office parts asked: {}; complete: {outcome}", docs.0.load(Ordering::Relaxed));
}

/// The product's sub-agent retention as the core asks it (`boot.rs` `ProductRetention`): the rule's own functions
/// (`mixdog-core-session` `sub_agent_retention`) over the product's archive authority. It removes nothing but the sources:
/// no row is listed for the sessions it expires and nothing is purged.
struct ProductRule {
    now: u64,
    /// The product's archive authority over the migrated data dir, bound once the driver has opened it as the core does.
    archive: std::sync::OnceLock<Arc<mixdog_store::archive_state::ArchiveStates>>,
    /// Where the sessions removed unconverted are listed, for the measurement of their delete over the composed core.
    removed: Option<Mutex<std::fs::File>>,
}

impl mixdog_migrate::framework::Retention for ProductRule {
    fn now_ms(&self) -> u64 {
        self.now
    }

    fn fields(&self) -> Vec<String> {
        sub_agent_retention::judged_fields().into_iter().map(str::to_owned).collect()
    }

    fn candidate(&self, session: &str, header: &serde_json::Map<String, serde_json::Value>) -> bool {
        sub_agent_retention::member(session, header).is_some()
    }

    fn expired(
        &self,
        sessions: &BTreeMap<String, serde_json::Map<String, serde_json::Value>>,
        held: &std::collections::BTreeSet<String>,
        now_ms: u64,
    ) -> std::collections::BTreeSet<String> {
        // As `ProductRetention::expired`: with no authority bound nothing is trusted.
        let archive = |id: &str, header: &serde_json::Map<String, serde_json::Value>| match self.archive.get() {
            Some(archive) => (
                mixdog_core_session::session::archive_trees::resolved_header(archive, id, header).into_owned(),
                archive.resolve(id, header.get("archivedAt")).trusted(),
            ),
            None => (header.clone(), false),
        };
        let members: Vec<&String> = sessions.iter().filter(|(id, header)| sub_agent_retention::member(id, header).is_some()).map(|(id, _)| id).collect();
        let trusted = members.iter().filter(|id| archive(id, &sessions[**id]).1).count();
        let indexed = members.iter().filter(|id| sessions[**id].contains_key("worker")).count();
        let expired = sub_agent_retention::deleted_before_conversion(sessions, held, &archive, now_ms as f64);
        eprintln!(
            "the product's rule over {} sessions read, {} held: {} sub-agent members, trusted {trusted}, with a worker map {indexed}; deletes {}",
            sessions.len(),
            held.len(),
            members.len(),
            expired.len()
        );
        expired
    }

    fn unlisted(&self, _sessions: &[String]) {}

    fn purge(&self, session: &str, header: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
        if let Some(removed) = &self.removed {
            use std::io::Write as _;
            let line = serde_json::json!({ "id": session, "header": header });
            writeln!(removed.lock().unwrap(), "{line}").map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

/// `boot.rs` `pending_row`: the pending row of a session the earlier version listed by `row`.
fn pending_row(
    session: String,
    mut row: serde_json::Map<String, serde_json::Value>,
) -> (mixdog_store::summary::CatalogHead, mixdog_store::summary::MessageStats) {
    use serde_json::Value;
    let mut text = |key: &str| match row.shift_remove(key) {
        Some(Value::String(text)) => text,
        _ => String::new(),
    };
    let (preview, last) = (text("preview"), text("lastMessagePreview"));
    let mut count = |key: &str| row.shift_remove(key).and_then(|count| count.as_u64()).unwrap_or(0);
    let stats = mixdog_store::summary::MessageStats {
        count: count("messageCount"),
        real: count("realTurnCount"),
        incoming: row.shift_remove("incomingTail").and_then(|tail| serde_json::from_value(tail).ok()),
        preview,
        last,
        last_routine: row.shift_remove("lastMessageRoutine").unwrap_or(Value::Null),
    };
    (mixdog_store::summary::CatalogHead { session, log_id: mixdog_store::sqlite::PENDING_LOG_ID.to_owned(), base_session: None, header: row }, stats)
}
