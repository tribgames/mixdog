//! `runtime/shared/statusline/statusline-segments.mjs`: the statusline's segment sources that live on disk.
//!
//! The shell-jobs segment (an owner-scoped scan of the job records plus liveness) and the memory-cycle segment (the
//! daemon's state file) each keep a one-second cache. A render call ([`StatuslineSegments::shell_jobs_status`],
//! [`StatuslineSegments::memory_cycle_status`]) is a pure cache read and never touches the disk: when the cache has
//! expired it returns the last known value at once and hands a refresh to the background, guarded against overlap, which
//! updates the cache for the next render tick. That keeps the 500 ms render tick off file I/O.
//!
//! Reading the files, probing a pid, the clock and running a refresh in the background are the caller's: the workspace
//! routes blocking file work through a lane job, so a [`SegmentSource`] and a [`BackgroundRun`] come from the host (the
//! scan and the cache rules here do not change with them, and the tests run them over a map of files).

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_js::js_trim;
use mixdog_js::json_number;
use mixdog_js::json_parse;
use mixdog_js::time::date_parse;
use mixdog_js::to_number_of;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::coerce::field;
use super::coerce::number_or_zero;
use super::coerce::present;
use super::coerce::text_nullish;
use super::coerce::truthy;
use super::time_format::format_elapsed;

const SHELL_JOBS_SEGMENT_CACHE_MS: f64 = 1000.0;
const SHELL_JOBS_OWNER_CACHE_TTL_MS: f64 = 60_000.0;
const FINISHED_SHELL_JOB_TTL_MS: f64 = 30.0 * 60.0 * 1000.0;
const MEMORY_CYCLE_SEGMENT_CACHE_MS: f64 = 1000.0;
const MEMORY_CYCLE_BACKLOG_WARN: f64 = 500.0;
const MEMORY_CYCLE_STALE_MS: f64 = 10.0 * 60_000.0;
/// The most open job records one refresh reads, newest first.
const OPEN_JOB_LIMIT: usize = 60;
/// The most finished job records one refresh reads, newest first.
const DONE_JOB_LIMIT: usize = 30;
/// A job that enforces its timeout is dead this long after the timeout passes without a record update.
const TIMEOUT_GRACE_MS: f64 = 30.0 * 60_000.0;

/// What the segments read: the shell-jobs directory of the data directory and the memory-cycle state file. A name is a
/// file name inside the shell-jobs directory (`<id>.json`, `<id>.done`, `<id>.owner-<pid>`, `<id>.enforced`).
pub trait SegmentSource: Send + Sync {
    /// The names in the shell-jobs directory; `None` when it cannot be read (it does not exist).
    fn shell_job_names(&self) -> Option<Vec<String>>;
    /// The text of a file of the shell-jobs directory.
    fn shell_job_text(&self, name: &str) -> Option<String>;
    /// The modification time of a file of the shell-jobs directory, in epoch milliseconds.
    fn shell_job_mtime_ms(&self, name: &str) -> Option<f64>;
    /// Whether a file of the shell-jobs directory exists.
    fn shell_job_file_exists(&self, name: &str) -> bool;
    /// The text of `memory-cycle-state.json`.
    fn memory_cycle_state_text(&self) -> Option<String>;
    /// `isPidAlive(pid)`: a process with this pid exists (one this process may not signal counts).
    fn pid_alive(&self, pid: u64) -> bool;
}

/// Runs a refresh off the render path.
pub trait BackgroundRun: Send + Sync {
    fn run(&self, job: Box<dyn FnOnce() + Send>);
}

/// `Date.now()`.
pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;

struct ShellCacheEntry {
    owner: u64,
    at: f64,
    value: Value,
}

#[derive(Default)]
struct State {
    /// One entry per owner pid, in the order they were first remembered: a desktop host polls under whichever session
    /// frame arrived last, so the owner can alternate between processes. A single shared slot answered every switch with
    /// "no jobs" and made the job list flicker.
    shell: Vec<ShellCacheEntry>,
    shell_in_flight: HashSet<u64>,
    memory_at: f64,
    memory_value: Option<Value>,
    memory_in_flight: bool,
}

/// The two segment sources with their caches.
pub struct StatuslineSegments {
    source: Arc<dyn SegmentSource>,
    background: Arc<dyn BackgroundRun>,
    clock: Clock,
    state: Mutex<State>,
}

fn empty_session() -> Value {
    json!({ "count": 0, "elapsedLabel": "", "jobs": [], "finished": [] })
}

fn empty_shell_jobs() -> Value {
    json!({ "count": 0, "elapsedLabel": "", "jobs": [], "sessions": {} })
}

/// `positiveInt(value)`: `Math.floor(Number(value))` when finite and at least 1.
fn positive_int(value: f64) -> Option<u64> {
    let parsed = value.floor();
    (parsed.is_finite() && parsed >= 1.0).then_some(parsed as u64)
}

/// `String(value || '').trim()`.
fn text_of(value: Option<&Value>) -> String {
    if truthy(value) { js_trim(&value.map(value_to_string).unwrap_or_default()).to_owned() } else { String::new() }
}

fn is_true(value: Option<&Value>) -> bool {
    value == Some(&Value::Bool(true))
}

/// `jobStampMs(id)`: the timestamp in `job_<ms>...`, 0 for any other id.
fn job_stamp_ms(id: &str) -> f64 {
    let Some(rest) = id.strip_prefix("job_") else { return 0.0 };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() { 0.0 } else { mixdog_js::string_to_number(&digits) }
}

/// The open job records (newest first, capped), the `.owner-<pid>` marker of each job and the finished ones.
struct OpenJobs {
    ids: Vec<String>,
    owner_by_job: HashMap<String, u64>,
    done_ids: Vec<String>,
}

/// `listOpenShellJobs(names)`.
fn list_open_shell_jobs(names: &[String]) -> OpenJobs {
    let mut done: Vec<&str> = Vec::new();
    for name in names {
        if let Some(id) = name.strip_suffix(".done")
            && !done.contains(&id)
        {
            done.push(id);
        }
    }
    let mut owner_by_job = HashMap::new();
    for name in names {
        if let Some(at) = name.rfind(".owner-")
            && at > 0
            && let Some(pid) = positive_int(mixdog_js::string_to_number(&name[at + 7..]))
        {
            owner_by_job.insert(name[..at].to_owned(), pid);
        }
    }
    // Session buckets are not pid-scoped. A desktop pane's background shell is published by the session shard that ran it,
    // so the record's `.owner-<pid>` marker carries the shard pid while the desktop poller asks with its own host pid. The
    // two never intersect, so every id is listed and the owner-wide aggregate alone honours the pid, keeping the CLI
    // statusline and keep-awake counting only their own process. Session ids are globally unique, so bucketing by session
    // needs no pid axis at all.
    let mut ids: Vec<String> = names.iter().filter_map(|name| name.strip_suffix(".json")).filter(|id| !done.contains(id)).map(str::to_owned).collect();
    ids.sort_by(|a, b| job_stamp_ms(b).partial_cmp(&job_stamp_ms(a)).unwrap_or(std::cmp::Ordering::Equal));
    // Scanning both scopes from one list doubles the worst-case window, so the per-refresh cap doubles with it; a live
    // record set is a handful in practice and terminal ones age out on their own.
    ids.truncate(OPEN_JOB_LIMIT);
    let mut done_ids: Vec<String> = done.into_iter().filter(|id| names.iter().any(|name| name.strip_suffix(".json") == Some(*id))).map(str::to_owned).collect();
    done_ids.sort_by(|a, b| job_stamp_ms(b).partial_cmp(&job_stamp_ms(a)).unwrap_or(std::cmp::Ordering::Equal));
    done_ids.truncate(DONE_JOB_LIMIT);
    OpenJobs { ids, owner_by_job, done_ids }
}

struct Bucket {
    owner: String,
    count: u64,
    oldest_ms: f64,
    jobs: Vec<Value>,
    finished: Vec<Value>,
}

fn bucket_of<'a>(buckets: &'a mut Vec<Bucket>, owner: &str) -> &'a mut Bucket {
    if let Some(at) = buckets.iter().position(|bucket| bucket.owner == owner) {
        return &mut buckets[at];
    }
    buckets.push(Bucket { owner: owner.to_owned(), count: 0, oldest_ms: f64::INFINITY, jobs: Vec::new(), finished: Vec::new() });
    buckets.last_mut().expect("pushed")
}

fn elapsed_label(oldest_ms: f64, now: f64) -> String {
    if oldest_ms.is_finite() { format_elapsed(now - oldest_ms) } else { String::new() }
}

impl StatuslineSegments {
    pub fn new(source: Arc<dyn SegmentSource>, background: Arc<dyn BackgroundRun>, clock: Clock) -> Arc<Self> {
        Arc::new(Self { source, background, clock, state: Mutex::new(State::default()) })
    }

    fn now(&self) -> f64 {
        (self.clock)()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// `rememberShellJobs(ownerPid, value)`: stores a scan, dropping the entries nobody polled for a minute.
    fn remember_shell_jobs(&self, owner: u64, value: Value) {
        let at = self.now();
        let mut state = self.lock();
        state.shell.retain(|entry| at - entry.at <= SHELL_JOBS_OWNER_CACHE_TTL_MS);
        match state.shell.iter_mut().find(|entry| entry.owner == owner) {
            Some(entry) => {
                entry.at = at;
                entry.value = value;
            }
            None => state.shell.push(ShellCacheEntry { owner, at, value }),
        }
    }

    /// `shellJobsStatus({ clientHostPid, sessionId })`: the render-path entry point, synchronous and cache-only. Without a
    /// session id it reports the owner process's aggregate (the CLI statusline, keep-awake); with one, only that
    /// session's own jobs. Asking for a scope is what matters, not whether that scope is non-empty: an explicit blank id
    /// (a desktop pane with no session yet) owns nothing, while an omitted id means the whole owner process.
    pub fn shell_jobs_status(self: &Arc<Self>, client_host_pid: f64, session_id: Option<&str>) -> Value {
        let owner = positive_int(client_host_pid);
        let scoped = session_id.is_some();
        let scope = js_trim(session_id.unwrap_or_default());
        let Some(owner) = owner else { return if scoped { empty_session() } else { empty_shell_jobs() } };
        let now = self.now();
        let (kick, own, freshest) = {
            let mut state = self.lock();
            let cached = state.shell.iter().find(|entry| entry.owner == owner).map(|entry| (entry.at, entry.value.clone()));
            let fresh = cached.as_ref().is_some_and(|(at, _)| now - at < SHELL_JOBS_SEGMENT_CACHE_MS);
            // Session buckets are not pid-scoped, so they come from the freshest scan of any owner. Reading them from
            // this owner's own slot made the list follow that slot's age: an owner polled again after its entry was
            // evicted (or went stale) answered with "no sessions", and the finished shells vanished until the next poll
            // brought them back.
            let mut freshest: Option<&ShellCacheEntry> = None;
            for entry in &state.shell {
                if freshest.is_none_or(|best| entry.at >= best.at) {
                    freshest = Some(entry);
                }
            }
            let freshest = freshest.and_then(|entry| entry.value.get("sessions").cloned());
            let kick = !fresh && state.shell_in_flight.insert(owner);
            (kick, cached.map_or_else(empty_shell_jobs, |(_, value)| value), freshest)
        };
        if kick {
            let this = Arc::clone(self);
            self.background.run(Box::new(move || {
                this.refresh_shell_jobs(owner);
                this.lock().shell_in_flight.remove(&owner);
            }));
        }
        let sessions = freshest.or_else(|| own.get("sessions").cloned()).unwrap_or_else(|| json!({}));
        if !scoped {
            let mut aggregate = own;
            if let Some(map) = aggregate.as_object_mut() {
                map.insert("sessions".to_owned(), sessions);
            }
            return aggregate;
        }
        if !scope.is_empty()
            && let Some(bucket) = present(sessions.get(scope))
        {
            return bucket.clone();
        }
        empty_session()
    }

    /// `shellJobsStatusFresh({ clientHostPid })`: a scan made now, for a poller that owns its cadence (the desktop): the
    /// result reflects the disk at call time instead of the previous poll.
    pub fn shell_jobs_status_fresh(&self, client_host_pid: f64) -> Value {
        match positive_int(client_host_pid) {
            Some(owner) => self.refresh_shell_jobs(owner),
            None => empty_shell_jobs(),
        }
    }

    /// `isShellJobAlive(detail, detailPath, dir, id)`.
    fn is_shell_job_alive(&self, detail: &Value, id: &str) -> bool {
        let Some(pid) = positive_int(to_number_of(detail.get("pid"))) else { return false };
        let Some(mtime) = self.source.shell_job_mtime_ms(&format!("{id}.json")) else { return false };
        let timeout_ms = to_number_of(detail.get("timeoutMs"));
        let enforced = is_true(detail.get("timeoutEnforced")) || self.source.shell_job_file_exists(&format!("{id}.enforced"));
        if enforced && timeout_ms.is_finite() && timeout_ms > 0.0 && self.now() - mtime > timeout_ms + TIMEOUT_GRACE_MS {
            return false;
        }
        self.source.pid_alive(pid)
    }

    fn job_record(id: &str, detail: &Value, job_ms: f64, unconfirmed: bool) -> Value {
        let started = present(field(Some(detail), "startedAt"));
        let mut job = Map::new();
        job.insert("taskId".to_owned(), Value::String(id.to_owned()));
        job.insert("command".to_owned(), Value::String(text_of(detail.get("command"))));
        job.insert("cwd".to_owned(), Value::String(text_of(detail.get("cwd"))));
        job.insert("startedAt".to_owned(), started.cloned().unwrap_or_else(|| if job_ms.is_finite() { json_number(job_ms) } else { Value::Null }));
        if unconfirmed {
            job.insert("terminationUnconfirmed".to_owned(), Value::Bool(true));
        }
        Value::Object(job)
    }

    /// `refreshShellJobsStatus(ownerPid)`: scans the job records, caches the result under the owner and returns it.
    fn refresh_shell_jobs(&self, owner: u64) -> Value {
        let value = self.scan_shell_jobs(owner).unwrap_or_else(empty_shell_jobs);
        self.remember_shell_jobs(owner, value.clone());
        value
    }

    fn scan_shell_jobs(&self, owner: u64) -> Option<Value> {
        let names = self.source.shell_job_names()?;
        let OpenJobs { ids, owner_by_job, done_ids } = list_open_shell_jobs(&names);
        let mut count: u64 = 0;
        let mut oldest_ms = f64::INFINITY;
        let mut jobs: Vec<Value> = Vec::new();
        let mut orphaned: Vec<Value> = Vec::new();
        // Jobs with no session stamp (legacy records, plain CLI runs) still count toward the owner total but belong to no
        // pane, so they never light up a session's indicator.
        let mut by_session: Vec<Bucket> = Vec::new();
        for id in &ids {
            let name = format!("{id}.json");
            let Some(detail) = self.source.shell_job_text(&name).and_then(|text| json_parse(&text).ok()) else { continue };
            // A killed command whose processes are not confirmed gone has already reported its result, so its tool card
            // is closed: it is listed until its owner retires the record. An incomplete observation can leave no known
            // survivors even after the owner session closes; only the owning runtime can confirm termination, so its
            // liveness decides, not the root's.
            let unconfirmed = is_true(detail.get("terminationUnconfirmed"));
            let alive = if unconfirmed { owner_by_job.get(id).is_some_and(|pid| self.source.pid_alive(*pid)) } else { self.is_shell_job_alive(&detail, id) };
            if !alive {
                continue;
            }
            // A foreground command is awaited in its own tool card; listing it here made every short command flash in and
            // out of the shell list. Only backgrounded jobs (including promoted ones) are background work.
            if is_true(detail.get("foreground")) && !unconfirmed {
                continue;
            }
            // Owner-wide totals stay this process's own; session buckets take every live job regardless of which host
            // published it.
            let owned_by_this_host = owner_by_job.get(id) == Some(&owner);
            if owned_by_this_host {
                count += 1;
            }
            let mut job_ms = f64::INFINITY;
            if let Some(mtime) = self.source.shell_job_mtime_ms(&name) {
                job_ms = mtime;
                if owned_by_this_host && mtime < oldest_ms {
                    oldest_ms = mtime;
                }
            }
            let owner_session = js_trim(&text_nullish(detail.get("ownerSessionId"))).to_owned();
            let job = Self::job_record(id, &detail, job_ms, unconfirmed);
            if owned_by_this_host {
                jobs.push(job.clone());
            }
            // Held by a session that has closed: every session that sees its folder lists it, not only the closed owner.
            if unconfirmed && is_true(detail.get("ownerSessionClosed")) {
                orphaned.push(job.clone());
            }
            if owner_session.is_empty() {
                continue;
            }
            let bucket = bucket_of(&mut by_session, &owner_session);
            bucket.count += 1;
            if job_ms < bucket.oldest_ms {
                bucket.oldest_ms = job_ms;
            }
            bucket.jobs.push(job);
        }
        // Recently finished background jobs ride in their session bucket only; they never touch the running counts.
        let finished_cutoff = self.now() - FINISHED_SHELL_JOB_TTL_MS;
        for id in &done_ids {
            let Some(detail) = self.source.shell_job_text(&format!("{id}.json")).and_then(|text| json_parse(&text).ok()) else { continue };
            if is_true(detail.get("foreground")) {
                continue;
            }
            let owner_session = js_trim(&text_nullish(detail.get("ownerSessionId"))).to_owned();
            if owner_session.is_empty() {
                continue;
            }
            let finished_at = present(field(Some(&detail), "finishedAt")).or_else(|| present(field(Some(&detail), "recordedAt")));
            let finished_ms = date_parse(&finished_at.map(value_to_string).unwrap_or_default());
            if finished_ms.is_finite() && finished_ms < finished_cutoff {
                continue;
            }
            let exit_code = match detail.get("exitCode") {
                Some(Value::Number(n)) if n.as_f64().is_some_and(|n| n.fract() == 0.0 && n.is_finite()) => detail["exitCode"].clone(),
                _ => Value::Null,
            };
            let mut record = Map::new();
            record.insert("taskId".to_owned(), Value::String(id.clone()));
            record.insert("command".to_owned(), Value::String(text_of(detail.get("command"))));
            record.insert("cwd".to_owned(), Value::String(text_of(detail.get("cwd"))));
            record.insert("startedAt".to_owned(), present(field(Some(&detail), "startedAt")).cloned().unwrap_or(Value::Null));
            record.insert(
                "status".to_owned(),
                Value::String(if truthy(detail.get("status")) { detail.get("status").map(value_to_string).unwrap_or_default() } else { String::new() }),
            );
            record.insert("exitCode".to_owned(), exit_code);
            record.insert("finishedAt".to_owned(), finished_at.cloned().unwrap_or(Value::Null));
            bucket_of(&mut by_session, &owner_session).finished.push(Value::Object(record));
        }
        // A desktop pane's job lands in a session bucket while the owner-wide count stays 0 (its publisher is a shard, not
        // this host), so an empty aggregate must not discard the session buckets.
        let mut value = empty_shell_jobs();
        if count > 0 || !by_session.is_empty() {
            let now = self.now();
            let mut sessions = Map::new();
            for bucket in by_session {
                sessions.insert(
                    bucket.owner,
                    json!({
                        "count": bucket.count,
                        "elapsedLabel": elapsed_label(bucket.oldest_ms, now),
                        "jobs": bucket.jobs,
                        "finished": bucket.finished,
                    }),
                );
            }
            value = json!({ "count": count, "elapsedLabel": elapsed_label(oldest_ms, now), "jobs": jobs, "sessions": sessions });
        }
        if !orphaned.is_empty()
            && let Some(map) = value.as_object_mut()
        {
            map.insert("orphaned".to_owned(), Value::Array(orphaned));
        }
        Some(value)
    }

    /// `memoryCycleStatus()`: the render-path entry point, synchronous and cache-only. `{ kind: "running", startedAt }`
    /// while the first memory cycle runs, `{ kind: "backlog", pending }` when the unchunked backlog is large, else `None`.
    pub fn memory_cycle_status(self: &Arc<Self>) -> Option<Value> {
        let now = self.now();
        let (kick, value) = {
            let mut state = self.lock();
            let kick = now - state.memory_at >= MEMORY_CYCLE_SEGMENT_CACHE_MS && !state.memory_in_flight;
            if kick {
                state.memory_in_flight = true;
            }
            (kick, state.memory_value.clone())
        };
        if kick {
            let this = Arc::clone(self);
            self.background.run(Box::new(move || {
                this.refresh_memory_cycle();
                this.lock().memory_in_flight = false;
            }));
        }
        value
    }

    /// `isPidAlive(Number(pid))`: only a positive integer pid can be alive.
    fn number_pid_alive(&self, pid: f64) -> bool {
        pid.is_finite() && pid.fract() == 0.0 && pid >= 1.0 && self.source.pid_alive(pid as u64)
    }

    /// `refreshMemoryCycleStatus()`.
    pub fn refresh_memory_cycle(&self) {
        let value = self.read_memory_cycle();
        let mut state = self.lock();
        state.memory_at = self.now();
        state.memory_value = value;
    }

    fn read_memory_cycle(&self) -> Option<Value> {
        let text = self.source.memory_cycle_state_text()?;
        let state = json_parse(&text).ok()?;
        let state = Some(&state);
        let running = present(field(state, "running"));
        // A daemon that died mid-run leaves `running` set: anything not refreshed in the last 10 minutes is ignored.
        let fresh = to_number_of(field(state, "updatedAt")) > self.now() - MEMORY_CYCLE_STALE_MS;
        // The precise guard: `running` carries the daemon pid, and if that pid is gone the run died with it, so the
        // spinner drops at once instead of after the 10-minute window. A marker without a pid keeps the time guard.
        let pid = to_number_of(field(running, "pid"));
        let owner_alive = pid.is_nan() || pid == 0.0 || self.number_pid_alive(pid);
        let started_at = to_number_of(field(running, "started_at"));
        if fresh && owner_alive && field(running, "cycle").and_then(Value::as_str) == Some("cycle1") && started_at > 0.0 {
            return Some(json!({ "kind": "running", "startedAt": json_number(started_at) }));
        }
        if fresh {
            let backlog = present(field(state, "backlog"));
            let pending = number_or_zero(field(backlog, "unchunked"));
            if pending > MEMORY_CYCLE_BACKLOG_WARN {
                return Some(json!({ "kind": "backlog", "pending": json_number(pending) }));
            }
        }
        None
    }
}

/// `unconfirmedShellCount(status)`: the listed jobs held only because their termination is unconfirmed.
pub fn unconfirmed_shell_count(status: &Value) -> usize {
    status.get("jobs").and_then(Value::as_array).map_or(0, |jobs| jobs.iter().filter(|job| is_true(job.get("terminationUnconfirmed"))).count())
}

/// `shellJobVisibleFrom(job, sessionCwd)`: whether an orphaned held shell belongs in the list of a session working in
/// `session_cwd`; `sees(target, viewer)` is the workspace's own rule (the folders overlap, or belong to one repository).
pub fn shell_job_visible_from(job: &Value, session_cwd: &str, sees: &dyn Fn(&str, &str) -> bool) -> bool {
    let Some(target) = job.get("cwd").and_then(Value::as_str).filter(|cwd| !cwd.is_empty()) else { return false };
    !session_cwd.is_empty() && sees(target, session_cwd)
}
