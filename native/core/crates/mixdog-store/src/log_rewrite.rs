//! A session's log rewritten with some records replaced (FORMAT.md §13): a value marked
//! sensitive after records holding it were written leaves no readable copy in the log.
//!
//! The rewrite keeps every frame's ordinal and file; only the replaced records' payloads and
//! the positions the checkpoints carry change. The new files are staged whole and synced in
//! `<D>/sessions-rewrite/<id>/`, then a `commit` file is published there: before it the
//! session's own log is untouched and a restart removes the staging; from it on the rewrite is
//! finished, never undone, and a restart renames what is left of the staged files over the
//! session's (each rename replaces one file whole). The staging goes once the caller has
//! rebuilt the session's index rows from the new log.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "log file I/O runs only in lane jobs (lane proof arguments)")]

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
use crate::schema::checkpoint::CheckpointState;
use crate::schema::checkpoint::FramePos;
use crate::schema::frame::LOG_FILE_PREFIX;
use crate::schema::frame::ORDINAL_DIGITS;
use crate::schema::record::Record;
use crate::schema::record::Refs;

/// `<D>/sessions-rewrite/<id>/`: a session's rewritten log files before they replace its own.
pub const REWRITE_DIR: &str = "sessions-rewrite";
/// Published once every staged file is synced: the rewrite is decided.
pub const COMMIT_FILE: &str = "commit";

#[derive(Debug, thiserror::Error)]
pub enum RewriteError {
    #[error(transparent)]
    Io(#[from] IoError),
    #[error("session log not rewritable: {0}")]
    Log(String),
    /// A test stopped the rewrite at a step, leaving what a kill there leaves.
    #[cfg(test)]
    #[error("stopped at {0:?}")]
    Stopped(Step),
}

/// The boundaries of a rewrite, each reported before it is taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Staging log file `n`.
    Stage(u32),
    /// Every file staged and synced; the commit file not yet published.
    Commit,
    /// Renaming staged file `n` over the session's.
    Swap(u32),
}

type Hook<'a> = &'a mut dyn FnMut(Step) -> Result<(), RewriteError>;

fn stage_dir(data: &Path, session: &str) -> PathBuf {
    data.join(REWRITE_DIR).join(session)
}

fn session_dir(data: &Path, session: &str) -> PathBuf {
    data.join("sessions").join(session)
}

/// A rewrite whose files are staged and synced; [`commit`](Self::commit) decides it.
#[must_use]
pub struct Staged {
    data: PathBuf,
    session: String,
    /// The blobs the replaced records moved out of line, kept until the index holds them.
    pub pins: Vec<BlobPin>,
}

/// Every out-of-line slot a replacement may change, read back inline; the slot's own blob
/// leaves the record's `refs` with it (the encode names the blob the new body needs, if any).
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
        _ => {}
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

/// Reads every committed frame of `session`'s log and stages its files with `replace` applied
/// to each record (its slots inline; `None` keeps the frame's bytes as they are). `None` when
/// no record changes: nothing is staged. A log that does not read to a clean end is refused.
pub fn stage<L: WriteLane>(
    _lane: &InLane<L>,
    data: &Path,
    session: &str,
    io: &dyn WriterIo,
    blobs: &BlobStore,
    replace: &mut dyn FnMut(&Record) -> Option<Record>,
) -> Result<Option<Staged>, RewriteError> {
    stage_with(data, session, io, blobs, replace, &mut |_| Ok(()))
}

fn stage_with(
    data: &Path,
    session: &str,
    io: &dyn WriterIo,
    blobs: &BlobStore,
    replace: &mut dyn FnMut(&Record) -> Option<Record>,
    hook: Hook<'_>,
) -> Result<Option<Staged>, RewriteError> {
    let dir = session_dir(data, session);
    let files = list_logs(&dir).map_err(|e| RewriteError::Log(e.to_string()))?;
    let mut moved: HashMap<u64, FramePos> = HashMap::new();
    let mut rewritten: Vec<(u32, Vec<u8>)> = Vec::with_capacity(files.len());
    let mut pins = Vec::new();
    let mut changed = false;
    for &file_no in &files {
        let path = dir.join(log_name(file_no));
        let bytes = std::fs::read(&path).map_err(err(IoOp::Read, &path))?;
        let first = std::str::from_utf8(bytes.get(..ORDINAL_DIGITS).unwrap_or_default())
            .ok()
            .and_then(|digits| u64::from_str_radix(digits, 16).ok())
            .ok_or_else(|| RewriteError::Log(format!("{}: no frame header", path.display())))?;
        let mut from = FramePos { ordinal: first, file_no, offset: 0 };
        let mut out = Vec::with_capacity(bytes.len());
        loop {
            let read = read_forward_unlaned(&dir, from, bytes.len() as u64).map_err(|e| RewriteError::Log(e.to_string()))?;
            for (record, pos, frame_len) in &read.frames {
                let offset = out.len() as u64;
                let resolved = inline(record, blobs).map_err(RewriteError::Log)?;
                let mut next = replace(&resolved);
                if let Record::Checkpoint(checkpoint) = next.as_ref().unwrap_or(&resolved)
                    && let Slot::Inline(state) = &checkpoint.state
                    && let Some(state) = moved_state(state, &moved)
                {
                    let mut checkpoint = checkpoint.clone();
                    checkpoint.state = Slot::Inline(state);
                    next = Some(Record::Checkpoint(checkpoint));
                }
                match next {
                    Some(next) => {
                        let encoded = encode_record(next).map_err(|e| RewriteError::Log(e.to_string()))?;
                        for blob in encoded.blobs() {
                            pins.push(blobs.put_unlaned(&blob.bytes, |p, b| io.publish(p, b)).map_err(|e| RewriteError::Log(e.to_string()))?);
                        }
                        framing::encode_into(&mut out, pos.ordinal, encoded.payload());
                        changed = true;
                    }
                    None => out.extend_from_slice(&bytes[pos.offset as usize..(pos.offset + frame_len) as usize]),
                }
                moved.insert(pos.ordinal, FramePos { ordinal: pos.ordinal, file_no, offset });
            }
            match read.next {
                ForwardEnd::More(next) if next.file_no == file_no => from = next,
                ForwardEnd::More(_) | ForwardEnd::Done { torn: false, .. } => break,
                ForwardEnd::Done { torn: true, end, .. } => return Err(RewriteError::Log(format!("{}: torn at {end}", path.display()))),
                ForwardEnd::Damaged(damage) => return Err(RewriteError::Log(format!("damaged at {damage:?}"))),
            }
        }
        rewritten.push((file_no, out));
    }
    if !changed {
        return Ok(None);
    }
    let stage = stage_dir(data, session);
    remove_dir(&stage)?;
    fsio::create_dir_durable(&stage)?;
    for (file_no, bytes) in &rewritten {
        hook(Step::Stage(*file_no))?;
        io.publish(&stage.join(log_name(*file_no)), bytes)?;
    }
    Ok(Some(Staged { data: data.to_path_buf(), session: session.to_owned(), pins }))
}

impl Staged {
    /// Decides the rewrite and puts its files in place of the session's. An error after the
    /// commit file leaves the rest to [`recover`] at the next start.
    pub fn commit<L: WriteLane>(self, _lane: &InLane<L>) -> Result<Vec<BlobPin>, RewriteError> {
        self.commit_with(&mut |_| Ok(()))
    }

    fn commit_with(self, hook: Hook<'_>) -> Result<Vec<BlobPin>, RewriteError> {
        let stage = stage_dir(&self.data, &self.session);
        hook(Step::Commit)?;
        fsio::publish_file_unlaned(&stage.join(COMMIT_FILE), b"")?;
        swap(&stage, &session_dir(&self.data, &self.session), hook)?;
        Ok(self.pins)
    }
}

/// Renames every staged log file over the session's, in file order.
fn swap(stage: &Path, dir: &Path, hook: Hook<'_>) -> Result<(), RewriteError> {
    for file_no in staged_files(stage)? {
        hook(Step::Swap(file_no))?;
        fsio::durable_rename(&stage.join(log_name(file_no)), &dir.join(log_name(file_no)))?;
    }
    Ok(())
}

/// The staged log files still to rename (the commit file and `publish_file` tmps aside).
fn staged_files(stage: &Path) -> Result<Vec<u32>, IoError> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(stage).map_err(err(IoOp::List, stage))? {
        let name = entry.map_err(err(IoOp::List, stage))?.file_name().to_string_lossy().into_owned();
        if let Some(n) = name.strip_prefix(LOG_FILE_PREFIX).and_then(|digits| digits.parse::<u32>().ok())
            && name == log_name(n)
        {
            files.push(n);
        }
    }
    files.sort_unstable();
    Ok(files)
}

fn remove_dir(dir: &Path) -> Result<(), IoError> {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => fsio::sync_dir(dir.parent().expect("staging in its parent")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(err(IoOp::Remove, dir)(e)),
    }
}

/// The staging of `session`, gone: once its index rows are rebuilt from the new log.
pub fn clear<L: WriteLane>(_lane: &InLane<L>, data: &Path, session: &str) -> Result<(), IoError> {
    remove_dir(&stage_dir(data, session))
}

/// What a stopped rewrite left, settled before any session opens: a staging without its commit
/// file is removed (the session keeps its log as it was); one with it finishes its renames.
/// Returns the sessions whose log was rewritten and whose staging is still there: the caller
/// rebuilds their index rows, then [`clear`]s them.
pub fn recover<L: WriteLane>(_lane: &InLane<L>, data: &Path) -> Result<Vec<String>, IoError> {
    recover_with(data, &mut |_| Ok(())).map_err(|e| match e {
        RewriteError::Io(e) => e,
        other => IoError { op: IoOp::Rename, path: data.join(REWRITE_DIR), source: std::io::Error::other(other.to_string()) },
    })
}

fn recover_with(data: &Path, hook: Hook<'_>) -> Result<Vec<String>, RewriteError> {
    let root = data.join(REWRITE_DIR);
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(err(IoOp::List, &root)(e).into()),
    };
    let mut sessions = Vec::new();
    for entry in entries {
        let entry = entry.map_err(err(IoOp::List, &root))?;
        let session = entry.file_name().to_string_lossy().into_owned();
        let stage = entry.path();
        let dir = session_dir(data, &session);
        if stage.join(COMMIT_FILE).is_file() && dir.is_dir() {
            swap(&stage, &dir, hook)?;
            sessions.push(session);
        } else {
            remove_dir(&stage)?;
        }
    }
    sessions.sort();
    Ok(sessions)
}

#[cfg(test)]
#[path = "log_rewrite_tests.rs"]
mod tests;
