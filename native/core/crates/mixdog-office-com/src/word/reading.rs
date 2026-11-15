//! `Word-ReadingContext` and what a snapshot reads through it: one reading of the document's tracked changes, pictures,
//! tables and page starts that every paragraph and cell would otherwise ask Word for again (`Range.Revisions`,
//! `Range.InlineShapes`, `Information(wdWithInTable)`, `Information(wdActiveEndPageNumber)` cost 10-40 ms apiece, and a
//! 60-paragraph report took 14 s to read), the page and table lookups over it, and `Word-AcceptedText`.

use crate::com::Obj;
use crate::com::Result;
use crate::com::Value as Com;
use crate::ps::Value;
use crate::ps::collate::SortOptions;
use crate::ps::collate::sort_by_key;

/// `Word-Span`: where a revision, picture or table sits, by character offset (`Type` is the revision's type, else 0).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Span {
    pub start: i32,
    pub end: i32,
    pub kind: i32,
}

/// What `Word-ReadingContext` read.
#[derive(Debug, Default)]
pub(super) struct ReadingContext {
    revisions: Vec<Span>,
    pictures: Vec<Span>,
    tables: Vec<Span>,
    page_starts: Vec<i32>,
    table_cursor: usize,
}

/// `Word-Span $range ([int]$type)`.
fn span(range: &Com, kind: i32) -> Result<Span> {
    Ok(Span { start: super::int(&range.member("Start")?)?, end: super::int(&range.member("End")?)?, kind })
}

/// `@(foreach ($item in @($document.<collection>)) { Word-Span $item.Range [([int]$item.Type)] })`.
fn spans(document: &Obj, collection: &str, typed: bool) -> Result<Vec<Span>> {
    let mut found = Vec::new();
    for item in super::items_of(&document.get(collection)?)? {
        let range = item.member("Range")?;
        let kind = if typed { super::int(&item.member("Type")?)? } else { 0 };
        found.push(span(&range, kind)?);
    }
    Ok(found)
}

/// The offset of each page's first character: `wdNumberOfPagesInDocument`, then `wdGoToPage` by `wdGoToAbsolute` for each.
fn page_starts(document: &Obj) -> Result<Vec<i32>> {
    let pages = super::int(&super::indexed(&document.get("Content")?, "Information", &[Com::I4(4)])?)?;
    let mut starts = Vec::new();
    for page in 1..=pages {
        let range = document.call("GoTo", &[Com::I4(1), Com::I4(1), Com::I4(page)])?;
        starts.push(super::int(&range.member("Start")?)?);
    }
    Ok(starts)
}

/// `Word-ReadingContext`: each reading is tried once and its failure leaves that part empty.
pub(super) fn reading_context(document: &Obj) -> ReadingContext {
    ReadingContext {
        revisions: spans(document, "Revisions", true).unwrap_or_default(),
        pictures: spans(document, "InlineShapes", false).unwrap_or_default(),
        tables: spans(document, "Tables", false).unwrap_or_default(),
        page_starts: page_starts(document).unwrap_or_default(),
        table_cursor: 0,
    }
}

impl ReadingContext {
    /// `Word-PageAt`: the last page that starts at or before the offset (0 when Word gave no pages).
    pub(super) fn page_at(&self, position: i32) -> i32 {
        let starts = &self.page_starts;
        if starts.is_empty() {
            return 0;
        }
        let (mut low, mut high) = (0_i64, starts.len() as i64 - 1);
        let mut page = 1;
        while low <= high {
            let middle = (low + high) / 2;
            if starts[middle as usize] <= position {
                page = middle as i32 + 1;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }
        page
    }

    /// `Word-InTable`: whether the offset sits in a table; asked in document order, so the tables already passed are skipped.
    pub(super) fn in_table(&mut self, position: i32) -> bool {
        while self.table_cursor < self.tables.len() && self.tables[self.table_cursor].end <= position {
            self.table_cursor += 1;
        }
        self.table_cursor < self.tables.len() && self.tables[self.table_cursor].start <= position
    }
}

/// What `Word-AcceptedText` answers: the text as the page shows it, the struck-through text, and whether a tracked change
/// touches the range.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Accepted {
    pub text: String,
    pub deleted: String,
    pub tracked: bool,
}

/// A stretch of the range that is not part of its accepted text: a deleted span, or an inline picture.
#[derive(Clone)]
struct Gap {
    start: i32,
    end: i32,
    picture: bool,
}

/// `[string]$document.Range($start, $end).Text`.
fn text_between(document: &Obj, start: i32, end: i32) -> Result<String> {
    Ok(super::string(&super::document_range(document, start, end)?.member("Text")?))
}

/// `Word-AcceptedText`. Word's `Range.Text` still spells struck-through deletions while changes are tracked, so a paragraph
/// reads "oneuno" where the page shows one word going and another coming: the deleted spans are left out and handed back
/// as `deleted`, and an inline picture (read as "/") is left out too. Only a revision that overlaps the range counts
/// (`Range.Revisions` also lists one that merely touches its edge, the next table cell's, say).
pub(super) fn accepted_text(document: &Obj, range: &Com, context: &ReadingContext) -> Result<Accepted> {
    let range_start = super::int(&range.member("Start")?)?;
    let range_end = super::int(&range.member("End")?)?;
    let mut tracked = false;
    let mut gaps: Vec<Gap> = Vec::new();
    for revision in &context.revisions {
        let start = range_start.max(revision.start);
        let end = range_end.min(revision.end);
        if end <= start {
            continue;
        }
        tracked = true;
        if revision.kind != 2 && revision.kind != 14 {
            continue;
        }
        gaps.push(Gap { start, end, picture: false });
    }
    for picture in &context.pictures {
        if picture.start >= range_start && picture.start < range_end {
            gaps.push(Gap { start: picture.start, end: picture.end, picture: true });
        }
    }
    if gaps.is_empty() {
        return Ok(Accepted { text: super::string(&range.member("Text")?), deleted: String::new(), tracked });
    }
    let gaps = sort_by_key(&gaps, SortOptions::default(), |gap| Value::Int(gap.start));
    let (mut kept, mut gone) = (String::new(), String::new());
    let mut cursor = range_start;
    for gap in &gaps {
        if gap.start > cursor {
            kept.push_str(&text_between(document, cursor, gap.start)?);
        }
        if gap.end > cursor {
            if !gap.picture {
                gone.push_str(&text_between(document, cursor.max(gap.start), gap.end)?);
            }
            cursor = gap.end;
        }
    }
    if cursor < range_end {
        kept.push_str(&text_between(document, cursor, range_end)?);
    }
    Ok(Accepted { text: kept, deleted: gone, tracked })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(starts: &[i32], tables: &[(i32, i32)]) -> ReadingContext {
        ReadingContext {
            page_starts: starts.to_vec(),
            tables: tables.iter().map(|(start, end)| Span { start: *start, end: *end, kind: 0 }).collect(),
            ..ReadingContext::default()
        }
    }

    #[test]
    fn a_position_is_on_the_last_page_that_starts_at_or_before_it() {
        let context = context(&[0, 100, 250], &[]);
        assert_eq!([0, 99, 100, 249, 250, 9000].map(|at| context.page_at(at)), [1, 1, 2, 2, 3, 3]);
        assert_eq!(ReadingContext::default().page_at(5), 0);
    }

    #[test]
    fn tables_are_passed_in_document_order() {
        let mut context = context(&[], &[(10, 20), (30, 40)]);
        let asked: Vec<bool> = [5, 10, 19, 20, 25, 30, 39, 40, 50].iter().map(|at| context.in_table(*at)).collect();
        assert_eq!(asked, [false, true, true, false, false, true, true, false, false]);
    }
}
