//! Session logs: bounded open (FORMAT.md §6.3), positioned reads, the `LogWriter` state
//! machine (SM §8, SPEC R26) and the damage repair (FORMAT.md §3.4).
//!
//! One `LogWriter` per session, owned by that session's `DurabilityTask`: its barrier, its
//! fsync and its group commit touch only its own files, so a slow session never delays
//! another. A batch is written with one write and one `sync_file`; batches are strictly
//! sequential (the next starts only after this call returns).
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "log file I/O runs only in lane jobs (lane proof arguments)")]

use std::cell::RefCell;
use std::collections::HashMap;
use std::fs::File;
use std::fs::OpenOptions;
use std::io;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_core_api::domain::ownership::FenceReason;
use mixdog_core_api::domain::ownership::Ownership;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;

use crate::blobs::BlobError;
use crate::blobs::BlobStore;
use crate::encode::EncodeError;
use crate::encode::Encoded;
use crate::encode::PendingBlob;
use crate::fold::Fold;
use crate::fold::FoldError;
use crate::fold::LineageIndex;
use crate::fold::resolve_slot;
use crate::framing;
use crate::fsio;
use crate::fsio::IoError;
use crate::fsio::IoLane;
use crate::fsio::IoOp;
use crate::fsio::err;
use crate::projection::ProjectedFrame;
use crate::projection::Projection;
use crate::projection::project;
use crate::schema::checkpoint::FramePos;
use crate::schema::frame::*;
use crate::schema::record::CheckpointRecord;
use crate::schema::record::Header;
use crate::schema::record::Record;
use crate::summary::CatalogHead;

/// `log.<nnnnnn>`.
pub fn log_name(file_no: u32) -> String {
    format!("{LOG_FILE_PREFIX}{file_no:06}")
}

fn parse_log_name(name: &str) -> Option<u32> {
    let digits = name.strip_prefix(LOG_FILE_PREFIX)?;
    (digits.len() == LOG_FILE_DIGITS && digits.bytes().all(|b| b.is_ascii_digit())).then(|| digits.parse().ok()).flatten()
}

/// The log files of a session directory, ascending. Tmp files of `publish_file` and run drafts (`draft_file`) are
/// skipped; any other entry is a format error.
pub fn list_logs(dir: &Path) -> Result<Vec<u32>, OpenError> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(err(IoOp::List, dir))? {
        let entry = entry.map_err(err(IoOp::List, dir))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(n) = parse_log_name(&name) {
            files.push(n);
        } else if !fsio::is_tmp_name(&name) && crate::draft_file::rid_of(&name).is_none() {
            return Err(OpenError::Format(format!("unexpected entry {name:?} in {}", dir.display())));
        }
    }
    files.sort_unstable();
    Ok(files)
}

/// Whether log `file_no` of the listing `files` is a group file (FORMAT.md §1): its number follows
/// a gap. The kind is known from the names alone, before any byte of the file is read; a writer
/// before group files numbered its files without gaps, so none of its files is one.
pub fn is_group_file(files: &[u32], file_no: u32) -> bool {
    file_no > 0 && files.binary_search(&(file_no - 1)).is_err()
}

#[derive(Debug, thiserror::Error)]
pub enum OpenError {
    #[error("session log missing: {0}")]
    Missing(PathBuf),
    #[error("session log format: {0}")]
    Format(String),
    #[error(transparent)]
    Io(#[from] IoError),
    #[error(transparent)]
    Blob(#[from] BlobError),
    #[error(transparent)]
    Fold(#[from] FoldError),
}

/// Where a session's newest file ends, as classified at open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogStatus {
    Clean,
    /// Unacknowledged bytes from `offset`; the first open-for-append truncates them.
    Torn {
        offset: u64,
    },
    /// Read-only until `session.repair`.
    Damaged(Damage),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Damage {
    pub file_no: u32,
    pub offset: u64,
    pub ordinal: u64,
}

/// The result of the bounded open (J1).
#[derive(Debug)]
pub struct OpenedLog {
    pub dir: PathBuf,
    pub files: Vec<u32>,
    pub newest_file_no: u32,
    pub file_len: u64,
    /// End of the last committed frame.
    pub committed_end: u64,
    pub status: LogStatus,
    pub fold: Fold,
    /// Bytes read from the log, for the open bound (≤ `REVERSE_SCAN_MAX` + the frame
    /// before the anchor), plus the checkpoint-state blob if out of line.
    pub bytes_read: u64,
    /// What the fold could not read and no later checkpoint restored (a salvaged open, FORMAT.md §4.5): the state may
    /// be stale, so the log is read-only (`LogWriter::open` refuses, `OpenAppendError::BodiesLost`) until the missing
    /// blobs are back and an open reads it whole.
    pub lost: Option<String>,
    anchor_offset: u64,
    last_is_anchor: bool,
    /// The newest file is a group file (§1): the next write starts the next file.
    group_file: bool,
}

fn read_range(file: &mut File, path: &Path, offset: u64, len: usize) -> Result<Vec<u8>, IoError> {
    let mut buf = vec![0; len];
    read_into(file, path, offset, &mut buf)?;
    Ok(buf)
}

fn read_into(file: &mut File, path: &Path, offset: u64, buf: &mut [u8]) -> Result<(), IoError> {
    file.seek(SeekFrom::Start(offset)).map_err(err(IoOp::Read, path))?;
    file.read_exact(buf).map_err(err(IoOp::Read, path))
}

fn parse_record(payload: &[u8]) -> Result<Record, String> {
    serde_json::from_slice(payload).map_err(|e| e.to_string())
}

/// Bounded open of `dir` (FORMAT.md §6.3) in one call: `read_head`, `read_tail`,
/// `decode_tail`. The writer's reopen and tests use it; the session open runs the three
/// steps as separate lane jobs (J1, J2, decode).
pub fn open_log<L: IoLane>(lane: &InLane<L>, dir: &Path, blobs: &BlobStore, index: &dyn LineageIndex) -> Result<OpenedLog, OpenError> {
    let head = read_head(lane, dir)?;
    let tail = read_tail(lane, head, blobs, index)?;
    Ok(decode_tail_unlaned(tail))
}

/// J1: the newest file's bounded tail, read and checked (frame headers, CRCs).
pub struct HeadRead {
    dir: PathBuf,
    files: Vec<u32>,
    newest: u32,
    size: u64,
    buf: Vec<u8>,
    window_start: u64,
    scan: framing::Scan,
    anchor_start: usize,
    anchor_ordinal: u64,
    bytes_read: u64,
    group_file: bool,
}

impl std::fmt::Debug for HeadRead {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HeadRead").field("dir", &self.dir).field("bytes_read", &self.bytes_read).finish()
    }
}

/// J2's tail part: the anchor and tail records parsed, the anchor's state resolved and the
/// fold's index lookups done. `decode_tail` applies them.
pub struct TailRead {
    head: HeadRead,
    fold: Fold,
    anchor_offset: u64,
    status: LogStatus,
    committed_end: u64,
    records: Vec<(FramePos, u64)>,
    effects: Vec<crate::fold::Effect>,
    last_is_anchor: bool,
    lost: Option<String>,
}

impl TailRead {
    /// The fold at the anchor (before the tail): lineage, `base_cut`, open-set positions.
    pub fn anchor_fold(&self) -> &Fold {
        &self.fold
    }
}

/// J1 (FORMAT.md §6.3): reverse scan of the newest file to its newest committed
/// `checkpoint`/`session` frame and the forward frame scan to end of file.
pub fn read_head<L: IoLane>(_lane: &InLane<L>, dir: &Path) -> Result<HeadRead, OpenError> {
    read_head_of(dir, list_logs(dir)?)
}

/// `read_head` of a newest file that is a group file: never reverse-scanned, only its head frame is read here and
/// `read_tail` reads the rest forward in chunks (§6.3). A file that does not start with a head has no anchor.
fn read_group_head(dir: &Path, files: Vec<u32>, newest: u32, file: &mut File, path: &Path, size: u64) -> Result<HeadRead, OpenError> {
    let (buf, anchor_ordinal) = GroupFileHead::read(file, path, size)?.map_or((Vec::new(), 0), |head| (head.frame, head.ordinal));
    let bytes_read = buf.len() as u64;
    let scan = framing::Scan { frames: Vec::new(), end: ScanEnd::Clean };
    Ok(HeadRead { dir: dir.to_path_buf(), files, newest, size, buf, window_start: 0, scan, anchor_start: 0, anchor_ordinal, bytes_read, group_file: true })
}

/// `read_head` over the listing `files` (the newest of them is read).
fn read_head_of(dir: &Path, files: Vec<u32>) -> Result<HeadRead, OpenError> {
    let Some(&newest) = files.last() else {
        return Err(OpenError::Missing(dir.to_path_buf()));
    };
    let path = dir.join(log_name(newest));
    let mut file = File::open(&path).map_err(err(IoOp::Open, &path))?;
    let size = file.metadata().map_err(err(IoOp::Read, &path))?.len();

    let group_file = is_group_file(&files, newest);
    if group_file {
        return read_group_head(dir, files, newest, &mut file, &path, size);
    }
    let mut bytes_read = 0u64;
    let AnchorWindow { buf, window_start, anchor_start, anchor_ordinal } = locate_anchor(&mut file, &path, size, &mut bytes_read)?;
    let scan = framing::scan(&buf, window_start, anchor_start, anchor_ordinal);
    Ok(HeadRead { dir: dir.to_path_buf(), files, newest, size, buf, window_start, scan, anchor_start, anchor_ordinal, bytes_read, group_file })
}

struct AnchorWindow {
    buf: Vec<u8>,
    window_start: u64,
    anchor_start: usize,
    anchor_ordinal: u64,
}

/// The tail window of a file of `size` bytes that holds its newest anchor, read backwards from the end, twice as far each
/// time no anchor is in it, so it ends near that anchor. The clean-close case needs the last frame and the
/// `GROUP_LOOKBACK` bytes before it: the bound is `REVERSE_SCAN_MAX` (+1 byte so the LF before the anchor is in the
/// window) plus that lookback. With no anchor within the bound the newest file is damaged somewhere: it is read whole from
/// its first frame (every file starts with an anchor), so the forward scan validates every group and locates any damage
/// exactly.
fn locate_anchor(file: &mut File, path: &Path, size: u64, bytes_read: &mut u64) -> Result<AnchorWindow, IoError> {
    let mut buf = Vec::new();
    let mut window_start = size;
    let mut want = MAX_FRAME_LEN as u64 + 1;
    let found = loop {
        let start = size.saturating_sub(want);
        if start < window_start {
            let added = (window_start - start) as usize;
            let mut wider = vec![0; added + buf.len()];
            read_into(file, path, start, &mut wider[..added])?;
            *bytes_read += added as u64;
            wider[added..].copy_from_slice(&buf);
            buf = wider;
            window_start = start;
        }
        want = match framing::reverse_scan(&buf, window_start == 0) {
            framing::Reverse::Found(a) => break Some(a),
            framing::Reverse::Need(n) => size - window_start + n,
            framing::Reverse::None if want < REVERSE_SCAN_MAX + 1 => (want * 2).min(REVERSE_SCAN_MAX + 1),
            framing::Reverse::None => break None,
        };
        if want > REVERSE_SCAN_MAX + 1 + GROUP_LOOKBACK {
            break None;
        }
    };
    if let Some(a) = found {
        return Ok(AnchorWindow { buf, window_start, anchor_start: a.start, anchor_ordinal: a.ordinal });
    }
    let all = read_range(file, path, 0, size as usize)?;
    *bytes_read += window_start;
    let anchor_ordinal = ordinal_of(&all).unwrap_or(0);
    Ok(AnchorWindow { buf: all, window_start: 0, anchor_start: 0, anchor_ordinal })
}

pub(crate) fn ordinal_of(header: &[u8]) -> Option<u64> {
    std::str::from_utf8(header.get(..ORDINAL_DIGITS).unwrap_or_default()).ok().and_then(|t| u64::from_str_radix(t, 16).ok())
}

/// A body reader over `blobs` that notes its losses in `gone` and adds the bytes it reads to `bytes_read`.
fn counting<'a>(
    blobs: &'a BlobStore,
    gone: &'a RefCell<Vec<crate::schema::bounded::Digest>>,
    bytes_read: &'a mut u64,
) -> impl FnMut(&crate::schema::blob::BodyBlob) -> Result<Vec<u8>, String> + 'a {
    let mut read = crate::fold::noting(blobs, gone);
    move |blob| read(blob).inspect(|bytes| *bytes_read += bytes.len() as u64)
}

/// The newest anchor of the file holding `before` (a frame boundary) that lies before it, the fold right after that anchor
/// and the position of the frame that follows it: what a reader that needs only the frames from `before` on starts from,
/// instead of folding the log from its first frame (J1 and §6.3 step 3, over the part of the file before `before`). Frames
/// written after `before` do not move it, so a cursor behind the log's newest anchor still costs only the bytes after it.
/// `None` when `before` starts its file, is in a group file, or the anchor cannot be read; the caller folds from the start then.
pub(crate) fn anchor_fold_before_unlaned(dir: &Path, before: FramePos, resolve: &mut crate::fold::ResolveBody<'_>) -> Option<(FramePos, Fold, FramePos)> {
    let files = list_logs(dir).ok()?;
    if before.offset == 0 || files.binary_search(&before.file_no).is_err() || is_group_file(&files, before.file_no) {
        return None;
    }
    let path = dir.join(log_name(before.file_no));
    let mut file = File::open(&path).ok()?;
    let window = locate_anchor(&mut file, &path, before.offset, &mut 0).ok()?;
    let scan = framing::scan(&window.buf, window.window_start, window.anchor_start, window.anchor_ordinal);
    let (anchor, _) = scan.frames.split_first()?;
    let anchor_pos = FramePos { ordinal: anchor.ordinal, file_no: before.file_no, offset: window.window_start + anchor.start as u64 };
    let next = FramePos { ordinal: anchor.ordinal + 1, file_no: before.file_no, offset: window.window_start + anchor.end() as u64 };
    let session_name = dir.file_name()?.to_string_lossy().into_owned();
    let record = parse_record(anchor.payload(&window.buf)).ok()?;
    let fold = fold_at_anchor(record, anchor_pos, &session_name, resolve).ok()?;
    Some((anchor_pos, fold, next))
}

/// The fold right after the anchor frame at `pos` whose record is `record` (§6.3 step 3): the
/// `session` frame of this session, or a `checkpoint` whose state covers exactly that frame.
fn fold_at_anchor(record: Record, pos: FramePos, session_name: &str, resolve: &mut crate::fold::ResolveBody<'_>) -> Result<Fold, OpenError> {
    match record {
        Record::Session(s) => {
            if s.id.as_str() != session_name {
                return Err(OpenError::Format(format!("session frame names {:?}", s.id.as_str())));
            }
            let header = resolve_slot(&s.header, resolve).map_err(OpenError::Format)?;
            Ok(Fold::from_session(&s, header, pos))
        }
        Record::Checkpoint(c) => {
            let state = resolve_slot(&c.state, resolve).and_then(|state| crate::encode::checkpoint_in_line(state, resolve)).map_err(OpenError::Format)?;
            if state.covers_ordinal != pos.ordinal {
                return Err(OpenError::Format(format!("checkpoint at {} covers {}", pos.ordinal, state.covers_ordinal)));
            }
            Ok(Fold::from_checkpoint(session_name, state))
        }
        _ => Err(OpenError::Format("anchor is not a checkpoint or session".into())),
    }
}

/// The fold of the log in `dir` read forward from its `session` frame up to ordinal `end` (exclusive; `None`: to the
/// log's end), for an open whose anchor state or tail record names a blob that is missing or corrupt (FORMAT.md §4.5):
/// every record is folded as far as it can be, and the next checkpoint whose state reads puts back what a lost body
/// changed in the header (`fold::fold_salvaging`). Fails `BlobError::Missing` when the session's own header is lost and
/// no later checkpoint holds it: no session is opened without its header. With the fold, the losses no later checkpoint
/// restored (`Losses::describe`): the log then opens read-only ([`OpenedLog::lost`]). Unbounded (the whole log), and
/// only then.
fn salvage_fold(dir: &Path, blobs: &BlobStore, end: Option<u64>) -> Result<(Fold, Option<String>), OpenError> {
    let gone = RefCell::new(Vec::new());
    let mut resolve = crate::fold::noting(blobs, &gone);
    let mut losses = crate::fold::Losses::default();
    let mut fold = None;
    let mut pos = FramePos { ordinal: first_ordinal_unlaned(dir)?, file_no: 0, offset: 0 };
    'read: loop {
        let read = read_forward_unlaned(dir, pos, MAX_FRAME_LEN as u64)?;
        for (record, at, _) in &read.frames {
            if end.is_some_and(|end| at.ordinal >= end) {
                break 'read;
            }
            crate::fold::fold_salvaging(&mut fold, record, *at, &mut resolve, &gone, &mut losses).map_err(OpenError::Format)?;
        }
        match read.next {
            ForwardEnd::More(next) => pos = next,
            ForwardEnd::Done { .. } | ForwardEnd::Damaged(_) => break,
        }
    }
    if let Some(digest) = losses.header_missing() {
        return Err(BlobError::Missing { digest: digest.clone() }.into());
    }
    let fold = fold.ok_or_else(|| OpenError::Format(format!("{}: the log holds no frame", dir.display())))?;
    match end {
        Some(end) if fold.next_ordinal != end => {
            Err(OpenError::Format(format!("{}: salvaged to ordinal {}, the tail ends at {end}", dir.display(), fold.next_ordinal)))
        }
        _ => Ok((fold, (!losses.is_empty()).then(|| losses.describe()))),
    }
}

/// A group file's head frame (FORMAT.md §1, §3.6), read whole from offset 0: the frame's bytes, its
/// ordinal, the group it names and the `checkpoint` record it carries. `None` when the file does
/// not start with one.
struct GroupFileHead {
    frame: Vec<u8>,
    ordinal: u64,
    marker: GroupMarker,
    checkpoint: Record,
}

impl GroupFileHead {
    fn read(file: &mut File, path: &Path, size: u64) -> Result<Option<Self>, IoError> {
        let header = read_range(file, path, 0, size.min(HEADER_LEN as u64) as usize)?;
        let Some(ordinal) = ordinal_of(&header) else {
            return Ok(None);
        };
        let frame_len = match framing::check_header(&header, ordinal) {
            Ok(Some(len)) if (len + FRAME_OVERHEAD) as u64 <= size => len + FRAME_OVERHEAD,
            _ => return Ok(None),
        };
        let frame = read_range(file, path, 0, frame_len)?;
        Ok(Self::of(frame, ordinal))
    }

    fn of(frame: Vec<u8>, ordinal: u64) -> Option<Self> {
        let (marker, checkpoint) = parse_group_file_head(framing::check_frame(&frame, ordinal).ok()?).ok()?;
        let checkpoint = parse_record(checkpoint).ok()?;
        matches!(checkpoint, Record::Checkpoint(_)).then_some(GroupFileHead { frame, ordinal, marker, checkpoint })
    }

    /// The file is exactly this head and the bytes of the group it names: a group file is published
    /// whole and never appended to, so any other length is damage.
    fn spans(&self, size: u64) -> bool {
        (self.frame.len() as u64).checked_add(self.marker.bytes) == Some(size)
    }

    /// Damage of a group file is damage of the whole file: it is used whole or not at all.
    fn damage(file_no: u32, ordinal: u64) -> Damage {
        Damage { file_no, offset: 0, ordinal }
    }
}

/// The open of a newest file that is a group file (FORMAT.md §1, §3.6, §6.3). Its head frame is its
/// anchor: the state before the group and the group's count, bytes and SHA-256. The members are read
/// forward once, in `GROUP_CHECK_CHUNK` pieces; the file is never reverse-scanned. A group file is
/// used whole or not at all: when its length is not the head's plus the bytes the head names, or its
/// members do not check against the head, the file is damaged as a whole and the open holds the
/// state before the group. A file that does not start with a head has no anchor and the open fails,
/// as for a segment whose first frame does not read.
///
/// Members are folded as they are checked, into a fold of this call that is returned only once the
/// whole group has checked; otherwise the fold of the head's state is returned. Nothing outside this
/// call sees a member of a group that did not check whole. A member that is no record, or does not
/// fold, ends the folding but not the check: a fold failure is reported only when the group checks
/// whole (it is then the log's own failure); a group that does not check is damage whatever its
/// members held.
fn read_group_file(mut head: HeadRead, blobs: &BlobStore, index: &dyn LineageIndex) -> Result<TailRead, OpenError> {
    let path = head.dir.join(log_name(head.newest));
    let Some(file_head) = GroupFileHead::of(std::mem::take(&mut head.buf), head.anchor_ordinal) else {
        return Err(OpenError::Format(format!("{}: no committed group file head", path.display())));
    };
    let mut whole = file_head.spans(head.size);
    let GroupFileHead { frame, ordinal, marker, checkpoint } = file_head;
    let head_len = frame.len() as u64;
    let session_name = head.dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut bytes_read = head.bytes_read;
    let gone = RefCell::new(Vec::new());
    let mut resolve = counting(blobs, &gone, &mut bytes_read);
    // A head state or a member body whose blob is missing or corrupt: the fold is salvaged from the whole log (FORMAT.md
    // §4.5).
    let (before, lost) = match fold_at_anchor(checkpoint, FramePos { ordinal, file_no: head.newest, offset: 0 }, &session_name, &mut resolve) {
        Ok(before) => (before, None),
        Err(_) if crate::fold::take_lost(&gone).is_some() => salvage_fold(&head.dir, blobs, Some(ordinal + 1))?,
        Err(e) => return Err(e),
    };
    let mut fold = before.clone();
    let mut log_bytes = 0u64;
    // `Some(None)`: a member that is no record; `Some(Some(_))`: one that did not fold.
    let mut halted: Option<Option<OpenError>> = None;
    if whole {
        let mut file = File::open(&path).map_err(err(IoOp::Open, &path))?;
        let mut check = framing::GroupCheck::new(marker, ordinal + 1, false);
        let mut at = head_len;
        while at < head.size {
            let n = (head.size - at).min(GROUP_CHECK_CHUNK as u64) as usize;
            let chunk = read_range(&mut file, &path, at, n)?;
            log_bytes += n as u64;
            let mut members = Vec::new();
            let fed = check.feed_members(&chunk, |ordinal, start, payload| {
                members.push((parse_record(payload), FramePos { ordinal, file_no: head.newest, offset: head_len + start as u64 }));
            });
            if fed.is_err() {
                whole = false;
                break;
            }
            if halted.is_none() {
                let members: Result<Vec<_>, _> = members.into_iter().map(|(r, pos)| r.map(|r| (r, pos))).collect();
                halted = match members {
                    Err(_) => Some(None),
                    Ok(members) => match fold.prepare(members.iter().map(|(r, _)| r), index, &mut resolve) {
                        Err(e) => Some(Some(e.into())),
                        Ok(effects) => {
                            for (effect, (_, pos)) in effects.into_iter().zip(members) {
                                fold.apply(effect, pos);
                            }
                            None
                        }
                    },
                };
            }
            at += n as u64;
        }
        whole = whole && check.finish().is_ok();
    }
    let ((fold, lost), status, committed_end) = match (whole, halted) {
        (true, None) => ((fold, lost), LogStatus::Clean, head.size),
        (true, Some(Some(_))) if crate::fold::take_lost(&gone).is_some() => (salvage_fold(&head.dir, blobs, None)?, LogStatus::Clean, head.size),
        (true, Some(Some(failure))) => return Err(failure),
        _ => ((before, lost), LogStatus::Damaged(GroupFileHead::damage(head.newest, ordinal)), head_len),
    };
    let last_is_anchor = status != LogStatus::Clean;
    head.buf = frame;
    drop(resolve);
    head.bytes_read = bytes_read + log_bytes;
    Ok(TailRead { head, fold, anchor_offset: 0, status, committed_end, records: Vec::new(), effects: Vec::new(), last_is_anchor, lost })
}

/// J2's tail part: parses the anchor and the tail, reads the anchor state's blob, and runs
/// the fold's index lookups (a tail rewind below the checkpoint).
pub fn read_tail<L: IoLane>(_lane: &InLane<L>, head: HeadRead, blobs: &BlobStore, index: &dyn LineageIndex) -> Result<TailRead, OpenError> {
    if head.group_file {
        return read_group_file(head, blobs, index);
    }
    let HeadRead { ref dir, newest, ref buf, window_start, ref scan, anchor_start, anchor_ordinal, .. } = head;
    let mut bytes_read = head.bytes_read;
    let path = dir.join(log_name(newest));
    let damaged = |offset: u64, ordinal: u64| LogStatus::Damaged(Damage { file_no: newest, offset, ordinal });
    let Some((anchor, tail)) = scan.frames.split_first() else {
        let status = match scan.end {
            ScanEnd::Corrupt { offset, ordinal, .. } => damaged(offset, ordinal),
            _ => damaged(window_start + anchor_start as u64, anchor_ordinal),
        };
        return Err(OpenError::Format(format!("{}: no committed anchor frame ({status:?})", path.display())));
    };
    let anchor_pos = FramePos { ordinal: anchor.ordinal, file_no: newest, offset: window_start + anchor.start as u64 };
    let session_name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let gone = RefCell::new(Vec::new());
    let mut resolve = counting(blobs, &gone, &mut bytes_read);
    let anchor_record = parse_record(anchor.payload(buf)).map_err(OpenError::Format)?;

    // Fold the tail; a committed frame that is not a valid record is damage of the record
    // layer at that frame (FORMAT.md §3.2).
    let mut status = match scan.end {
        ScanEnd::Clean => LogStatus::Clean,
        ScanEnd::Torn { offset } => LogStatus::Torn { offset },
        ScanEnd::Corrupt { offset, ordinal, .. } => damaged(offset, ordinal),
    };
    let mut committed_end = window_start + anchor.end() as u64;
    let mut records = Vec::with_capacity(tail.len());
    for frame in tail {
        match parse_record(frame.payload(buf)) {
            Ok(record) => records.push((record, frame)),
            Err(_) => {
                status = damaged(window_start + frame.start as u64, frame.ordinal);
                break;
            }
        }
    }
    let folded = fold_at_anchor(anchor_record, anchor_pos, &session_name, &mut resolve).and_then(|fold| {
        let effects = fold.prepare(records.iter().map(|(r, _)| r), index, &mut resolve)?;
        Ok((fold, effects))
    });
    // A blob the anchor's state or a tail record names is missing or corrupt: the fold is salvaged from the whole log
    // (FORMAT.md §4.5), and the next clean close writes a checkpoint of it.
    let salvaged = folded.is_err() && !gone.borrow().is_empty();
    let (fold, effects, lost) = match folded {
        Ok((fold, effects)) => (fold, effects, None),
        Err(_) if salvaged => {
            let (fold, lost) = salvage_fold(dir, blobs, Some(anchor.ordinal + 1 + records.len() as u64))?;
            (fold, Vec::new(), lost)
        }
        Err(e) => return Err(e),
    };
    let positions: Vec<(FramePos, u64)> = records
        .iter()
        .map(|(_, frame)| {
            let pos = FramePos { ordinal: frame.ordinal, file_no: newest, offset: window_start + frame.start as u64 };
            (pos, window_start + frame.end() as u64)
        })
        .collect();
    if let Some((_, end)) = positions.last() {
        committed_end = *end;
    }
    let anchor_offset = anchor_pos.offset;
    let last_is_anchor = positions.is_empty() && !salvaged;
    // The salvaged fold already holds the tail.
    let positions = if salvaged { Vec::new() } else { positions };
    let mut head = head;
    drop(resolve);
    head.bytes_read = bytes_read;
    Ok(TailRead { head, fold, anchor_offset, status, committed_end, records: positions, effects, last_is_anchor, lost })
}

/// Decode: applies the tail's effects to the anchor fold (CPU only).
pub fn decode_tail(_lane: &InLane<mixdog_rt::CpuInteractive>, tail: TailRead) -> OpenedLog {
    decode_tail_unlaned(tail)
}

fn decode_tail_unlaned(tail: TailRead) -> OpenedLog {
    let TailRead { head, mut fold, anchor_offset, status, committed_end, records, effects, last_is_anchor, lost } = tail;
    for (effect, (pos, _)) in effects.into_iter().zip(records) {
        fold.apply(effect, pos);
    }
    OpenedLog {
        lost,
        dir: head.dir,
        files: head.files,
        newest_file_no: head.newest,
        file_len: head.size,
        committed_end,
        status,
        fold,
        bytes_read: head.bytes_read,
        anchor_offset,
        last_is_anchor,
        group_file: head.group_file,
    }
}

/// J2: a window or open-set frame read and checked, left unparsed (decode parses it).
pub fn read_frame_payload<L: IoLane>(_lane: &InLane<L>, dir: &Path, pos: FramePos, frame_len: u64) -> Result<Vec<u8>, ReadError> {
    let path = dir.join(log_name(pos.file_no));
    let damaged = || ReadError::Damaged(Damage { file_no: pos.file_no, offset: pos.offset, ordinal: pos.ordinal });
    if frame_len as usize > MAX_FRAME_LEN {
        return Err(damaged());
    }
    let mut file = File::open(&path).map_err(err(IoOp::Open, &path))?;
    let mut buf = match read_range(&mut file, &path, pos.offset, frame_len as usize) {
        Ok(b) => b,
        Err(e) if e.source.kind() == io::ErrorKind::UnexpectedEof => return Err(damaged()),
        Err(e) => return Err(e.into()),
    };
    // The payload is a part of the frame just read: the frame's buffer is cut down to it, not copied a second time.
    let payload = framing::check_frame(&buf, pos.ordinal).map_err(|_| damaged())?;
    let start = payload.as_ptr() as usize - buf.as_ptr() as usize;
    let end = start + payload.len();
    buf.truncate(end);
    buf.drain(..start);
    Ok(buf)
}

/// Decode: one payload from `read_frame_payload` parsed; a payload that is not a valid
/// record is damage of the record layer at `pos`.
pub fn parse_frame_payload(_lane: &InLane<mixdog_rt::CpuInteractive>, pos: FramePos, payload: &[u8]) -> Result<Record, ReadError> {
    parse_record(payload).map_err(|_| ReadError::Damaged(Damage { file_no: pos.file_no, offset: pos.offset, ordinal: pos.ordinal }))
}

#[derive(Debug, thiserror::Error)]
pub enum ReadError {
    /// The frame failed its checks: the session is damaged at this position.
    #[error("frame damaged at {0:?}")]
    Damaged(Damage),
    #[error(transparent)]
    Io(#[from] IoError),
}

/// One positioned read of a committed frame, checked (header, CRC, terminator) and parsed.
pub fn read_frame<L: IoLane>(_lane: &InLane<L>, dir: &Path, pos: FramePos, frame_len: u64) -> Result<Record, ReadError> {
    read_frame_unlaned(dir, pos, frame_len)
}

pub(crate) fn read_frame_unlaned(dir: &Path, pos: FramePos, frame_len: u64) -> Result<Record, ReadError> {
    let path = dir.join(log_name(pos.file_no));
    let damaged = || ReadError::Damaged(Damage { file_no: pos.file_no, offset: pos.offset, ordinal: pos.ordinal });
    if frame_len as usize > MAX_FRAME_LEN {
        return Err(damaged());
    }
    let mut file = File::open(&path).map_err(err(IoOp::Open, &path))?;
    let buf = match read_range(&mut file, &path, pos.offset, frame_len as usize) {
        Ok(b) => b,
        Err(e) if e.source.kind() == io::ErrorKind::UnexpectedEof => return Err(damaged()),
        Err(e) => return Err(e.into()),
    };
    let payload = framing::check_frame(&buf, pos.ordinal).map_err(|_| damaged())?;
    parse_record(payload).map_err(|_| damaged())
}

/// The ordinal of the `session` frame (0, or a fork's `base.end_ordinal_exclusive`),
/// from the header of `log.000000`; checked by the read that follows.
pub(crate) fn first_ordinal_unlaned(dir: &Path) -> Result<u64, OpenError> {
    let path = dir.join(log_name(0));
    let mut file = File::open(&path).map_err(err(IoOp::Open, &path))?;
    let digits = read_range(&mut file, &path, 0, ORDINAL_DIGITS)?;
    ordinal_of(&digits).ok_or_else(|| OpenError::Format(format!("{}: no frame header", path.display())))
}

/// Where a log's first frame starts ([`read_forward`] from here reads every committed frame).
pub fn first_frame<L: IoLane>(_lane: &InLane<L>, dir: &Path) -> Result<FramePos, OpenError> {
    Ok(FramePos { ordinal: first_ordinal_unlaned(dir)?, file_no: 0, offset: 0 })
}

/// `read_frame` when only the position is known (open-set records, whose checkpoint
/// entries carry `FramePos`): the header names the length.
pub fn read_frame_at<L: IoLane>(lane: &InLane<L>, dir: &Path, pos: FramePos) -> Result<Record, ReadError> {
    let path = dir.join(log_name(pos.file_no));
    let damaged = || ReadError::Damaged(Damage { file_no: pos.file_no, offset: pos.offset, ordinal: pos.ordinal });
    let mut file = File::open(&path).map_err(err(IoOp::Open, &path))?;
    let header = match read_range(&mut file, &path, pos.offset, HEADER_LEN) {
        Ok(h) => h,
        Err(e) if e.source.kind() == io::ErrorKind::UnexpectedEof => return Err(damaged()),
        Err(e) => return Err(e.into()),
    };
    let len = match framing::check_header(&header, pos.ordinal) {
        Ok(Some(len)) => len,
        _ => return Err(damaged()),
    };
    read_frame(lane, dir, pos, (len + FRAME_OVERHEAD) as u64)
}

/// Committed frames read forward from a known frame start, across files, for projection
/// (reconcile, rebuild). Reads at most about `max_bytes` (at least one frame).
#[derive(Debug)]
pub struct ForwardRead {
    pub frames: Vec<(Record, FramePos, u64)>,
    /// Where the next read starts, or how the log ends.
    pub next: ForwardEnd,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForwardEnd {
    More(FramePos),
    /// End of the newest file: everything committed was read. `end` is the committed end.
    Done {
        file_no: u32,
        end: u64,
        torn: bool,
    },
    Damaged(Damage),
}

pub fn read_forward<L: IoLane>(_lane: &InLane<L>, dir: &Path, from: FramePos, max_bytes: u64) -> Result<ForwardRead, OpenError> {
    read_forward_unlaned(dir, from, max_bytes)
}

pub(crate) fn read_forward_unlaned(dir: &Path, from: FramePos, max_bytes: u64) -> Result<ForwardRead, OpenError> {
    let files = list_logs(dir)?;
    let newest = *files.last().ok_or_else(|| OpenError::Missing(dir.to_path_buf()))?;
    let path = dir.join(log_name(from.file_no));
    let mut file = File::open(&path).map_err(err(IoOp::Open, &path))?;
    let size = file.metadata().map_err(err(IoOp::Read, &path))?.len();
    let window = max_bytes.max(MAX_FRAME_LEN as u64);
    if is_group_file(&files, from.file_no) {
        return read_forward_group_file(&mut file, &path, &files, from, size, window);
    }
    let mut len = (size - from.offset.min(size)).min(window);
    loop {
        let buf = read_range(&mut file, &path, from.offset, len as usize)?;
        let final_window = from.offset + len == size;
        let scan = framing::scan(&buf, from.offset, 0, from.ordinal);
        let mut frames = Vec::with_capacity(scan.frames.len());
        let mut damage = None;
        for f in &scan.frames {
            let pos = FramePos { ordinal: f.ordinal, file_no: from.file_no, offset: from.offset + f.start as u64 };
            match parse_record(f.payload(&buf)) {
                Ok(r) => frames.push((r, pos, f.frame_len() as u64)),
                Err(_) => {
                    damage = Some(Damage { file_no: from.file_no, offset: pos.offset, ordinal: pos.ordinal });
                    break;
                }
            }
        }
        let after = frames.last().map_or(from, |(_, p, l)| FramePos { ordinal: p.ordinal + 1, file_no: p.file_no, offset: p.offset + l });
        let next = if let Some(d) = damage {
            ForwardEnd::Damaged(d)
        } else {
            match scan.end {
                ScanEnd::Corrupt { offset, ordinal, .. } => ForwardEnd::Damaged(Damage { file_no: from.file_no, offset, ordinal }),
                ScanEnd::Clean if final_window && from.file_no < newest => {
                    let next_no = files.iter().copied().find(|&n| n > from.file_no).expect("newer file");
                    ForwardEnd::More(FramePos { ordinal: after.ordinal, file_no: next_no, offset: 0 })
                }
                ScanEnd::Clean | ScanEnd::Torn { .. } if final_window => {
                    ForwardEnd::Done { file_no: from.file_no, end: after.offset, torn: matches!(scan.end, ScanEnd::Torn { .. }) }
                }
                // A non-final window ended inside a frame or zeros: read on from there.
                _ if after.offset > from.offset => ForwardEnd::More(after),
                _ => {
                    len = size - from.offset;
                    continue;
                }
            }
        };
        return Ok(ForwardRead { frames, next });
    }
}

/// `read_forward` in a group file (FORMAT.md §1, §3.6). A read that enters the file (at its head)
/// checks the group whole, in `GROUP_CHECK_CHUNK` pieces, every member a record, before it returns
/// anything of the file: the head's `checkpoint` record and the members that start within `window`.
/// A read that goes on inside it (from a member's start: the `More` of the read before) reads the
/// next members by position, each frame checked on its own (header, CRC, ordinal) within the extent
/// the head names, as positioned reads of members do. Damage anywhere is damage of the whole file.
fn read_forward_group_file(file: &mut File, path: &Path, files: &[u32], from: FramePos, size: u64, window: u64) -> Result<ForwardRead, OpenError> {
    let file_no = from.file_no;
    let ended = |next| Ok(ForwardRead { frames: Vec::new(), next });
    let Some(head) = GroupFileHead::read(file, path, size)?.filter(|head| head.spans(size) && (from.offset != 0 || head.ordinal == from.ordinal)) else {
        return ended(ForwardEnd::Damaged(GroupFileHead::damage(file_no, from.ordinal)));
    };
    let head_len = head.frame.len() as u64;
    let damaged = ForwardEnd::Damaged(GroupFileHead::damage(file_no, head.ordinal));
    let frames = if from.offset == 0 {
        enter_group_file(file, path, head, file_no, size, window)?
    } else {
        continue_group_file(file, path, from, head_len, size, window)?
    };
    let Some(frames) = frames else {
        return ended(damaged);
    };
    let after = frames.last().map_or(from, |(_, p, l)| FramePos { ordinal: p.ordinal + 1, file_no, offset: p.offset + l });
    let next = if after.offset < size {
        ForwardEnd::More(after)
    } else {
        match files.iter().copied().find(|&n| n > file_no) {
            Some(next_no) => ForwardEnd::More(FramePos { ordinal: after.ordinal, file_no: next_no, offset: 0 }),
            None => ForwardEnd::Done { file_no, end: size, torn: false },
        }
    };
    Ok(ForwardRead { frames, next })
}

type ForwardFrames = Vec<(Record, FramePos, u64)>;

/// The head's `checkpoint` and the members that start within `window` of a group file read from its head, once the group
/// checks whole with every member a record; `None` when it does not.
fn enter_group_file(file: &mut File, path: &Path, head: GroupFileHead, file_no: u32, size: u64, window: u64) -> Result<Option<ForwardFrames>, OpenError> {
    let head_len = head.frame.len() as u64;
    let mut frames = Vec::new();
    let mut check = framing::GroupCheck::new(head.marker, head.ordinal + 1, false);
    let mut all_records = true;
    let mut at = head_len;
    while at < size {
        let n = (size - at).min(GROUP_CHECK_CHUNK as u64) as usize;
        let chunk = read_range(file, path, at, n)?;
        let fed = check.feed_members(&chunk, |ordinal, start, payload| {
            let offset = head_len + start as u64;
            match parse_record(payload) {
                Ok(record) if offset < window => frames.push((record, FramePos { ordinal, file_no, offset }, (payload.len() + FRAME_OVERHEAD) as u64)),
                Ok(_) => {}
                Err(_) => all_records = false,
            }
        });
        if fed.is_err() {
            return Ok(None);
        }
        at += n as u64;
    }
    if check.finish().is_err() || !all_records {
        return Ok(None);
    }
    frames.insert(0, (head.checkpoint, FramePos { ordinal: head.ordinal, file_no, offset: 0 }, head_len));
    Ok(Some(frames))
}

/// The members of a group file read on from `from` (a member's start), each frame checked on its own within the extent
/// the head names; `None` on any damage.
fn continue_group_file(file: &mut File, path: &Path, from: FramePos, head_len: u64, size: u64, window: u64) -> Result<Option<ForwardFrames>, OpenError> {
    if from.offset < head_len || from.offset > size {
        return Ok(None);
    }
    let buf = read_range(file, path, from.offset, (size - from.offset).min(window) as usize)?;
    let mut frames = Vec::new();
    let (mut p, mut ordinal) = (0, from.ordinal);
    while buf.len() - p >= HEADER_LEN {
        let Ok(Some(len)) = framing::check_header(&buf[p..p + HEADER_LEN], ordinal) else {
            return Ok(None);
        };
        let frame_len = len + FRAME_OVERHEAD;
        if buf.len() - p < frame_len {
            break;
        }
        let Some(record) = framing::check_frame(&buf[p..p + frame_len], ordinal).ok().and_then(|payload| parse_record(payload).ok()) else {
            return Ok(None);
        };
        frames.push((record, FramePos { ordinal, file_no: from.file_no, offset: from.offset + p as u64 }, frame_len as u64));
        p += frame_len;
        ordinal += 1;
    }
    // The window holds a whole frame unless the file ends inside one.
    if p == 0 && from.offset < size {
        return Ok(None);
    }
    Ok(Some(frames))
}

// ---------------------------------------------------------------------------------------
// Writer

/// The log file operations of the writer; the production impl is `OsIo`. Tests inject
/// faults here (SM §11.8 §8 transitions, RL G3 (e)).
pub trait LogFile: Send {
    fn write_at(&mut self, offset: u64, bytes: &[u8]) -> io::Result<()>;
    fn sync(&mut self) -> io::Result<()>;
    fn truncate(&mut self, len: u64) -> io::Result<()>;
    /// The file's length now.
    fn size(&mut self) -> io::Result<u64>;
}

pub trait WriterIo: Send + Sync {
    fn open_append(&self, path: &Path) -> io::Result<Box<dyn LogFile>>;
    /// `publish_file` (SM §7.2).
    fn publish(&self, path: &Path, bytes: &[u8]) -> Result<(), IoError>;
}

/// Ordinary handles; std opens them with `FILE_SHARE_READ|WRITE|DELETE` on Windows, so
/// readers never block a rollback's `SetEndOfFile`.
pub struct OsIo;

struct OsFile(File);

impl LogFile for OsFile {
    fn write_at(&mut self, offset: u64, bytes: &[u8]) -> io::Result<()> {
        self.0.seek(SeekFrom::Start(offset))?;
        self.0.write_all(bytes)
    }

    fn sync(&mut self) -> io::Result<()> {
        fsio::flush(&self.0)
    }

    fn truncate(&mut self, len: u64) -> io::Result<()> {
        self.0.set_len(len)
    }

    fn size(&mut self) -> io::Result<u64> {
        self.0.metadata().map(|meta| meta.len())
    }
}

impl WriterIo for OsIo {
    fn open_append(&self, path: &Path) -> io::Result<Box<dyn LogFile>> {
        Ok(Box::new(OsFile(OpenOptions::new().read(true).write(true).open(path)?)))
    }

    fn publish(&self, path: &Path, bytes: &[u8]) -> Result<(), IoError> {
        fsio::publish_file_unlaned(path, bytes)
    }
}

/// What a writer needs besides its log.
#[derive(Clone)]
pub struct WriterDeps {
    pub io: Arc<dyn WriterIo>,
    pub blobs: BlobStore,
    pub ownership: Arc<dyn Ownership>,
    pub index: Arc<dyn LineageIndex>,
}

/// SM §8 states. `Dirty` and `RollingBack` exist only inside one `append_barrier` call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriterState {
    Clean {
        end: u64,
    },
    Dirty {
        acked: u64,
        written: u64,
    },
    RollingBack {
        target: u64,
    },
    /// Persistent in memory until a rollback succeeds; no timer (SM §8 rule 2).
    PendingRollback {
        target: u64,
        cause: String,
        second: bool,
    },
    /// Ownership revalidation failed; the writer never touches the files again.
    Fenced(FenceReason),
}

/// Whether the op of a failed batch took effect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    NotApplied,
    Unknown,
}

#[derive(Debug, thiserror::Error)]
pub enum AppendError {
    /// `barrier_failed`: rolled back and synced; not applied.
    #[error("barrier failed: {0}")]
    BarrierFailed(IoError),
    /// `storage_indeterminate`: the rollback failed too (second fault); outcome unknown.
    #[error("storage indeterminate: {0}")]
    Indeterminate(IoError),
    /// `storage_indeterminate`: the pending rollback still fails; this op was refused.
    #[error("storage indeterminate, op refused: {0}")]
    Refused(IoError),
    #[error("fenced: {reason:?}")]
    Fenced { reason: FenceReason, outcome: Outcome },
    #[error(transparent)]
    Fold(#[from] FoldError),
    #[error(transparent)]
    Blob(#[from] BlobError),
    #[error(transparent)]
    Encode(#[from] EncodeError),
}

impl AppendError {
    /// `NotApplied` maps to the session seam's `BarrierError::Failed`, `Unknown` to
    /// `Indeterminate`. A refused op (pending rollback failed again) was not written but
    /// the earlier batch's outcome is still unknown, so it reads `Unknown` too.
    pub fn outcome(&self) -> Outcome {
        match self {
            AppendError::Indeterminate(_) | AppendError::Refused(_) => Outcome::Unknown,
            AppendError::Fenced { outcome, .. } => *outcome,
            _ => Outcome::NotApplied,
        }
    }

    /// The failing step: the I/O primitive, or the non-I/O cause.
    pub fn io_kind(&self) -> String {
        match self {
            AppendError::BarrierFailed(e) | AppendError::Indeterminate(e) | AppendError::Refused(e) => e.op.to_string(),
            AppendError::Fenced { reason, .. } => format!("fenced:{reason:?}"),
            AppendError::Fold(_) => "fold".into(),
            AppendError::Blob(_) => "blob".into(),
            AppendError::Encode(_) => "encode".into(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum OpenAppendError {
    #[error("session damaged at {0:?}")]
    StoreDamaged(Damage),
    /// The open salvaged a fold that lost state ([`OpenedLog::lost`]): read-only until the blobs are restored.
    #[error("session state lost with its blobs: {0}")]
    BodiesLost(String),
    #[error(transparent)]
    Io(#[from] IoError),
}

/// A successful barrier: positions of the batch's records, and the projection.
#[derive(Debug)]
pub struct BatchAck {
    pub positions: Vec<FramePos>,
    pub projection: Projection,
}

pub struct LogWriter {
    dir: PathBuf,
    deps: WriterDeps,
    file_no: u32,
    file: Option<Box<dyn LogFile>>,
    state: WriterState,
    fold: Fold,
    /// Bytes from the start of the newest `checkpoint`/`session` frame to the end.
    since_anchor: u64,
    last_is_anchor: bool,
    /// The current file is a group file (FORMAT.md §1): nothing is appended to it; the next batch
    /// starts the next file.
    sealed: bool,
}

impl std::fmt::Debug for LogWriter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LogWriter").field("dir", &self.dir).field("file_no", &self.file_no).field("state", &self.state).finish()
    }
}

impl LogWriter {
    /// Creates `dir` with `log.000000` holding the `session` frame (published whole). The
    /// catalog row (`dirty = 1`) is committed by the caller before this (RL §9.2 rule 4).
    pub fn create(_lane: &InLane<DurabilityIo>, dir: &Path, session: Encoded, deps: WriterDeps) -> Result<(LogWriter, BatchAck), AppendError> {
        let Record::Session(record) = &session.record else {
            return Err(FoldError::Unexpected("first record must be a session").into());
        };
        let _writing = crate::log_epoch::writing_dir(dir);
        let start = record.base.as_ref().map_or(0, |b| b.end_ordinal_exclusive);
        for blob in &session.blobs {
            deps.blobs.put_unlaned(&blob.bytes, |p, b| deps.io.publish(p, b))?;
        }
        let mut lookup = blob_lookup(&session.blobs);
        let header: Header = resolve_slot(&record.header, &mut lookup).map_err(FoldError::Body)?;
        let mut buf = Vec::with_capacity(session.frame_len());
        framing::encode_into(&mut buf, start, &session.payload);
        let path = dir.join(log_name(0));
        revalidate(&deps)?;
        fsio::create_dir_durable(dir).map_err(AppendError::BarrierFailed)?;
        deps.io.publish(&path, &buf).map_err(AppendError::BarrierFailed)?;
        let pos = FramePos { ordinal: start, file_no: 0, offset: 0 };
        let fold = Fold::from_session(record, header, pos);
        let (kind, op) = project(&session.record, &mut lookup).map_err(FoldError::Body)?;
        let projection = Projection {
            session: fold.session.clone(),
            head: std::sync::Arc::new(CatalogHead::of(&fold)),
            frames: vec![ProjectedFrame { pos, frame_len: buf.len() as u64, kind, op, receipt: None, history_rev: 0, rows: 0, visible_rows: 0 }],
        };
        let writer = LogWriter {
            dir: dir.to_path_buf(),
            file: deps.io.open_append(&path).ok(),
            deps,
            file_no: 0,
            state: WriterState::Clean { end: buf.len() as u64 },
            fold,
            since_anchor: buf.len() as u64,
            last_is_anchor: true,
            sealed: false,
        };
        Ok((writer, BatchAck { positions: vec![pos], projection }))
    }

    /// Open-for-append (SM §8 `Opening`): sweep tmp files, truncate a torn tail.
    pub fn open(_lane: &InLane<DurabilityIo>, opened: OpenedLog, deps: WriterDeps) -> Result<LogWriter, OpenAppendError> {
        if let LogStatus::Damaged(d) = opened.status {
            return Err(OpenAppendError::StoreDamaged(d));
        }
        // No write, checkpoint or execution from a fold that lost state.
        if let Some(lost) = opened.lost {
            return Err(OpenAppendError::BodiesLost(lost));
        }
        let _writing = crate::log_epoch::writing_dir(&opened.dir);
        fsio::sweep_tmp_unlaned(&opened.dir)?;
        let path = opened.dir.join(log_name(opened.newest_file_no));
        let mut file = deps.io.open_append(&path).map_err(err(IoOp::Open, &path))?;
        let state = match opened.status {
            LogStatus::Torn { offset } => match file.truncate(offset).and_then(|()| file.sync()) {
                Ok(()) => WriterState::Clean { end: offset },
                Err(e) => WriterState::PendingRollback { target: offset, cause: e.to_string(), second: false },
            },
            _ => WriterState::Clean { end: opened.file_len },
        };
        Ok(LogWriter {
            dir: opened.dir,
            deps,
            file_no: opened.newest_file_no,
            file: Some(file),
            state,
            fold: opened.fold,
            since_anchor: opened.committed_end - opened.anchor_offset,
            sealed: opened.group_file,
            last_is_anchor: opened.last_is_anchor,
        })
    }

    pub fn state(&self) -> &WriterState {
        &self.state
    }

    /// The acked fold (memory advances only at successful barriers).
    pub fn fold(&self) -> &Fold {
        &self.fold
    }

    pub fn file_no(&self) -> u32 {
        self.file_no
    }

    /// "Retry storage": runs a pending rollback now.
    pub fn retry_storage(&mut self, _lane: &InLane<DurabilityIo>) -> Result<(), AppendError> {
        let _writing = crate::log_epoch::writing_dir(&self.dir);
        self.ready().map(|_| ())
    }

    /// Writes `batch` as one write batch with one barrier (write + `revalidate` +
    /// `sync_file`). Its blobs are published first. A checkpoint leads the batch once
    /// `CHECKPOINT_EVERY` bytes were written since the last one; a batch that would pass
    /// `ROTATE_AT` goes to a new file published whole, starting with a checkpoint.
    pub fn append_barrier(&mut self, _lane: &InLane<DurabilityIo>, batch: Vec<Encoded>) -> Result<BatchAck, AppendError> {
        self.append(batch, false)
    }

    /// Where the next frame would go: the end of the last frame this writer holds as durable. `None` unless the writer is
    /// `Clean` (a pending rollback, a fence).
    pub fn end(&self) -> Option<FramePos> {
        match self.state {
            WriterState::Clean { end } => Some(FramePos { ordinal: self.fold.next_ordinal, file_no: self.file_no, offset: end }),
            _ => None,
        }
    }

    /// Clean close: ends the file with a checkpoint unless its last frame is one. A group file
    /// gets none (it holds no anchor after its group, FORMAT.md §3.6). `Ok` only from a writer that is `Clean` and still
    /// the log's only one, with or without a frame to append: a pending rollback is run first, and a fence refuses.
    pub fn close(&mut self, _lane: &InLane<DurabilityIo>) -> Result<Option<BatchAck>, AppendError> {
        // Before anything else: a pending rollback cuts and syncs the file, which a writer that lost the log must not.
        if !matches!(self.state, WriterState::Fenced(_)) {
            self.revalidated()?;
        }
        if self.last_is_anchor || self.sealed {
            let _writing = crate::log_epoch::writing_dir(&self.dir);
            let end = self.ready()?;
            self.alone(end)?;
            // As a barrier ends: this writer may have lost the log since its last one, and then closed nothing.
            self.revalidated()?;
            return Ok(None);
        }
        self.append(Vec::new(), true).map(Some)
    }

    /// Fences the writer when it no longer owns the log; nothing was applied.
    fn revalidated(&mut self) -> Result<(), AppendError> {
        if let Err(reason) = self.deps.ownership.revalidate() {
            self.state = WriterState::Fenced(reason);
            return Err(AppendError::Fenced { reason, outcome: Outcome::NotApplied });
        }
        Ok(())
    }

    fn ready(&mut self) -> Result<u64, AppendError> {
        match self.state.clone() {
            WriterState::Clean { end } => Ok(end),
            WriterState::PendingRollback { target, .. } => {
                self.revalidated()?;
                let file = self.file_handle().map_err(AppendError::Refused)?;
                match truncate_fault().and_then(|()| file.truncate(target)).and_then(|()| file.sync()) {
                    Ok(()) => {
                        self.state = WriterState::Clean { end: target };
                        Ok(target)
                    }
                    Err(e) => Err(AppendError::Refused(self.io_err(IoOp::Truncate, e))),
                }
            }
            WriterState::Fenced(reason) => Err(AppendError::Fenced { reason, outcome: Outcome::NotApplied }),
            WriterState::Dirty { .. } | WriterState::RollingBack { .. } => {
                unreachable!("transient writer state outside a barrier")
            }
        }
    }

    /// This writer is still the log's only one: its file ends where this writer's last frame ended (`end`). A file
    /// that grew past it holds frames another writer appended after this writer's copy (Node's save refused because
    /// another writer recorded after this copy, `ESESSIONCHANGED`): nothing of the batch is written, as it would land
    /// over them.
    fn alone(&mut self, end: u64) -> Result<(), AppendError> {
        let file = self.file_handle().map_err(AppendError::BarrierFailed)?;
        let size = file.size();
        match size {
            Ok(size) if size > end => {
                let grown = io::Error::other(format!("another writer appended {} bytes after this writer's last frame", size - end));
                Err(AppendError::BarrierFailed(self.io_err(IoOp::Write, grown)))
            }
            Ok(_) => Ok(()),
            Err(e) => Err(AppendError::BarrierFailed(self.io_err(IoOp::Open, e))),
        }
    }

    fn path(&self, file_no: u32) -> PathBuf {
        self.dir.join(log_name(file_no))
    }

    fn io_err(&self, op: IoOp, source: io::Error) -> IoError {
        IoError { op, path: self.path(self.file_no), source }
    }

    fn file_handle(&mut self) -> Result<&mut Box<dyn LogFile>, IoError> {
        if self.file.is_none() {
            let path = self.path(self.file_no);
            self.file = Some(self.deps.io.open_append(&path).map_err(err(IoOp::Open, &path))?);
        }
        Ok(self.file.as_mut().expect("opened"))
    }

    fn append(&mut self, batch: Vec<Encoded>, force_checkpoint: bool) -> Result<BatchAck, AppendError> {
        // Held to the end: a pending rollback run first, the write, and the rollback of a write that failed.
        let mut writing = crate::log_epoch::appending_dir(&self.dir);
        // The frames a pending rollback cuts were never acked, and a reader may have folded them.
        if matches!(self.state, WriterState::PendingRollback { .. }) {
            writing.reshape();
        }
        let end = self.ready()?;
        self.alone(end)?;
        let deps = self.deps.clone();
        let batch = self.narrow_changes(batch);

        // Phase 1 of the fold: may fail; nothing is written then.
        let mut lookup = blob_lookup_many(batch.iter().flat_map(|e| &e.blobs), &deps.blobs);
        let effects = self.fold.prepare(batch.iter().map(|e| &e.record), &*deps.index, &mut lookup)?;
        if effects.iter().any(crate::fold::Effect::reshapes) {
            writing.reshape();
        }

        let batch_len: u64 = batch.iter().map(|e| e.frame_len() as u64).sum();
        // A group larger than an in-place group is a group file (FORMAT.md §1, §6.1): its head
        // frame, the members and nothing else, published whole under the number after a gap. Nothing
        // is ever appended to a group file: the batch after it starts the next file.
        let group_file = batch.len() > 1 && batch_len > GROUP_IN_PLACE_MAX;
        let due = force_checkpoint || group_file || self.sealed || self.since_anchor >= CHECKPOINT_EVERY;
        let mut checkpoint = if due || end + batch_len > ROTATE_AT { Some(self.encode_checkpoint()?) } else { None };
        let cp_len = checkpoint.as_ref().map_or(0, |c| c.frame_len() as u64);
        let rotate = group_file || self.sealed || end + cp_len + batch_len > ROTATE_AT;
        if !rotate && !due {
            checkpoint = None;
        }
        let (file_no, base) = match (group_file, rotate) {
            (true, _) => (self.file_no + 2, 0),
            (false, true) => (self.file_no + 1, 0),
            (false, false) => (self.file_no, end),
        };
        let (buf, positions, lens) = frame_batch(&batch, checkpoint.as_ref(), group_file, self.fold.next_ordinal, file_no, base, batch_len);
        for blob in checkpoint.iter().chain(&batch).flat_map(|e| &e.blobs) {
            deps.blobs.put_unlaned(&blob.bytes, |p, b| deps.io.publish(p, b))?;
        }
        self.write_batch(&batch, &buf, rotate, file_no, end)?;
        let frames = self.fold_durable(&batch, checkpoint.is_some(), effects, &positions, &lens, &mut lookup);
        if checkpoint.is_some() {
            self.since_anchor = buf.len() as u64;
        } else {
            self.since_anchor += buf.len() as u64;
        }
        self.last_is_anchor = batch.is_empty() && checkpoint.is_some();
        self.sealed = group_file;
        let skip = usize::from(checkpoint.is_some());
        Ok(BatchAck {
            positions: positions[skip..].to_vec(),
            projection: Projection { session: self.fold.session.clone(), frames, head: std::sync::Arc::new(CatalogHead::of(&self.fold)) },
        })
    }

    #[cfg_attr(not(feature = "crash-hook"), allow(unused_variables, reason = "only the crash hook reads the batch"))]
    fn write_batch(&mut self, batch: &[Encoded], buf: &[u8], rotate: bool, file_no: u32, end: u64) -> Result<(), AppendError> {
        let deps = self.deps.clone();
        #[cfg(feature = "crash-hook")]
        let records: Vec<Record> = batch.iter().map(|e| e.record.clone()).collect();
        #[cfg(feature = "crash-hook")]
        let write_fault = fsio::append_step(fsio::AppendStep::Write, &records).err();
        #[cfg(not(feature = "crash-hook"))]
        let write_fault: Option<io::Error> = None;
        if rotate {
            if let Some(fault) = write_fault {
                return Err(AppendError::BarrierFailed(self.io_err(IoOp::Write, fault)));
            }
            revalidate(&deps)?;
            let path = self.path(file_no);
            // A failed publish leaves the writer Clean on the old file (SM §8 rule 4).
            deps.io.publish(&path, buf).map_err(AppendError::BarrierFailed)?;
            self.file_no = file_no;
            self.file = deps.io.open_append(&path).ok();
            self.state = WriterState::Clean { end: buf.len() as u64 };
        } else {
            let written = end + buf.len() as u64;
            let file = match self.file_handle() {
                Ok(f) => f,
                Err(e) => return Err(AppendError::BarrierFailed(e)),
            };
            let write = match write_fault {
                Some(fault) => file.write_at(end, &buf[..buf.len() / 2]).and(Err(fault)),
                None => file.write_at(end, buf),
            };
            self.state = WriterState::Dirty { acked: end, written };
            if let Err(e) = write {
                return Err(self.roll_back(end, IoOp::Write, e));
            }
            if let Err(reason) = deps.ownership.revalidate() {
                self.state = WriterState::Fenced(reason);
                return Err(AppendError::Fenced { reason, outcome: Outcome::Unknown });
            }
            #[cfg(feature = "crash-hook")]
            let sync_fault = fsio::append_step(fsio::AppendStep::Sync, &records);
            #[cfg(not(feature = "crash-hook"))]
            let sync_fault = Ok(());
            let file = self.file.as_mut().expect("opened");
            if let Err(e) = sync_fault.and_then(|()| file.sync()) {
                return Err(self.roll_back(end, IoOp::SyncFile, e));
            }
            self.state = WriterState::Clean { end: written };
        }
        #[cfg(feature = "crash-hook")]
        let _ = fsio::append_step(fsio::AppendStep::Synced, &records);
        Ok(())
    }

    fn fold_durable(
        &mut self,
        batch: &[Encoded],
        led_by_checkpoint: bool,
        effects: Vec<crate::fold::Effect>,
        positions: &[FramePos],
        lens: &[u64],
        lookup: &mut crate::fold::ResolveBody<'_>,
    ) -> Vec<ProjectedFrame> {
        let mut frames = Vec::with_capacity(positions.len());
        let mut records = batch.iter();
        let mut effects = effects.into_iter();
        for (i, (&pos, &frame_len)) in positions.iter().zip(lens).enumerate() {
            let (effect, kind, op, receipt) = if led_by_checkpoint && i == 0 {
                (crate::fold::Effect::None, crate::projection::FrameKind::Other, None, None)
            } else {
                let record = &records.next().expect("one record per frame").record;
                let (kind, op) = project(record, lookup).expect("batch body readable");
                let receipt = crate::projection::receipt(record, lookup).expect("batch body readable");
                (effects.next().expect("one effect per record"), kind, op, receipt)
            };
            self.fold.apply(effect, pos);
            frames.push(ProjectedFrame {
                pos,
                frame_len,
                kind,
                op,
                receipt,
                history_rev: self.fold.history_rev,
                rows: self.fold.rows,
                visible_rows: self.fold.visible_rows,
            });
        }
        frames
    }

    /// The batch with each header change in the form the log takes it: a map-valued key set over a map as the members that
    /// changed, when that is fewer bytes (`header_patch`). Decided here because this fold's header is exactly what each
    /// record lands on; a change that cannot be read or encoded again is written as it came, and so is all after it.
    fn narrow_changes(&self, batch: Vec<Encoded>) -> Vec<Encoded> {
        if !batch.iter().any(|encoded| matches!(encoded.record, Record::Meta(_))) {
            return batch;
        }
        let mut moved = Some(crate::header_patch::Moved::default());
        batch
            .into_iter()
            .map(|encoded| {
                let (Record::Meta(meta), Some(seen)) = (&encoded.record, moved.as_mut()) else { return encoded };
                let read = {
                    let mut lookup = blob_lookup_many(encoded.blobs.iter(), &self.deps.blobs);
                    resolve_slot(&meta.change, &mut lookup)
                };
                let Ok(change) = read else {
                    moved = None;
                    return encoded;
                };
                let Some(narrow) = seen.narrowed(&self.fold.header, &change) else { return encoded };
                let record = Record::Meta(crate::schema::record::MetaRecord { op: meta.op.clone(), change: crate::schema::blob::Slot::Inline(narrow) });
                crate::encode::encode_record(record).unwrap_or(encoded)
            })
            .collect()
    }

    fn encode_checkpoint(&self) -> Result<Encoded, AppendError> {
        let state = crate::schema::blob::Slot::Inline(self.fold.checkpoint_state());
        Ok(crate::encode::encode_record(Record::Checkpoint(CheckpointRecord { state }))?)
    }

    /// `Dirty → RollingBack → Clean{acked}` (not applied) or `PendingRollback` (unknown).
    fn roll_back(&mut self, target: u64, op: IoOp, cause: io::Error) -> AppendError {
        let cause = self.io_err(op, cause);
        self.state = WriterState::RollingBack { target };
        let file = self.file.as_mut().expect("opened");
        match truncate_fault().and_then(|()| file.truncate(target)).and_then(|()| file.sync()) {
            Ok(()) => {
                self.state = WriterState::Clean { end: target };
                AppendError::BarrierFailed(cause)
            }
            Err(second) => {
                self.state = WriterState::PendingRollback { target, cause: format!("{cause}; rollback: {second}"), second: true };
                AppendError::Indeterminate(cause)
            }
        }
    }
}

/// A rollback's truncate failed by the test hook ([`fsio::AppendStep::Truncate`]); always `Ok` in a build without it.
fn truncate_fault() -> io::Result<()> {
    #[cfg(feature = "crash-hook")]
    return fsio::append_step(fsio::AppendStep::Truncate, &[]);
    #[cfg(not(feature = "crash-hook"))]
    Ok(())
}

fn revalidate(deps: &WriterDeps) -> Result<(), AppendError> {
    deps.ownership.revalidate().map_err(|reason| AppendError::Fenced { reason, outcome: Outcome::NotApplied })
}

fn blob_lookup(blobs: &[PendingBlob]) -> impl FnMut(&crate::schema::blob::BodyBlob) -> Result<Vec<u8>, String> + '_ {
    move |b| {
        blobs
            .iter()
            .find(|p| p.digest == b.descriptor().digest)
            .map(|p| p.bytes.clone())
            .ok_or_else(|| format!("body blob {} not in the batch", b.descriptor().digest))
    }
}

fn blob_lookup_many<'a>(
    pending: impl Iterator<Item = &'a PendingBlob>,
    store: &'a BlobStore,
) -> impl FnMut(&crate::schema::blob::BodyBlob) -> Result<Vec<u8>, String> + 'a {
    let map: HashMap<String, &'a [u8]> = pending.map(|p| (p.digest.as_str().to_owned(), p.bytes.as_slice())).collect();
    move |b| match map.get(b.descriptor().digest.as_str()) {
        Some(bytes) => Ok(bytes.to_vec()),
        None => store.read_unlaned(&b.descriptor().digest).map_err(|e| e.to_string()),
    }
}

/// The write buffer of a batch and the position and frame length of each frame in it, the leading checkpoint's first.
///
/// More than one record frame is a group (FORMAT.md §3.6): the members' count, bytes and SHA-256 are named before
/// them, so recovery takes all of them or none. In place that is a marker frame after the leading checkpoint, which
/// stays outside the group: it is the state before the batch. In a group file the head frame carries both (the
/// checkpoint and the group's fields). No checkpoint follows a group in the same write (§3.6 invariant).
fn frame_batch(
    batch: &[Encoded],
    checkpoint: Option<&Encoded>,
    group_file: bool,
    cp_ordinal: u64,
    file_no: u32,
    base: u64,
    batch_len: u64,
) -> (Vec<u8>, Vec<FramePos>, Vec<u64>) {
    let members = batch.len();
    let first_member = cp_ordinal + u64::from(checkpoint.is_some());
    let head_len = match checkpoint {
        Some(cp) if group_file => GROUP_MARKER_LEN + 1 + cp.payload.len() + FRAME_OVERHEAD,
        Some(cp) => cp.frame_len(),
        None => 0,
    };
    let marker_len = if members > 1 && !group_file { GROUP_MARKER_LEN + FRAME_OVERHEAD } else { 0 };
    let lead = head_len + marker_len;
    let mut buf = vec![0; lead];
    buf.reserve(batch_len as usize);
    let mut positions = Vec::with_capacity(members + 1);
    let mut lens = Vec::with_capacity(members + 1);
    if checkpoint.is_some() {
        positions.push(FramePos { ordinal: cp_ordinal, file_no, offset: base });
        lens.push(head_len as u64);
    }
    for (ordinal, e) in (first_member..).zip(batch) {
        positions.push(FramePos { ordinal, file_no, offset: base + buf.len() as u64 });
        lens.push(e.frame_len() as u64);
        framing::encode_into(&mut buf, ordinal, &e.payload);
    }
    let mut lead_frames = Vec::with_capacity(lead);
    match checkpoint {
        Some(cp) if group_file => framing::encode_into(&mut lead_frames, cp_ordinal, &group_file_head(members as u64, &buf[lead..], &cp.payload)),
        Some(cp) => framing::encode_into(&mut lead_frames, cp_ordinal, &cp.payload),
        None => {}
    }
    if marker_len > 0 {
        framing::encode_into(&mut lead_frames, first_member, &group_marker(members as u64, &buf[lead..]));
    }
    buf[..lead].copy_from_slice(&lead_frames);
    (buf, positions, lens)
}

// ---------------------------------------------------------------------------------------
// Repair

/// `quarantine/session_damage/<escaped key>/`.
pub fn escape_key(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    for b in key.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The quarantine key and folder of this repair of `damage`: the first of the place's keys whose folder holds no
/// reason file (the reason is written last, so such a folder is this repair interrupted).
fn free_quarantine_key(data_dir: &Path, session: &str, damage: Damage) -> (String, PathBuf) {
    use crate::schema::migration::{QUARANTINE_DIR, REASON_FILE};
    let place = format!("damage/{session}/{}/{}", damage.file_no, damage.offset);
    let quarantined = data_dir.join(QUARANTINE_DIR).join("session_damage");
    (1u32..)
        .map(|nth| if nth == 1 { place.clone() } else { format!("{place}/{nth}") })
        .map(|key| {
            let qdir = quarantined.join(escape_key(&key));
            (key, qdir)
        })
        .find(|(_, qdir)| !qdir.join(REASON_FILE).exists())
        .expect("a place has a free quarantine key")
}

/// The user-confirmed `session.repair` (FORMAT.md §3.4): moves the bytes from the damage
/// point to the end of that file, and every newer log file, into quarantine, truncates at
/// the damage point and syncs. A damaged group file (§3.6) is used whole or not at all: it is
/// moved whole, wherever in it the damage was found, and the file before it becomes the newest.
/// The caller then opens the log and appends `meta{set:{repairedAt, repairCutOrdinal}}`.
pub fn repair_damage(_lane: &InLane<DurabilityIo>, data_dir: &Path, session: &str, damage: Damage) -> Result<PathBuf, IoError> {
    use crate::schema::migration::*;
    let dir = data_dir.join("sessions").join(session);
    let _writing = crate::log_epoch::writing(session);
    let (key, qdir) = free_quarantine_key(data_dir, session, damage);
    let files = list_logs(&dir).map_err(|e| match e {
        OpenError::Io(e) => e,
        other => IoError { op: IoOp::List, path: dir.clone(), source: io::Error::other(other.to_string()) },
    })?;
    let path = dir.join(log_name(damage.file_no));
    let whole = is_group_file(&files, damage.file_no);
    let mut sources = Vec::new();
    let mut cut_file = None;
    if !whole {
        let mut file = OpenOptions::new().read(true).write(true).open(&path).map_err(err(IoOp::Open, &path))?;
        let size = file.metadata().map_err(err(IoOp::Read, &path))?.len();
        let cut = read_range(&mut file, &path, damage.offset, (size - damage.offset.min(size)) as usize)?;
        sources.push(QuarantinedSource {
            root: Root::Data,
            path: format!("sessions/{session}/{}", log_name(damage.file_no)),
            sha256: crate::blobs::digest_of(&cut).as_str()["sha256:".len()..].to_owned(),
        });
        fsio::publish_file_unlaned(&qdir.join(log_name(damage.file_no)), &cut)?;
        cut_file = Some(file);
    }
    for &n in files.iter().filter(|&&n| n > damage.file_no || (whole && n == damage.file_no)) {
        let from = dir.join(log_name(n));
        let bytes = std::fs::read(&from).map_err(err(IoOp::Read, &from))?;
        sources.push(QuarantinedSource {
            root: Root::Data,
            path: format!("sessions/{session}/{}", log_name(n)),
            sha256: crate::blobs::digest_of(&bytes).as_str()["sha256:".len()..].to_owned(),
        });
        fsio::create_dir_durable(&qdir)?;
        fsio::durable_rename(&from, &qdir.join(log_name(n)))?;
    }
    let reason = QuarantineReason {
        format: REASON_FORMAT,
        key,
        code: QuarantineCode::SessionDamage,
        expected: QuarantineCode::SessionDamage.expected(),
        detail: format!("damaged frame at ordinal {}", damage.ordinal),
        sources,
    };
    let reason = serde_json::to_vec(&reason).expect("reason encodes");
    fsio::publish_file_unlaned(&qdir.join(REASON_FILE), &reason)?;
    if let Some(file) = cut_file {
        file.set_len(damage.offset).map_err(err(IoOp::Truncate, &path))?;
        fsio::sync_file(&file, &path)?;
    }
    Ok(qdir)
}
