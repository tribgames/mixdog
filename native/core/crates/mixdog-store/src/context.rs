//! The model context of a thread (FORMAT.md §6.4): the lineage's model messages since the
//! newest live compaction, oldest first, each with its live body (an amend's, if any). It
//! is the transcript 1.4.5 replays from its last `compacted` record
//! (`session-log-reader.mjs`: the replacement, then every later message, edits applied).
//!
//! A read is paged and every step is one lane job:
//! 1. `SqliteStore::context_page_on_lane` (interactive I/O): the page's rows from the index
//!    (`message_rows`) and their frames, read and checked; at most `limit` rows and
//!    `PAGE_MAX_BYTES` of frames (at least one row).
//! 2. [`decode_context`] (interactive CPU): the records parsed, inline bodies taken.
//! 3. [`read_context_blobs`] (interactive I/O), only when [`DecodedContext::needs_blobs`]:
//!    the out-of-line bodies.
//! 4. [`finish_context`] (interactive CPU): those bodies parsed; the page's messages.
#![allow(clippy::disallowed_types, reason = "mixdog-store::context reads the sqlite projection")]

use std::collections::HashMap;
use std::path::Path;

use mixdog_rt::CpuInteractive;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::params;
use serde_json::Value;

use crate::blobs::BlobError;
use crate::blobs::BlobStore;
use crate::log::ReadError;
use crate::log::parse_frame_payload;
use crate::log::read_frame_payload;
use crate::schema::blob::BodyBlob;
use crate::schema::blob::Slot;
use crate::schema::checkpoint::FramePos;
use crate::schema::record::Record;
use crate::sqlite::DbError;
use crate::sqlite::LineageLevel;
use crate::sqlite::PAGE_MAX_BYTES;

/// Where the next page starts. A page read after the thread's history changed (a rewind,
/// or a new model-context start) fails with `DbError::CursorStale`; the read restarts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContextCursor {
    history_rev: u64,
    start: (usize, u64),
    span: usize,
    from: (u64, u32),
}

/// One message of the context: row `iid` at `(ordinal, idx)` of `session` (`idx` is the
/// entry of a `compacted` replacement, else 0); its live body is in the frame at `body`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextRow {
    pub session: String,
    pub ordinal: u64,
    pub idx: u32,
    pub iid: String,
    pub body: FramePos,
    pub frame_len: u64,
}

/// One page as read by step 1: its rows and their frames, checked, not parsed.
#[derive(Debug)]
pub struct ContextPage {
    pub rows: Vec<ContextRow>,
    frames: HashMap<(String, u64), Vec<u8>>,
    pub next: Option<ContextCursor>,
}

/// A message of the context: the 1.4.5 message object (`role`, `content`, …).
#[derive(Debug, Clone, PartialEq)]
pub struct ContextMessage {
    pub iid: String,
    pub body: Value,
}

#[derive(Debug, thiserror::Error)]
pub enum ContextError {
    #[error(transparent)]
    Db(#[from] DbError),
    #[error(transparent)]
    Read(#[from] ReadError),
    #[error(transparent)]
    Blob(#[from] BlobError),
    /// The frame an index row names does not hold that row's body: the index is not the
    /// log's projection (rebuild it).
    #[error("context row {iid} at {pos:?}: {reason}")]
    Mismatch { iid: String, pos: FramePos, reason: String },
}

/// One run of rows of one lineage level from ordinal `from`: the live rows (`as_of` `None`),
/// or those below `as_of` as they were then.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Span {
    level: usize,
    from: u64,
    as_of: Option<u64>,
}

/// The newest compaction of the session live now.
pub(crate) const CONTEXT_START_SQL: &str = "SELECT ordinal FROM compactions
     WHERE session = ?1 AND superseded_rev IS NULL ORDER BY ordinal DESC LIMIT 1";

/// The newest compaction of a base below `?2`, live as of `?2`.
pub(crate) const CONTEXT_BASE_START_SQL: &str = "SELECT ordinal FROM compactions
     WHERE session = ?1 AND ordinal < ?2 AND (superseded_rev IS NULL OR superseded_rev >= ?2)
     ORDER BY ordinal DESC LIMIT 1";

/// The session's live rows from `(?2, ?3)`, in context order.
pub(crate) const CONTEXT_LIVE_SQL: &str = "SELECT ordinal, idx, ver, iid, file_no, frame_offset, frame_len
     FROM message_rows INDEXED BY message_rows_live
     WHERE session = ?1 AND live = 1 AND (ordinal, idx) >= (?2, ?3) ORDER BY ordinal, idx LIMIT ?4";

/// A base's row versions from `(?2, ?3)` below `?4`, current as of `?4`, in context order;
/// the newest version of a row is its last.
pub(crate) const CONTEXT_BASE_SQL: &str = "SELECT ordinal, idx, ver, iid, file_no, frame_offset, frame_len
     FROM message_rows WHERE session = ?1 AND (ordinal, idx) >= (?2, ?3) AND ordinal < ?4 AND ver < ?4
       AND (superseded_rev IS NULL OR superseded_rev >= ?4) ORDER BY ordinal, idx, ver LIMIT ?5";

/// The newest version of one base row as of `?4`.
pub(crate) const CONTEXT_BASE_ROW_SQL: &str = "SELECT ordinal, idx, ver, iid, file_no, frame_offset, frame_len
     FROM message_rows WHERE session = ?1 AND ordinal = ?2 AND idx = ?3 AND ver < ?4
       AND (superseded_rev IS NULL OR superseded_rev >= ?4) ORDER BY ver DESC LIMIT 1";

/// The spans of the context, oldest first: from the session down its lineage until a level
/// holds a compaction (the context starts at it), else to the root. A base level ends at
/// the fork point, or lower at `cut` (the session rewound into its base range), and is
/// read as of that point, so later base appends, amends and rewinds do not reach it.
fn plan(c: &Connection, lineage: &[LineageLevel], cut: Option<u64>) -> Result<Vec<Span>, DbError> {
    let mut spans = Vec::new();
    for (level, l) in lineage.iter().enumerate() {
        let (start, as_of) = if level == 0 {
            let start: Option<i64> = c.prepare_cached(CONTEXT_START_SQL)?.query_row([&l.session], |r| r.get(0)).optional()?;
            (start, None)
        } else {
            let bound = l.end.unwrap_or(u64::MAX).min(cut.unwrap_or(u64::MAX));
            let start: Option<i64> = c
                .prepare_cached(CONTEXT_BASE_START_SQL)?
                .query_row(params![l.session, sql_ordinal(bound)], |r| r.get(0))
                .optional()?;
            (start, Some(bound))
        };
        spans.push(Span { level, from: start.map_or(0, |s| s as u64), as_of });
        if start.is_some() {
            break;
        }
    }
    spans.reverse();
    Ok(spans)
}

fn sql_ordinal(o: u64) -> i64 {
    o.min(i64::MAX as u64) as i64
}

/// `(ordinal, idx, ver, iid, file_no, frame_offset, frame_len)`.
type RawRow = (i64, i64, i64, String, u32, i64, i64);

fn raw(r: &rusqlite::Row<'_>) -> rusqlite::Result<RawRow> {
    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
}

/// Step 1's index part: the rows of one page and the next cursor, in one read snapshot.
pub(crate) fn rows_on(
    c: &Connection,
    lineage: &[LineageLevel],
    cut: Option<u64>,
    cursor: Option<ContextCursor>,
    limit: usize,
) -> Result<(Vec<ContextRow>, Option<ContextCursor>), DbError> {
    let tx = c.unchecked_transaction()?;
    let rev: i64 = tx
        .prepare_cached("SELECT history_rev FROM sessions WHERE id = ?1")?
        .query_row([&lineage[0].session], |r| r.get(0))
        .optional()?
        .unwrap_or(0);
    let spans = plan(&tx, lineage, cut)?;
    let first = &spans[0];
    let start = (first.level, first.from);
    let mut cur = match cursor {
        Some(c) if c.history_rev != rev as u64 || c.start != start => return Err(DbError::CursorStale),
        Some(c) => c,
        None => ContextCursor { history_rev: rev as u64, start, span: 0, from: (first.from, 0) },
    };
    let limit = limit.max(1);
    let mut out: Vec<ContextRow> = Vec::new();
    let mut bytes = 0u64;
    let mut seen: std::collections::HashSet<(usize, i64)> = std::collections::HashSet::new();
    'spans: while cur.span < spans.len() && out.len() < limit {
        let span = &spans[cur.span];
        let session = &lineage[span.level].session;
        let want = limit - out.len();
        let (rows, more): (Vec<RawRow>, bool) = match span.as_of {
            None => {
                let rows: Vec<RawRow> = tx
                    .prepare_cached(CONTEXT_LIVE_SQL)?
                    .query_map(params![session, cur.from.0 as i64, cur.from.1, want as i64], raw)?
                    .collect::<Result<_, _>>()?;
                let more = rows.len() == want;
                (rows, more)
            }
            Some(as_of) => {
                let fetched: Vec<RawRow> = tx
                    .prepare_cached(CONTEXT_BASE_SQL)?
                    .query_map(params![session, cur.from.0 as i64, cur.from.1, sql_ordinal(as_of), want as i64], raw)?
                    .collect::<Result<_, _>>()?;
                let more = fetched.len() == want;
                // The newest version of each row is the last of its run.
                let mut latest: Vec<RawRow> = Vec::new();
                for v in fetched {
                    match latest.last_mut() {
                        Some(last) if (last.0, last.1) == (v.0, v.1) => *last = v,
                        _ => latest.push(v),
                    }
                }
                // A full fetch may have cut the last row's versions short.
                if more && let Some(last) = latest.last_mut() {
                    *last = tx
                        .prepare_cached(CONTEXT_BASE_ROW_SQL)?
                        .query_row(params![session, last.0, last.1, sql_ordinal(as_of)], raw)?;
                }
                (latest, more)
            }
        };
        for (ordinal, idx, ver, iid, file_no, offset, len) in rows {
            let key = (span.level, ver);
            let cost = if seen.contains(&key) { 0 } else { len as u64 };
            if !out.is_empty() && bytes + cost > PAGE_MAX_BYTES {
                break 'spans;
            }
            bytes += cost;
            seen.insert(key);
            out.push(ContextRow {
                session: session.clone(),
                ordinal: ordinal as u64,
                idx: idx as u32,
                iid,
                body: FramePos { ordinal: ver as u64, file_no, offset: offset as u64 },
                frame_len: len as u64,
            });
            cur.from = (ordinal as u64, idx as u32 + 1);
        }
        if !more {
            // The span is exhausted: the next starts at its floor.
            cur.span += 1;
            if let Some(next) = spans.get(cur.span) {
                cur.from = (next.from, 0);
            }
        }
    }
    let next = (cur.span < spans.len()).then_some(cur);
    Ok((out, next))
}

/// Step 1's frame part: each distinct frame of `rows` read and checked.
pub(crate) fn read_frames(
    lane: &InLane<InteractiveIo>,
    sessions: &Path,
    rows: Vec<ContextRow>,
    next: Option<ContextCursor>,
) -> Result<ContextPage, ContextError> {
    let mut frames = HashMap::new();
    for row in &rows {
        let key = (row.session.clone(), row.body.ordinal);
        if frames.contains_key(&key) {
            continue;
        }
        let payload = read_frame_payload(lane, &sessions.join(&row.session), row.body, row.frame_len)?;
        frames.insert(key, payload);
    }
    Ok(ContextPage { rows, frames, next })
}

/// A page after step 2: the bodies, some waiting for their out-of-line bytes.
#[derive(Debug)]
pub struct DecodedContext {
    messages: Vec<(String, FramePos, Pending)>,
    pub next: Option<ContextCursor>,
}

#[derive(Debug)]
enum Pending {
    Body(Value),
    /// An out-of-line item or amend body.
    Blob(BodyBlob),
    /// Entry `idx` of an out-of-line replacement.
    Entry(BodyBlob, u32),
}

impl DecodedContext {
    /// Whether step 3 is needed.
    pub fn needs_blobs(&self) -> bool {
        self.messages.iter().any(|(_, _, p)| !matches!(p, Pending::Body(_)))
    }

    fn blobs(&self) -> impl Iterator<Item = &BodyBlob> {
        self.messages.iter().filter_map(|(_, _, p)| match p {
            Pending::Body(_) => None,
            Pending::Blob(b) | Pending::Entry(b, _) => Some(b),
        })
    }
}

/// The out-of-line bodies of a decoded page, by digest.
#[derive(Debug, Default)]
pub struct ContextBlobs(HashMap<String, Vec<u8>>);

/// Step 2 (interactive CPU): parses the page's records and takes each row's body.
pub fn decode_context(lane: &InLane<CpuInteractive>, page: ContextPage) -> Result<DecodedContext, ContextError> {
    let mut records: HashMap<(String, u64), Record> = HashMap::new();
    let mut messages = Vec::with_capacity(page.rows.len());
    for row in page.rows {
        let key = (row.session.clone(), row.body.ordinal);
        if !records.contains_key(&key) {
            let record = parse_frame_payload(lane, row.body, &page.frames[&key])?;
            records.insert(key.clone(), record);
        }
        let mismatch = |reason: &str| ContextError::Mismatch { iid: row.iid.clone(), pos: row.body, reason: reason.to_owned() };
        let pending = match &records[&key] {
            Record::Item(r) if r.iid.as_str() == row.iid => slot(&r.body),
            Record::Amend(r) if r.iid.as_str() == row.iid => slot(&r.body),
            Record::Compacted(r) => match &r.replacement {
                Slot::Inline(entries) => match entries.get(row.idx as usize) {
                    Some(e) if e.iid == row.iid => Pending::Body(e.body.clone()),
                    _ => return Err(mismatch("no such replacement entry")),
                },
                Slot::Blob(b) => Pending::Entry(b.clone(), row.idx),
            },
            _ => return Err(mismatch("not the row's item, amend or compaction")),
        };
        messages.push((row.iid, row.body, pending));
    }
    Ok(DecodedContext { messages, next: page.next })
}

fn slot(s: &Slot<Value>) -> Pending {
    match s {
        Slot::Inline(v) => Pending::Body(v.clone()),
        Slot::Blob(b) => Pending::Blob(b.clone()),
    }
}

/// Step 3 (interactive I/O): the out-of-line bodies of `page`, each read once and verified.
pub fn read_context_blobs(
    lane: &InLane<InteractiveIo>,
    blobs: &BlobStore,
    page: &DecodedContext,
) -> Result<ContextBlobs, ContextError> {
    let mut out = ContextBlobs::default();
    for b in page.blobs() {
        let digest = &b.descriptor().digest;
        if !out.0.contains_key(digest.as_str()) {
            out.0.insert(digest.as_str().to_owned(), blobs.read(lane, digest)?);
        }
    }
    Ok(out)
}

/// Step 4 (interactive CPU): the page's messages, in context order.
pub fn finish_context(
    _lane: &InLane<CpuInteractive>,
    page: DecodedContext,
    blobs: ContextBlobs,
) -> Result<Vec<ContextMessage>, ContextError> {
    let mut entries: HashMap<String, Vec<crate::schema::record::ReplacementEntry>> = HashMap::new();
    let mut out = Vec::with_capacity(page.messages.len());
    for (iid, pos, pending) in page.messages {
        let bad = |reason: String| ContextError::Mismatch { iid: iid.clone(), pos, reason };
        let bytes = |b: &BodyBlob| {
            let d = b.descriptor().digest.as_str();
            blobs.0.get(d).ok_or_else(|| bad(format!("blob {d} not read")))
        };
        let body = match pending {
            Pending::Body(v) => v,
            Pending::Blob(b) => serde_json::from_slice(bytes(&b)?).map_err(|e| bad(e.to_string()))?,
            Pending::Entry(b, idx) => {
                let d = b.descriptor().digest.as_str().to_owned();
                if !entries.contains_key(&d) {
                    let parsed = serde_json::from_slice(bytes(&b)?).map_err(|e| bad(e.to_string()))?;
                    entries.insert(d.clone(), parsed);
                }
                match entries[&d].get(idx as usize) {
                    Some(e) if e.iid == iid => e.body.clone(),
                    _ => return Err(bad("no such replacement entry".into())),
                }
            }
        };
        out.push(ContextMessage { iid, body });
    }
    Ok(out)
}
