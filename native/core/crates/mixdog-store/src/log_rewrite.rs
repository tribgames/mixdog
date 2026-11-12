//! A session's log rewritten with some records replaced (FORMAT.md §13): a value marked
//! sensitive after records holding it were written leaves no readable copy in the log, in the
//! blobs its records moved out of line, or (through the caller's index step) in the index.
//!
//! The rewrite keeps every frame's ordinal and file; only the replaced records' payloads and
//! the positions the checkpoints carry change. Its parts live in `<D>/sessions-rewrite/<id>/`:
//! `intent` (the replacement payloads by ordinal, none holding a marked value), `building/` and
//! `new/` (the rewritten log, before and after it is whole), `old/` (the session's former
//! folder). The session folder is replaced as one unit, so no reader of `sessions/<id>/` (this
//! process, a rebuild, an older build) ever lists files of two generations.
//!
//! | Step | Kill before it completes leaves | The next start (before any session opens) | A reader in this process |
//! |---|---|---|---|
//! | 1 plan: replacements computed, their blobs published | the old log; maybe unreferenced redacted blobs (age GC) | removes the rewrite folder; the marks died with the process, as Node's | reads the old log |
//! | 2 `intent` published (the rewrite is decided) | old log + intent | builds, swaps, rebuilds the rows, deletes, clears | reads the old log |
//! | 3 `building/` written, renamed to `new/` | old log + intent (+ partial `building/`) | drops `building/`/`new/`, builds again from the log and the intent | reads the old log |
//! | 4 `sessions/<id>` renamed to `old/` | intent + `new/` + `old/`, no session folder | renames `new/` to `sessions/<id>` (no `new/`: `old/` back, then step 3) | waits: the store's read gate is held from here to step 8 |
//! | 5 `new/` renamed to `sessions/<id>` | new log + intent + `old/` | rebuilds the rows, deletes, clears | waits |
//! | 6 index rows rebuilt from the new log, WAL truncated; superseded blobs no record names deleted | new log + intent + `old/` | the same again (each part is idempotent) | waits |
//! | 7 `intent` removed | new log + `old/` | removes the rewrite folder | waits |
//! | 8 rewrite folder removed | new log | nothing | reads the new log and the new rows |
//!
//! An older build knows none of this: it sees the old log whole, the new log whole, or (a kill
//! between steps 4 and 5) no folder for the session, never a mix; this build's next start puts
//! the session back before anything reads it.
//!
//! The memory database's part (`mixdog-services` `session_search/db.rs` `SessionSearchDb::replace`
//! and `scrub`), run by the session's search queue after the same mark:
//!
//! | Step | Kill before it completes leaves | The next start (`SessionSearchDb::open`, before the schema is used) | A reader of the search rows |
//! |---|---|---|---|
//! | M1 the rows holding the value replaced and the owed scrub recorded (`session_search.scrub`), one transaction | the old rows (the marks died with the process, as Node's) | nothing | the old rows |
//! | M2 `VACUUM FULL session_search.messages` (table, TOAST and indexes written anew from the live rows) | the new rows; the old row versions in the table files and the WAL; the scrub row | M2-M4 | the new rows (waits on the table lock while M2 runs) |
//! | M3 `pg_switch_wal()`, `CHECKPOINT`: the segments before the new redo point are removed (`wal_recycle = off`) | the old row versions in the WAL only; the scrub row | M2-M4 (M2 again is cheap) | the new rows |
//! | M4 the scrub row deleted | nothing of the value | nothing | the new rows |
//!
//! The memory transcript's part, PENDING on branch `gaps-session-rest` (the transcript writer is not on this branch yet):
//!
//! | Step | Kill before it completes leaves | The next start | A reader |
//! |---|---|---|---|
//! | T1 every transcript file of the session rewritten line for line, the watcher's read position moved to the same line of the new file: `mixdog-core-session` `TranscriptFiles::redact_session(&self, thread: &str)` (`session/transcript_writer.rs`) | owed: lands with that branch, with its own kill behaviour | owed | owed |
//!
//! Open with T1 (its owner's branch): the search rows the watcher ingested from the transcript are replaced by M1 only if
//! they carry the session's id, and the read position must not make the watcher ingest the pre-mark lines again.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "log file I/O runs only in lane jobs (lane proof arguments)")]

use std::collections::BTreeSet;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;

use mixdog_rt::InLane;

use crate::blobs::BlobPin;
use crate::blobs::BlobStore;
use crate::encode::encode_record;
use crate::fold::resolve_slot;
use crate::framing;
use crate::fsio;
use crate::fsio::IoError;
use crate::fsio::IoOp;
use crate::fsio::WriteLane;
use crate::fsio::err;
use crate::log::ForwardEnd;
use crate::log::WriterIo;
use crate::log::list_logs;
use crate::log::log_name;
use crate::log::read_forward_unlaned;
use crate::schema::blob::BodyBlob;
use crate::schema::blob::Slot;
use crate::schema::bounded::Digest;
use crate::schema::checkpoint::CheckpointState;
use crate::schema::checkpoint::FramePos;
use crate::schema::frame::ORDINAL_DIGITS;
use crate::schema::record::CheckpointRecord;
use crate::schema::record::Record;
use crate::schema::record::Refs;

/// `<D>/sessions-rewrite/<id>/`: the parts of a session's unfinished log rewrite.
pub const REWRITE_DIR: &str = "sessions-rewrite";
/// The replacement payloads; published, the rewrite is decided.
const INTENT_FILE: &str = "intent";
const BUILDING_DIR: &str = "building";
const NEW_DIR: &str = "new";
const OLD_DIR: &str = "old";

#[derive(Debug, thiserror::Error)]
pub enum RewriteError {
    #[error(transparent)]
    Io(#[from] IoError),
    #[error("session log not rewritable: {0}")]
    Log(String),
    /// The index step failed; the next attempt or start does it again.
    #[error("index: {0}")]
    Index(String),
    /// A test stopped the rewrite at a step, leaving what a kill there leaves.
    #[cfg(test)]
    #[error("stopped at {0:?}")]
    Stopped(Step),
}

/// The boundaries of a rewrite (the module's step table), each reported before it is taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Intent,
    /// Writing rewritten log file `n` into `building/`.
    Build(u32),
    /// `building/` whole; renaming it to `new/`.
    Built,
    MoveOld,
    MoveNew,
    Index,
    DropIntent,
    DropFolder,
}

type Hook<'a> = &'a mut dyn FnMut(Step) -> Result<(), RewriteError>;

/// The index step: the session's rows rebuilt from its new log, then each digest no record names any more deleted.
pub type IndexStep<'a> = &'a mut dyn FnMut(Vec<Digest>) -> Result<(), String>;

fn stage_dir(data: &Path, session: &str) -> PathBuf {
    data.join(REWRITE_DIR).join(session)
}

fn session_dir(data: &Path, session: &str) -> PathBuf {
    data.join("sessions").join(session)
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Intent {
    v: u32,
    /// (ordinal, the record payload that replaces the frame's).
    frames: Vec<(u64, String)>,
}

/// Where a session's rewrite stands, read from what is on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pending {
    /// No rewrite folder.
    Clean,
    /// A folder with no intent (a plan cut short, or a rewrite past step 7): removed.
    Leftover,
    /// Steps 3-4 next.
    Planned,
    /// Step 5 next.
    Moved,
    /// Step 6 next.
    Swapped,
}

pub fn pending<L: WriteLane>(_lane: &InLane<L>, data: &Path, session: &str) -> Pending {
    pending_unlaned(data, session)
}

fn pending_unlaned(data: &Path, session: &str) -> Pending {
    let root = stage_dir(data, session);
    if !root.is_dir() {
        return Pending::Clean;
    }
    if !root.join(INTENT_FILE).is_file() {
        return Pending::Leftover;
    }
    match (root.join(OLD_DIR).is_dir(), session_dir(data, session).is_dir()) {
        (false, true) => Pending::Planned,
        (false, false) => Pending::Leftover,
        (true, false) => Pending::Moved,
        (true, true) => Pending::Swapped,
    }
}

/// Every slot of `record` (all kinds: the match has no wildcard, so a new kind is a decision), read back inline when
/// out of line; the slot's own blob leaves the record's `refs` with it (the encode names the blob the new body needs).
fn inline(record: &Record, blobs: &BlobStore) -> Result<Record, String> {
    let mut resolve = |b: &BodyBlob| blobs.read_unlaned(&b.descriptor().digest).map_err(|e| e.to_string());
    fn own<T: serde::de::DeserializeOwned + Clone>(
        slot: &mut Slot<T>,
        refs: Option<&mut Refs>,
        resolve: &mut crate::fold::ResolveBody<'_>,
    ) -> Result<(), String> {
        if let Slot::Blob(blob) = slot {
            let digest = blob.descriptor().digest.clone();
            *slot = Slot::Inline(resolve_slot(slot, resolve)?);
            if let Some(refs) = refs {
                *refs = Refs::try_from(refs.as_slice().iter().filter(|d| **d != digest).cloned().collect::<Vec<_>>())?;
            }
        }
        Ok(())
    }
    let mut out = record.clone();
    match &mut out {
        Record::Session(r) => own(&mut r.header, None, &mut resolve)?,
        Record::Meta(r) => own(&mut r.change, None, &mut resolve)?,
        Record::Item(r) => {
            own(&mut r.body, Some(&mut r.refs), &mut resolve)?;
            if let Some(prompt) = &mut r.prompt {
                own(prompt, Some(&mut r.refs), &mut resolve)?;
            }
        }
        Record::Amend(r) => own(&mut r.body, Some(&mut r.refs), &mut resolve)?,
        Record::Compacted(r) => own(&mut r.replacement, None, &mut resolve)?,
        Record::Checkpoint(r) => own(&mut r.state, None, &mut resolve)?,
        Record::Run(r) => {
            if let Some(detail) = &mut r.detail {
                own(detail, None, &mut resolve)?;
            }
        }
        Record::Approval(r) => {
            if let Some(body) = &mut r.body {
                own(body, None, &mut resolve)?;
            }
        }
        Record::Queue(r) => {
            if let Some(entry) = &mut r.entry {
                own(entry, None, &mut resolve)?;
            }
        }
        Record::Op(r) => {
            if let Some(detail) = &mut r.detail {
                own(detail, None, &mut resolve)?;
            }
        }
        Record::ModelSwitch(r) => own(&mut r.entry, None, &mut resolve)?,
        Record::Draft(r) => own(&mut r.body, None, &mut resolve)?,
        Record::Rewind(_) => {}
    }
    Ok(out)
}

/// The digests of `record`'s own out-of-line slots (every kind; no wildcard).
fn slot_digests(record: &Record, out: &mut BTreeSet<Digest>) {
    fn one<T>(slot: &Slot<T>, out: &mut BTreeSet<Digest>) {
        if let Slot::Blob(blob) = slot {
            out.insert(blob.descriptor().digest.clone());
        }
    }
    match record {
        Record::Session(r) => one(&r.header, out),
        Record::Meta(r) => one(&r.change, out),
        Record::Item(r) => {
            one(&r.body, out);
            r.prompt.iter().for_each(|p| one(p, out));
        }
        Record::Amend(r) => one(&r.body, out),
        Record::Compacted(r) => one(&r.replacement, out),
        Record::Checkpoint(r) => one(&r.state, out),
        Record::Run(r) => r.detail.iter().for_each(|s| one(s, out)),
        Record::Approval(r) => r.body.iter().for_each(|s| one(s, out)),
        Record::Queue(r) => r.entry.iter().for_each(|s| one(s, out)),
        Record::Op(r) => r.detail.iter().for_each(|s| one(s, out)),
        Record::ModelSwitch(r) => one(&r.entry, out),
        Record::Draft(r) => one(&r.body, out),
        Record::Rewind(_) => {}
    }
}

/// One log file and its committed frames (a torn tail, unacknowledged, ends the file).
struct LogFile {
    file_no: u32,
    bytes: Vec<u8>,
    frames: Vec<(Record, FramePos, u64)>,
}

fn read_log(dir: &Path) -> Result<Vec<LogFile>, RewriteError> {
    let mut out = Vec::new();
    for file_no in list_logs(dir).map_err(|e| RewriteError::Log(e.to_string()))? {
        let path = dir.join(log_name(file_no));
        let bytes = std::fs::read(&path).map_err(err(IoOp::Read, &path))?;
        let first = std::str::from_utf8(bytes.get(..ORDINAL_DIGITS).unwrap_or_default())
            .ok()
            .and_then(|digits| u64::from_str_radix(digits, 16).ok())
            .ok_or_else(|| RewriteError::Log(format!("{}: no frame header", path.display())))?;
        let mut from = FramePos { ordinal: first, file_no, offset: 0 };
        let mut frames = Vec::new();
        loop {
            let read = read_forward_unlaned(dir, from, bytes.len() as u64).map_err(|e| RewriteError::Log(e.to_string()))?;
            frames.extend(read.frames);
            match read.next {
                ForwardEnd::More(next) if next.file_no == file_no => from = next,
                ForwardEnd::More(_) | ForwardEnd::Done { .. } => break,
                ForwardEnd::Damaged(damage) => return Err(RewriteError::Log(format!("damaged at {damage:?}"))),
            }
        }
        out.push(LogFile { file_no, bytes, frames });
    }
    Ok(out)
}

/// The checkpoint's frame positions where the rewritten frames are; `None` when none moved.
fn moved_state(state: &CheckpointState, moved: &HashMap<u64, FramePos>) -> Option<CheckpointState> {
    let at = |pos: FramePos| moved.get(&pos.ordinal).copied().unwrap_or(pos);
    let mut next = state.clone();
    next.context = next.context.map(at);
    for run in &mut next.runs {
        run.started = at(run.started);
    }
    for approval in &mut next.approvals {
        approval.requested = at(approval.requested);
    }
    for entry in &mut next.queue {
        entry.enqueued = at(entry.enqueued);
        entry.updated = entry.updated.map(at);
    }
    (next != *state).then_some(next)
}

fn log_error(e: impl std::fmt::Display) -> RewriteError {
    RewriteError::Log(e.to_string())
}

/// Steps 1-2: every committed record of `session`'s log through `replace` (its slots inline; `None` keeps it), the
/// replacements' blobs published, then the intent. `None` when no record changes: nothing is written. The pins keep
/// the new blobs from GC until the index names them.
pub fn plan<L: WriteLane>(
    _lane: &InLane<L>,
    data: &Path,
    session: &str,
    io: &dyn WriterIo,
    blobs: &BlobStore,
    replace: &mut dyn FnMut(&Record) -> Option<Record>,
) -> Result<Option<Vec<BlobPin>>, RewriteError> {
    plan_with(data, session, io, blobs, replace, &mut |_| Ok(()))
}

fn plan_with(
    data: &Path,
    session: &str,
    io: &dyn WriterIo,
    blobs: &BlobStore,
    replace: &mut dyn FnMut(&Record) -> Option<Record>,
    hook: Hook<'_>,
) -> Result<Option<Vec<BlobPin>>, RewriteError> {
    let mut frames = Vec::new();
    let mut pins = Vec::new();
    for file in read_log(&session_dir(data, session))? {
        for (record, pos, _) in &file.frames {
            let Some(next) = replace(&inline(record, blobs).map_err(RewriteError::Log)?) else { continue };
            let encoded = encode_record(next).map_err(log_error)?;
            for blob in encoded.blobs() {
                pins.push(blobs.put_unlaned(&blob.bytes, |p, b| io.publish(p, b)).map_err(log_error)?);
            }
            frames.push((pos.ordinal, String::from_utf8(encoded.payload().to_vec()).map_err(log_error)?));
        }
    }
    if frames.is_empty() {
        return Ok(None);
    }
    hook(Step::Intent)?;
    let intent = serde_json::to_vec(&Intent { v: 1, frames }).map_err(log_error)?;
    fsio::publish_file_unlaned(&stage_dir(data, session).join(INTENT_FILE), &intent)?;
    Ok(Some(pins))
}

/// Step 3: the session's log as it is now, each frame the intent names replaced and every checkpoint's positions
/// where the frames are in the new files, written to `building/` and renamed `new/` once whole.
fn build_with(data: &Path, session: &str, io: &dyn WriterIo, blobs: &BlobStore, hook: Hook<'_>) -> Result<(), RewriteError> {
    let root = stage_dir(data, session);
    let intent_path = root.join(INTENT_FILE);
    let intent: Intent =
        serde_json::from_slice(&std::fs::read(&intent_path).map_err(err(IoOp::Read, &intent_path))?).map_err(log_error)?;
    let replacements: HashMap<u64, String> = intent.frames.into_iter().collect();
    let (building, new) = (root.join(BUILDING_DIR), root.join(NEW_DIR));
    remove_dir(&building)?;
    remove_dir(&new)?;
    let mut moved: HashMap<u64, FramePos> = HashMap::new();
    // The checkpoints' blobs, published before the files naming them; age keeps them from GC.
    let mut pins = Vec::new();
    for file in read_log(&session_dir(data, session))? {
        let mut out = Vec::with_capacity(file.bytes.len());
        for (record, pos, frame_len) in &file.frames {
            let offset = out.len() as u64;
            let mut payload = replacements.get(&pos.ordinal).map(|p| p.as_bytes().to_vec());
            let replaced = payload.as_deref().map(serde_json::from_slice::<Record>).transpose().map_err(log_error)?;
            if let Record::Checkpoint(checkpoint) = replaced.as_ref().unwrap_or(record) {
                let mut resolve = |b: &BodyBlob| blobs.read_unlaned(&b.descriptor().digest).map_err(|e| e.to_string());
                let state: CheckpointState = resolve_slot(&checkpoint.state, &mut resolve).map_err(RewriteError::Log)?;
                if let Some(state) = moved_state(&state, &moved) {
                    let encoded = encode_record(Record::Checkpoint(CheckpointRecord { state: Slot::Inline(state) })).map_err(log_error)?;
                    for blob in encoded.blobs() {
                        pins.push(blobs.put_unlaned(&blob.bytes, |p, b| io.publish(p, b)).map_err(log_error)?);
                    }
                    payload = Some(encoded.payload().to_vec());
                }
            }
            match payload {
                Some(payload) => framing::encode_into(&mut out, pos.ordinal, &payload),
                None => out.extend_from_slice(&file.bytes[pos.offset as usize..(pos.offset + frame_len) as usize]),
            }
            moved.insert(pos.ordinal, FramePos { ordinal: pos.ordinal, file_no: file.file_no, offset });
        }
        hook(Step::Build(file.file_no))?;
        io.publish(&building.join(log_name(file.file_no)), &out)?;
    }
    hook(Step::Built)?;
    fsio::durable_rename(&building, &new)?;
    Ok(())
}

/// Steps 4-5: the session's folder moved to `old/`, then `new/` put in its place.
fn swap_with(data: &Path, session: &str, hook: Hook<'_>) -> Result<(), RewriteError> {
    let root = stage_dir(data, session);
    hook(Step::MoveOld)?;
    fsio::durable_rename(&session_dir(data, session), &root.join(OLD_DIR))?;
    move_new(data, session, hook)
}

fn move_new(data: &Path, session: &str, hook: Hook<'_>) -> Result<(), RewriteError> {
    hook(Step::MoveNew)?;
    fsio::durable_rename(&stage_dir(data, session).join(NEW_DIR), &session_dir(data, session))?;
    Ok(())
}

/// The out-of-line slot blobs the old log names and the new one does not: what the rewrite took a value out of.
fn superseded(data: &Path, session: &str) -> Result<Vec<Digest>, RewriteError> {
    let digests = |dir: &Path| -> Result<BTreeSet<Digest>, RewriteError> {
        let mut out = BTreeSet::new();
        for file in read_log(dir)? {
            file.frames.iter().for_each(|(record, _, _)| slot_digests(record, &mut out));
        }
        Ok(out)
    };
    let kept = digests(&session_dir(data, session))?;
    Ok(digests(&stage_dir(data, session).join(OLD_DIR))?.difference(&kept).cloned().collect())
}

/// Steps 6-8 over a session whose new log is in place.
fn finish_with(data: &Path, session: &str, index: IndexStep<'_>, hook: Hook<'_>) -> Result<(), RewriteError> {
    let root = stage_dir(data, session);
    let superseded = superseded(data, session)?;
    hook(Step::Index)?;
    index(superseded).map_err(RewriteError::Index)?;
    hook(Step::DropIntent)?;
    let intent = root.join(INTENT_FILE);
    std::fs::remove_file(&intent).map_err(err(IoOp::Remove, &intent))?;
    fsio::sync_dir(&root)?;
    hook(Step::DropFolder)?;
    remove_dir(&root)?;
    Ok(())
}

/// Steps 3-8 from wherever the session's rewrite stands (a no-op when there is none). The caller keeps every reader of
/// the session's log and index rows out meanwhile and holds no handle on its log files.
pub fn settle<L: WriteLane>(
    _lane: &InLane<L>,
    data: &Path,
    session: &str,
    io: &dyn WriterIo,
    blobs: &BlobStore,
    index: IndexStep<'_>,
) -> Result<(), RewriteError> {
    settle_with(data, session, io, blobs, index, &mut |_| Ok(()))
}

fn settle_with(data: &Path, session: &str, io: &dyn WriterIo, blobs: &BlobStore, index: IndexStep<'_>, hook: Hook<'_>) -> Result<(), RewriteError> {
    settle_files(data, session, io, blobs, hook)?;
    if pending_unlaned(data, session) == Pending::Swapped {
        finish_with(data, session, index, hook)?;
    }
    Ok(())
}

/// Steps 3-5 from wherever the rewrite stands: what is left is step 6 on (`Swapped`) or nothing.
fn settle_files(data: &Path, session: &str, io: &dyn WriterIo, blobs: &BlobStore, hook: Hook<'_>) -> Result<(), RewriteError> {
    let root = stage_dir(data, session);
    match pending_unlaned(data, session) {
        Pending::Clean | Pending::Swapped => {}
        Pending::Leftover => remove_dir(&root)?,
        Pending::Moved if root.join(NEW_DIR).is_dir() => move_new(data, session, hook)?,
        Pending::Moved => {
            // No whole new log to put in place: the old folder goes back and the rewrite is built again.
            fsio::durable_rename(&root.join(OLD_DIR), &session_dir(data, session))?;
            build_with(data, session, io, blobs, hook)?;
            swap_with(data, session, hook)?;
        }
        Pending::Planned => {
            build_with(data, session, io, blobs, hook)?;
            swap_with(data, session, hook)?;
        }
    }
    Ok(())
}

/// A rewrite cut short in this process before step 5: the session's old folder back in place if it was moved, so
/// the session goes on over its old log; the intent stays and the next attempt or start builds again.
pub fn undo_move<L: WriteLane>(_lane: &InLane<L>, data: &Path, session: &str) -> Result<(), IoError> {
    if pending_unlaned(data, session) == Pending::Moved {
        fsio::durable_rename(&stage_dir(data, session).join(OLD_DIR), &session_dir(data, session))?;
    }
    Ok(())
}

fn remove_dir(dir: &Path) -> Result<(), IoError> {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => fsio::sync_dir(dir.parent().expect("a rewrite part in its parent")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(err(IoOp::Remove, dir)(e)),
    }
}

/// The first part of a start's recovery, before the index opens: every session's rewrite settled up to step 5.
/// Returns the sessions whose step 6 on is still to do (`finish` once the index is open), in name order. A rewrite
/// that cannot be settled fails the start, as any data-dir write that cannot be made does: its session would
/// otherwise open over a log the rewrite was decided to replace.
pub fn recover<L: WriteLane>(_lane: &InLane<L>, data: &Path, io: &dyn WriterIo, blobs: &BlobStore) -> Result<Vec<String>, RewriteError> {
    recover_with(data, io, blobs, &mut |_| Ok(()))
}

fn recover_with(data: &Path, io: &dyn WriterIo, blobs: &BlobStore, hook: Hook<'_>) -> Result<Vec<String>, RewriteError> {
    let root = data.join(REWRITE_DIR);
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(err(IoOp::List, &root)(e).into()),
    };
    let mut sessions = Vec::new();
    for entry in entries {
        let session = entry.map_err(err(IoOp::List, &root))?.file_name().to_string_lossy().into_owned();
        settle_files(data, &session, io, blobs, hook)?;
        if pending_unlaned(data, &session) == Pending::Swapped {
            sessions.push(session);
        }
    }
    sessions.sort();
    Ok(sessions)
}

/// The second part of a start's recovery for one session [`recover`] returned: steps 6-8.
pub fn finish<L: WriteLane>(_lane: &InLane<L>, data: &Path, session: &str, index: IndexStep<'_>) -> Result<(), RewriteError> {
    finish_with(data, session, index, &mut |_| Ok(()))
}

#[cfg(test)]
#[path = "log_rewrite_tests.rs"]
mod tests;
