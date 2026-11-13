//! Which history rows a page shows as taken out of the model context (1.4.5 `archived`).
//!
//! One mechanism: the compactions that apply to a row are those of the reader's lineage
//! that came after it (the thread's own and its bases', and every compaction of a fork
//! applies to the rows the fork inherits), and each decides by its event
//! (`compaction_view`): `drop_mode` 0 takes every row before it that its replacement did
//! not keep, 1 none, 2 by the ids of `compaction_dropped`, run through `ArchivedRows` over
//! the row's facets. A row is archived when every part it stands for was taken out by some
//! compaction.
//!
//! The divider of a compaction sits where the compaction happened: at its own record, in
//! its own session's rows. (1.4.5 put it before the oldest row the replacement kept, which
//! is where its stored view began the live rows. A compaction keeps the user's requests
//! from anywhere in the conversation, so that place could be far above the stretch that was
//! summarized, and it was not where the live view showed the same divider.)
#![allow(clippy::disallowed_types, reason = "mixdog-store::archive_index reads the sqlite projection")]

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, params};

use crate::compaction_view::{ArchiveRow, ArchivedRows, DropMode, Dropped, IdSets};
use crate::message_facets::Facets;
use crate::sqlite::LineageLevel;

#[derive(Clone, Copy)]
struct Compaction {
    session_level: usize,
    ordinal: u64,
    mode: DropMode,
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
}

/// Whether `iid` is an entry of the replacement of the compaction at `ordinal` of `session`: a row it kept.
const KEPT_ENTRY_SQL: &str = "SELECT EXISTS (SELECT 1 FROM message_rows WHERE session = ?1 AND ordinal = ?2 AND ver = ordinal AND iid = ?3)";

/// The ordinal bound of rows of lineage level `i` for a reader with `cut`.
pub(crate) fn level_bound(lineage: &[LineageLevel], cut: Option<u64>, i: usize) -> i64 {
    let clamp = |v: u64| v.min(i64::MAX as u64) as i64;
    if i > 0 { lineage[i].end.into_iter().chain(cut).min().map_or(i64::MAX, clamp) } else { i64::MAX }
}

/// Where the divider of the compaction at `ordinal` of lineage level `home` sits: at the
/// compaction's own record, `(level, ordinal)`.
pub(crate) fn divider_place(home: usize, ordinal: u64) -> (usize, u64) {
    (home, ordinal)
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
                "SELECT ordinal, drop_mode FROM compactions WHERE session = ?1 AND ordinal < ?3
                 AND (superseded_rev IS NULL OR superseded_rev >= ?2) ORDER BY ordinal",
            )?;
            let rows = stmt.query_map(params![level.session, asof, bound], |r| {
                Ok(Compaction {
                    session_level: j,
                    ordinal: r.get::<_, i64>(0)? as u64,
                    mode: DropMode::from_db(r.get(1)?).unwrap_or(DropMode::All),
                })
            })?;
            self.levels[j] = Some(rows.collect::<Result<_, _>>()?);
        }
        Ok(self.levels[j].as_deref().unwrap_or_default())
    }

    /// The verdict for the model message row `iid` at `ordinal` of lineage level `level`.
    pub fn verdict(&mut self, level: usize, ordinal: u64, iid: &str, facets: &Facets) -> rusqlite::Result<Verdict> {
        let parts = facets.rows(iid);
        let mut text = false;
        let mut calls = vec![false; parts.calls.len()];
        let mut everything = false;
        let mut ids: Vec<Compaction> = Vec::new();
        let mut all: Vec<Compaction> = Vec::new();
        for j in 0..=level {
            for comp in self.level(j)? {
                if j == level && comp.ordinal <= ordinal {
                    continue;
                }
                match comp.mode {
                    DropMode::Nothing => {}
                    DropMode::All => all.push(*comp),
                    DropMode::Ids => ids.push(*comp),
                }
            }
        }
        // Every row before the compaction (all of these are) that its replacement did not
        // keep: a kept row stays live.
        for comp in all {
            let clamp = |v: u64| v.min(i64::MAX as u64) as i64;
            let kept: bool = self.c.prepare_cached(KEPT_ENTRY_SQL)?.query_row(
                params![self.lineage[comp.session_level].session, clamp(comp.ordinal), iid],
                |r| r.get(0),
            )?;
            everything |= !kept;
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
        Ok(Verdict { archived, text, calls: dropped_calls })
    }
}
