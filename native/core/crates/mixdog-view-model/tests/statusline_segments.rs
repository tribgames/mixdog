//! The tests of `statusline-segments.test.mjs`, over a map of files instead of a temporary data directory: the scan, the
//! caches and the liveness rules are the module's; the files, the pids, the clock and the background are fed in.

use std::collections::BTreeMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_view_model::display::statusline_segments::BackgroundRun;
use mixdog_view_model::display::statusline_segments::Clock;
use mixdog_view_model::display::statusline_segments::SegmentSource;
use mixdog_view_model::display::statusline_segments::StatuslineSegments;
use mixdog_view_model::display::statusline_segments::shell_job_visible_from;
use mixdog_view_model::display::statusline_segments::unconfirmed_shell_count;
use mixdog_view_model::display::time_format::format_utc_timestamp;
use serde_json::Value;
use serde_json::json;

const START: f64 = 1_700_000_000_000.0;
/// The pid of "this process" in these tests.
const ME: u64 = 4242;
/// A pid no process has.
const GONE: u64 = 2_147_483_646;

#[derive(Default)]
struct World {
    files: Mutex<BTreeMap<String, (String, f64)>>,
    memory: Mutex<Option<String>>,
    alive: Mutex<HashSet<u64>>,
    now: Mutex<f64>,
}

impl World {
    fn new() -> Arc<Self> {
        let world = Arc::new(Self::default());
        *world.now.lock().unwrap() = START;
        world.alive.lock().unwrap().insert(ME);
        world
    }

    fn now(&self) -> f64 {
        *self.now.lock().unwrap()
    }

    fn put(&self, name: &str, text: &str) {
        let at = self.now();
        self.files.lock().unwrap().insert(name.to_owned(), (text.to_owned(), at));
    }

    fn record(&self, id: &str, record: Value) {
        self.put(&format!("{id}.json"), &record.to_string());
    }

    fn marker(&self, id: &str, owner: u64) {
        self.put(&format!("{id}.owner-{owner}"), "");
    }

    fn remove(&self, name: &str) {
        self.files.lock().unwrap().remove(name);
    }

    fn segments(self: &Arc<Self>) -> Arc<StatuslineSegments> {
        let world = Arc::clone(self);
        let clock: Clock = Arc::new(move || world.now());
        StatuslineSegments::new(Arc::clone(self) as Arc<dyn SegmentSource>, Arc::new(Inline), clock)
    }
}

impl SegmentSource for World {
    fn shell_job_names(&self) -> Option<Vec<String>> {
        let files = self.files.lock().unwrap();
        (!files.is_empty()).then(|| files.keys().cloned().collect())
    }

    fn shell_job_text(&self, name: &str) -> Option<String> {
        self.files.lock().unwrap().get(name).map(|(text, _)| text.clone())
    }

    fn shell_job_mtime_ms(&self, name: &str) -> Option<f64> {
        self.files.lock().unwrap().get(name).map(|(_, at)| *at)
    }

    fn shell_job_file_exists(&self, name: &str) -> bool {
        self.files.lock().unwrap().contains_key(name)
    }

    fn memory_cycle_state_text(&self) -> Option<String> {
        self.memory.lock().unwrap().clone()
    }

    fn pid_alive(&self, pid: u64) -> bool {
        self.alive.lock().unwrap().contains(&pid)
    }
}

/// Runs the refresh where it is handed over: the next render call sees it.
struct Inline;

impl BackgroundRun for Inline {
    fn run(&self, job: Box<dyn FnOnce() + Send>) {
        job();
    }
}

fn commands(jobs: &Value) -> Vec<String> {
    jobs.as_array().expect("jobs").iter().map(|job| job["command"].as_str().unwrap_or_default().to_owned()).collect()
}

fn task_ids(jobs: &Value) -> HashSet<String> {
    jobs.as_array().expect("jobs").iter().map(|job| job["taskId"].as_str().unwrap_or_default().to_owned()).collect()
}

#[test]
fn foreground_commands_stay_out_of_the_shell_job_list() {
    let world = World::new();
    let segments = world.segments();
    for (id, record) in [
        (format!("job_{}_bg", START), json!({ "pid": ME, "ownerSessionId": "sess-fg", "command": "npm run dev" })),
        (format!("job_{}_fg", START), json!({ "pid": ME, "ownerSessionId": "sess-fg", "command": "git status", "foreground": true })),
    ] {
        world.record(&id, record);
        world.marker(&id, ME);
    }
    let owner = (ME + 200_000) as f64;
    // The first call starts the refresh and answers from the empty cache; the next one reads what it found.
    segments.shell_jobs_status(owner, Some("sess-fg"));
    let status = segments.shell_jobs_status(owner, Some("sess-fg"));
    assert_eq!(status["count"], json!(1));
    assert_eq!(commands(&status["jobs"]), ["npm run dev"]);
}

#[test]
fn recently_finished_background_jobs_ride_in_the_session_bucket_without_counting() {
    let world = World::new();
    let segments = world.segments();
    let owner = ME + 300_000;
    let finished_at = |ago: f64| format_utc_timestamp(START - ago);
    let write = |id: String, record: Value, done: bool| {
        let mut base = json!({ "pid": ME, "ownerSessionId": "sess-fin" });
        base.as_object_mut().unwrap().extend(record.as_object().unwrap().clone());
        world.record(&id, base);
        world.marker(&id, owner);
        if done {
            world.put(&format!("{id}.done"), "");
        }
    };
    write(format!("job_{}_run", START), json!({ "command": "npm run dev" }), false);
    write(format!("job_{}_ok", START - 1.0), json!({ "command": "make", "status": "completed", "exitCode": 0, "finishedAt": finished_at(1000.0) }), true);
    write(
        format!("job_{}_fg", START - 2.0),
        json!({ "command": "git status", "foreground": true, "status": "completed", "exitCode": 0, "finishedAt": finished_at(0.0) }),
        true,
    );
    write(
        format!("job_{}_old", START - 3.0),
        json!({ "command": "old", "status": "completed", "exitCode": 0, "finishedAt": finished_at(3.0 * 3_600_000.0) }),
        true,
    );
    segments.shell_jobs_status(owner as f64, Some("sess-fin"));
    let status = segments.shell_jobs_status(owner as f64, Some("sess-fin"));
    assert_eq!(status["count"], json!(1));
    assert_eq!(segments.shell_jobs_status(owner as f64, None)["count"], json!(1));
    let finished = status["finished"].as_array().expect("finished");
    assert_eq!(finished.len(), 1);
    assert_eq!(finished[0]["command"], json!("make"));
    assert_eq!(finished[0]["status"], json!("completed"));
    assert_eq!(finished[0]["exitCode"], json!(0));
    assert!(!finished[0]["finishedAt"].is_null());
}

#[test]
fn a_session_keeps_its_shell_jobs_while_the_polling_owner_pid_alternates() {
    let world = World::new();
    let segments = world.segments();
    let id = format!("job_{}_owners", START);
    world.record(&id, json!({ "pid": ME, "command": "npm run dev", "ownerSessionId": "sess-a", "startedAt": START }));
    world.marker(&id, ME);
    let (owner_a, owner_b) = (ME as f64, (ME + 100_000) as f64);
    let session_count = |owner: f64| segments.shell_jobs_status(owner, Some("sess-a"))["count"].clone();
    // Warm both owners' caches.
    for _ in 0..2 {
        session_count(owner_a);
        session_count(owner_b);
    }
    for poll in 0..6 {
        assert_eq!(session_count(if poll % 2 == 1 { owner_b } else { owner_a }), json!(1), "poll {poll}");
    }
    // The owner-wide aggregate stays pid-scoped.
    assert_eq!(segments.shell_jobs_status(owner_a, None)["count"], json!(1));
    assert_eq!(segments.shell_jobs_status(owner_b, None)["count"], json!(0));
}

#[test]
fn a_fresh_status_scans_now_so_a_just_finished_shell_is_visible_on_the_same_call() {
    let world = World::new();
    let segments = world.segments();
    let id = format!("job_{}_fresh", START);
    let owner = ME + 400_000;
    let record = json!({ "pid": ME, "command": "npm run dev", "ownerSessionId": "sess-fresh", "startedAt": START });
    world.record(&id, record.clone());
    world.marker(&id, owner);
    let running = segments.shell_jobs_status_fresh(owner as f64);
    assert_eq!(running["sessions"]["sess-fresh"]["count"], json!(1), "the first call already sees the running shell");

    let mut finished = record;
    finished
        .as_object_mut()
        .unwrap()
        .extend(json!({ "status": "completed", "exitCode": 0, "finishedAt": format_utc_timestamp(START) }).as_object().unwrap().clone());
    world.record(&id, finished);
    world.put(&format!("{id}.done"), "");
    world.remove(&format!("{id}.owner-{owner}"));
    let settled = segments.shell_jobs_status_fresh(owner as f64);
    assert_eq!(settled["sessions"]["sess-fresh"]["count"], json!(0), "no one-interval lag after the shell settles");
    assert_eq!(settled["sessions"]["sess-fresh"]["finished"][0]["status"], json!("completed"));
    assert_eq!(segments.shell_jobs_status_fresh(f64::NAN), segments.shell_jobs_status(f64::NAN, None), "no owner pid owns nothing");
}

#[test]
fn finished_shells_do_not_blink_out_when_an_owner_is_polled_again_after_its_cache_entry_aged_out() {
    let world = World::new();
    let segments = world.segments();
    let id = format!("job_{}_blink", START);
    world.record(
        &id,
        json!({ "pid": ME, "command": "make", "ownerSessionId": "sess-blink", "status": "completed", "exitCode": 0, "finishedAt": format_utc_timestamp(START - 1000.0) }),
    );
    world.put(&format!("{id}.done"), "");
    let (owner_a, owner_b) = ((ME + 400_000) as f64, (ME + 500_000) as f64);
    // The desktop poller asks for the owner aggregate and reads its session buckets.
    let finished = |owner: f64| segments.shell_jobs_status(owner, None)["sessions"]["sess-blink"]["finished"].as_array().map_or(0, Vec::len);
    for _ in 0..2 {
        finished(owner_a);
        finished(owner_b);
    }
    assert_eq!(finished(owner_a), 1);
    assert_eq!(finished(owner_b), 1);

    // Past the owner cache retention only owner B keeps polling: its refresh evicts owner A's entry. Owner A's next poll
    // must still see the shell.
    *world.now.lock().unwrap() = START + 61_000.0;
    for _ in 0..4 {
        finished(owner_b);
    }
    assert_eq!(finished(owner_a), 1);
}

#[test]
fn a_foreground_command_whose_termination_is_unconfirmed_stays_listed_after_its_root_exits() {
    let world = World::new();
    let segments = world.segments();
    let id = format!("job_{}_unconfirmed", START);
    // The root pid is gone; a descendant may still be alive. The owner lives.
    world.record(
        &id,
        json!({ "pid": GONE, "ownerSessionId": "sess-unconfirmed", "command": "node server.js", "foreground": true, "terminationUnconfirmed": true }),
    );
    world.marker(&id, ME);
    let status = segments.shell_jobs_status_fresh(ME as f64);
    assert_eq!(status["count"], json!(1));
    let jobs = status["sessions"]["sess-unconfirmed"]["jobs"].as_array().expect("jobs");
    assert_eq!(
        jobs.iter().map(|job| (job["command"].clone(), job["terminationUnconfirmed"].clone())).collect::<Vec<_>>(),
        [(json!("node server.js"), json!(true))]
    );
    assert_eq!(unconfirmed_shell_count(&status), 1);
}

#[test]
fn a_closed_sessions_unconfirmed_shells_stay_listed_until_their_records_retire_or_complete() {
    let world = World::new();
    let segments = world.segments();
    let write = |id: &str, record: Value, owner: u64| {
        let mut base =
            json!({ "ownerSessionId": "sess-closed", "foreground": true, "terminationUnconfirmed": true, "ownerSessionClosed": true, "cwd": "/work" });
        base.as_object_mut().unwrap().extend(record.as_object().unwrap().clone());
        world.record(id, base);
        world.marker(id, owner);
    };
    let orphan = format!("job_{}_orphan", START);
    let survivor = format!("job_{}_survivor", START);
    let dead_owner = format!("job_{}_dead-owner", START);
    // Missing or empty survivor lists cannot confirm a failed observation. The owner host still owns the hold after its
    // session has closed.
    write(&orphan, json!({ "pid": GONE, "command": "npm test" }), ME);
    write(&survivor, json!({ "pid": GONE - 1, "survivorPids": [ME], "command": "node server.js" }), ME);
    write(&dead_owner, json!({ "pid": ME, "command": "stale hold" }), GONE - 2);
    let held: HashSet<String> = [orphan.clone(), survivor.clone()].into_iter().collect();
    let mut status = segments.shell_jobs_status_fresh(ME as f64);
    assert_eq!(status["count"], json!(2));
    assert_eq!(task_ids(&status["orphaned"]), held, "both unresolved holds are offered to other sessions, but a dead host owns no hold");
    assert_eq!(task_ids(&status["sessions"]["sess-closed"]["jobs"]), held);
    assert!(status["orphaned"].as_array().unwrap().iter().all(|job| job["terminationUnconfirmed"] == json!(true)));

    write(&orphan, json!({ "pid": GONE, "survivorPids": [], "command": "npm test" }), ME);
    status = segments.shell_jobs_status_fresh(ME as f64);
    assert_eq!(task_ids(&status["orphaned"]), held, "an empty observation does not retire the hold");

    // Explicitly releasing a foreground hold retires its record.
    world.remove(&format!("{orphan}.json"));
    world.remove(&format!("{orphan}.owner-{ME}"));
    status = segments.shell_jobs_status_fresh(ME as f64);
    assert_eq!(status["count"], json!(1));
    assert_eq!(task_ids(&status["orphaned"]), [survivor.clone()].into_iter().collect());

    // Completion is authoritative even if the last record still names a pid.
    world.put(&format!("{survivor}.done"), "");
    status = segments.shell_jobs_status_fresh(ME as f64);
    assert_eq!(status["count"], json!(0));
    assert_eq!(status["jobs"], json!([]));
    assert!(status.get("orphaned").is_none());
    assert!(status["sessions"].get("sess-closed").is_none());
}

#[test]
fn an_unreadable_directory_and_a_record_that_is_not_json_list_nothing() {
    let world = World::new();
    let segments = world.segments();
    assert_eq!(segments.shell_jobs_status_fresh(ME as f64), json!({ "count": 0, "elapsedLabel": "", "jobs": [], "sessions": {} }));
    world.put("job_1_x.json", "{ not json");
    world.put("job_1_x.owner-4242", "");
    assert_eq!(segments.shell_jobs_status_fresh(ME as f64)["count"], json!(0));
    assert_eq!(segments.shell_jobs_status(f64::NAN, Some("s")), json!({ "count": 0, "elapsedLabel": "", "jobs": [], "finished": [] }));
    assert_eq!(segments.shell_jobs_status(ME as f64, Some("  ")), json!({ "count": 0, "elapsedLabel": "", "jobs": [], "finished": [] }));
}

#[test]
fn a_job_that_enforces_its_timeout_is_dead_long_after_it() {
    let world = World::new();
    let segments = world.segments();
    let id = format!("job_{}_timeout", START);
    world.record(&id, json!({ "pid": ME, "command": "sleep", "ownerSessionId": "s", "timeoutMs": 1000, "timeoutEnforced": true }));
    world.marker(&id, ME);
    assert_eq!(segments.shell_jobs_status_fresh(ME as f64)["count"], json!(1));
    *world.now.lock().unwrap() = START + 1000.0 + 30.0 * 60_000.0 + 1.0;
    assert_eq!(segments.shell_jobs_status_fresh(ME as f64)["count"], json!(0));
    // Without the enforcement the timeout does not retire a live process.
    world.record(&id, json!({ "pid": ME, "command": "sleep", "ownerSessionId": "s", "timeoutMs": 1000 }));
    assert_eq!(segments.shell_jobs_status_fresh(ME as f64)["count"], json!(1));
    world.put(&format!("{id}.enforced"), "");
    assert_eq!(segments.shell_jobs_status_fresh(ME as f64)["count"], json!(1), "the record was just written");
    *world.now.lock().unwrap() += 1000.0 + 30.0 * 60_000.0 + 1.0;
    assert_eq!(segments.shell_jobs_status_fresh(ME as f64)["count"], json!(0));
}

#[test]
fn the_memory_cycle_segment_reads_the_daemons_state_file() {
    let world = World::new();
    let segments = world.segments();
    let state = |value: Value| *world.memory.lock().unwrap() = Some(value.to_string());
    // The first render call starts the refresh and reads the empty cache.
    assert_eq!(segments.memory_cycle_status(), None);
    state(json!({ "updatedAt": START, "running": { "cycle": "cycle1", "started_at": START - 5000.0, "pid": ME } }));
    segments.refresh_memory_cycle();
    *world.now.lock().unwrap() = START + 2000.0;
    assert_eq!(segments.memory_cycle_status(), Some(json!({ "kind": "running", "startedAt": 1_699_999_995_000_i64 })));

    // A daemon whose pid is gone no longer runs, whatever the file says.
    state(json!({ "updatedAt": START + 2000.0, "running": { "cycle": "cycle1", "started_at": 1, "pid": GONE } }));
    segments.refresh_memory_cycle();
    assert_eq!(segments.memory_cycle_status(), None);

    // A large backlog is a warning, a small one nothing.
    state(json!({ "updatedAt": START + 2000.0, "backlog": { "unchunked": 501 } }));
    segments.refresh_memory_cycle();
    assert_eq!(segments.memory_cycle_status(), Some(json!({ "kind": "backlog", "pending": 501 })));
    state(json!({ "updatedAt": START + 2000.0, "backlog": { "unchunked": 500 } }));
    segments.refresh_memory_cycle();
    assert_eq!(segments.memory_cycle_status(), None);

    // A file nobody refreshed for ten minutes is stale; text that is not JSON is nothing.
    state(json!({ "updatedAt": START - 700_000.0, "backlog": { "unchunked": 900 } }));
    segments.refresh_memory_cycle();
    assert_eq!(segments.memory_cycle_status(), None);
    *world.memory.lock().unwrap() = Some("{ broken".to_owned());
    segments.refresh_memory_cycle();
    assert_eq!(segments.memory_cycle_status(), None);
    *world.memory.lock().unwrap() = None;
    segments.refresh_memory_cycle();
    assert_eq!(segments.memory_cycle_status(), None);
}

#[test]
fn an_orphaned_hold_is_visible_from_the_folders_the_workspace_rule_connects() {
    let job = json!({ "cwd": "/repo/app" });
    let sees = |target: &str, viewer: &str| viewer.starts_with("/repo") && target.starts_with("/repo");
    assert!(shell_job_visible_from(&job, "/repo/lib", &sees));
    assert!(!shell_job_visible_from(&job, "/other", &sees));
    assert!(!shell_job_visible_from(&job, "", &sees));
    assert!(!shell_job_visible_from(&json!({}), "/repo", &sees));
    assert!(!shell_job_visible_from(&json!({ "cwd": 5 }), "/repo", &sees));
}
