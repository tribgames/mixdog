//! Which history rows a page shows as taken out of the model context (1.4.5 `archived`).
//!
//! One mechanism: the compactions that apply to a row are those of the reader's lineage
//! that came after it (the thread's own and its bases', and every compaction of a fork
//! applies to the rows the fork inherits), and each decides by its event
//! (`compaction_view`): `drop_mode` 0 takes every row before its divider, 1 none, 2 by
//! the ids of `compaction_dropped`, run through `ArchivedRows` over the row's facets.
//! A row is archived when every part it stands for was taken out by some compaction.
#![allow(clippy::disallowed_types, reason = "mixdog-store::archive_index reads the sqlite projection")]

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, params};

use crate::compaction_view::{ArchiveRow, ArchivedRows, DropMode, Dropped, IdSets};
use crate::message_facets::Facets;
use crate::sqlite::LineageLevel;

/// The `compactions.silent` value of a compaction whose archive was lost (`CompactedRecord::lost`).
pub(crate) const LOST: i64 = 2;

#[derive(Clone, Copy)]
struct Compaction {
    session_level: usize,
    ordinal: u64,
    boundary: u64,
    mode: DropMode,
    lost: bool,
}

/// What the compactions took out of one row.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Verdict {
    /// Every part of the row left the context.
    pub archived: bool,
    /// Its text row left (it has one).
    pub text: bool,
    /// The calls of the row that left.
    pub calls: Vec<String>,
    /// Every part of the row left with compactions whose archive was lost alone.
    pub hidden: bool,
}

/// The oldest live message row of lineage level `k` (below its range end and `bound`, live
/// as of `asof`) whose id is an entry of the replacement of the compaction at `ordinal` of
/// `session`.
const OLDEST_KEPT_SQL: &str = "SELECT min(h.ordinal) FROM message_rows m
     JOIN history h ON h.session = ?4 AND h.iid = m.iid
     WHERE m.session = ?1 AND m.ordinal = ?2 AND m.ver = m.ordinal AND h.ordinal < ?5
       AND h.form = 0 AND h.model = 1 AND (h.superseded_rev IS NULL OR h.superseded_rev >= ?3)";

/// The ordinal bound of rows of lineage level `i` for a reader with `cut`.
pub(crate) fn level_bound(lineage: &[LineageLevel], cut: Option<u64>, i: usize) -> i64 {
    let clamp = |v: u64| v.min(i64::MAX as u64) as i64;
    if i > 0 { lineage[i].end.into_iter().chain(cut).min().map_or(i64::MAX, clamp) } else { i64::MAX }
}

/// Where the divider of the compaction at `ordinal` of lineage level `home` sits: before
/// the oldest message row its replacement kept, wherever the lineage holds it (the deepest
/// level with one; a fork's inherited rows come first in display order), else before the
/// end of the rows of its own session (`own_boundary`). `(level, ordinal)`. The one place
/// both the divider and the rows a compaction archives (`DropMode::All`) are cut at.
pub(crate) fn divider_place(
    c: &Connection,
    lineage: &[LineageLevel],
    cut: Option<u64>,
    home: usize,
    ordinal: u64,
    own_boundary: u64,
) -> rusqlite::Result<(usize, u64)> {
    let clamp = |v: u64| v.min(i64::MAX as u64) as i64;
    for k in (home + 1..lineage.len()).rev() {
        let kept: Option<i64> = c.prepare_cached(OLDEST_KEPT_SQL)?.query_row(
            params![
                lineage[home].session,
                clamp(ordinal),
                lineage[k].end.map_or(i64::MAX, clamp),
                lineage[k].session,
                level_bound(lineage, cut, k)
            ],
            |r| r.get(0),
        )?;
        if let Some(o) = kept {
            return Ok((k, o as u64));
        }
    }
    Ok((home, own_boundary))
}

/// The live compactions of a lineage, loaded per level when first needed.
pub(crate) struct Compactions<'a> {
    c: &'a Connection,
    lineage: &'a [LineageLevel],
    cut: Option<u64>,
    levels: Vec<Option<Vec<Compaction>>>,
}

impl<'a> Compactions<'a> {
    pub fn new(c: &'a Connection, lineage: &'a [LineageLevel], cut: Option<u64>) -> Compactions<'a> {
        Compactions { c, lineage, cut, levels: (0..lineage.len()).map(|_| None).collect() }
    }

    /// The compactions of level `j` a reader sees: below its range end and the cut, live as
    /// of the fork point (the same bounds as its rows).
    fn level(&mut self, j: usize) -> rusqlite::Result<&[Compaction]> {
        if self.levels[j].is_none() {
            let clamp = |v: u64| v.min(i64::MAX as u64) as i64;
            let level = &self.lineage[j];
            let asof = level.end.map_or(i64::MAX, clamp);
            let bound = if j > 0 { level.end.into_iter().chain(self.cut).min().map_or(i64::MAX, clamp) } else { i64::MAX };
            let mut stmt = self.c.prepare_cached(
                "SELECT ordinal, boundary, drop_mode, silent FROM compactions WHERE session = ?1 AND ordinal < ?3
                 AND (superseded_rev IS NULL OR superseded_rev >= ?2) ORDER BY ordinal",
            )?;
            let rows = stmt.query_map(params![level.session, asof, bound], |r| {
                Ok(Compaction {
                    session_level: j,
                    ordinal: r.get::<_, i64>(0)? as u64,
                    boundary: r.get::<_, i64>(1)? as u64,
                    mode: DropMode::from_db(r.get(2)?).unwrap_or(DropMode::All),
                    lost: r.get::<_, i64>(3)? == LOST,
                })
            })?;
            self.levels[j] = Some(rows.collect::<Result<_, _>>()?);
        }
        Ok(self.levels[j].as_deref().unwrap_or_default())
    }

    /// The verdict for the model message row `iid` at `ordinal` of lineage level `level`.
    pub fn verdict(&mut self, level: usize, ordinal: u64, iid: &str, facets: &Facets) -> rusqlite::Result<Verdict> {
        let mut verdict = self.verdict_of(level, ordinal, iid, facets, false)?;
        // Only a lineage holding a compaction whose archive was lost is asked again, over those alone.
        let mut lost = false;
        for j in 0..=level {
            lost |= self.level(j)?.iter().any(|comp| comp.lost);
        }
        verdict.hidden = verdict.archived && lost && self.verdict_of(level, ordinal, iid, facets, true)?.archived;
        Ok(verdict)
    }

    /// `verdict` over every compaction, or over those whose archive was lost.
    fn verdict_of(&mut self, level: usize, ordinal: u64, iid: &str, facets: &Facets, only_lost: bool) -> rusqlite::Result<Verdict> {
        let parts = facets.rows(iid);
        let mut text = false;
        let mut calls = vec![false; parts.calls.len()];
        let mut everything = false;
        let mut ids: Vec<Compaction> = Vec::new();
        let mut all: Vec<Compaction> = Vec::new();
        for j in 0..=level {
            for comp in self.level(j)? {
                if (j == level && comp.ordinal <= ordinal) || (only_lost && !comp.lost) {
                    continue;
                }
                match comp.mode {
                    DropMode::Nothing => {}
                    DropMode::All => all.push(*comp),
                    DropMode::Ids => ids.push(*comp),
                }
            }
        }
        // Every row before the divider, where the divider is (the same place `dividers`
        // reports): rows the replacement kept stay live.
        for comp in all {
            let (place_level, place) =
                divider_place(self.c, self.lineage, self.cut, comp.session_level, comp.ordinal, comp.boundary)?;
            everything |= level > place_level || (level == place_level && ordinal < place);
        }
        if everything {
            text = parts.text.is_some();
            calls.iter_mut().for_each(|d| *d = true);
        } else if !ids.is_empty() {
            let iid = facets.id_of(iid);
            let call_ids: Vec<&str> = facets.calls.iter().map(String::as_str).collect();
            let call_json = serde_json::to_string(&call_ids).expect("strings serialize");
            // Per session of the lineage: the compactions whose ids hold a part of this row.
            let mut hits: HashMap<(usize, u64), IdSets> = HashMap::new();
            let sessions: HashSet<usize> = ids.iter().map(|c| c.session_level).collect();
            for j in sessions {
                let session = &self.lineage[j].session;
                if parts.text.is_some() {
                    let mut stmt = self.c.prepare_cached(
                        "SELECT ordinal FROM compaction_dropped WHERE session = ?1 AND kind = 0 AND id = ?2",
                    )?;
                    for o in stmt.query_map(params![session, iid], |r| r.get::<_, i64>(0))? {
                        hits.entry((j, o? as u64)).or_default().messages.insert(iid.to_owned());
                    }
                }
                if !call_ids.is_empty() {
                    let mut stmt = self.c.prepare_cached(
                        "SELECT id, ordinal FROM compaction_dropped WHERE session = ?1 AND kind = 1
                         AND id IN (SELECT value FROM json_each(?2))",
                    )?;
                    for hit in stmt.query_map(params![session, call_json], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
                        let (id, o) = hit?;
                        hits.entry((j, o as u64)).or_default().calls.insert(id);
                    }
                }
            }
            for comp in &ids {
                let Some(sets) = hits.get(&(comp.session_level, comp.ordinal)) else { continue };
                let rows = |row: &ArchiveRow| ArchivedRows::new(Dropped::Ids(sets.clone())).archived(row);
                if let Some(row) = &parts.text {
                    text |= rows(row);
                }
                for (done, row) in calls.iter_mut().zip(&parts.calls) {
                    *done |= rows(row);
                }
            }
        }
        let archived = (parts.text.is_none() || text) && calls.iter().all(|d| *d);
        let dropped_calls =
            facets.calls.iter().zip(&calls).filter(|(_, d)| **d).map(|(id, _)| id.clone()).collect();
        Ok(Verdict { archived, text, calls: dropped_calls, hidden: false })
    }
}
