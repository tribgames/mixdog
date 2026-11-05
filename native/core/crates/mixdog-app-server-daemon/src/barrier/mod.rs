//! The claim barrier (LR §2.2, §3.2): exclusion of 1.4.5 and older binaries.
//!
//! `daemon-owner.json.claim.lock` (`B`) permanently holds the 1.4.5 lock-file
//! format with the pid `4294967296`. 1.4.5's `ownerIsLive` calls
//! `process.kill(4294967296, 0)`, which throws `ERR_INVALID_ARG_TYPE` (not
//! `ESRCH`), so every 1.4.5 claim, refresh and handoff ends `BUSY` on every host
//! at every time. `daemon-owner.json` is written once beside it with a text pid
//! that every 1.4.5 reader treats as "not alive", and whose text is the update
//! message a 1.4.5 daemon start prints. No Mixdog code deletes `B`, the record
//! or the lock file: deleting `B` would re-admit 1.4.5 on that data dir.

#[cfg(test)]
mod tests;

use std::io;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use mixdog_core_api::domain::ownership::Ownership;
use serde::Serialize;

use crate::ownership::CoreOwnership;
use crate::ownership::DataDir;
use crate::ownership::EntryKind;
use crate::verdict::ProcessTable;

/// The 1.4.5 owner record (`R`).
pub const RECORD_FILE: &str = "daemon-owner.json";
/// The 1.4.5 claim lock (`B`).
pub const CLAIM_LOCK_FILE: &str = "daemon-owner.json.claim.lock";
/// 1.4.5's reclaim guard for `B` (`file-lock.mjs` `tryAcquireReclaimGuard`).
const RECLAIM_GUARD_FILE: &str = "daemon-owner.json.claim.lock.reclaim";
/// Outside 1.4.5's staged-file sweep pattern `^(reclaim\.)?\d+\.[0-9a-f]{16}\.tmp$`.
const BARRIER_STAGING_FILE: &str = "daemon-owner.json.claim.lock.v2-staging";
const RECORD_STAGING_FILE: &str = "daemon-owner.json.v2-staging";

/// Finite, positive, and not a 32-bit integer: `process.kill` rejects it with
/// `ERR_INVALID_ARG_TYPE`, which 1.4.5 judges "live" forever.
pub const BARRIER_PID: &str = "4294967296";
pub const BARRIER_TOKEN_PREFIX: &str = "mixdog-barrier-v1:";
/// Token of the ordinary content a core holds `B` with during installation.
const CORE_TOKEN_PREFIX: &str = "mixdog-core:";

/// What `B` holds, read the way 1.4.5's `readLockOwner` reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClaimLock {
    Absent,
    /// The permanent barrier (first token `4294967296`, third `mixdog-barrier-v1:…`).
    Barrier,
    /// A 1.4.5-format lock file (a holder mid-claim, or one a crash left).
    Held(LockOwner),
    /// A bare directory, the claim lock of versions before 1.4.x.
    Dir {
        empty: bool,
    },
    /// A symlink or special file; nothing Mixdog ever wrote.
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LockOwner {
    /// `Number.parseInt` of the first token when finite and positive (or the
    /// `pid` of the v1.4.2 JSON form); `None` names no holder.
    pub pid: Option<u64>,
    /// The acquisition time in Unix ms (second token), when present.
    pub acquired_ms: Option<u64>,
    pub bytes: Vec<u8>,
}

impl ClaimLock {
    pub fn read(dir: &DataDir) -> io::Result<Self> {
        Ok(match dir.kind(CLAIM_LOCK_FILE)? {
            None => Self::Absent,
            Some(EntryKind::Dir) => Self::Dir {
                empty: dir.is_empty_dir(CLAIM_LOCK_FILE)?,
            },
            Some(EntryKind::Other) => Self::Other,
            Some(EntryKind::File) => match dir.read(CLAIM_LOCK_FILE)? {
                None => Self::Absent,
                Some(bytes) => Self::parse(bytes),
            },
        })
    }

    pub fn parse(bytes: Vec<u8>) -> Self {
        let owner = LockOwner::parse(bytes);
        let text = String::from_utf8_lossy(&owner.bytes);
        let parts: Vec<&str> = text.split_whitespace().collect();
        if parts.first() == Some(&BARRIER_PID)
            && parts
                .get(2)
                .is_some_and(|token| token.starts_with(BARRIER_TOKEN_PREFIX))
        {
            return Self::Barrier;
        }
        Self::Held(owner)
    }
}

impl LockOwner {
    pub fn parse(bytes: Vec<u8>) -> Self {
        let text = String::from_utf8_lossy(&bytes);
        let text = text.trim();
        let (pid, acquired_ms) = if text.starts_with('{') {
            let pid = serde_json::from_str::<serde_json::Value>(text)
                .ok()
                .and_then(|value| value.get("pid").and_then(serde_json::Value::as_u64))
                .filter(|pid| *pid > 0);
            (pid, None)
        } else {
            let mut parts = text.split_whitespace();
            let pid = parts.next().and_then(js_parse_int);
            (pid, parts.next().and_then(|ms| ms.parse().ok()))
        };
        Self {
            pid,
            acquired_ms,
            bytes,
        }
    }
}

/// `Number.parseInt(token, 10)` restricted to finite positive values; digits
/// past `u64` saturate (such a pid names no process either way).
fn js_parse_int(token: &str) -> Option<u64> {
    let (negative, digits) = match token.as_bytes().first() {
        Some(b'-') => (true, &token[1..]),
        Some(b'+') => (false, &token[1..]),
        _ => (false, token),
    };
    let end = digits
        .bytes()
        .position(|b| !b.is_ascii_digit())
        .unwrap_or(digits.len());
    if end == 0 {
        return None;
    }
    let value = digits[..end].bytes().fold(0u64, |acc, b| {
        acc.saturating_mul(10).saturating_add(u64::from(b - b'0'))
    });
    (!negative && value > 0).then_some(value)
}

/// The barrier record's content (LR §2.2), written once with the barrier.
pub struct BarrierRecord {
    /// The installing core's version.
    pub version: String,
    /// The update message 1.4.5 shows as the owner's pid ([copy]).
    pub update_text: String,
}

impl BarrierRecord {
    pub fn to_bytes(&self) -> Vec<u8> {
        #[derive(Serialize)]
        struct Record<'a> {
            kind: &'static str,
            pid: &'a str,
            protocol: u32,
            version: &'a str,
        }
        let record = Record {
            kind: "mixdog-daemon",
            pid: &self.update_text,
            protocol: 2,
            version: &self.version,
        };
        let mut bytes = serde_json::to_vec(&record).expect("record serializes");
        bytes.push(b'\n');
        bytes
    }
}

pub fn barrier_bytes(instance_id: &str) -> Vec<u8> {
    format!("{BARRIER_PID} 0 {BARRIER_TOKEN_PREFIX}{instance_id}\n").into_bytes()
}

/// The steps of LR §3.2, reported after each one completes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallStep {
    /// Step 1: `B` holds this core's ordinary 1.4.5-format content.
    ClaimLockTaken,
    /// Step 2: the record still holds the bytes the verdict judged.
    RecordRechecked,
    /// Step 3: the barrier record is durable.
    RecordWritten,
    /// Step 4: `B` is the barrier, durable and pinned.
    BarrierInstalled,
}

/// How `B` is taken in step 1, as the verdict found it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Take {
    Absent,
    /// `B` names a dead holder (or none); these are its exact bytes.
    DeadHolder(Vec<u8>),
    EmptyDir,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Install {
    Done,
    /// A 1.4.5 contender changed `B` or the record: back to the verdict.
    Raced,
    /// A live process holds the reclaim guard (a 1.4.5 reclaim in progress).
    GuardHeld(u64),
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn hex16() -> String {
    format!("{:016x}", rand::random::<u64>())
}

/// A name 1.4.5's staged-file sweep recognises as this live pid's.
fn staged_name(base: &str) -> String {
    format!("{base}.{}.{}.tmp", std::process::id(), hex16())
}

/// Publishes `content` at `target` the 1.4.5 way: a staged file hard-linked
/// onto the target, so the target never exists without its owner. `false`
/// when the target exists.
fn publish_linked(dir: &DataDir, target: &str, content: &[u8]) -> io::Result<bool> {
    let staged = staged_name(target);
    dir.create_new(&staged, content)?;
    let linked = dir.link(&staged, target);
    dir.remove_if_exists(&staged)?;
    match linked {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(error),
    }
}

enum Guard {
    Held(Vec<u8>),
    Busy(u64),
}

/// 1.4.5's reclaim guard protocol (`file-lock.mjs:217-240`). A guard whose
/// owner is not running is revoked by moving it aside; the moved file's unique
/// token proves it is the one inspected, else it is linked back.
fn take_guard(dir: &DataDir, procs: &dyn ProcessTable) -> io::Result<Guard> {
    let token = format!("{} {} {}\n", std::process::id(), now_ms(), hex16()).into_bytes();
    loop {
        if publish_linked(dir, RECLAIM_GUARD_FILE, &token)? {
            return Ok(Guard::Held(token));
        }
        let Some(inspected) = dir.read(RECLAIM_GUARD_FILE)? else {
            continue;
        };
        if let Some(pid) = LockOwner::parse(inspected.clone()).pid
            && procs.query(pid)?.is_some()
        {
            return Ok(Guard::Busy(pid));
        }
        let tomb = format!(
            "{RECLAIM_GUARD_FILE}.{}.{}.revoked",
            std::process::id(),
            hex16()
        );
        match dir.rename(RECLAIM_GUARD_FILE, &tomb) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        }
        if dir.read(&tomb)?.as_deref() != Some(&inspected[..]) {
            match dir.link(&tomb, RECLAIM_GUARD_FILE) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
        dir.remove_if_exists(&tomb)?;
    }
}

/// Unlinks `name` only while it still holds `content` (`releaseLock`).
fn release_own(dir: &DataDir, name: &str, content: &[u8]) -> io::Result<()> {
    if dir.read(name)?.as_deref() == Some(content) {
        dir.remove_if_exists(name)?;
    }
    Ok(())
}

/// Step 1 for a dead holder: under the guard, `B` still holding the judged
/// bytes is rename-replaced with this core's content, so it never disappears.
fn reclaim(
    dir: &DataDir,
    judged: &[u8],
    content: &[u8],
    procs: &dyn ProcessTable,
) -> io::Result<Install> {
    let token = match take_guard(dir, procs)? {
        Guard::Held(token) => token,
        Guard::Busy(pid) => return Ok(Install::GuardHeld(pid)),
    };
    let replaced = (|| {
        if dir.read(CLAIM_LOCK_FILE)?.as_deref() != Some(judged) {
            return Ok(false);
        }
        let staged = staged_name(CLAIM_LOCK_FILE);
        dir.create_new(&staged, content)?;
        if let Err(error) = dir.rename(&staged, CLAIM_LOCK_FILE) {
            dir.remove_if_exists(&staged)?;
            return Err(error);
        }
        Ok(true)
    })();
    release_own(dir, RECLAIM_GUARD_FILE, &token)?;
    Ok(if replaced? {
        Install::Done
    } else {
        Install::Raced
    })
}

/// Replaces `target` with `content` durably: staged, synced, renamed, directory synced.
fn publish_durable(dir: &DataDir, staging: &str, target: &str, content: &[u8]) -> io::Result<()> {
    dir.remove_if_exists(staging)?;
    dir.create_new(staging, content)?;
    dir.rename(staging, target)?;
    dir.sync()
}

/// LR §3.2, under the OS lock after a `clear` verdict. `judged_record` is the
/// record as the verdict read it; `observe` sees each completed step.
pub(crate) fn install(
    own: &CoreOwnership,
    take: Take,
    judged_record: Option<&[u8]>,
    record: &BarrierRecord,
    procs: &dyn ProcessTable,
    observe: &mut dyn FnMut(InstallStep),
) -> io::Result<Install> {
    let dir = own.data_dir();
    let content = format!(
        "{} {} {CORE_TOKEN_PREFIX}{}\n",
        std::process::id(),
        now_ms(),
        own.instance_id()
    );
    let content = content.as_bytes();

    // 1. Take B in 1.4.5 terms with ordinary content.
    let taken = match take {
        Take::Absent => publish_linked(dir, CLAIM_LOCK_FILE, content)?,
        Take::EmptyDir => match dir.rmdir(CLAIM_LOCK_FILE) {
            Ok(()) => publish_linked(dir, CLAIM_LOCK_FILE, content)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(error) => return Err(error),
        },
        Take::DeadHolder(judged) => match reclaim(dir, &judged, content, procs)? {
            Install::Done => true,
            other => return Ok(other),
        },
    };
    if !taken {
        return Ok(Install::Raced);
    }
    observe(InstallStep::ClaimLockTaken);

    // 2. A 1.4.5 claim that landed between the verdict and step 1 changed R.
    if dir.read(RECORD_FILE)?.as_deref() != judged_record {
        release_own(dir, CLAIM_LOCK_FILE, content)?;
        return Ok(Install::Raced);
    }
    observe(InstallStep::RecordRechecked);

    // 3. The barrier record.
    publish_durable(dir, RECORD_STAGING_FILE, RECORD_FILE, &record.to_bytes())?;
    observe(InstallStep::RecordWritten);

    // 4. B becomes the barrier by atomic rename-replace; it never disappears.
    publish_durable(
        dir,
        BARRIER_STAGING_FILE,
        CLAIM_LOCK_FILE,
        &barrier_bytes(own.instance_id()),
    )?;
    own.pin_barrier()?;
    observe(InstallStep::BarrierInstalled);
    Ok(Install::Done)
}
