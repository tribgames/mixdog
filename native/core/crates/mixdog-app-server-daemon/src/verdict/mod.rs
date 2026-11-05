//! The prior-owner verdict (LR §3.1) and the gate that drives LR §3 steps 3–4.
//!
//! The verdict is decided from facts only: the bytes of the 1.4.5 record, the
//! legacy discovery and the claim lock, the OS process table (is the pid
//! running, and its start time) and the OS socket table (does that pid own the
//! LISTEN socket its record publishes). Nothing is probed and nothing is timed.
//! A blocked verdict waits on OS events (process exit, a data-dir change) or on
//! the one user decision, `release{pid}`, journaled before it takes effect.

mod process;
#[cfg(test)]
mod tag_gates;
#[cfg(test)]
pub(crate) mod tests;
mod wait;

use std::fmt;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use mixdog_core_api::domain::ownership::Ownership;
pub use process::OsProcessTable;
pub use process::ProcessIdentity;
pub use process::ProcessInfo;
pub use process::ProcessTable;
pub use process::current_identity;
use serde::Serialize;
use wait::DirWatch;
use wait::ExitWatch;
pub use wait::Interrupt;
pub use wait::Wake;

use crate::barrier;
use crate::barrier::BarrierRecord;
use crate::barrier::ClaimLock;
use crate::barrier::RECORD_FILE;
use crate::barrier::Step;
use crate::barrier::Take;
use crate::barrier::Taken;
use crate::ownership::CoreOwnership;

/// The `undecidable` decision journal, `<data>/migration/ownership-decisions.jsonl`.
pub const JOURNAL_DIR: &str = "migration";
pub const JOURNAL_FILE: &str = "ownership-decisions.jsonl";

/// Blocks until the process `identity` names has exited, confirmed by the OS (a Windows process
/// handle, a Linux pidfd, a macOS `NOTE_EXIT`). Returns at once when it already has, or when
/// the pid now names another process.
pub fn wait_for_exit(identity: ProcessIdentity) -> io::Result<()> {
    let Some(exit) = ExitWatch::open(identity)? else {
        return Ok(());
    };
    wait::wait(&Interrupt::new()?, None, Some(&exit)).map(drop)
}

/// What `B` alone decides (the claim-lock rows of LR §3.1).
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ClaimJudgement {
    /// The barrier is installed: clear.
    Barrier,
    /// `B` may be taken this way once the owner rows are judged `clear`.
    Free(Take),
    Blocked(Verdict),
}

/// A verdict other than `clear`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Verdict {
    /// A 1.4.5 daemon must exit first. `proven`: it owns the LISTEN socket it
    /// published; otherwise it may be a reused pid, which the user may release.
    WaitExit {
        process: ProcessInfo,
        proven: bool,
    },
    /// A live process holds `B` (a 1.4.5 claim or refresh in progress).
    WaitClaim(ProcessInfo),
    Undecidable(ProcessInfo),
    /// `B` is a non-empty directory or a special file: no 1.4.5 process can
    /// own the data dir, and no barrier can be installed over it.
    Unusable,
}

/// The 1.4.5 record's pid (JSON numbers only: the barrier record's text pid
/// is "not alive" to every 1.4.5 reader) and liveness port.
fn record_owner(bytes: &[u8]) -> Option<(u64, Option<u16>)> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let pid = value.get("pid")?.as_u64().filter(|pid| *pid > 0)?;
    Some((pid, value.get("livenessPort").and_then(port)))
}

fn port(value: &serde_json::Value) -> Option<u16> {
    value
        .as_u64()
        .filter(|port| (1..=65_535).contains(port))
        .map(|port| port as u16)
}

/// The pid and session port a 1.4.5 discovery names. A discovery with a
/// `core` section is a 1.4.6+ core's, never a 1.4.5 daemon's.
fn legacy_discovery(bytes: &[u8]) -> Option<(u64, Option<u16>)> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    if value.get("core").is_some() {
        return None;
    }
    let pid = value.get("pid")?.as_u64().filter(|pid| *pid > 0)?;
    let session = value
        .get("endpoints")
        .and_then(|e| e.get("session"))
        .and_then(|s| s.get("port"));
    Some((pid, session.and_then(port)))
}

/// `pid` as a running prior owner: never this core, never a released identity.
fn running(
    procs: &dyn ProcessTable,
    released: &[ProcessIdentity],
    pid: u64,
) -> io::Result<Option<ProcessInfo>> {
    if pid == u64::from(std::process::id()) {
        return Ok(None);
    }
    Ok(procs
        .query(pid)?
        .filter(|info| !released.contains(&info.identity)))
}

/// LR §3.1, the rows on `B`, judged first.
pub(crate) fn judge_claim(
    claim: &ClaimLock,
    procs: &dyn ProcessTable,
    released: &[ProcessIdentity],
) -> io::Result<ClaimJudgement> {
    Ok(match claim {
        ClaimLock::Barrier => ClaimJudgement::Barrier,
        ClaimLock::Held(owner) => {
            if let Some(pid) = owner.pid
                && let Some(info) = running(procs, released, pid)?
            {
                // Started after it acquired B: not its writer, whose pid was reused.
                let reused = owner
                    .acquired_ms
                    .is_some_and(|ms| info.identity.start_ms > ms);
                return Ok(ClaimJudgement::Blocked(if reused {
                    Verdict::Undecidable(info)
                } else {
                    Verdict::WaitClaim(info)
                }));
            }
            ClaimJudgement::Free(Take::DeadHolder(owner.bytes.clone()))
        }
        ClaimLock::Absent => ClaimJudgement::Free(Take::Absent),
        ClaimLock::Dir { empty: true } => ClaimJudgement::Free(Take::EmptyDir),
        ClaimLock::Dir { empty: false } | ClaimLock::Other => {
            ClaimJudgement::Blocked(Verdict::Unusable)
        }
    })
}

/// LR §3.1, the rows on `R` and the legacy discovery, judged without `B`;
/// `None` is `clear`. `released` are identities the user released.
pub(crate) fn judge_owner(
    record: Option<&[u8]>,
    discovery: Option<&[u8]>,
    procs: &dyn ProcessTable,
    released: &[ProcessIdentity],
) -> io::Result<Option<Verdict>> {
    if let Some((pid, liveness_port)) = record.and_then(record_owner) {
        let Some(info) = running(procs, released, pid)? else {
            return Ok(None);
        };
        return Ok(match liveness_port {
            // The writer binds its liveness listener before it writes the record and
            // closes it only by exiting; sockets are not inherited.
            Some(port) if procs.listens(info.identity.pid, port)? => Some(Verdict::WaitExit {
                process: info,
                proven: true,
            }),
            Some(_) => None,
            None => Some(Verdict::Undecidable(info)),
        });
    }

    if let Some((pid, session_port)) = discovery.and_then(legacy_discovery)
        && let Some(info) = running(procs, released, pid)?
    {
        let proven = match session_port {
            Some(port) => procs.listens(info.identity.pid, port)?,
            None => false,
        };
        return Ok(Some(Verdict::WaitExit {
            process: info,
            proven,
        }));
    }
    Ok(None)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BlockedKind {
    WaitExit,
    WaitClaim,
    Undecidable,
}

/// A blocked verdict: published on discovery and answered on the control
/// listener while the boot thread waits in [`Blocked::wait`].
pub struct Blocked {
    pub kind: BlockedKind,
    pub process: ProcessInfo,
    /// Whether `release{pid}` may resolve it (never for a proven 1.4.5 owner).
    pub releasable: bool,
    dir: Option<DirWatch>,
    /// Always present: a block the owner's exit cannot wake is never returned
    /// ([`GateError::ExitUnwatchable`]).
    exit: ExitWatch,
}

impl fmt::Debug for Blocked {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Blocked")
            .field("kind", &self.kind)
            .field("process", &self.process)
            .field("releasable", &self.releasable)
            .finish()
    }
}

impl Blocked {
    /// The `blocked` object for discovery and `status`.
    pub fn describe(&self) -> serde_json::Value {
        serde_json::json!({
            "kind": self.kind,
            "pid": self.process.identity.pid,
            "startTime": self.process.identity.start_ms,
            "image": self.process.image.as_ref().map(|image| image.to_string_lossy()),
            "commandLine": self.process.command_line,
            "releasable": self.releasable,
        })
    }

    /// Blocks until the process exits, the data dir changes (a held claim
    /// lock) or `interrupt` fires; then run [`Gate::step`] again.
    pub fn wait(&self, interrupt: &Interrupt) -> io::Result<Wake> {
        wait::wait(interrupt, self.dir.as_ref(), Some(&self.exit))
    }
}

#[derive(Debug)]
pub enum GateStep {
    /// The barrier is installed (or already was) and pinned: migration may start.
    Clear,
    Blocked(Blocked),
}

#[derive(Debug)]
pub enum GateError {
    Io(io::Error),
    /// `B` is a non-empty directory or a special file.
    ClaimLockUnusable,
    /// The verdict blocks on `process`, which runs but whose exit this user
    /// may not wait on (the OS denied the exit watch). A 1.4.5 contender takes
    /// such a pid as a live peer and does not claim; neither does the core,
    /// and it never waits on something only an interrupt could end. When
    /// `releasable`, `release{pid}` still applies before the next step.
    ExitUnwatchable {
        kind: BlockedKind,
        process: ProcessInfo,
        releasable: bool,
    },
}

impl From<io::Error> for GateError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl fmt::Display for GateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "prior-owner verdict failed: {error}"),
            Self::ClaimLockUnusable => {
                f.write_str("daemon-owner.json.claim.lock is not a file Mixdog can replace")
            }
            Self::ExitUnwatchable { process, .. } => write!(
                f,
                "prior owner pid {} is running, but this user cannot wait for its exit",
                process.identity.pid
            ),
        }
    }
}

impl std::error::Error for GateError {}

#[derive(Debug)]
pub enum ReleaseError {
    /// The gate is not blocked on that pid.
    NotBlockedOn(u32),
    /// A proven 1.4.5 owner is resolved by its exit, never released.
    NotReleasable(u32),
    Io(io::Error),
}

impl fmt::Display for ReleaseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotBlockedOn(pid) => write!(f, "not blocked on pid {pid}"),
            Self::NotReleasable(pid) => {
                write!(f, "pid {pid} is a proven owner and cannot be released")
            }
            Self::Io(error) => write!(f, "release journal failed: {error}"),
        }
    }
}

impl std::error::Error for ReleaseError {}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseEntry<'a> {
    at: u64,
    decision: &'static str,
    instance_id: &'a str,
    pid: u32,
    process_start_ms: u64,
    image: Option<String>,
    command_line: Option<&'a str>,
}

/// LR §3 steps 3–4 under the OS lock: judge the prior owner without `B`; only
/// on `clear` take `B`, re-read `R` under it and install the barrier, else give
/// `B` back at once and judge again. Construct it right after the lock is
/// taken, before discovery is first published: it keeps the legacy discovery
/// found then.
pub struct Gate {
    ownership: Arc<CoreOwnership>,
    record: BarrierRecord,
    discovery_path: PathBuf,
    discovery: Option<Vec<u8>>,
    procs: Box<dyn ProcessTable>,
    released: Vec<ProcessIdentity>,
    blocked: Option<(ProcessInfo, bool)>,
}

impl Gate {
    pub fn new(
        ownership: Arc<CoreOwnership>,
        discovery_path: PathBuf,
        record: BarrierRecord,
    ) -> io::Result<Self> {
        Self::with_table(ownership, discovery_path, record, Box::new(OsProcessTable))
    }

    pub(crate) fn with_table(
        ownership: Arc<CoreOwnership>,
        discovery_path: PathBuf,
        record: BarrierRecord,
        procs: Box<dyn ProcessTable>,
    ) -> io::Result<Self> {
        let mut gate = Self {
            ownership,
            record,
            discovery_path,
            discovery: None,
            procs,
            released: Vec::new(),
            blocked: None,
        };
        gate.refresh_discovery()?;
        Ok(gate)
    }

    /// Keeps the newest discovery that is not a 1.4.6+ core's.
    #[allow(
        clippy::disallowed_methods,
        reason = "the startup gate is synchronous and runs before any async worker exists"
    )]
    fn refresh_discovery(&mut self) -> io::Result<()> {
        match std::fs::read(&self.discovery_path) {
            Ok(bytes) if legacy_discovery(&bytes).is_some() => self.discovery = Some(bytes),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        Ok(())
    }

    /// The owner rows for `record`, judged without `B`.
    fn judge_owner(&mut self, record: Option<&[u8]>) -> io::Result<Option<Verdict>> {
        self.refresh_discovery()?;
        judge_owner(
            record,
            self.discovery.as_deref(),
            &*self.procs,
            &self.released,
        )
    }

    pub fn step(&mut self) -> Result<GateStep, GateError> {
        self.blocked = None;
        loop {
            let dir_watch = DirWatch::arm(self.ownership.data_dir())?;
            let claim = ClaimLock::read(self.ownership.data_dir())?;
            let verdict = match judge_claim(&claim, &*self.procs, &self.released)? {
                ClaimJudgement::Barrier => {
                    self.ownership.pin_barrier()?;
                    return Ok(GateStep::Clear);
                }
                ClaimJudgement::Blocked(verdict) => verdict,
                // A live 1.4.5 owner refreshes its heartbeat under B, so B is
                // touched only after a `clear` verdict judged without it.
                ClaimJudgement::Free(take) => {
                    let record = self.ownership.data_dir().read(RECORD_FILE)?;
                    if let Some(verdict) = self.judge_owner(record.as_deref())? {
                        verdict
                    } else {
                        barrier::hook(Step::Judged);
                        // Narrows the gap a 1.4.5 claim could land in before B is taken.
                        if self.ownership.data_dir().read(RECORD_FILE)? != record {
                            continue;
                        }
                        barrier::hook(Step::Linking);
                        match barrier::take(&self.ownership, take, record.as_deref(), &*self.procs)?
                        {
                            Taken::Held(held) => {
                                held.install(&self.record)?;
                                return Ok(GateStep::Clear);
                            }
                            Taken::Raced | Taken::RecordChanged => continue,
                            Taken::GuardHeld(pid) => match self.procs.query(pid)? {
                                Some(process) => Verdict::WaitClaim(process),
                                None => continue,
                            },
                        }
                    }
                }
            };
            let (kind, process, releasable, dir) = match verdict {
                Verdict::WaitExit { process, proven } => {
                    (BlockedKind::WaitExit, process, !proven, None)
                }
                Verdict::WaitClaim(process) => {
                    (BlockedKind::WaitClaim, process, false, Some(dir_watch))
                }
                Verdict::Undecidable(process) => (BlockedKind::Undecidable, process, true, None),
                Verdict::Unusable => return Err(GateError::ClaimLockUnusable),
            };
            // The process's exit always changes the facts; a process that already
            // exited sends the verdict around again.
            let exit = match ExitWatch::open(process.identity) {
                Ok(Some(exit)) => exit,
                Ok(None) => continue,
                // Runs, but this user may not wait on it: 1.4.5 takes such a pid
                // (EPERM) as live and does not claim (`T:pid-liveness.mjs:22-25`,
                // `T:daemon.mjs:577-583`). Neither does the core.
                Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                    self.blocked = Some((process.clone(), releasable));
                    return Err(GateError::ExitUnwatchable {
                        kind,
                        process,
                        releasable,
                    });
                }
                Err(error) => return Err(error.into()),
            };
            self.blocked = Some((process.clone(), releasable));
            return Ok(GateStep::Blocked(Blocked {
                kind,
                process,
                releasable,
                dir,
                exit,
            }));
        }
    }

    /// The `undecidable` decision `release{pid}` (LR §3.1), journaled in
    /// `migration/ownership-decisions.jsonl` before it takes effect. The next
    /// [`Gate::step`] treats that process identity as not an owner.
    pub fn release(&mut self, pid: u32) -> Result<ProcessInfo, ReleaseError> {
        let (process, releasable) = match &self.blocked {
            Some((process, releasable)) if process.identity.pid == pid => {
                (process.clone(), *releasable)
            }
            _ => return Err(ReleaseError::NotBlockedOn(pid)),
        };
        if !releasable {
            return Err(ReleaseError::NotReleasable(pid));
        }
        let entry = ReleaseEntry {
            at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as u64),
            decision: "release",
            instance_id: self.ownership.instance_id(),
            pid,
            process_start_ms: process.identity.start_ms,
            image: process
                .image
                .as_ref()
                .map(|image| image.to_string_lossy().into_owned()),
            command_line: process.command_line.as_deref(),
        };
        let line = serde_json::to_string(&entry).map_err(|error| ReleaseError::Io(error.into()))?;
        self.ownership
            .data_dir()
            .append_line(JOURNAL_DIR, JOURNAL_FILE, &line)
            .map_err(ReleaseError::Io)?;
        self.released.push(process.identity);
        self.blocked = None;
        Ok(process)
    }
}
