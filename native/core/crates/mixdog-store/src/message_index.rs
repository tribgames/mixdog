//! The catalog's message state in the index (FORMAT.md §8.2 `message_rows`,
//! `message_epochs`, `message_views`), maintained inside the projection transaction of each
//! frame. Every write is O(1) (a rewind is bounded per transaction):
//!
//! - rows are immutable versions keyed by log position; an amend adds a version and a rewind
//!   supersedes the versions after its cut, so the earlier version comes back;
//! - the aggregates are per epoch (the root, or a live `compacted` frame) and move by deltas;
//! - a fork inherits a snapshot of its base as of the fork position (`message_views`), taken
//!   at creation, or by bounded maintenance steps while `pending`; no lineage is walked.
#![allow(clippy::disallowed_types, reason = "mixdog-store::message_index is part of the sqlite projection")]

use rusqlite::OptionalExtension;
use rusqlite::Transaction;
use rusqlite::params;

use crate::message_state::INCOMING_TAIL_MAX;
use crate::message_state::MessageRow;
use crate::message_state::StatsRows;

// The three lookups are the latest live version of the first/last/incoming rows: each names
// its partial index, which holds exactly the live versions (`INDEXED BY` fails to prepare if
// the index cannot serve the query).
pub(crate) const PREVIEW_SQL: &str = "SELECT preview FROM message_rows INDEXED BY message_rows_preview
     WHERE session = ?1 AND live = 1 AND preview <> '' AND ordinal >= ?2 ORDER BY ordinal, idx LIMIT 1";
pub(crate) const LAST_SQL: &str = "SELECT line, routine FROM message_rows INDEXED BY message_rows_line
     WHERE session = ?1 AND live = 1 AND line <> '' AND ordinal >= ?2 ORDER BY ordinal DESC, idx DESC LIMIT 1";
pub(crate) const INCOMING_SQL: &str = "SELECT place FROM message_rows INDEXED BY message_rows_incoming
     WHERE session = ?1 AND live = 1 AND incoming = 1 AND ordinal >= ?2 ORDER BY ordinal DESC, idx DESC LIMIT ?3";

struct Epoch {
    start: i64,
    count: i64,
    real: i64,
}

/// The newest live epoch (the root, zeros, when the session has none yet).
fn live_epoch(tx: &Transaction<'_>, session: &str) -> rusqlite::Result<Epoch> {
    Ok(tx
        .prepare_cached(
            "SELECT start, count, real FROM message_epochs WHERE session = ?1 AND superseded_rev IS NULL
             ORDER BY start DESC LIMIT 1",
        )?
        .query_row([session], |r| Ok(Epoch { start: r.get(0)?, count: r.get(1)?, real: r.get(2)? }))
        .optional()?
        .unwrap_or(Epoch { start: 0, count: 0, real: 0 }))
}

fn add_to_epoch(tx: &Transaction<'_>, session: &str, start: i64, count: i64, real: i64) -> rusqlite::Result<()> {
    tx.prepare_cached("UPDATE message_epochs SET count = count + ?3, real = real + ?4 WHERE session = ?1 AND start = ?2")?
        .execute(params![session, start, count, real])?;
    Ok(())
}

fn ensure_root(tx: &Transaction<'_>, session: &str) -> rusqlite::Result<()> {
    tx.prepare_cached("INSERT OR IGNORE INTO message_epochs (session, start, count, real, superseded_rev) VALUES (?1, 0, 0, 0, NULL)")?
        .execute([session])?;
    Ok(())
}

/// What a fork inherited.
struct View {
    base: String,
    pending: bool,
    position: i64,
    cut: i64,
    count: i64,
    real: i64,
    preview: String,
    line: String,
    routine: String,
    incoming: Vec<u64>,
}

fn incoming_of(text: String) -> rusqlite::Result<Vec<u64>> {
    serde_json::from_str(&text)
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))
}

/// The newest live view of a fork.
fn live_view(tx: &Transaction<'_>, session: &str) -> rusqlite::Result<Option<View>> {
    tx.prepare_cached(
        "SELECT base, state, position, cut, count, real, preview, line, routine, incoming FROM message_views
         WHERE session = ?1 ORDER BY valid_from DESC LIMIT 1",
    )?
    .query_row([session], |r| {
        Ok(View {
            base: r.get(0)?,
            pending: r.get::<_, String>(1)? == "pending",
            position: r.get(2)?,
            cut: r.get(3)?,
            count: r.get(4)?,
            real: r.get(5)?,
            preview: r.get(6)?,
            line: r.get(7)?,
            routine: r.get(8)?,
            incoming: incoming_of(r.get(9)?)?,
        })
    })
    .optional()
}

/// Whether any live view of `session` is still being computed (a fork of it must wait).
fn any_pending_view(tx: &Transaction<'_>, session: &str) -> rusqlite::Result<bool> {
    Ok(tx
        .prepare_cached("SELECT 1 FROM message_views WHERE session = ?1 AND state = 'pending' LIMIT 1")?
        .query_row([session], |_| Ok(()))
        .optional()?
        .is_some())
}

/// Whether the session's inherited state is still being computed (its row waits).
pub(crate) fn has_pending_view(tx: &Transaction<'_>, session: &str) -> rusqlite::Result<bool> {
    Ok(live_view(tx, session)?.is_some_and(|v| v.pending))
}

/// The catalog stats of `session`: the live epoch's aggregates plus, for the root epoch of a
/// fork, the inherited view. Seeks only. `incoming` is read for home and room sessions.
pub(crate) fn read_stats(tx: &Transaction<'_>, session: &str, with_incoming: bool) -> rusqlite::Result<StatsRows> {
    let e = live_epoch(tx, session)?;
    let view = if e.start == 0 { live_view(tx, session)? } else { None };
    let (vc, vr) = view.as_ref().map_or((0, 0), |v| (v.count, v.real));
    let preview = match view.as_ref().filter(|v| !v.preview.is_empty()) {
        Some(v) => v.preview.clone(),
        None => tx.prepare_cached(PREVIEW_SQL)?.query_row(params![session, e.start], |r| r.get(0)).optional()?.unwrap_or_default(),
    };
    let own_last: Option<(String, String)> =
        tx.prepare_cached(LAST_SQL)?.query_row(params![session, e.start], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    let last = own_last.or_else(|| view.as_ref().filter(|v| !v.line.is_empty()).map(|v| (v.line.clone(), v.routine.clone())));
    let mut incoming: Vec<u64> = Vec::new();
    if with_incoming {
        let own: Vec<u64> = tx
            .prepare_cached(INCOMING_SQL)?
            .query_map(params![session, e.start, INCOMING_TAIL_MAX as i64], |r| r.get::<_, i64>(0).map(|p| (p + vc) as u64))?
            .collect::<Result<_, _>>()?;
        if let Some(v) = &view {
            let room = INCOMING_TAIL_MAX - own.len();
            incoming.extend(v.incoming.iter().skip(v.incoming.len().saturating_sub(room)));
        }
        incoming.extend(own.into_iter().rev());
    }
    Ok(StatsRows { count: (e.count + vc) as u64, real: (e.real + vr) as u64, incoming, preview, last })
}

/// `(file_no, frame_offset, frame_len)` of the frame holding a version's body.
pub(crate) type FrameLoc = (i64, i64, i64);

fn put_version(
    tx: &Transaction<'_>,
    session: &str,
    key: (i64, i64, i64),
    loc: FrameLoc,
    iid: &str,
    row: &MessageRow,
    place: i64,
) -> rusqlite::Result<()> {
    tx.prepare_cached(
        "INSERT OR REPLACE INTO message_rows (session, ordinal, idx, ver, file_no, frame_offset, frame_len, iid,
         counted, real, incoming, place, preview, line, routine, live, superseded_rev)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 1, NULL)",
    )?
    .execute(params![
        session, key.0, key.1, key.2, loc.0, loc.1, loc.2, iid, row.counted, row.real, row.incoming, place, row.preview,
        row.line, row.routine
    ])?;
    Ok(())
}

/// A model message item at `ordinal`, in the frame at `loc`.
pub(crate) fn add_item(
    tx: &Transaction<'_>,
    session: &str,
    ordinal: i64,
    loc: FrameLoc,
    iid: &str,
    row: &MessageRow,
) -> rusqlite::Result<()> {
    ensure_root(tx, session)?;
    let e = live_epoch(tx, session)?;
    put_version(tx, session, (ordinal, 0, ordinal), loc, iid, row, e.count + i64::from(row.counted))?;
    add_to_epoch(tx, session, e.start, i64::from(row.counted), i64::from(row.real))
}

/// A `compacted` frame at `loc`: a new epoch whose rows are the replacement; its totals
/// count from it.
pub(crate) fn add_compaction(
    tx: &Transaction<'_>,
    session: &str,
    ordinal: i64,
    loc: FrameLoc,
    rows: &[(String, MessageRow)],
) -> rusqlite::Result<()> {
    let (mut count, mut real) = (0, 0);
    for (idx, (iid, row)) in rows.iter().enumerate() {
        count += i64::from(row.counted);
        real += i64::from(row.real);
        put_version(tx, session, (ordinal, idx as i64, ordinal), loc, iid, row, count)?;
    }
    tx.prepare_cached("INSERT OR REPLACE INTO message_epochs (session, start, count, real, superseded_rev) VALUES (?1, ?2, ?3, ?4, NULL)")?
        .execute(params![session, ordinal, count, real])?;
    Ok(())
}

/// The live epoch that holds the row at `ordinal`, as `(start, superseded by rewind `rev`)`.
fn epoch_of(tx: &Transaction<'_>, session: &str, ordinal: i64, rev: i64) -> rusqlite::Result<Option<(i64, bool)>> {
    tx.prepare_cached(
        "SELECT start, superseded_rev IS NOT NULL FROM message_epochs WHERE session = ?1 AND start <= ?2
         AND (superseded_rev IS NULL OR superseded_rev = ?3) ORDER BY start DESC LIMIT 1",
    )?
    .query_row(params![session, ordinal, rev], |r| Ok((r.get(0)?, r.get(1)?)))
    .optional()
}

/// An amend of message `iid` (an item or a replacement entry alike: 1.4.5 edits the message
/// in `session.messages` in place and its summary re-reads that array,
/// `_sessionMessageProjection`): a new version of the row, whose place and role-derived
/// `counted` stay the row's; the epoch's `real` moves by the difference.
pub(crate) fn amend(
    tx: &Transaction<'_>,
    session: &str,
    iid: &str,
    at: i64,
    loc: FrameLoc,
    new: &MessageRow,
) -> rusqlite::Result<()> {
    let old: Option<(i64, i64, i64, bool, bool, i64)> = tx
        .prepare_cached(
            "SELECT ordinal, idx, ver, counted, real, place FROM message_rows
             WHERE session = ?1 AND iid = ?2 AND live = 1 ORDER BY ordinal DESC, idx DESC LIMIT 1",
        )?
        .query_row(params![session, iid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
        .optional()?;
    let Some((ordinal, idx, ver, counted, real, place)) = old else { return Ok(()) };
    let row = MessageRow { counted, incoming: new.incoming && counted, ..new.clone() };
    tx.prepare_cached("UPDATE message_rows SET live = 0 WHERE session = ?1 AND ordinal = ?2 AND idx = ?3 AND ver = ?4")?
        .execute(params![session, ordinal, idx, ver])?;
    put_version(tx, session, (ordinal, idx, at), loc, iid, &row, place)?;
    if let Some((start, _)) = epoch_of(tx, session, ordinal, -1)? {
        add_to_epoch(tx, session, start, 0, i64::from(row.real) - i64::from(real))?;
    }
    Ok(())
}

/// A rewind at ordinal `at` to `to`, within `budget` rows: supersedes the epochs, views and
/// versions it removes and moves the aggregates by the contributions that go; a version
/// that stops being current hands its row back to the previous version. Resumable: what is
/// superseded is never selected again.
pub(crate) fn rewind(tx: &Transaction<'_>, session: &str, to: i64, at: i64, budget: usize) -> rusqlite::Result<(usize, bool)> {
    // Every chunk below is limited by what is left of `budget`; what a chunk supersedes is
    // never selected again, so a rewind resumes where it stopped.
    let mut used = 0usize;
    let left = |used: usize| budget.saturating_sub(used);
    if left(used) == 0 {
        return Ok((used, false));
    }
    let n = tx
        .prepare_cached(
            "UPDATE message_epochs SET superseded_rev = ?3 WHERE session = ?1 AND start IN
             (SELECT start FROM message_epochs WHERE session = ?1 AND start > 0 AND start >= ?2 AND start < ?3
              AND superseded_rev IS NULL LIMIT ?4)",
        )?
        .execute(params![session, to, at, left(used) as i64])?;
    used += n;
    if n >= left(used - n) {
        return Ok((used, false));
    }
    if left(used) == 0 {
        return Ok((used, false));
    }
    if let Some(view) = live_view(tx, session)?
        && to < view.cut
    {
        // Rewound into the base range: the base frames below `to`, live at the fork, are
        // what the child inherits now.
        open_view(tx, session, at, &view.base, view.position, to)?;
        used += 1;
    }
    // One version costs at most three writes (its supersede, the previous version taking
    // over, the epoch's aggregate).
    loop {
        if left(used) < 3 {
            return Ok((used, false));
        }
        let next: Option<(i64, i64, i64, bool, bool, bool)> = tx
            .prepare_cached(
                "SELECT ordinal, idx, ver, live, counted, real FROM message_rows WHERE session = ?1
                 AND superseded_rev IS NULL AND ver >= ?2 AND ver < ?3 ORDER BY ver DESC LIMIT 1",
            )?
            .query_row(params![session, to, at], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
            )
            .optional()?;
        let Some((ordinal, idx, ver, live, counted, real)) = next else {
            return Ok((used, true));
        };
        used += tx
            .prepare_cached("UPDATE message_rows SET superseded_rev = ?5, live = 0 WHERE session = ?1 AND ordinal = ?2 AND idx = ?3 AND ver = ?4")?
            .execute(params![session, ordinal, idx, ver, at])?;
        if !live {
            continue;
        }
        let epoch = epoch_of(tx, session, ordinal, at)?;
        let previous: Option<(i64, bool)> = tx
            .prepare_cached(
                "SELECT ver, real FROM message_rows WHERE session = ?1 AND ordinal = ?2 AND idx = ?3
                 AND superseded_rev IS NULL ORDER BY ver DESC LIMIT 1",
            )?
            .query_row(params![session, ordinal, idx], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        if let Some((previous_ver, previous_real)) = previous {
            used += tx
                .prepare_cached("UPDATE message_rows SET live = 1 WHERE session = ?1 AND ordinal = ?2 AND idx = ?3 AND ver = ?4")?
                .execute(params![session, ordinal, idx, previous_ver])?;
            if let Some((start, false)) = epoch {
                add_to_epoch(tx, session, start, 0, i64::from(previous_real) - i64::from(real))?;
                used += 1;
            }
        } else if let Some((start, false)) = epoch {
            add_to_epoch(tx, session, start, -i64::from(counted), -i64::from(real))?;
            used += 1;
        }
    }
}

/// The view a fork (re)starts with: its base as of `position`, taken now when the base's
/// projection ends exactly there, else computed by maintenance steps (`pending`).
pub(crate) fn open_view(
    tx: &Transaction<'_>,
    session: &str,
    valid_from: i64,
    base: &str,
    position: i64,
    cut: i64,
) -> rusqlite::Result<()> {
    let projected: Option<i64> =
        tx.prepare_cached("SELECT projected_ordinal FROM sessions WHERE id = ?1")?.query_row([base], |r| r.get(0)).optional()?;
    // Ready now only when the base's projection ends exactly at the fork point (its state
    // is then the snapshot); a base behind it must project first, a base ahead is scanned.
    let now = cut == position && projected == Some(position) && !any_pending_view(tx, base)?;
    let (state, count, real, preview, line, routine, incoming) = if now {
        // The tail is kept for every fork: a fork of this fork may want it.
        let s = read_stats(tx, base, true)?;
        let (line, routine) = s.last.map_or((String::new(), "null".to_owned()), |l| l);
        ("ready", s.count as i64, s.real as i64, s.preview, line, routine, serde_json::to_string(&s.incoming).expect("places encode"))
    } else {
        ("pending", 0, 0, String::new(), String::new(), "null".to_owned(), "[]".to_owned())
    };
    tx.prepare_cached(
        "INSERT OR REPLACE INTO message_views (session, valid_from, base, position, cut, state, count, real, preview,
         line, routine, incoming, hop_session, hop_time, hop_cut, scanning, cur_ordinal, cur_idx)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?3, ?4, ?5, 0, 0, -1)",
    )?
    .execute(params![session, valid_from, base, position, cut, state, count, real, preview, line, routine, incoming])?;
    Ok(())
}

/// What one maintenance step did.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Step {
    /// Nothing runnable (no pending view, or each waits for its base's).
    Idle,
    Progress,
    /// The view of this session is complete: its catalog row can be rebuilt.
    Done(String),
}

type Job = (String, i64, String, i64, i64, bool, i64, i64, i64, i64, String, String, String, String);

/// Advances one runnable pending view by `rows` units: hops down the bases' views, or
/// `rows` rows of the final hop paged by keyset. A view is runnable once its base has
/// projected up to the fork position and has no view of its own pending.
pub(crate) fn view_step(tx: &Transaction<'_>, rows: usize) -> rusqlite::Result<Step> {
    let job: Option<Job> = tx
        .prepare_cached(
            "SELECT v.session, v.valid_from, v.hop_session, v.hop_time, v.hop_cut, v.scanning, v.cur_ordinal,
               v.cur_idx, v.count, v.real, v.preview, v.line, v.routine, v.incoming
             FROM message_views v JOIN sessions b ON b.id = v.base
             WHERE v.state = 'pending' AND b.projected_ordinal >= v.position
               AND NOT EXISTS (SELECT 1 FROM message_views w WHERE w.session = v.base AND w.state = 'pending')
             ORDER BY v.session, v.valid_from LIMIT 1",
        )?
        .query_row([], |r| {
            Ok((
                r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?,
                r.get(9)?, r.get(10)?, r.get(11)?, r.get(12)?, r.get(13)?,
            ))
        })
        .optional()?;
    let Some((session, valid_from, mut hop, time, cut, mut scanning, mut cur_o, mut cur_i, mut count, mut real, mut preview, mut line, mut routine, incoming)) =
        job
    else {
        return Ok(Step::Idle);
    };
    let mut hop_time = time;
    let hop_cut = cut;
    let mut tail: std::collections::VecDeque<u64> = incoming_of(incoming)?.into();
    let mut done = false;
    if !scanning {
        for _ in 0..rows.max(1) {
            // Inside a compaction epoch live at the hop's time the bases' views do not matter.
            let epoch: Option<i64> = tx
                .prepare_cached(
                    "SELECT max(start) FROM message_epochs WHERE session = ?1 AND start > 0 AND start < ?2
                     AND (superseded_rev IS NULL OR superseded_rev >= ?3)",
                )?
                .query_row(params![hop, hop_cut, hop_time], |r| r.get(0))?;
            if let Some(start) = epoch {
                (scanning, cur_o, cur_i) = (true, start, -1);
                break;
            }
            type Inherited = (String, i64, i64, String, i64, i64, String, String, String, String);
            let inherited: Option<Inherited> = tx
                .prepare_cached(
                    "SELECT base, position, cut, state, count, real, preview, line, routine, incoming FROM message_views
                     WHERE session = ?1 AND valid_from < ?2 ORDER BY valid_from DESC LIMIT 1",
                )?
                .query_row(params![hop, hop_time], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?))
                })
                .optional()?;
            match inherited {
                None => {
                    (scanning, cur_o, cur_i) = (true, 0, -1);
                    break;
                }
                Some((_, _, view_cut, state, c, r, p, l, rt, inc)) if hop_cut >= view_cut => {
                    // The inherited snapshot covers everything below the cut: take it.
                    debug_assert_eq!(state, "ready", "a runnable view's bases are ready");
                    (count, real, preview, line, routine) = (c, r, p, l, rt);
                    tail = incoming_of(inc)?.into();
                    (scanning, cur_o, cur_i) = (true, 0, -1);
                    break;
                }
                Some((b, p, ..)) => {
                    // The cut is below the base's own inheritance: that base's frames, as
                    // they were at the base's fork, are what remains.
                    (hop, hop_time) = (b, p);
                }
            }
        }
    } else {
        for _ in 0..rows.max(1) {
            let key: Option<(i64, i64)> = tx
                .prepare_cached(
                    "SELECT ordinal, idx FROM message_rows WHERE session = ?1 AND (ordinal, idx) > (?2, ?3)
                     AND ordinal < ?4 ORDER BY ordinal, idx LIMIT 1",
                )?
                .query_row(params![hop, cur_o, cur_i, hop_cut], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()?;
            let Some((o, i)) = key else {
                done = true;
                break;
            };
            (cur_o, cur_i) = (o, i);
            // The newest version that was live at the hop's time, below the cut.
            let version: Option<(bool, bool, bool, String, String, String)> = tx
                .prepare_cached(
                    "SELECT counted, real, incoming, preview, line, routine FROM message_rows
                     WHERE session = ?1 AND ordinal = ?2 AND idx = ?3 AND ver < ?4
                       AND (superseded_rev IS NULL OR superseded_rev >= ?5) ORDER BY ver DESC LIMIT 1",
                )?
                .query_row(params![hop, o, i, hop_cut, hop_time], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
                })
                .optional()?;
            let Some((counted, is_real, is_incoming, p, l, rt)) = version else { continue };
            count += i64::from(counted);
            real += i64::from(is_real);
            if preview.is_empty() && !p.is_empty() {
                preview = p;
            }
            if !l.is_empty() {
                line = l;
                routine = rt;
            }
            if is_incoming {
                tail.push_back(count as u64);
                if tail.len() > INCOMING_TAIL_MAX {
                    tail.pop_front();
                }
            }
        }
    }
    tx.prepare_cached(
        "UPDATE message_views SET state = ?3, count = ?4, real = ?5, preview = ?6, line = ?7, routine = ?8,
         incoming = ?9, hop_session = ?10, hop_time = ?11, hop_cut = ?12, scanning = ?13, cur_ordinal = ?14,
         cur_idx = ?15 WHERE session = ?1 AND valid_from = ?2",
    )?
    .execute(params![
        session,
        valid_from,
        if done { "ready" } else { "pending" },
        count,
        real,
        preview,
        line,
        routine,
        serde_json::to_string(&tail.iter().collect::<Vec<_>>()).expect("places encode"),
        hop,
        hop_time,
        hop_cut,
        scanning,
        cur_o,
        cur_i
    ])?;
    Ok(if done { Step::Done(session) } else { Step::Progress })
}
