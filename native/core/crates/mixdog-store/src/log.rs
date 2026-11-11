//! Session logs: bounded open (FORMAT.md §6.3), positioned reads, the `LogWriter` state
//! machine (SM §8, SPEC R26) and the damage repair (FORMAT.md §3.4).
//!
//! One `LogWriter` per session, owned by that session's `DurabilityTask`: its barrier, its
//! fsync and its group commit touch only its own files, so a slow session never delays
//! another. A batch is written with one write and one `sync_file`; batches are strictly
//! sequential (the next starts only after this call returns).
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "log file I/O runs only in lane jobs (lane proof arguments)")]

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
use crate::blobs::BlobPin;
use crate::blobs::BlobStore;
use crate::encode::EncodeError;
use crate::encode::Encoded;
use crate::encode::PendingBlob;
use crate::encode::body_slot;
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
use crate::projection::Projection;
use crate::projection::ProjectedFrame;
use crate::projection::project;
use crate::summary::CatalogHead;
use crate::schema::checkpoint::FramePos;
use crate::schema::frame::*;
use crate::schema::record::CheckpointRecord;
use crate::schema::record::Header;
use crate::schema::record::Record;

/// `log.<nnnnnn>`.
pub fn log_name(file_no: u32) -> String {
    format!("{LOG_FILE_PREFIX}{file_no:06}")
}

fn parse_log_name(name: &str) -> Option<u32> {
    let digits = name.strip_prefix(LOG_FILE_PREFIX)?;
    (digits.len() == LOG_FILE_DIGITS && digits.bytes().all(|b| b.is_ascii_digit()))
        .then(|| digits.parse().ok())
        .flatten()
}

/// The log files of a session directory, ascending. Tmp files of `publish_file` are
/// skipped; any other entry is a format error.
pub fn list_logs(dir: &Path) -> Result<Vec<u32>, OpenError> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(err(IoOp::List, dir))? {
        let entry = entry.map_err(err(IoOp::List, dir))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(n) = parse_log_name(&name) {
            files.push(n);
        } else if !fsio::is_tmp_name(&name) {
            return Err(OpenError::Format(format!("unexpected entry {name:?} in {}", dir.display())));
        }
    }
    files.sort_unstable();
    Ok(files)
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
    Torn { offset: u64 },
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
    anchor_offset: u64,
    last_is_anchor: bool,
}

fn read_range(file: &mut File, path: &Path, offset: u64, len: usize) -> Result<Vec<u8>, IoError> {
    let mut buf = vec![0; len];
    file.seek(SeekFrom::Start(offset)).map_err(err(IoOp::Read, path))?;
    file.read_exact(&mut buf).map_err(err(IoOp::Read, path))?;
    Ok(buf)
}

fn parse_record(payload: &[u8]) -> Result<Record, String> {
    serde_json::from_slice(payload).map_err(|e| e.to_string())
}

/// Bounded open of `dir` (FORMAT.md §6.3) in one call: `read_head`, `read_tail`,
/// `decode_tail`. The writer's reopen and tests use it; the session open runs the three
/// steps as separate lane jobs (J1, J2, decode).
pub fn open_log<L: IoLane>(
    lane: &InLane<L>,
    dir: &Path,
    blobs: &BlobStore,
    index: &dyn LineageIndex,
) -> Result<OpenedLog, OpenError> {
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
    let files = list_logs(dir)?;
    let Some(&newest) = files.last() else {
        return Err(OpenError::Missing(dir.to_path_buf()));
    };
    let path = dir.join(log_name(newest));
    let mut file = File::open(&path).map_err(err(IoOp::Open, &path))?;
    let size = file.metadata().map_err(err(IoOp::Read, &path))?.len();

    // Reverse scan: the clean-close case needs the last frame only; the bound is
    // REVERSE_SCAN_MAX (+1 byte so the LF before the anchor is in the window).
    let mut bytes_read = 0u64;
    let mut found = None;
    let mut buf = Vec::new();
    let mut window_start = size;
    for want in [MAX_FRAME_LEN as u64 + 1, REVERSE_SCAN_MAX + 1] {
        let start = size.saturating_sub(want);
        if start >= window_start {
            continue;
        }
        let mut more = read_range(&mut file, &path, start, (window_start - start) as usize)?;
        bytes_read += more.len() as u64;
        more.extend_from_slice(&buf);
        buf = more;
        window_start = start;
        if let Some(a) = framing::reverse_scan(&buf, window_start == 0) {
            found = Some(a);
            break;
        }
    }
    let (anchor_start, anchor_ordinal) = match found {
        Some(a) => (a.start, a.ordinal),
        None => {
            // The format bound does not hold: the newest file is damaged somewhere. Read it
            // whole so the forward scan locates the damage exactly.
            let all = read_range(&mut file, &path, 0, size as usize)?;
            bytes_read += window_start;
            buf = all;
            window_start = 0;
            let ordinal = std::str::from_utf8(buf.get(..ORDINAL_DIGITS).unwrap_or_default())
                .ok()
                .and_then(|t| u64::from_str_radix(t, 16).ok())
                .unwrap_or(0);
            (0, ordinal)
        }
    };
    let scan = framing::scan(&buf, window_start, anchor_start, anchor_ordinal);
    Ok(HeadRead {
        dir: dir.to_path_buf(),
        files,
        newest,
        size,
        buf,
        window_start,
        scan,
        anchor_start,
        anchor_ordinal,
        bytes_read,
    })
}

/// J2's tail part: parses the anchor and the tail, reads the anchor state's blob, and runs
/// the fold's index lookups (a tail rewind below the checkpoint).
pub fn read_tail<L: IoLane>(
    _lane: &InLane<L>,
    head: HeadRead,
    blobs: &BlobStore,
    index: &dyn LineageIndex,
) -> Result<TailRead, OpenError> {
    let HeadRead { ref dir, newest, ref buf, window_start, ref scan, anchor_start, anchor_ordinal, .. } = head;
    let mut bytes_read = head.bytes_read;
    let path = dir.join(log_name(newest));
    let damaged = |offset: u64, ordinal: u64| LogStatus::Damaged(Damage {
        file_no: newest,
        offset,
        ordinal,
    });
    let Some((anchor, tail)) = scan.frames.split_first() else {
        let status = match scan.end {
            ScanEnd::Corrupt { offset, ordinal, .. } => damaged(offset, ordinal),
            _ => damaged(window_start + anchor_start as u64, anchor_ordinal),
        };
        return Err(OpenError::Format(format!("{}: no committed anchor frame ({status:?})", path.display())));
    };
    let anchor_pos = FramePos {
        ordinal: anchor.ordinal,
        file_no: newest,
        offset: window_start + anchor.start as u64,
    };
    let session_name = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut resolve = |b: &crate::schema::blob::BodyBlob| {
        blobs
            .read_unlaned(&b.descriptor().digest)
            .inspect(|bytes| bytes_read += bytes.len() as u64)
            .map_err(|e| e.to_string())
    };
    let fold = match parse_record(anchor.payload(buf)).map_err(OpenError::Format)? {
        Record::Session(s) => {
            if s.id.as_str() != session_name {
                return Err(OpenError::Format(format!("session frame names {:?}", s.id.as_str())));
            }
            let header = resolve_slot(&s.header, &mut resolve).map_err(OpenError::Format)?;
            Fold::from_session(&s, header, anchor_pos)
        }
        Record::Checkpoint(c) => {
            let state = resolve_slot(&c.state, &mut resolve).map_err(OpenError::Format)?;
            if state.covers_ordinal != anchor.ordinal {
                return Err(OpenError::Format(format!(
                    "checkpoint at {} covers {}",
                    anchor.ordinal, state.covers_ordinal
                )));
            }
            Fold::from_checkpoint(&session_name, state)
        }
        _ => return Err(OpenError::Format("anchor is not a checkpoint or session".into())),
    };

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
    let effects = fold.prepare(records.iter().map(|(r, _)| r), index, &mut resolve)?;
    let positions: Vec<(FramePos, u64)> = records
        .iter()
        .map(|(_, frame)| {
            let pos = FramePos {
                ordinal: frame.ordinal,
                file_no: newest,
                offset: window_start + frame.start as u64,
            };
            (pos, window_start + frame.end() as u64)
        })
        .collect();
    if let Some((_, end)) = positions.last() {
        committed_end = *end;
    }
    let anchor_offset = anchor_pos.offset;
    let mut head = head;
    head.bytes_read = bytes_read;
    Ok(TailRead { head, fold, anchor_offset, status, committed_end, records: positions, effects })
}

/// Decode: applies the tail's effects to the anchor fold (CPU only).
pub fn decode_tail(_lane: &InLane<mixdog_rt::CpuInteractive>, tail: TailRead) -> OpenedLog {
    decode_tail_unlaned(tail)
}

fn decode_tail_unlaned(tail: TailRead) -> OpenedLog {
    let TailRead { head, mut fold, anchor_offset, status, committed_end, records, effects } = tail;
    let last_is_anchor = records.is_empty();
    for (effect, (pos, _)) in effects.into_iter().zip(records) {
        fold.apply(effect, pos);
    }
    OpenedLog {
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
    let buf = match read_range(&mut file, &path, pos.offset, frame_len as usize) {
        Ok(b) => b,
        Err(e) if e.source.kind() == io::ErrorKind::UnexpectedEof => return Err(damaged()),
        Err(e) => return Err(e.into()),
    };
    let payload = framing::check_frame(&buf, pos.ordinal).map_err(|_| damaged())?;
    Ok(payload.to_vec())
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
pub fn read_frame<L: IoLane>(
    _lane: &InLane<L>,
    dir: &Path,
    pos: FramePos,
    frame_len: u64,
) -> Result<Record, ReadError> {
    read_frame_unlaned(dir, pos, frame_len)
}

pub(crate) fn read_frame_unlaned(dir: &Path, pos: FramePos, frame_len: u64) -> Result<Record, ReadError> {
    let path = dir.join(log_name(pos.file_no));
    let damaged = || ReadError::Damaged(Damage {
        file_no: pos.file_no,
        offset: pos.offset,
        ordinal: pos.ordinal,
    });
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
    std::str::from_utf8(&digits)
        .ok()
        .and_then(|t| u64::from_str_radix(t, 16).ok())
        .ok_or_else(|| OpenError::Format(format!("{}: no frame header", path.display())))
}

/// `read_frame` when only the position is known (open-set records, whose checkpoint
/// entries carry `FramePos`): the header names the length.
pub fn read_frame_at<L: IoLane>(lane: &InLane<L>, dir: &Path, pos: FramePos) -> Result<Record, ReadError> {
    let path = dir.join(log_name(pos.file_no));
    let damaged = || ReadError::Damaged(Damage {
        file_no: pos.file_no,
        offset: pos.offset,
        ordinal: pos.ordinal,
    });
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
    Done { file_no: u32, end: u64, torn: bool },
    Damaged(Damage),
}

pub fn read_forward<L: IoLane>(
    _lane: &InLane<L>,
    dir: &Path,
    from: FramePos,
    max_bytes: u64,
) -> Result<ForwardRead, OpenError> {
    read_forward_unlaned(dir, from, max_bytes)
}

pub(crate) fn read_forward_unlaned(dir: &Path, from: FramePos, max_bytes: u64) -> Result<ForwardRead, OpenError> {
    let files = list_logs(dir)?;
    let newest = *files.last().ok_or_else(|| OpenError::Missing(dir.to_path_buf()))?;
    let path = dir.join(log_name(from.file_no));
    let mut file = File::open(&path).map_err(err(IoOp::Open, &path))?;
    let size = file.metadata().map_err(err(IoOp::Read, &path))?.len();
    let window = max_bytes.max(MAX_FRAME_LEN as u64);
    let mut len = (size - from.offset.min(size)).min(window);
    loop {
        let buf = read_range(&mut file, &path, from.offset, len as usize)?;
        let final_window = from.offset + len == size;
        let scan = framing::scan(&buf, from.offset, 0, from.ordinal);
        let mut frames = Vec::with_capacity(scan.frames.len());
        let mut damage = None;
        for f in &scan.frames {
            let pos = FramePos {
                ordinal: f.ordinal,
                file_no: from.file_no,
                offset: from.offset + f.start as u64,
            };
            match parse_record(f.payload(&buf)) {
                Ok(r) => frames.push((r, pos, f.frame_len() as u64)),
                Err(_) => {
                    damage = Some(Damage { file_no: from.file_no, offset: pos.offset, ordinal: pos.ordinal });
                    break;
                }
            }
        }
        let after = frames
            .last()
            .map_or(from, |(_, p, l)| FramePos { ordinal: p.ordinal + 1, file_no: p.file_no, offset: p.offset + l });
        let next = if let Some(d) = damage {
            ForwardEnd::Damaged(d)
        } else {
            match scan.end {
                ScanEnd::Corrupt { offset, ordinal, .. } => ForwardEnd::Damaged(Damage { file_no: from.file_no, offset, ordinal }),
                ScanEnd::Clean if final_window && from.file_no < newest => {
                    let next_no = files.iter().copied().find(|&n| n > from.file_no).expect("newer file");
                    ForwardEnd::More(FramePos { ordinal: after.ordinal, file_no: next_no, offset: 0 })
                }
                ScanEnd::Clean | ScanEnd::Torn { .. } if final_window => ForwardEnd::Done {
                    file_no: from.file_no,
                    end: after.offset,
                    torn: matches!(scan.end, ScanEnd::Torn { .. }),
                },
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

// ---------------------------------------------------------------------------------------
// Writer

/// The log file operations of the writer; the production impl is `OsIo`. Tests inject
/// faults here (SM §11.8 §8 transitions, RL G3 (e)).
pub trait LogFile: Send {
    fn write_at(&mut self, offset: u64, bytes: &[u8]) -> io::Result<()>;
    fn sync(&mut self) -> io::Result<()>;
    fn truncate(&mut self, len: u64) -> io::Result<()>;
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
    Clean { end: u64 },
    Dirty { acked: u64, written: u64 },
    RollingBack { target: u64 },
    /// Persistent in memory until a rollback succeeds; no timer (SM §8 rule 2).
    PendingRollback { target: u64, cause: String, second: bool },
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
}

impl std::fmt::Debug for LogWriter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LogWriter")
            .field("dir", &self.dir)
            .field("file_no", &self.file_no)
            .field("state", &self.state)
            .finish()
    }
}

impl LogWriter {
    /// Creates `dir` with `log.000000` holding the `session` frame (published whole). The
    /// catalog row (`dirty = 1`) is committed by the caller before this (RL §9.2 rule 4).
    pub fn create(
        _lane: &InLane<DurabilityIo>,
        dir: &Path,
        session: Encoded,
        deps: WriterDeps,
    ) -> Result<(LogWriter, BatchAck), AppendError> {
        let Record::Session(record) = &session.record else {
            return Err(FoldError::Unexpected("first record must be a session").into());
        };
        let start = record.base.as_ref().map_or(0, |b| b.end_ordinal_exclusive);
        let mut pins = Vec::new();
        for blob in &session.blobs {
            pins.push(deps.blobs.put_unlaned(&blob.bytes, |p, b| deps.io.publish(p, b))?);
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
            head: CatalogHead::of(&fold),
            frames: vec![ProjectedFrame {
                pos,
                frame_len: buf.len() as u64,
                kind,
                op,
                history_rev: 0,
                rows: 0,
                visible_rows: 0,
            }],
            pins,
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
        };
        Ok((writer, BatchAck { positions: vec![pos], projection }))
    }

    /// Open-for-append (SM §8 `Opening`): sweep tmp files, truncate a torn tail.
    pub fn open(
        _lane: &InLane<DurabilityIo>,
        opened: OpenedLog,
        deps: WriterDeps,
    ) -> Result<LogWriter, OpenAppendError> {
        if let LogStatus::Damaged(d) = opened.status {
            return Err(OpenAppendError::StoreDamaged(d));
        }
        fsio::sweep_tmp_unlaned(&opened.dir)?;
        let path = opened.dir.join(log_name(opened.newest_file_no));
        let mut file = deps.io.open_append(&path).map_err(err(IoOp::Open, &path))?;
        let state = match opened.status {
            LogStatus::Torn { offset } => match file.truncate(offset).and_then(|()| file.sync()) {
                Ok(()) => WriterState::Clean { end: offset },
                Err(e) => WriterState::PendingRollback {
                    target: offset,
                    cause: e.to_string(),
                    second: false,
                },
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
        self.ready().map(|_| ())
    }

    /// Writes `batch` as one write batch with one barrier (write + `revalidate` +
    /// `sync_file`). Its blobs are published first. A checkpoint leads the batch once
    /// `CHECKPOINT_EVERY` bytes were written since the last one; a batch that would pass
    /// `ROTATE_AT` goes to a new file published whole, starting with a checkpoint.
    pub fn append_barrier(
        &mut self,
        _lane: &InLane<DurabilityIo>,
        batch: Vec<Encoded>,
    ) -> Result<BatchAck, AppendError> {
        self.append(batch, false)
    }

    /// Clean close: ends the file with a checkpoint unless its last frame is one.
    pub fn close(&mut self, _lane: &InLane<DurabilityIo>) -> Result<Option<BatchAck>, AppendError> {
        if self.last_is_anchor {
            return Ok(None);
        }
        self.append(Vec::new(), true).map(Some)
    }

    fn ready(&mut self) -> Result<u64, AppendError> {
        match self.state.clone() {
            WriterState::Clean { end } => Ok(end),
            WriterState::PendingRollback { target, .. } => {
                let file = self.file_handle().map_err(AppendError::Refused)?;
                match file.truncate(target).and_then(|()| file.sync()) {
                    Ok(()) => {
                        self.state = WriterState::Clean { end: target };
                        Ok(target)
                    }
                    Err(e) => Err(AppendError::Refused(self.io_err(IoOp::Truncate, e))),
                }
            }
            WriterState::Fenced(reason) => Err(AppendError::Fenced {
                reason,
                outcome: Outcome::NotApplied,
            }),
            WriterState::Dirty { .. } | WriterState::RollingBack { .. } => {
                unreachable!("transient writer state outside a barrier")
            }
        }
    }

    fn path(&self, file_no: u32) -> PathBuf {
        self.dir.join(log_name(file_no))
    }

    fn io_err(&self, op: IoOp, source: io::Error) -> IoError {
        IoError {
            op,
            path: self.path(self.file_no),
            source,
        }
    }

    fn file_handle(&mut self) -> Result<&mut Box<dyn LogFile>, IoError> {
        if self.file.is_none() {
            let path = self.path(self.file_no);
            self.file = Some(self.deps.io.open_append(&path).map_err(err(IoOp::Open, &path))?);
        }
        Ok(self.file.as_mut().expect("opened"))
    }

    fn append(&mut self, batch: Vec<Encoded>, force_checkpoint: bool) -> Result<BatchAck, AppendError> {
        let end = self.ready()?;
        let deps = self.deps.clone();

        // Phase 1 of the fold: may fail; nothing is written then.
        let mut lookup = blob_lookup_many(batch.iter().flat_map(|e| &e.blobs), &deps.blobs);
        let effects = self
            .fold
            .prepare(batch.iter().map(|e| &e.record), &*deps.index, &mut lookup)?;



        let batch_len: u64 = batch.iter().map(|e| e.frame_len() as u64).sum();
        let due = force_checkpoint || self.since_anchor >= CHECKPOINT_EVERY;
        let mut checkpoint = if due || end + batch_len > ROTATE_AT {
            Some(self.encode_checkpoint()?)
        } else {
            None
        };
        let cp_len = checkpoint.as_ref().map_or(0, |c| c.frame_len() as u64);
        let rotate = end + cp_len + batch_len > ROTATE_AT;
        if !rotate && !due {
            checkpoint = None;
        }
        let total = batch_len + checkpoint.as_ref().map_or(0, |c| c.frame_len() as u64);
        let (file_no, base) = if rotate { (self.file_no + 1, 0) } else { (self.file_no, end) };
        // A batch over the durability window (one request's whole unit, e.g. an inherited conversation: Node writes it as one
        // record) is still one write and one barrier; a checkpoint of the state after it ends the write, so the newest anchor
        // stays within REVERSE_SCAN_MAX of the end (FORMAT.md §6.3).
        let closing = total > DURABILITY_WINDOW_BYTES;
        // More than one record frame is a group (FORMAT.md §3.6): a marker frame naming the members' count and bytes, then the
        // members, so recovery takes all of them or none (a kill inside the write leaves no prefix of the batch). The leading
        // checkpoint stays outside it: it is the state before the batch, whole on its own, and an anchor the reverse scan may
        // start from.
        let members = batch.len() + usize::from(closing);
        let marker_len = if members > 1 { (GROUP_MARKER_LEN + FRAME_OVERHEAD) as u64 } else { 0 };
        let mut buf = Vec::with_capacity(total as usize + marker_len as usize);
        let mut positions = Vec::with_capacity(batch.len() + 2);
        let mut lens = Vec::with_capacity(batch.len() + 2);
        let mut ordinals = self.fold.next_ordinal..;
        if let Some(cp) = &checkpoint {
            let ordinal = ordinals.next().expect("unbounded");
            positions.push(FramePos { ordinal, file_no, offset: base });
            framing::encode_into(&mut buf, ordinal, &cp.payload);
            lens.push(cp.frame_len() as u64);
        }
        let group_at = buf.len();
        let first_member = self.fold.next_ordinal + u64::from(checkpoint.is_some());
        for (ordinal, e) in ordinals.zip(&batch) {
            let offset = base + marker_len + buf.len() as u64;
            framing::encode_into(&mut buf, ordinal, &e.payload);
            positions.push(FramePos { ordinal, file_no, offset });
            lens.push(e.frame_len() as u64);
        }
        let trailing = if closing {
            let mut after = self.fold.clone();
            let skip = usize::from(checkpoint.is_some());
            if checkpoint.is_some() {
                after.apply(crate::fold::Effect::None, positions[0]);
            }
            for (effect, &pos) in effects.iter().cloned().zip(&positions[skip..]) {
                after.apply(effect, pos);
            }
            let (state, blob) = body_slot(after.checkpoint_state())?;
            let encoded = Encoded::new(Record::Checkpoint(CheckpointRecord { state }), blob.into_iter().collect())?;
            let offset = base + marker_len + buf.len() as u64;
            framing::encode_into(&mut buf, after.next_ordinal, &encoded.payload);
            positions.push(FramePos { ordinal: after.next_ordinal, file_no, offset });
            lens.push(encoded.frame_len() as u64);
            Some(encoded)
        } else {
            None
        };
        if members > 1 {
            let mut marker = Vec::with_capacity(marker_len as usize);
            framing::encode_into(&mut marker, first_member, &group_marker(members as u64, (buf.len() - group_at) as u64));
            debug_assert_eq!(marker.len() as u64, marker_len);
            buf.splice(group_at..group_at, marker);
        }
        // Blobs before the frames that reference them (SM §7.5).
        let mut pins: Vec<BlobPin> = Vec::new();
        for blob in checkpoint.iter().chain(&batch).chain(trailing.iter()).flat_map(|e| &e.blobs) {
            pins.push(deps.blobs.put_unlaned(&blob.bytes, |p, b| deps.io.publish(p, b))?);
        }

        if rotate {
            revalidate(&deps)?;
            let path = self.path(file_no);
            // A failed publish leaves the writer Clean on the old file (SM §8 rule 4).
            deps.io.publish(&path, &buf).map_err(AppendError::BarrierFailed)?;
            self.file_no = file_no;
            self.file = deps.io.open_append(&path).ok();
            self.state = WriterState::Clean { end: buf.len() as u64 };
        } else {
            let written = end + buf.len() as u64;
            let file = match self.file_handle() {
                Ok(f) => f,
                Err(e) => return Err(AppendError::BarrierFailed(e)),
            };
            let write = file.write_at(end, &buf);
            self.state = WriterState::Dirty { acked: end, written };
            if let Err(e) = write {
                return Err(self.roll_back(end, IoOp::Write, e));
            }
            if let Err(reason) = deps.ownership.revalidate() {
                self.state = WriterState::Fenced(reason);
                return Err(AppendError::Fenced { reason, outcome: Outcome::Unknown });
            }
            let file = self.file.as_mut().expect("opened");
            if let Err(e) = file.sync() {
                return Err(self.roll_back(end, IoOp::SyncFile, e));
            }
            self.state = WriterState::Clean { end: written };
        }

        // Durable: phase 2 of the fold, then the projection.
        let mut frames = Vec::with_capacity(positions.len());
        let mut records = batch.iter();
        let mut effects = effects.into_iter();
        let last = positions.len() - 1;
        for (i, (&pos, &frame_len)) in positions.iter().zip(&lens).enumerate() {
            let (effect, kind, op) = if (i == 0 && checkpoint.is_some()) || (i == last && trailing.is_some()) {
                (crate::fold::Effect::None, crate::projection::FrameKind::Other, None)
            } else {
                let record = &records.next().expect("one record per frame").record;
                // The bodies are in the batch (or already stored): the fold read them too.
                let (kind, op) = project(record, &mut lookup).expect("batch body readable");
                (effects.next().expect("one effect per record"), kind, op)
            };
            self.fold.apply(effect, pos);
            frames.push(ProjectedFrame {
                pos,
                frame_len,
                kind,
                op,
                history_rev: self.fold.history_rev,
                rows: self.fold.rows,
                visible_rows: self.fold.visible_rows,
            });
        }
        if let Some(trailing) = &trailing {
            self.since_anchor = trailing.frame_len() as u64;
        } else if checkpoint.is_some() {
            self.since_anchor = buf.len() as u64;
        } else {
            self.since_anchor += buf.len() as u64;
        }
        self.last_is_anchor = trailing.is_some() || (batch.is_empty() && checkpoint.is_some());
        let skip = usize::from(checkpoint.is_some());
        let records_end = positions.len() - usize::from(trailing.is_some());
        Ok(BatchAck {
            positions: positions[skip..records_end].to_vec(),
            projection: Projection {
                session: self.fold.session.clone(),
                frames,
                head: CatalogHead::of(&self.fold),
                pins,
            },
        })
    }

    fn encode_checkpoint(&self) -> Result<Encoded, AppendError> {
        let (state, blob) = body_slot(self.fold.checkpoint_state())?;
        Ok(Encoded::new(
            Record::Checkpoint(CheckpointRecord { state }),
            blob.into_iter().collect(),
        )?)
    }

    /// `Dirty → RollingBack → Clean{acked}` (not applied) or `PendingRollback` (unknown).
    fn roll_back(&mut self, target: u64, op: IoOp, cause: io::Error) -> AppendError {
        let cause = self.io_err(op, cause);
        self.state = WriterState::RollingBack { target };
        let file = self.file.as_mut().expect("opened");
        match file.truncate(target).and_then(|()| file.sync()) {
            Ok(()) => {
                self.state = WriterState::Clean { end: target };
                AppendError::BarrierFailed(cause)
            }
            Err(second) => {
                self.state = WriterState::PendingRollback {
                    target,
                    cause: format!("{cause}; rollback: {second}"),
                    second: true,
                };
                AppendError::Indeterminate(cause)
            }
        }
    }
}

fn revalidate(deps: &WriterDeps) -> Result<(), AppendError> {
    deps.ownership.revalidate().map_err(|reason| AppendError::Fenced {
        reason,
        outcome: Outcome::NotApplied,
    })
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
    let map: HashMap<String, &'a [u8]> = pending
        .map(|p| (p.digest.as_str().to_owned(), p.bytes.as_slice()))
        .collect();
    move |b| match map.get(b.descriptor().digest.as_str()) {
        Some(bytes) => Ok(bytes.to_vec()),
        None => store.read_unlaned(&b.descriptor().digest).map_err(|e| e.to_string()),
    }
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

/// The user-confirmed `session.repair` (FORMAT.md §3.4): moves the bytes from the damage
/// point to the end of that file, and every newer log file, into quarantine, truncates at
/// the damage point and syncs. The caller then opens the log and appends
/// `meta{set:{repairedAt, repairCutOrdinal}}`.
pub fn repair_damage(
    _lane: &InLane<DurabilityIo>,
    data_dir: &Path,
    session: &str,
    damage: Damage,
) -> Result<PathBuf, IoError> {
    use crate::schema::migration::*;
    let dir = data_dir.join("sessions").join(session);
    let key = format!("damage/{session}/{}/{}", damage.file_no, damage.offset);
    let qdir = data_dir
        .join(QUARANTINE_DIR)
        .join("session_damage")
        .join(escape_key(&key));
    let files = list_logs(&dir).map_err(|e| match e {
        OpenError::Io(e) => e,
        other => IoError {
            op: IoOp::List,
            path: dir.clone(),
            source: io::Error::other(other.to_string()),
        },
    })?;
    let path = dir.join(log_name(damage.file_no));
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .map_err(err(IoOp::Open, &path))?;
    let size = file.metadata().map_err(err(IoOp::Read, &path))?.len();
    let cut = read_range(&mut file, &path, damage.offset, (size - damage.offset.min(size)) as usize)?;
    let mut sources = vec![QuarantinedSource {
        root: Root::Data,
        path: format!("sessions/{session}/{}", log_name(damage.file_no)),
        sha256: crate::blobs::digest_of(&cut).as_str()["sha256:".len()..].to_owned(),
    }];
    fsio::publish_file_unlaned(&qdir.join(log_name(damage.file_no)), &cut)?;
    for &n in files.iter().filter(|&&n| n > damage.file_no) {
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
    file.set_len(damage.offset).map_err(err(IoOp::Truncate, &path))?;
    fsio::sync_file(&file, &path)?;
    Ok(qdir)
}
