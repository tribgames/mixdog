//! Workspace admission: the turn, command and management leases of a Git repository (Node
//! `activity-gate.mjs` + `activity-ledger.mjs`). One admission thread per `Activity` owns every
//! lease the process holds and runs the ledger's locked read-modify-publish, one request at a
//! time in the order the requests were made, so the fsynced writes never block a caller and no
//! two updates of the ledger overlap inside the process.
//!
//! The ledger is kept in two copies of the same content in the Git common directory
//! (`mixdog-workspace-admission.json` and its `.management` mirror). A grant is answered only
//! once both copies hold it; a release is forgotten only once both dropped it. `recoveredAt`
//! marks a ledger that may be missing leases because no complete copy survived: readers still
//! run, management refuses. A `bounded` request still unanswered after the bound reports an
//! unknown outcome, and a grant it completes later is withdrawn at once.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every blocking std::fs call in this module is the body of a lane job")]

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU8;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use mixdog_workspace::pathguard::canonical_through_existing;
use mixdog_workspace::pathguard::is_within;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::oneshot;

use crate::error::ScmFailure;
use crate::repo::discover;
use crate::worktree::errors::RefusalReason;
use crate::worktree::errors::admission_unreadable;
use crate::worktree::errors::busy;
use crate::worktree::errors::unsupported_repo;
use crate::worktree::ownership::pid_alive_or_unknown;
use crate::worktree::registry::Registry;

const FILE: &str = "mixdog-workspace-admission.json";
const VERSION: i64 = 2;
const LOCK_TIMEOUT: Duration = Duration::from_secs(30);

fn env_ms(name: &str, fallback: u64) -> Duration {
    let value = std::env::var(name).ok().and_then(|v| v.trim().parse::<f64>().ok()).filter(|v| v.is_finite() && *v > 0.0);
    Duration::from_millis(value.map_or(fallback, |v| v as u64))
}

fn unverifiable() -> ScmFailure {
    busy(RefusalReason::WorkspaceAdmissionUnreadable)
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Lease {
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    pid: u32,
    token: String,
    path: String,
}

impl Lease {
    fn key(&self) -> String {
        format!("{}\0{}", self.token, self.path)
    }
}

fn parse_lease(value: &Value) -> Option<Lease> {
    let object = value.as_object()?;
    let kind = object.get("kind")?.as_str()?;
    if !matches!(kind, "turn" | "command" | "management") {
        return None;
    }
    let pid = u32::try_from(object.get("pid")?.as_u64()?).ok().filter(|p| *p > 0)?;
    let path = object.get("path")?.as_str()?;
    if !Path::new(path).is_absolute() {
        return None;
    }
    Some(Lease {
        kind: kind.to_owned(),
        session_id: object.get("sessionId").and_then(Value::as_str).map(str::to_owned),
        pid,
        token: object.get("token")?.as_str()?.to_owned(),
        path: path.to_owned(),
    })
}

// Only a pid PROVEN dead drops its lease; an unprobeable pid still counts as running.
fn alive(lease: &Lease) -> bool {
    pid_alive_or_unknown(Some(lease.pid))
}

fn canonical_text(path: &Path) -> String {
    canonical_through_existing(path).unwrap_or_else(|_| path.to_owned()).to_string_lossy().into_owned()
}

fn overlaps(a: &str, b: &str) -> bool {
    is_within(Path::new(a), Path::new(b)) || is_within(Path::new(b), Path::new(a))
}

fn same_path(a: &Path, b: &Path) -> bool {
    canonical_text(a) == canonical_text(b)
}

/// What a grant returns for its release: one per repository the grant touched.
#[derive(Clone, Debug, PartialEq)]
pub struct Handle {
    common_dir: PathBuf,
    token: String,
}

struct Copy {
    path: PathBuf,
    bytes: Option<Vec<u8>>,
    leases: Vec<Lease>,
    damaged: bool,
    uncertain: bool,
    complete: bool,
    recovered_at: Option<i64>,
}

struct FileLock(PathBuf);

impl FileLock {
    fn acquire(path: PathBuf) -> Result<Self, ScmFailure> {
        let started = Instant::now();
        loop {
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    use std::io::Write;
                    let _ = write!(file, "{}", std::process::id());
                    return Ok(Self(path));
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    // A lock whose owner is proven dead is stale.
                    let owner = std::fs::read_to_string(&path).ok().and_then(|t| t.trim().parse::<u32>().ok());
                    if owner.is_some_and(|pid| !pid_alive_or_unknown(Some(pid))) {
                        let _ = std::fs::remove_file(&path);
                        continue;
                    }
                    if started.elapsed() > LOCK_TIMEOUT {
                        return Err(unverifiable());
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(_) => return Err(unverifiable()),
            }
        }
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(format!(".tmp-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed)));
    let temp = path.with_file_name(name);
    let mut file = std::fs::File::create(&temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&temp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })
}

fn copy_paths(common_dir: &Path) -> [PathBuf; 2] {
    let primary = common_dir.join(FILE);
    let mirror = common_dir.join(format!("{FILE}.management"));
    [primary, mirror]
}

/// One copy as read under the ledger lock. A copy that cannot be read or that a newer build
/// wrote refuses everything and is never written; anything else that is not a ledger, or holds
/// an invalid lease record, is damaged (its valid records still count).
fn read_copy(path: &Path, primary: bool) -> Result<Copy, ScmFailure> {
    let empty = |bytes: Option<Vec<u8>>| Copy { path: path.to_owned(), bytes, leases: Vec::new(), damaged: false, uncertain: false, complete: false, recovered_at: None };
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(empty(None)),
        Err(_) => return Err(unverifiable()),
    };
    let ledger: Option<Value> = serde_json::from_slice(&bytes).ok();
    let version = ledger.as_ref().and_then(|l| l.get("version")).and_then(Value::as_i64);
    if version.is_some_and(|v| v > VERSION) {
        return Err(unverifiable());
    }
    let list = ledger.as_ref().and_then(|l| l.get("leases")).and_then(Value::as_array);
    let (Some(version), Some(list)) = (version.filter(|v| [1, VERSION].contains(v)), list) else {
        return Ok(Copy { damaged: true, ..empty(Some(bytes)) });
    };
    let leases: Vec<Lease> = list.iter().filter_map(parse_lease).collect();
    let damaged = leases.len() != list.len();
    let recovered = ledger.as_ref().and_then(|l| l.get("recoveredAt"));
    let uncertain = recovered.is_some();
    Ok(Copy {
        path: path.to_owned(),
        bytes: Some(bytes),
        leases,
        damaged,
        uncertain,
        complete: !damaged && !uncertain && (version == VERSION || primary),
        recovered_at: recovered.and_then(Value::as_i64),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LedgerOut<'a> {
    version: i64,
    leases: &'a [Lease],
    #[serde(skip_serializing_if = "Option::is_none")]
    recovered_at: Option<i64>,
}

/// A repository found from a folder.
struct Layout {
    common_dir: PathBuf,
    git_dir: PathBuf,
    top_level: PathBuf,
}

fn layout(folder: &Path) -> Result<Option<Layout>, ScmFailure> {
    match discover(folder) {
        Ok(id) => Ok(id.work_tree.map(|top_level| Layout { common_dir: id.common_dir, git_dir: id.git_dir, top_level })),
        Err(ScmFailure::NotARepository) => Ok(None),
        Err(error) => Err(error),
    }
}

/// The ledger's state: owned and run by the admission thread alone.
struct Ledger {
    data_dir: PathBuf,
    held: HashMap<String, (PathBuf, Lease)>,
    // Tokens released or failed to grant whose removal from both copies is not confirmed yet.
    pending: HashMap<String, PathBuf>,
}

impl Ledger {
    /// A linked checkout Mixdog did not create is not lock-blocked by what is held elsewhere.
    fn is_external(&self, folder: &Path) -> Result<bool, ScmFailure> {
        let Some(found) = layout(folder)? else { return Ok(false) };
        if same_path(&found.git_dir, &found.common_dir) {
            return Ok(false);
        }
        let entries = Registry::new(&self.data_dir).read().map_err(|_| unverifiable())?;
        Ok(!entries.values().any(|record| same_path(Path::new(&record.path), &found.top_level)))
    }

    /// The union of both copies' valid leases, less proven-dead pids and this process's pending
    /// removals, plus the leases this process holds; uncertain when either copy is, or when a
    /// copy exists but none is complete.
    fn recover(&self, common_dir: &Path, copies: &[Copy]) -> (Vec<Lease>, Option<i64>) {
        let own = self.held.values().filter(|(dir, _)| dir == common_dir).map(|(_, lease)| lease.clone());
        let mut seen = HashSet::new();
        let mut leases = Vec::new();
        for lease in copies.iter().flat_map(|c| c.leases.iter().cloned()).chain(own) {
            if self.pending.get(&lease.token).is_some_and(|dir| dir == common_dir) || !alive(&lease) {
                continue;
            }
            if seen.insert(lease.key()) {
                leases.push(lease);
            }
        }
        let uncertain = copies.iter().any(|c| c.uncertain) || (copies.iter().any(|c| c.bytes.is_some()) && !copies.iter().any(|c| c.complete));
        let recovered_at = uncertain.then(|| copies.iter().find_map(|c| c.recovered_at).unwrap_or_else(now_ms));
        (leases, recovered_at)
    }

    /// The bytes of a damaged copy are kept aside before it is rewritten; if they cannot be,
    /// nothing is written and everything refuses.
    fn keep_aside(copies: &[Copy]) -> Result<(), ScmFailure> {
        for copy in copies.iter().filter(|c| c.damaged) {
            let mut name = copy.path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
            name.push(format!(".corrupt-{}", now_ms()));
            let aside = copy.path.with_file_name(name);
            write_atomic(&aside, copy.bytes.as_deref().unwrap_or_default()).map_err(|_| unverifiable())?;
            mixdog_rt::node_stderr!("[state] {} is damaged; kept as {}", copy.path.display(), aside.display());
        }
        Ok(())
    }

    /// Writes the primary, then the mirror; a copy already holding the ledger is left alone.
    fn publish(copies: &mut [Copy], leases: &[Lease], recovered_at: Option<i64>) -> std::io::Result<()> {
        let mut text = serde_json::to_vec_pretty(&LedgerOut { version: VERSION, leases, recovered_at }).expect("ledger serialises");
        text.push(b'\n');
        for copy in copies {
            if copy.bytes.as_deref() == Some(text.as_slice()) {
                continue;
            }
            copy.bytes = None; // Unknown until the write lands.
            write_atomic(&copy.path, &text)?;
            copy.bytes = Some(text.clone());
        }
        Ok(())
    }

    fn settle(&mut self, tokens: &[String]) {
        for token in tokens {
            self.pending.remove(token);
        }
    }

    /// Runs `update(leases, unknown)` on the recovered ledger under the primary copy's lock and
    /// publishes the result to both copies before returning. A refused update still publishes
    /// the repaired ledger. A grant that cannot be published is refused: its leases become
    /// pending removals and the ledger without them is published again.
    fn mutate<R>(&mut self, common_dir: &Path, update: impl FnOnce(&mut Vec<Lease>, bool) -> Result<R, ScmFailure>) -> Result<R, ScmFailure> {
        let paths = copy_paths(common_dir);
        let _lock = FileLock::acquire(PathBuf::from(format!("{}.lock", paths[0].display())))?;
        let mut copies = vec![read_copy(&paths[0], true)?, read_copy(&paths[1], false)?];
        Self::keep_aside(&copies)?;
        let withdrawn: Vec<String> = self.pending.iter().filter(|(_, dir)| dir.as_path() == common_dir).map(|(t, _)| t.clone()).collect();
        let (base, recovered_at) = self.recover(common_dir, &copies);
        let mut leases = base.clone();
        let outcome = update(&mut leases, recovered_at.is_some());
        let (result, refusal) = match outcome {
            Ok(value) => (Some(value), None),
            Err(error) => (None, Some(error)),
        };
        let base_keys: HashSet<String> = base.iter().map(Lease::key).collect();
        let granted: Vec<Lease> = if refusal.is_some() { Vec::new() } else { leases.iter().filter(|l| !base_keys.contains(&l.key())).cloned().collect() };
        let target = if refusal.is_some() { &base } else { &leases };
        match Self::publish(&mut copies, target, recovered_at) {
            Ok(()) => self.settle(&withdrawn),
            Err(error) => {
                mixdog_rt::node_stderr!("[state] {} could not be published ({error})", paths[0].display());
                if let Some(refusal) = refusal {
                    return Err(refusal);
                }
                for lease in &granted {
                    self.pending.insert(lease.token.clone(), common_dir.to_owned());
                }
                if !granted.is_empty() && Self::publish(&mut copies, &base, recovered_at).is_ok() {
                    let tokens: Vec<String> = withdrawn.into_iter().chain(granted.iter().map(|l| l.token.clone())).collect();
                    self.settle(&tokens);
                }
                return Err(unverifiable());
            }
        }
        match refusal {
            Some(error) => Err(error),
            None => Ok(result.expect("no refusal")),
        }
    }

    // Without the lock: both copies are the same current ledger holding every live lease this
    // process holds there and none of the tokens it is withdrawing. Repair, never proof.
    fn in_sync(&self, common_dir: &Path) -> bool {
        let [primary, mirror] = copy_paths(common_dir);
        let (Ok(a), Ok(b)) = (std::fs::read(primary), std::fs::read(mirror)) else { return false };
        if a != b {
            return false;
        }
        let Ok(ledger) = serde_json::from_slice::<Value>(&a) else { return false };
        let (Some(VERSION), Some(list)) = (ledger.get("version").and_then(Value::as_i64), ledger.get("leases").and_then(Value::as_array)) else { return false };
        let stored: HashSet<String> = list.iter().filter_map(parse_lease).map(|l| l.key()).collect();
        self.held.iter().all(|(key, (dir, lease))| dir != common_dir || stored.contains(key) || !alive(lease))
            && !list.iter().any(|l| l.get("token").and_then(Value::as_str).is_some_and(|t| self.pending.get(t).is_some_and(|dir| dir == common_dir)))
    }

    fn needs_heal(&self) -> bool {
        !self.held.is_empty() || !self.pending.is_empty()
    }

    fn heal_held(&mut self) {
        let dirs: HashSet<PathBuf> = self.held.values().map(|(d, _)| d.clone()).chain(self.pending.values().cloned()).collect();
        for dir in dirs {
            if !self.in_sync(&dir) {
                let _ = self.mutate(&dir, |_, _| Ok(()));
            }
        }
    }

    fn track(&mut self, common_dir: &Path, lease: Lease) {
        self.held.insert(lease.key(), (common_dir.to_owned(), lease));
    }

    // Forgotten as held first, so nothing puts the lease back; its token stays pending until
    // both copies dropped it. Never fails: a removal that did not land is retried.
    fn release_one(&mut self, handle: &Handle) {
        self.held.retain(|_, (_, lease)| lease.token != handle.token);
        self.pending.insert(handle.token.clone(), handle.common_dir.clone());
        let _ = self.mutate(&handle.common_dir, |_, _| Ok(()));
    }

    /// Last granted first.
    fn release(&mut self, handles: &[Handle]) {
        for handle in handles.iter().rev() {
            self.release_one(handle);
        }
    }

    /// Readers share a checkout freely. `None` means a management writer currently owns it.
    fn admit(&mut self, session_id: Option<String>, cwd: &Path, pid: u32, kind: &str) -> Result<Option<Vec<Handle>>, ScmFailure> {
        let Some(found) = layout(cwd)? else { return Ok(Some(Vec::new())) };
        let external = self.is_external(cwd)?;
        let path = canonical_text(cwd);
        let token = uuid_like();
        let lease = Lease { kind: kind.to_owned(), session_id, pid, token: token.clone(), path: path.clone() };
        let checkout = canonical_text(&found.top_level);
        let holds = |other: &Lease| if external { is_within(Path::new(&checkout), Path::new(&other.path)) } else { overlaps(&other.path, &path) };
        let granted = lease.clone();
        let admitted = self.mutate(&found.common_dir, move |leases, _| {
            if leases.iter().any(|other| other.kind == "management" && holds(other)) {
                return Ok(false);
            }
            leases.push(granted);
            Ok(true)
        })?;
        if !admitted {
            return Ok(None);
        }
        self.track(&found.common_dir, lease);
        Ok(Some(vec![Handle { common_dir: found.common_dir, token }]))
    }

    /// Writers refuse while any reader overlaps an affected folder, then exclude later readers
    /// until released. External checkouts are only checked, never held.
    fn hold(&mut self, folders: &[PathBuf], session_id: Option<&str>) -> Result<Vec<Handle>, ScmFailure> {
        let mut groups: BTreeMap<PathBuf, Vec<(String, bool)>> = BTreeMap::new();
        for folder in folders {
            let Some(found) = layout(folder)? else { return Err(unsupported_repo(None, None)) };
            groups.entry(found.common_dir).or_default().push((canonical_text(folder), self.is_external(folder)?));
        }
        let mut handles = Vec::new();
        for (common_dir, paths) in groups {
            let token = uuid_like();
            let mut taken = Vec::new();
            let result = self.mutate(&common_dir, |leases, unknown| {
                let conflicts = leases.iter().any(|lease| {
                    !(session_id.is_some() && lease.session_id.as_deref() == session_id && lease.pid == std::process::id())
                        && paths.iter().any(|(path, _)| overlaps(path, &lease.path))
                });
                if conflicts {
                    return Err(busy(RefusalReason::FolderInUse));
                }
                // The ledger may be missing a live foreign lease: refused until reset.
                if unknown {
                    return Err(unverifiable());
                }
                for (path, external) in &paths {
                    if *external {
                        continue;
                    }
                    let lease = Lease { kind: "management".into(), session_id: None, pid: std::process::id(), token: token.clone(), path: path.clone() };
                    leases.push(lease.clone());
                    taken.push(lease);
                }
                Ok(())
            });
            if let Err(error) = result {
                self.release(&handles);
                return Err(error);
            }
            for lease in taken {
                self.track(&common_dir, lease);
            }
            handles.push(Handle { common_dir, token });
        }
        Ok(handles)
    }
}

fn uuid_like() -> String {
    use sha2::Digest;
    use sha2::Sha256;
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let seed = format!("{nanos}-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed));
    Sha256::digest(seed.as_bytes()).iter().take(16).map(|b| format!("{b:02x}")).collect()
}

enum Op {
    Admit { session_id: Option<String>, cwd: PathBuf, pid: u32, kind: String },
    Hold { folders: Vec<PathBuf>, session_id: Option<String> },
    Release(Vec<Handle>),
}

struct Request {
    op: Op,
    /// A bounded request: 0 until either side sets it, 1 by its caller giving up, 2 by the
    /// admission thread answering.
    claim: Option<Arc<AtomicU8>>,
    reply: oneshot::Sender<Result<Option<Vec<Handle>>, ScmFailure>>,
}

fn run(mut ledger: Ledger, requests: mpsc::Receiver<Request>) {
    let heal = env_ms("MIXDOG_ADMISSION_HEAL_MS", 2_000);
    loop {
        let request = if ledger.needs_heal() {
            match requests.recv_timeout(heal) {
                Ok(request) => request,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    ledger.heal_held();
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        } else {
            match requests.recv() {
                Ok(request) => request,
                Err(_) => break,
            }
        };
        let answer = match request.op {
            Op::Admit { session_id, cwd, pid, kind } => ledger.admit(session_id, &cwd, pid, &kind),
            Op::Hold { folders, session_id } => ledger.hold(&folders, session_id.as_deref()).map(Some),
            Op::Release(handles) => {
                ledger.release(&handles);
                Ok(Some(Vec::new()))
            }
        };
        let answered = request.claim.as_ref().is_none_or(|claim| claim.compare_exchange(0, 2, Ordering::SeqCst, Ordering::SeqCst).is_ok());
        if answered {
            let _ = request.reply.send(answer);
        } else if let Ok(Some(handles)) = &answer {
            // Its caller stopped waiting and reported the outcome unknown: nobody holds this
            // grant, so it is withdrawn here.
            ledger.release(handles);
        }
    }
}

fn stopped(posted: bool) -> ScmFailure {
    if posted { admission_unreadable(Some("unknown"), Some("stopped")) } else { admission_unreadable(None, Some("stopped")) }
}

/// A grant; its release is requested once and lands before any later request.
pub struct Grant {
    handles: Vec<Handle>,
    released: AtomicBool,
}

impl Grant {
    /// Settles once the removal was attempted (one that did not land is retried by the
    /// admission thread); fails only when the admission thread stopped.
    pub async fn release(&self, activity: &Activity) -> Result<(), ScmFailure> {
        if self.handles.is_empty() || self.released.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        activity.request(Op::Release(self.handles.clone()), false).await.map(|_| ())
    }
}

/// Runs every release in reverse order, each settled before the next, even when one fails;
/// the first failure is returned after all ran.
pub async fn release_all(activity: &Activity, grants: &[Grant]) -> Result<(), ScmFailure> {
    let mut failure = None;
    for grant in grants.iter().rev() {
        if let Err(error) = grant.release(activity).await {
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(()), Err)
}

pub struct Activity {
    requests: Option<mpsc::Sender<Request>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Activity {
    pub fn new(data_dir: &Path) -> Self {
        let (tx, rx) = mpsc::channel();
        let ledger = Ledger { data_dir: data_dir.to_owned(), held: HashMap::new(), pending: HashMap::new() };
        let thread = std::thread::Builder::new().name("mixdog-admission".into()).spawn(move || run(ledger, rx)).ok();
        Self { requests: thread.as_ref().map(|_| tx), thread }
    }

    async fn request(&self, op: Op, bounded: bool) -> Result<Option<Vec<Handle>>, ScmFailure> {
        let (reply, mut answer) = oneshot::channel();
        let claim = bounded.then(|| Arc::new(AtomicU8::new(0)));
        let sender = self.requests.as_ref().ok_or_else(|| admission_unreadable(None, Some("unavailable")))?;
        sender.send(Request { op, claim: claim.clone(), reply }).map_err(|_| stopped(false))?;
        let Some(claim) = claim else {
            return answer.await.unwrap_or_else(|_| Err(stopped(true)));
        };
        match mixdog_rt::time::timeout(env_ms("MIXDOG_ADMISSION_SYNC_TIMEOUT_MS", 60_000), &mut answer).await {
            Ok(done) => done.unwrap_or_else(|_| Err(stopped(true))),
            // Lost the race when the admission thread already claimed it: its answer is coming.
            Err(_) if claim.compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst).is_ok() => Err(admission_unreadable(Some("unknown"), None)),
            Err(_) => answer.await.unwrap_or_else(|_| Err(stopped(true))),
        }
    }

    /// A reader (`turn` or `command`) of `cwd`. `None`: a management writer owns the checkout.
    pub async fn try_admit(&self, session_id: Option<&str>, cwd: &Path, kind: &str, bounded: bool) -> Result<Option<Grant>, ScmFailure> {
        assert!(matches!(kind, "turn" | "command"), "Invalid workspace reader kind.");
        let op = Op::Admit { session_id: session_id.map(str::to_owned), cwd: cwd.to_owned(), pid: std::process::id(), kind: kind.to_owned() };
        let granted = self.request(op, bounded).await?;
        Ok(granted.map(|handles| Grant { handles, released: AtomicBool::new(false) }))
    }

    /// Waits (polling) until a reader is admitted; a cancel registers nothing.
    pub async fn admit(&self, session_id: Option<&str>, cwd: &Path, kind: &str, cancel: &tokio_util::sync::CancellationToken) -> Result<Grant, ScmFailure> {
        loop {
            if cancel.is_cancelled() {
                return Err(ScmFailure::Cancelled);
            }
            if let Some(grant) = self.try_admit(session_id, cwd, kind, false).await? {
                if cancel.is_cancelled() {
                    let _ = grant.release(self).await;
                    return Err(ScmFailure::Cancelled);
                }
                return Ok(grant);
            }
            tokio::select! {
                () = mixdog_rt::time::sleep(Duration::from_millis(100)) => {}
                () = cancel.cancelled() => return Err(ScmFailure::Cancelled),
            }
        }
    }

    /// A management hold over `folders`; the acting session's own readers in this process do not count.
    pub async fn hold(&self, folders: &[PathBuf], session_id: Option<&str>, bounded: bool) -> Result<Grant, ScmFailure> {
        let op = Op::Hold { folders: folders.to_vec(), session_id: session_id.map(str::to_owned) };
        let handles = self.request(op, bounded).await?.unwrap_or_default();
        Ok(Grant { handles, released: AtomicBool::new(false) })
    }
}

impl Drop for Activity {
    // The requests already posted (a release made just before dropping) are let finish.
    fn drop(&mut self) {
        self.requests = None;
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use super::*;

    fn repo(dir: &Path) -> PathBuf {
        let root = dir.join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let git = |args: &[&str]| assert!(Command::new("git").args(args).current_dir(&root).output().unwrap().status.success());
        git(&["init", "-q"]);
        git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i"]);
        root
    }

    fn ledger_files(root: &Path) -> [PathBuf; 2] {
        copy_paths(&root.join(".git"))
    }

    #[tokio::test]
    async fn readers_share_and_a_management_hold_excludes_them_until_released() {
        let dir = tempfile::tempdir().unwrap();
        let root = repo(dir.path());
        let activity = Activity::new(&dir.path().join("data"));
        let a = activity.try_admit(Some("s1"), &root, "turn", false).await.unwrap().expect("admitted");
        let b = activity.try_admit(Some("s2"), &root, "command", false).await.unwrap().expect("readers share");
        // Another session's reader refuses the hold; the acting session's own does not.
        let refused = activity.hold(&[root.clone()], Some("s3"), false).await.err().unwrap();
        assert!(matches!(refused, ScmFailure::Coded { code: "WORKTREE_BUSY_JOBS", .. }));
        a.release(&activity).await.unwrap();
        b.release(&activity).await.unwrap();
        let held = activity.hold(&[root.clone()], None, false).await.unwrap();
        assert!(activity.try_admit(Some("s1"), &root, "turn", false).await.unwrap().is_none());
        held.release(&activity).await.unwrap();
        let again = activity.try_admit(Some("s1"), &root, "turn", false).await.unwrap();
        assert!(again.is_some());
        // Both copies carry the same ledger.
        let [primary, mirror] = ledger_files(&root);
        assert_eq!(std::fs::read(primary).unwrap(), std::fs::read(mirror).unwrap());
    }

    #[tokio::test]
    async fn a_folder_outside_git_is_admitted_without_a_lease() {
        let dir = tempfile::tempdir().unwrap();
        let activity = Activity::new(&dir.path().join("data"));
        let grant = activity.try_admit(None, dir.path(), "turn", false).await.unwrap().expect("admitted");
        assert!(grant.handles.is_empty());
    }

    #[tokio::test]
    async fn a_lease_of_a_dead_pid_is_dropped_and_a_damaged_copy_is_kept_aside() {
        let dir = tempfile::tempdir().unwrap();
        let root = repo(dir.path());
        let [primary, mirror] = ledger_files(&root);
        let dead = r#"{"version":2,"leases":[{"kind":"management","pid":2147483646,"token":"t","path":"__ROOT__"}]}"#.replace("__ROOT__", &canonical_text(&root).replace('\\', "\\\\"));
        std::fs::write(&primary, &dead).unwrap();
        std::fs::write(&mirror, b"not json").unwrap();
        let activity = Activity::new(&dir.path().join("data"));
        let grant = activity.try_admit(Some("s"), &root, "turn", false).await.unwrap();
        assert!(grant.is_some(), "a proven-dead pid does not hold the checkout");
        let kept: Vec<_> = std::fs::read_dir(root.join(".git")).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().contains(".corrupt-")).collect();
        assert_eq!(kept.len(), 1);
        assert_eq!(std::fs::read(&primary).unwrap(), std::fs::read(&mirror).unwrap());
    }

    #[tokio::test]
    async fn a_ledger_with_no_complete_copy_refuses_management_but_not_readers() {
        let dir = tempfile::tempdir().unwrap();
        let root = repo(dir.path());
        let [primary, _] = ledger_files(&root);
        std::fs::write(&primary, br#"{"version":2,"leases":[],"recoveredAt":5}"#).unwrap();
        let activity = Activity::new(&dir.path().join("data"));
        assert!(activity.try_admit(Some("s"), &root, "turn", false).await.unwrap().is_some());
        let refused = activity.hold(&[root.clone()], Some("s"), false).await.err().unwrap();
        assert!(matches!(refused, ScmFailure::Coded { code: "WORKTREE_BUSY_JOBS", .. }));
    }

    #[tokio::test]
    async fn a_newer_ledger_version_refuses_everything() {
        let dir = tempfile::tempdir().unwrap();
        let root = repo(dir.path());
        let [primary, _] = ledger_files(&root);
        std::fs::write(&primary, br#"{"version":3,"leases":[]}"#).unwrap();
        let activity = Activity::new(&dir.path().join("data"));
        assert!(activity.try_admit(Some("s"), &root, "turn", false).await.is_err());
        assert_eq!(std::fs::read(&primary).unwrap(), br#"{"version":3,"leases":[]}"#);
    }
}
