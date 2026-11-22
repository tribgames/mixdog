//! The prompts a thread can be rewound to and what a rewind to one removes, answered from the index: every live prompt
//! of the lineage whatever a window of it holds, a compaction's archived ones included (an occurrence is a target for
//! as long as no rewind superseded it).

use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::params;

use super::DbError;
use super::LineageLevel;
use super::SqliteStore;
use super::counted;
use super::history_rev_on;
use super::level_bounds;
use super::levels;

/// A prompt a rewind can name: its record's place in the lineage and the text the rewind hands back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewindTarget {
    /// The lineage level whose log holds the record (0: the thread's own).
    pub level: usize,
    pub ordinal: u64,
    pub iid: String,
    pub text: String,
}

/// What a rewind to a target removes from the lineage: every live record from the target's on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RewindCut {
    /// The records that show rows.
    pub removed: u64,
    /// The records of the model's history.
    pub messages: u64,
}

const TARGET: &str = "SELECT p.ordinal, h.iid, p.text";
const LIVE: &str = "h.ordinal < ?2 AND h.visible = 1 AND (h.superseded_rev IS NULL OR h.superseded_rev >= ?3)";

fn bound(value: u64) -> i64 {
    value.min(i64::MAX as u64) as i64
}

fn target(level: usize) -> impl Fn(&rusqlite::Row<'_>) -> rusqlite::Result<RewindTarget> {
    move |row| Ok(RewindTarget { level, ordinal: row.get::<_, i64>(0)? as u64, iid: row.get(1)?, text: row.get(2)? })
}

/// The live prompts of the lineage older than `before`, newest first, at most `limit`.
fn targets_on(c: &Connection, lineage: &[LineageLevel], cut: Option<u64>, before: Option<u64>, limit: usize) -> Result<Vec<RewindTarget>, DbError> {
    let sql = format!(
        "{TARGET} FROM prompt_occurrences p CROSS JOIN history h ON h.session = p.session AND h.ordinal = p.ordinal
         WHERE p.session = ?1 AND p.ordinal < ?2 AND (p.superseded_rev IS NULL OR p.superseded_rev >= ?3) AND h.visible = 1
         ORDER BY p.ordinal DESC LIMIT ?4"
    );
    let mut found = Vec::new();
    // A level's ordinals are above its base's: the thread's own prompts are the newest.
    for level in 0..lineage.len() {
        if found.len() >= limit {
            break;
        }
        let (below, floor) = level_bounds(lineage, cut, level, before.unwrap_or(u64::MAX));
        let mut rows = c.prepare_cached(&sql)?;
        let rows = rows.query_map(params![lineage[level].session, bound(below), floor, (limit - found.len()) as i64], target(level))?;
        for row in rows {
            found.push(row?);
        }
    }
    Ok(found)
}

/// The prompt a client's id names: the oldest live one `alias` names (a row shows its submission id before another
/// row's item id), else the oldest whose record is one of `ids`.
fn target_on(c: &Connection, lineage: &[LineageLevel], cut: Option<u64>, ids: &[String], alias: &str) -> Result<Option<RewindTarget>, DbError> {
    let by_alias = format!(
        "{TARGET} FROM history_alias a CROSS JOIN history h ON h.session = a.session AND h.ordinal = a.ordinal
         CROSS JOIN prompt_occurrences p ON p.session = h.session AND p.ordinal = h.ordinal
         WHERE a.session = ?1 AND a.alias = ?4 AND {LIVE} ORDER BY h.ordinal LIMIT 1"
    );
    let by_iid = format!(
        "{TARGET} FROM history h INDEXED BY history_iid
         CROSS JOIN prompt_occurrences p ON p.session = h.session AND p.ordinal = h.ordinal
         WHERE h.session = ?1 AND h.iid = ?4 AND {LIVE} ORDER BY h.ordinal LIMIT 1"
    );
    let names: Vec<(&str, &str)> = Some((by_alias.as_str(), alias))
        .filter(|(_, alias)| !alias.is_empty())
        .into_iter()
        .chain(ids.iter().map(|id| (by_iid.as_str(), id.as_str())))
        .collect();
    for (sql, name) in names {
        // The deepest level is the oldest.
        for level in (0..lineage.len()).rev() {
            let (below, floor) = level_bounds(lineage, cut, level, u64::MAX);
            let found = c.prepare_cached(sql)?.query_row(params![lineage[level].session, bound(below), floor, name], target(level)).optional()?;
            if found.is_some() {
                return Ok(found);
            }
        }
    }
    Ok(None)
}

/// The live records of the lineage from `ordinal` on.
fn cut_on(c: &Connection, lineage: &[LineageLevel], cut: Option<u64>, ordinal: u64) -> Result<RewindCut, DbError> {
    let mut total = RewindCut { removed: 0, messages: 0 };
    for level in 0..lineage.len() {
        let (below, floor) = level_bounds(lineage, cut, level, u64::MAX);
        if below <= ordinal {
            continue;
        }
        let (removed, messages) = c
            .prepare_cached(
                "SELECT coalesce(sum(visible), 0), coalesce(sum(model), 0) FROM history
                 WHERE session = ?1 AND ordinal >= ?2 AND ordinal < ?3 AND (superseded_rev IS NULL OR superseded_rev >= ?4)",
            )?
            .query_row(params![lineage[level].session, bound(ordinal), bound(below), floor], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))?;
        total.removed += removed as u64;
        total.messages += messages as u64;
    }
    Ok(total)
}

impl SqliteStore {
    /// The lineage's live prompts older than `before` (an ordinal; `None`: from the newest), newest first, with the
    /// history revision they were read at. Inside a job already on the read lane.
    pub fn rewind_targets_on_lane(
        &self,
        _lane: &InLane<InteractiveIo>,
        lineage: &[LineageLevel],
        cut: Option<u64>,
        before: Option<u64>,
        limit: usize,
    ) -> Result<(u64, Vec<RewindTarget>), DbError> {
        self.with_of(&levels(lineage), |c| counted(c, lineage, |c| Ok((history_rev_on(c, lineage)?, targets_on(c, lineage, cut, before, limit)?))))
    }

    /// The prompt `alias` or one of `ids` names, with what a rewind to it removes and the history revision both were
    /// read at; `None` when no live prompt is named.
    pub fn rewind_target_on_lane(
        &self,
        _lane: &InLane<InteractiveIo>,
        lineage: &[LineageLevel],
        cut: Option<u64>,
        ids: &[String],
        alias: &str,
    ) -> Result<Option<(u64, RewindTarget, RewindCut)>, DbError> {
        self.with_of(&levels(lineage), |c| {
            counted(c, lineage, |c| {
                let Some(target) = target_on(c, lineage, cut, ids, alias)? else { return Ok(None) };
                let removed = cut_on(c, lineage, cut, target.ordinal)?;
                Ok(Some((history_rev_on(c, lineage)?, target, removed)))
            })
        })
    }
}
