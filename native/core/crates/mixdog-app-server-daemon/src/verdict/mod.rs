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
use crate::barrier::Install;
use crate::barrier::InstallStep;
use crate::barrier::RECORD_FILE;
use crate::barrier::Take;
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

/// What one verdict run reads (`R`, the legacy discovery, `B`).
pub(crate) struct Facts {
    pub(crate) record: Option<Vec<u8>>,
    pub(crate) discovery: Option<Vec<u8>>,
    pub(crate) claim: ClaimLock,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Verdict {
    /// No prior owner can write. `None`: the barrier is already installed.
    Clear(Option<Take>),
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

/// LR §3.1. `released` are identities the user released; this core's own pid
/// is never a prior owner.
pub(crate) fn decide(
    facts: &Facts,
    procs: &dyn ProcessTable,
    released: &[ProcessIdentity],
) -> io::Result<Verdict> {
    let own_pid = u64::from(std::process::id());
    let running = |pid: u64| -> io::Result<Option<ProcessInfo>> {
        if pid == own_pid {
            return Ok(None);
        }
        Ok(procs
            .query(pid)?
            .filter(|info| !released.contains(&info.identity)))
    };

    let take = match &facts.claim {
        ClaimLock::Barrier => return Ok(Verdict::Clear(None)),
        ClaimLock::Held(owner) => {
            if let Some(pid) = owner.pid
                && let Some(info) = running(pid)?
            {
                // Started after it acquired B: not its writer, whose pid was reused.
                let reused = owner
                    .acquired_ms
                    .is_some_and(|ms| info.identity.start_ms > ms);
                return Ok(if reused {
                    Verdict::Undecidable(info)
                } else {
                    Verdict::WaitClaim(info)
                });
            }
            Take::DeadHolder(owner.bytes.clone())
        }
        ClaimLock::Absent => Take::Absent,
        ClaimLock::Dir { empty: true } => Take::EmptyDir,
        ClaimLock::Dir { empty: false } | ClaimLock::Other => return Ok(Verdict::Unusable),
    };

    if let Some((pid, liveness_port)) = facts.record.as_deref().and_then(record_owner) {
        let Some(info) = running(pid)? else {
            return Ok(Verdict::Clear(Some(take)));
        };
        return Ok(match liveness_port {
            // The writer binds its liveness listener before it writes the record and
            // closes it only by exiting; sockets are not inherited.
            Some(port) if procs.listens(info.identity.pid, port)? => Verdict::WaitExit {
                process: info,
                proven: true,
            },
            Some(_) => Verdict::Clear(Some(take)),
            None => Verdict::Undecidable(info),
        });
    }

    if let Some((pid, session_port)) = facts.discovery.as_deref().and_then(legacy_discovery)
        && let Some(info) = running(pid)?
    {
        let proven = match session_port {
            Some(port) => procs.listens(info.identity.pid, port)?,
            None => false,
        };
        return Ok(Verdict::WaitExit {
            process: info,
            proven,
        });
    }
    Ok(Verdict::Clear(Some(take)))
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
    exit: Option<ExitWatch>,
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
        wait::wait(interrupt, self.dir.as_ref(), self.exit.as_ref())
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

/// LR §3 steps 3–4 under the OS lock: verdict, then barrier installation,
/// repeated until clear. Construct it right after the lock is taken, before
/// discovery is first published: it keeps the legacy discovery found then.
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

    fn facts(&mut self) -> io::Result<Facts> {
        self.refresh_discovery()?;
        let dir = self.ownership.data_dir();
        Ok(Facts {
            record: dir.read(RECORD_FILE)?,
            discovery: self.discovery.clone(),
            claim: ClaimLock::read(dir)?,
        })
    }

    pub fn step(&mut self) -> Result<GateStep, GateError> {
        self.step_observed(&mut |_| {})
    }

    /// [`Gate::step`] with every completed installation step reported.
    pub(crate) fn step_observed(
        &mut self,
        observe: &mut dyn FnMut(InstallStep),
    ) -> Result<GateStep, GateError> {
        self.blocked = None;
        loop {
            let dir_watch = DirWatch::arm(self.ownership.data_dir())?;
            let facts = self.facts()?;
            let (kind, process, releasable, dir) =
                match decide(&facts, &*self.procs, &self.released)? {
                    Verdict::Clear(None) => {
                        self.ownership.pin_barrier()?;
                        return Ok(GateStep::Clear);
                    }
                    Verdict::Clear(Some(take)) => {
                        let installed = barrier::install(
                            &self.ownership,
                            take,
                            facts.record.as_deref(),
                            &self.record,
                            &*self.procs,
                            observe,
                        )?;
                        match installed {
                            Install::Done => return Ok(GateStep::Clear),
                            Install::Raced => continue,
                            Install::GuardHeld(pid) => {
                                let Some(process) = self.procs.query(pid)? else {
                                    continue;
                                };
                                (BlockedKind::WaitClaim, process, false, Some(dir_watch))
                            }
                        }
                    }
                    Verdict::WaitExit { process, proven } => {
                        (BlockedKind::WaitExit, process, !proven, None)
                    }
                    Verdict::WaitClaim(process) => {
                        (BlockedKind::WaitClaim, process, false, Some(dir_watch))
                    }
                    Verdict::Undecidable(process) => {
                        (BlockedKind::Undecidable, process, true, None)
                    }
                    Verdict::Unusable => return Err(GateError::ClaimLockUnusable),
                };
            // The process's exit always changes the facts; a process that already
            // exited sends the verdict around again.
            let exit = match ExitWatch::open(process.identity) {
                Ok(Some(exit)) => Some(exit),
                Ok(None) => continue,
                // Exists but may not be waited on by this user (start time unknown).
                Err(error) if error.kind() == io::ErrorKind::PermissionDenied => None,
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
