//! Port of 1.4.5 `src/tui/session/compaction-view.mjs` (`compactionArchivedRows`,
//! `archiveItemsForCompaction`): which transcript rows a compaction took out of the model
//! context. The decision is the event's: the identities of the `compacted` record
//! (`dropped`) when it has them, else its count (`dropped_count`): none when it is 0, every
//! row before the boundary when it is positive or missing (a source that reports nothing).
//! This is the one classifier: the transcript runs it over display rows with `IdSets`, the
//! index over the facets of each history row with identities read from its tables.

use std::collections::HashSet;

use crate::schema::record::CompactedDropped;

/// How a compaction's event decides which rows left the context (stored as `drop_mode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropMode {
    /// A source that reports nothing: every row before the boundary.
    All = 0,
    /// A pass that took out nothing visible (`droppedMessages: 0`, no identities).
    Nothing = 1,
    /// By the identities of the event.
    Ids = 2,
}

impl DropMode {
    /// 1.4.5 `compactionArchivedRows`: identities decide whenever supplied, whatever the
    /// count says; without them a count that is not positive means none.
    pub fn of(count: Option<u64>, identities: bool) -> DropMode {
        match (identities, count) {
            (true, _) => DropMode::Ids,
            (false, Some(0)) => DropMode::Nothing,
            (false, _) => DropMode::All,
        }
    }

    pub fn from_db(value: i64) -> Option<DropMode> {
        match value {
            0 => Some(DropMode::All),
            1 => Some(DropMode::Nothing),
            2 => Some(DropMode::Ids),
            _ => None,
        }
    }
}

/// The ids a compaction reported as taken out of the context.
pub trait Identities {
    fn has_message(&self, id: &str) -> bool;
    fn has_call(&self, id: &str) -> bool;
}

/// `droppedIdentities` held in memory.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IdSets {
    pub messages: HashSet<String>,
    pub calls: HashSet<String>,
}

impl IdSets {
    pub fn of(dropped: &CompactedDropped) -> IdSets {
        IdSets {
            messages: dropped.message_ids.iter().cloned().collect(),
            calls: dropped.call_ids.iter().cloned().collect(),
        }
    }
}

impl Identities for IdSets {
    fn has_message(&self, id: &str) -> bool {
        self.messages.contains(id)
    }

    fn has_call(&self, id: &str) -> bool {
        self.calls.contains(id)
    }
}

/// What one compaction took out of the context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Dropped<I> {
    All,
    Nothing,
    Ids(I),
}

impl Dropped<IdSets> {
    /// From the record's `dropped_count` and `dropped`.
    pub fn of_record(count: Option<u64>, dropped: Option<&CompactedDropped>) -> Dropped<IdSets> {
        match (DropMode::of(count, dropped.is_some()), dropped) {
            (DropMode::Ids, Some(d)) => Dropped::Ids(IdSets::of(d)),
            (DropMode::Nothing, _) => Dropped::Nothing,
            _ => Dropped::All,
        }
    }
}

/// One member of an aggregate tool row (`toolMembers`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub id: Option<String>,
    pub archived: bool,
}

/// The fields of a transcript row the classification reads.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ArchiveRow {
    /// The row `kind` (`user`, `assistant`, `tool`, ...).
    pub kind: String,
    pub message_id: Option<String>,
    pub call_id: Option<String>,
    pub call_ids: Vec<String>,
    pub aggregate: bool,
    /// `toolMembers`; `None` when the row has no such array.
    pub members: Option<Vec<Member>>,
    pub archived: bool,
    /// A compaction divider row: never marked.
    pub divider: bool,
}

fn is_message_row(kind: &str) -> bool {
    matches!(kind, "user" | "assistant" | "tool")
}

/// `toolCallIdsOfItem`: the tool calls a tool row shows.
fn tool_call_ids(row: &ArchiveRow) -> Vec<String> {
    if row.kind != "tool" {
        return Vec::new();
    }
    if let Some(id) = row.call_id.as_ref().filter(|s| !s.is_empty()) {
        return vec![id.clone()];
    }
    if !row.call_ids.is_empty() {
        return row.call_ids.iter().filter(|s| !s.is_empty()).cloned().collect();
    }
    if row.aggregate
        && let Some(members) = &row.members
    {
        return members.iter().filter_map(|m| m.id.clone()).collect();
    }
    Vec::new()
}

/// `compactionArchivedRows`: the predicate over the rows before the boundary, in order.
pub struct ArchivedRows<I: Identities> {
    drop: Dropped<I>,
    prompt_dropped: bool,
}

impl<I: Identities> ArchivedRows<I> {
    pub fn new(drop: Dropped<I>) -> ArchivedRows<I> {
        ArchivedRows { drop, prompt_dropped: false }
    }

    /// Whether the compaction took this row out of the model context.
    pub fn archived(&mut self, row: &ArchiveRow) -> bool {
        let ids = match &self.drop {
            Dropped::All => return true,
            Dropped::Nothing => return false,
            Dropped::Ids(ids) => ids,
        };
        let calls = tool_call_ids(row);
        let dropped = if !calls.is_empty() {
            calls.iter().all(|id| ids.has_call(id))
        } else if row.message_id.as_ref().is_some_and(|s| !s.is_empty()) || is_message_row(&row.kind) {
            // A message-backed row is decided by its own id alone.
            row.message_id.as_ref().is_some_and(|id| !id.is_empty() && ids.has_message(id))
        } else {
            // Only an auxiliary row (no message of its own) follows its turn.
            return self.prompt_dropped;
        };
        if row.kind == "user" {
            self.prompt_dropped = dropped;
        }
        dropped
    }

    /// `markDroppedMembers`: an aggregate row some of whose calls survive stays live, with
    /// its dropped members marked archived.
    pub fn mark_dropped_members(&self, row: &ArchiveRow) -> ArchiveRow {
        let Dropped::Ids(ids) = &self.drop else {
            return row.clone();
        };
        let (true, true, Some(members)) = (row.kind == "tool", row.aggregate, &row.members) else {
            return row.clone();
        };
        let hit = |m: &Member| m.id.as_ref().is_some_and(|id| ids.has_call(id));
        if !members.iter().any(hit) {
            return row.clone();
        }
        let mut next = row.clone();
        next.members = Some(
            members
                .iter()
                .map(|m| if hit(m) && !m.archived { Member { id: m.id.clone(), archived: true } } else { m.clone() })
                .collect(),
        );
        next
    }
}

/// `archiveItemsForCompaction` without the divider row itself: the rows with those before
/// `boundary` (default all) classified, and the divider's index. The caller inserts the
/// divider at that index.
pub fn archive_items_for_compaction(
    items: &[ArchiveRow],
    boundary: Option<i64>,
    count: Option<u64>,
    dropped: Option<&CompactedDropped>,
    archive_tail: bool,
) -> (Vec<ArchiveRow>, usize) {
    let at = boundary.map_or(items.len(), |b| b.clamp(0, items.len() as i64) as usize);
    let mut archived = ArchivedRows::new(Dropped::of_record(count, dropped));
    let classify = |row: &ArchiveRow, archived: &mut ArchivedRows<IdSets>| {
        if archived.archived(row) {
            if row.archived || row.divider {
                row.clone()
            } else {
                ArchiveRow { archived: true, ..row.clone() }
            }
        } else {
            archived.mark_dropped_members(row)
        }
    };
    let mut next: Vec<ArchiveRow> = items[..at].iter().map(|r| classify(r, &mut archived)).collect();
    // The current turn's rows after the boundary stay in place; what the compaction
    // explicitly dropped from this turn is archived when `archive_tail` is set.
    for row in &items[at..] {
        next.push(if archive_tail { classify(row, &mut archived) } else { row.clone() });
    }
    (next, at)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(kind: &str, message_id: Option<&str>) -> ArchiveRow {
        ArchiveRow { kind: kind.into(), message_id: message_id.map(Into::into), ..ArchiveRow::default() }
    }

    fn tool(call: &str) -> ArchiveRow {
        ArchiveRow { kind: "tool".into(), call_id: Some(call.into()), ..ArchiveRow::default() }
    }

    fn ids(messages: &[&str], calls: &[&str]) -> CompactedDropped {
        CompactedDropped {
            message_ids: messages.iter().map(|s| s.to_string()).collect(),
            call_ids: calls.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn rows_follow_their_ids_and_an_auxiliary_row_follows_its_prompt() {
        let d = ids(&["u1"], &["c1"]);
        let rows = [
            row("user", Some("u1")),
            row("status", None),
            row("assistant", None),
            tool("c1"),
            tool("c2"),
            row("user", Some("u2")),
            row("status", None),
        ];
        let mut p = ArchivedRows::new(Dropped::of_record(None, Some(&d)));
        let got: Vec<bool> = rows.iter().map(|r| p.archived(r)).collect();
        assert_eq!(got, [true, true, false, true, false, false, false]);
    }

    #[test]
    fn the_count_decides_only_without_identities() {
        let r = row("assistant", None);
        // A source that reports nothing, and a positive count: every row.
        for count in [None, Some(3)] {
            assert!(ArchivedRows::new(Dropped::of_record(count, None)).archived(&r), "{count:?}");
        }
        // A pass that took out nothing visible: none.
        assert!(!ArchivedRows::new(Dropped::of_record(Some(0), None)).archived(&r));
        // Identities win whatever the count says.
        let d = ids(&["m"], &[]);
        assert!(!ArchivedRows::new(Dropped::of_record(Some(0), Some(&d))).archived(&r));
        assert!(ArchivedRows::new(Dropped::of_record(Some(0), Some(&d))).archived(&row("user", Some("m"))));
    }

    #[test]
    fn an_aggregate_with_surviving_calls_stays_live_and_marks_its_dropped_members() {
        let d = ids(&[], &["a"]);
        let agg = ArchiveRow {
            kind: "tool".into(),
            aggregate: true,
            members: Some(vec![
                Member { id: Some("a".into()), archived: false },
                Member { id: Some("b".into()), archived: false },
            ]),
            ..ArchiveRow::default()
        };
        let (out, at) = archive_items_for_compaction(&[agg], None, None, Some(&d), false);
        assert_eq!(at, 1);
        assert!(!out[0].archived);
        let m = out[0].members.as_ref().unwrap();
        assert_eq!((m[0].archived, m[1].archived), (true, false));
    }
}
