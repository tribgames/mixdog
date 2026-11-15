//! `portable/docx-tracked-edits.mjs`: the edits a reviewer would make by hand in Word, written as tracked changes: a paragraph
//! rewritten as one deletion and one insertion, a phrase found inside a paragraph and cut out of its runs (a comment range, a
//! note mark, a hyperlink), and a find-and-replace at run granularity. The paragraph is edited as text with the patterns of
//! the Node code (`JsRegex`); offsets into a paragraph's joined text are byte offsets here (Node's are UTF-16 units: the text
//! between two offsets is the same).

use std::fmt::Display;

use crate::docx_parts::{mark_runs_deleted, revision_attributes};
use crate::docx_xml::word_text_content;
use crate::xml::{WORD_RUN_SOURCE, compiled, text_nodes, word_run_open, word_run_properties, xml_encode};

const MALFORMED_PARAGRAPH: &str = "DOCX paragraph is malformed";

/// `/<\/w:p>\s*$/` and `/\/>\s*$/` replaced by `closing(...)`: a paragraph ends in `</w:p>` or is self-closing.
fn with_inserted_tail(deleted: &str, inserted: &str) -> Result<String, String> {
    if let Some(range) = compiled(r"<\/w:p>\s*$", "").find(deleted) {
        return Ok(format!("{}{inserted}</w:p>{}", &deleted[..range.start], &deleted[range.end..]));
    }
    if let Some(range) = compiled(r"\/>\s*$", "").find(deleted) {
        return Ok(format!("{}>{inserted}</w:p>{}", &deleted[..range.start], &deleted[range.end..]));
    }
    Err(MALFORMED_PARAGRAPH.to_owned())
}

/// `trackedParagraphRewrite(paragraphXml, text, id, author)`: rewrites a paragraph's text as one tracked change: every existing
/// run is marked deleted and one inserted run, wearing the first run's formatting, carries the new text. Revision ids run from
/// `id` through `id + runCount`.
pub fn tracked_paragraph_rewrite(paragraph_xml: &str, text: &str, id: u64, author: &str) -> Result<String, String> {
    let run_count = compiled(r"<w:r(?:\s[^>]*)?>", "g").find_iter(paragraph_xml).count() as u64;
    let properties = compiled(r"<w:r(?:\s[^>]*)?>\s*(<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>)", "")
        .captures(paragraph_xml)
        .and_then(|found| found.get(1))
        .unwrap_or("");
    let deleted = mark_runs_deleted(paragraph_xml, id, author);
    let inserted = format!(
        "<w:ins {}><w:r>{properties}{}</w:r></w:ins>",
        revision_attributes(id + run_count, author),
        word_text_content(text, true)
    );
    with_inserted_tail(&deleted, &inserted)
}

/// One run of a paragraph: where it lies, its parts and, when it is made of text elements only, its text.
struct ParagraphRun {
    start: usize,
    end: usize,
    xml: String,
    open: String,
    properties: String,
    text: String,
    text_only: bool,
}

/// `paragraphRuns(paragraphXml)`. Only a run made of text elements can be cut at a character offset; a run carrying a tab, a
/// break, a field, or a drawing is left whole and its text is not searched.
fn paragraph_runs(paragraph_xml: &str) -> Vec<ParagraphRun> {
    let text_only_content = compiled(r"^(?:\s*<w:t\b[^>]*>[\s\S]*?<\/w:t>\s*)*$", "");
    compiled(WORD_RUN_SOURCE, "g")
        .find_iter(paragraph_xml)
        .map(|range| {
            let run = &paragraph_xml[range.clone()];
            let open = word_run_open().find(run).map_or("", |at| &run[at]).to_owned();
            let inner = &run[open.len()..run.len() - "</w:r>".len()];
            let properties = word_run_properties().find(inner).map_or("", |at| &inner[at]).to_owned();
            let content = &inner[properties.len()..];
            let text_only = text_only_content.is_match(content);
            let text = if text_only { text_nodes(content, "w:t").into_iter().map(|node| node.text).collect::<String>() } else { String::new() };
            ParagraphRun { start: range.start, end: range.end, xml: run.to_owned(), open, properties, text, text_only }
        })
        .collect()
}

/// `textRun(run, text)`: the run's own opening and properties around one text element.
fn text_run(run: &ParagraphRun, text: &str) -> String {
    format!("{}{}<w:t xml:space=\"preserve\">{}</w:t></w:r>", run.open, run.properties, xml_encode(text))
}

/// The markers [`anchor_phrase_in_paragraph`] places: the default is a comment range; `start` and `end` carry any other pair,
/// such as a footnote reference that only follows the phrase, and `replace` drops the phrase itself so the opening marker stands
/// in its place (a hyperlink carrying its own display run).
#[derive(Debug, Clone, Default)]
pub struct PhraseMarkers {
    pub start: Option<String>,
    pub end: Option<String>,
    pub replace: bool,
}

/// `anchorPhraseInParagraph(paragraphXml, find, id, markers)`: places markers around exactly `find` inside a paragraph,
/// cutting the runs it starts and ends in so Word marks the phrase and not the whole paragraph. `None` when the phrase is
/// absent or one of its boundary runs cannot be cut (a tab, break, field, or drawing run); the caller then anchors the
/// paragraph.
pub fn anchor_phrase_in_paragraph(paragraph_xml: &str, find: &str, id: impl Display, markers: Option<&PhraseMarkers>) -> Option<String> {
    let opening = markers.and_then(|markers| markers.start.clone()).unwrap_or_else(|| format!("<w:commentRangeStart w:id=\"{id}\"/>"));
    let closing = markers
        .and_then(|markers| markers.end.clone())
        .unwrap_or_else(|| format!("<w:commentRangeEnd w:id=\"{id}\"/><w:r><w:commentReference w:id=\"{id}\"/></w:r>"));
    let runs = paragraph_runs(paragraph_xml);
    let joined: String = runs.iter().map(|run| run.text.as_str()).collect();
    let start = if find.is_empty() { None } else { joined.find(find) }?;
    let end = start + find.len();
    // The phrase is dropped in every run it covers, not only the one holding its end: a replaced phrase split across runs left
    // its leading fragment and any wholly covered run beside the marker that stands in its place.
    let replace = markers.is_some_and(|markers| markers.replace);
    let mut output: Vec<String> = Vec::new();
    let mut source_cursor = 0;
    let mut offset = 0;
    let mut opened = false;
    let mut closed = false;
    for run in &runs {
        output.push(paragraph_xml[source_cursor..run.start].to_owned());
        source_cursor = run.end;
        let run_start = offset;
        let run_end = offset + run.text.len();
        offset = run_end;
        let holds_start = !opened && start >= run_start && start < run_end;
        let holds_end = !closed && end > run_start && end <= run_end;
        if !holds_start && !holds_end {
            if replace && opened && !closed && !run.text.is_empty() {
                continue;
            }
            output.push(run.xml.clone());
            continue;
        }
        if !run.text_only {
            return None;
        }
        let mut position = run_start;
        if holds_start {
            let before = &run.text[..start - run_start];
            if !before.is_empty() {
                output.push(text_run(run, before));
            }
            if !opening.is_empty() {
                output.push(opening.clone());
            }
            opened = true;
            position = start;
        }
        if holds_end {
            let inside = &run.text[position - run_start..end - run_start];
            if !inside.is_empty() && !replace {
                output.push(text_run(run, inside));
            }
            output.push(closing.clone());
            closed = true;
            let after = &run.text[end - run_start..];
            if !after.is_empty() {
                output.push(text_run(run, after));
            }
        } else {
            let rest = &run.text[position - run_start..];
            if !rest.is_empty() && !replace {
                output.push(text_run(run, rest));
            }
        }
    }
    if !opened || !closed {
        return None;
    }
    output.push(paragraph_xml[source_cursor..].to_owned());
    Some(output.concat())
}

/// What a replacement shares with its find at either end, and what lies between.
struct SharedEdges {
    lead: usize,
    trail: usize,
    insert: String,
}

/// `sharedWordEdges(find, replacement)`: the words a replacement shares with its find at either end are not an edit: "86억 원으로"
/// → "86억 원(잠정)으로" struck through the whole phrase and wrote it again, where a reviewer marks only "원으로" → "원(잠정)으로".
/// The match is found whole; the revision covers the words between the shared ones. Word granularity, never characters: "22%" →
/// "21.6%" reads as one changed figure, not "2" kept and "2" → "1.6".
fn shared_word_edges(find: &str, replacement: &str) -> SharedEdges {
    let tokens = |value: &str| -> Vec<String> { compiled(r"\s+|\S+", "g").find_iter(value).map(|range| value[range].to_owned()).collect() };
    let before = tokens(find);
    let after = tokens(replacement);
    let mut lead = 0;
    while lead < before.len() && lead < after.len() && before[lead] == after[lead] {
        lead += 1;
    }
    let mut trail = 0;
    while trail < before.len() - lead && trail < after.len() - lead && before[before.len() - 1 - trail] == after[after.len() - 1 - trail] {
        trail += 1;
    }
    SharedEdges {
        lead: before[..lead].concat().len(),
        trail: before[before.len() - trail..].concat().len(),
        insert: after[lead..after.len() - trail].concat(),
    }
}

/// What [`tracked_paragraph_replace`] made of one paragraph.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackedReplace {
    pub xml: String,
    pub count: usize,
    pub next_id: u64,
}

/// `trackedParagraphReplace(paragraphXml, find, fullReplacement, id, author)`: tracked find-and-replace at run granularity: only
/// the matched characters are wrapped in `w:del` and the replacement follows them in `w:ins`, both wearing the formatting of the
/// run they cut, so the rest of the paragraph keeps its runs untouched. `count` is 0 when no match lies entirely inside text-only
/// runs.
pub fn tracked_paragraph_replace(paragraph_xml: &str, find: &str, full_replacement: &str, id: u64, author: &str) -> Result<TrackedReplace, String> {
    if find.is_empty() {
        return Err("replace_text requires non-empty find".to_owned());
    }
    let runs = paragraph_runs(paragraph_xml);
    let joined: String = runs.iter().map(|run| run.text.as_str()).collect();
    let edges = shared_word_edges(find, full_replacement);
    let replacement = edges.insert.as_str();
    let mut intervals: Vec<(usize, usize)> = Vec::new();
    let mut found = 0;
    let mut cursor = 0;
    while joined.len() >= find.len() && cursor <= joined.len() - find.len() {
        let Some(at) = joined[cursor..].find(find) else { break };
        let index = cursor + at;
        found += 1;
        let start = index + edges.lead;
        let end = index + find.len() - edges.trail;
        if end > start || !replacement.is_empty() {
            intervals.push((start, end));
        }
        cursor = index + find.len();
    }
    if found > 0 && intervals.is_empty() {
        return Ok(TrackedReplace { xml: paragraph_xml.to_owned(), count: found, next_id: id });
    }
    if intervals.is_empty() {
        return Ok(TrackedReplace { xml: paragraph_xml.to_owned(), count: 0, next_id: id });
    }
    let mut next_id = id;
    let mut output: Vec<String> = Vec::new();
    let mut source_cursor = 0;
    let mut offset = 0;
    for run in &runs {
        output.push(paragraph_xml[source_cursor..run.start].to_owned());
        source_cursor = run.end;
        let run_start = offset;
        let run_end = offset + run.text.len();
        offset = run_end;
        // A pure insertion (nothing between the shared words is deleted) is a point: it belongs to the run it falls in, or to
        // the paragraph's last run when it falls at the very end.
        let touches = |interval: &(usize, usize)| {
            if interval.0 == interval.1 {
                interval.0 >= run_start && (interval.0 < run_end || (interval.0 == run_end && run_end == joined.len()))
            } else {
                interval.0 < run_end && interval.1 > run_start
            }
        };
        let overlapping: Vec<&(usize, usize)> = if run.text_only { intervals.iter().filter(|interval| touches(interval)).collect() } else { Vec::new() };
        if overlapping.is_empty() {
            output.push(run.xml.clone());
            continue;
        }
        let mut position = run_start;
        for interval in overlapping {
            let from = interval.0.max(run_start);
            let to = interval.1.min(run_end);
            let kept = &run.text[position - run_start..from - run_start];
            if !kept.is_empty() {
                output.push(text_run(run, kept));
            }
            let deleted = &run.text[from - run_start..to - run_start];
            if !deleted.is_empty() {
                output.push(format!(
                    "<w:del {}>{}{}<w:delText xml:space=\"preserve\">{}</w:delText></w:r></w:del>",
                    revision_attributes(next_id, author),
                    run.open,
                    run.properties,
                    xml_encode(deleted)
                ));
                next_id += 1;
            }
            if interval.1 <= run_end && !replacement.is_empty() {
                output.push(format!("<w:ins {}>{}</w:ins>", revision_attributes(next_id, author), text_run(run, replacement)));
                next_id += 1;
            }
            position = to;
        }
        let tail = &run.text[position - run_start..];
        if !tail.is_empty() {
            output.push(text_run(run, tail));
        }
    }
    output.push(paragraph_xml[source_cursor..].to_owned());
    Ok(TrackedReplace { xml: output.concat(), count: found, next_id })
}
