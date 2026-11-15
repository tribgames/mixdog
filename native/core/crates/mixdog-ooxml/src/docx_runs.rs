//! `portable/docx-runs.mjs`: Word fragments a paragraph into many runs, and tracked changes live in more places than the
//! runs. This coalesces adjacent runs of identical formatting ([`normalize_docx_runs`]) and settles the tracked changes of
//! one story part ([`settle_docx_story`]): wrappers, paragraph marks, table rows and formatting records. The patterns are the
//! Node code's (`JsRegex`); offsets are byte offsets (Node's are UTF-16 units; the text between two offsets is the same).

use std::cell::Cell;

use mixdog_js::{JsRegex, js_trim};

use crate::docx_revisions::{
    ResolveOptions, rendered_word_text, resolve_docx_property_changes, resolve_docx_revisions, revision_owner,
};
use crate::slide_shapes::remove_first;
use crate::snapshot_docx::docx_body_model;
use crate::xml::{
    WORD_RUN_SOURCE, compiled, container_inner, word_run_open, word_run_properties, xml_encode,
};

const EMPTY_RUN_PROPERTIES: &str = r"^\s*(?:<w:rPr\/>|<w:rPr>\s*<\/w:rPr>)?\s*$";

/// What [`consolidate_text`] made of a run's text elements.
struct Consolidated {
    content: String,
    merged: usize,
}

/// `consolidateText(content, tag)`: neighbouring text elements of one run joined into one.
fn consolidate_text(content: &str, tag: &str) -> Consolidated {
    let pair = compiled(&format!(r"<{tag}\b([^>]*)>([\s\S]*?)</{tag}>\s*<{tag}\b([^>]*)>([\s\S]*?)</{tag}>"), "");
    let edge_space = compiled(r"^[ \t\r\n]|[ \t\r\n]$", "");
    let preserved = compiled(r#"\bxml:space="preserve""#, "");
    let mut result = content.to_owned();
    let mut merged = 0;
    loop {
        let Some(found) = pair.captures(&result) else { return Consolidated { content: result, merged } };
        let (first_attrs, first_raw) = (found.get(1).unwrap_or(""), found.get(2).unwrap_or(""));
        let (second_attrs, second_raw) = (found.get(3).unwrap_or(""), found.get(4).unwrap_or(""));
        let text = format!("{}{}", rendered_word_text(first_attrs, first_raw), rendered_word_text(second_attrs, second_raw));
        let preserve = edge_space.is_match(&text) || preserved.is_match(first_attrs) || preserved.is_match(second_attrs);
        let range = found.range();
        result = format!(
            "{}<{tag}{}>{}</{tag}>{}",
            &result[..range.start],
            if preserve { " xml:space=\"preserve\"" } else { "" },
            xml_encode(&text),
            &result[range.end..]
        );
        merged += 1;
    }
}

/// What [`normalize_docx_runs`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedRuns {
    pub xml: String,
    pub merged: usize,
    pub text_merged: usize,
    pub proof_err_removed: usize,
    pub rsid_stripped: usize,
}

/// A run being built from the runs that merge into it.
struct PendingRun {
    open: String,
    properties: String,
    content: String,
}

/// `normalizeDocxRuns(xml)`: Word fragments a paragraph into many runs (revision ids, proofing marks, editing history), so a
/// phrase visible on the page often does not exist as one string in the XML. This coalesces adjacent runs whose formatting
/// is identical, drops proofing markers and rsid attributes, and joins the text elements of each merged run. Rendering is
/// unchanged; runs in different tracked-change wrappers are never merged because an element sits between them.
pub fn normalize_docx_runs(xml: &str) -> NormalizedRuns {
    let proof_err_removed = Cell::new(0_usize);
    let rsid_stripped = Cell::new(0_usize);
    let working = compiled(r"<w:proofErr\b[^>]*\/>", "g").replace_all_with(xml, |_| {
        proof_err_removed.set(proof_err_removed.get() + 1);
        String::new()
    });
    let rsid = compiled(r#"\s+w:rsid\w*="[^"]*""#, "g");
    let working = compiled(r"<w:r(\s[^>]*)?>", "g").replace_all_with(&working, |found| {
        let stripped = rsid.replace_all_with(found.get(1).unwrap_or(""), |_| {
            rsid_stripped.set(rsid_stripped.get() + 1);
            String::new()
        });
        let stripped = js_trim(&stripped);
        format!("<w:r{}>", if stripped.is_empty() { String::new() } else { format!(" {stripped}") })
    });
    let empty_properties = compiled(EMPTY_RUN_PROPERTIES, "");
    let run_pattern = compiled(WORD_RUN_SOURCE, "g");
    let open_pattern = word_run_open();
    let properties_pattern = word_run_properties();
    let mut output = String::new();
    let mut cursor = 0;
    let (mut merged, mut text_merged) = (0, 0);
    let mut pending: Option<PendingRun> = None;
    let flush = |pending: &mut Option<PendingRun>, output: &mut String, text_merged: &mut usize| {
        let Some(run) = pending.take() else { return };
        let texts = consolidate_text(&run.content, "w:t");
        let deleted = consolidate_text(&texts.content, "w:delText");
        *text_merged += texts.merged + deleted.merged;
        output.push_str(&format!("{}{}{}</w:r>", run.open, run.properties, deleted.content));
    };
    for range in run_pattern.find_iter(&working) {
        let between = &working[cursor..range.start];
        let whole = &working[range.clone()];
        let open = open_pattern.find(whole).map_or("", |opened| &whole[opened]);
        let inner = &whole[open.len()..whole.len() - "</w:r>".len()];
        let raw_properties = properties_pattern.find(inner).map_or("", |found| &inner[found]);
        let properties = if empty_properties.is_match(raw_properties) { "" } else { js_trim(raw_properties) };
        let content = &inner[raw_properties.len()..];
        let joins = pending.as_ref().is_some_and(|run| js_trim(between).is_empty() && run.properties == properties);
        if joins {
            pending.as_mut().expect("a pending run").content.push_str(content);
            merged += 1;
        } else {
            flush(&mut pending, &mut output, &mut text_merged);
            output.push_str(between);
            pending = Some(PendingRun { open: open.to_owned(), properties: properties.to_owned(), content: content.to_owned() });
        }
        cursor = range.end;
    }
    flush(&mut pending, &mut output, &mut text_merged);
    output.push_str(&working[cursor..]);
    NormalizedRuns { xml: output, merged, text_merged, proof_err_removed: proof_err_removed.get(), rsid_stripped: rsid_stripped.get() }
}

/// The self-closing paragraph-mark or row marker of one kind, optionally pinned to one reviewer.
fn marker(tag: &str, author: &str) -> std::sync::Arc<JsRegex> {
    compiled(&format!(r"<w:{tag}\b{}[^>]*\/>", revision_owner(author)), "")
}

/// A paragraph cut into its opening tag, its properties and what follows them.
struct ParagraphParts {
    open: String,
    properties: String,
    content: String,
    empty: bool,
}

fn paragraph_parts(paragraph_xml: &str) -> ParagraphParts {
    let Some(inner) = container_inner(paragraph_xml, "w:p", 0) else {
        return ParagraphParts { open: "<w:p>".to_owned(), properties: String::new(), content: String::new(), empty: true };
    };
    let pattern = compiled(r"^\s*<w:pPr(?:\s[^>]*)?>[\s\S]*?<\/w:pPr>", "");
    let properties = pattern.find(&inner.inner).map_or("", |range| &inner.inner[range]).to_owned();
    ParagraphParts {
        open: paragraph_xml[..inner.start].to_owned(),
        content: inner.inner[properties.len()..].to_owned(),
        properties,
        empty: false,
    }
}

/// The run properties of a paragraph mark (the `w:rPr` inside `w:pPr`).
fn mark_properties(properties: &str) -> &str {
    let pattern = compiled(r"<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>", "");
    pattern.find(properties).map_or("", |range| &properties[range])
}

fn marked_paragraph(properties: &str, tag: &str, author: &str) -> bool {
    marker(tag, author).is_match(mark_properties(properties))
}

fn cleared_paragraph(paragraph_xml: &str, tag: &str, author: &str) -> String {
    let parts = paragraph_parts(paragraph_xml);
    if parts.empty {
        return paragraph_xml.to_owned();
    }
    let block = compiled(r"<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>", "");
    let properties = match block.find(&parts.properties) {
        Some(range) => format!(
            "{}{}{}",
            &parts.properties[..range.start],
            remove_first(&marker(tag, author), &parts.properties[range.clone()]),
            &parts.properties[range.end..]
        ),
        None => parts.properties.clone(),
    };
    format!("{}{properties}{}</w:p>", parts.open, parts.content)
}

/// Where an element lies in a part and where its content does.
#[derive(Debug, Clone, Copy)]
struct Extent {
    start: usize,
    inner_start: usize,
    inner_end: usize,
    end: usize,
}

/// `elementExtents(xml, tag)`: every `<tag>` element of a part with depth-aware extents, in document order; a nested element is
/// listed after the one that holds it.
fn element_extents(xml: &str, tag: &str) -> Vec<Extent> {
    let opener = compiled(&format!(r"<{tag}(?:\s[^>]*)?>"), "g");
    opener
        .find_iter(xml)
        .filter_map(|range| {
            let inner = container_inner(xml, tag, range.start)?;
            Some(Extent { start: range.start, inner_start: inner.start, inner_end: inner.end, end: inner.end + format!("</{tag}>").len() })
        })
        .collect()
}

fn leftover_marks_source(author: &str) -> String {
    format!(
        r"(<w:rPr(?:\s[^>]*)?>(?:(?!<\/w:rPr>)[\s\S])*?)<w:(ins|del)\b{}[^>]*\/>",
        revision_owner(author)
    )
}

/// What settling paragraph marks counted.
#[derive(Debug, Clone, PartialEq, Eq)]
struct MarkCounts {
    xml: String,
    merged: usize,
    cleared: usize,
    unmerged: usize,
}

/// `resolveDocxParagraphMarks(documentXml, { resolution, author })`: paragraph-mark revisions resolved the way Word does. A
/// deleted mark that is accepted (or an inserted mark that is rejected) joins its paragraph to the next one, which keeps its
/// own paragraph properties, so a paragraph whose runs were all deleted vanishes instead of surviving as an empty bullet. The
/// other marker is simply cleared. A mark whose next block is a table, or that ends the body, is cleared and reported as
/// unmerged. Table cells are resolved as small bodies of their own. Runs, wrappers, and contents must already be resolved.
/// With `author` only that reviewer's marks are settled; the others stay tracked.
fn resolve_paragraph_marks(document_xml: &str, accept: bool, author: &str) -> MarkCounts {
    let clear_tag = if accept { "ins" } else { "del" };
    let leftover = compiled(&leftover_marks_source(author), "g");
    let body = resolve_marks_in_body(document_xml, accept, author);
    let MarkCounts { mut xml, mut merged, cleared, unmerged } = body;
    let (mut cleared, mut unmerged) = (cleared, unmerged);
    // Each cell without a nested table is a paragraph sequence like the body; the last cell goes first so earlier offsets
    // stay valid.
    let nested_table = compiled(r"<w:tbl\b", "");
    let cells: Vec<Extent> = element_extents(&xml, "w:tc")
        .into_iter()
        .filter(|cell| !nested_table.is_match(&xml[cell.inner_start..cell.inner_end]))
        .rev()
        .collect();
    for cell in cells {
        let inner = xml[cell.inner_start..cell.inner_end].to_owned();
        if !leftover.is_match(&inner) {
            continue;
        }
        let resolved = resolve_marks_in_body(&format!("<w:body>{inner}</w:body>"), accept, author);
        merged += resolved.merged;
        cleared += resolved.cleared;
        unmerged += resolved.unmerged;
        let next = container_inner(&resolved.xml, "w:body", 0).map_or(inner, |body| body.inner);
        xml = format!("{}{next}{}", &xml[..cell.inner_start], &xml[cell.inner_end..]);
    }
    // A mark that survived (a cell inside a nested table) is cleared so Word shows no revision; a merge it implied is
    // reported as unmerged.
    let (survivors_cleared, survivors_unmerged) = (Cell::new(0_usize), Cell::new(0_usize));
    let xml = leftover.replace_all_with(&xml, |found| {
        if found.get(2) == Some(clear_tag) {
            survivors_cleared.set(survivors_cleared.get() + 1);
        } else {
            survivors_unmerged.set(survivors_unmerged.get() + 1);
        }
        found.get(1).unwrap_or("").to_owned()
    });
    MarkCounts { xml, merged, cleared: cleared + survivors_cleared.get(), unmerged: unmerged + survivors_unmerged.get() }
}

/// What settling table rows counted.
struct RowCounts {
    xml: String,
    removed: usize,
    cleared: usize,
}

/// `resolveDocxRowMarks(documentXml, { resolution, author })`: tracked table rows: a deleted row that is accepted (or an
/// inserted row that is rejected) disappears; the other marker is cleared. A row holding a nested table keeps its content and
/// only loses the marker.
fn resolve_row_marks(document_xml: &str, accept: bool, author: &str) -> RowCounts {
    let mut xml = document_xml.to_owned();
    let (mut removed, mut cleared) = (0, 0);
    let nested_table = compiled(r"<w:tbl\b", "");
    let row_properties = compiled(
        r"^<w:tr(?:\s[^>]*)?>\s*(?:<w:tblPrEx(?:\s[^>]*)?>[\s\S]*?<\/w:tblPrEx>\s*)?(<w:trPr(?:\s[^>]*)?>[\s\S]*?<\/w:trPr>)",
        "",
    );
    for row in element_extents(&xml, "w:tr").into_iter().rev() {
        let row_xml = xml[row.start..row.end].to_owned();
        if nested_table.is_match(&row_xml) {
            continue;
        }
        let Some(properties) = row_properties.captures(&row_xml).and_then(|found| found.get(1).map(str::to_owned)) else { continue };
        let (deleted, inserted) = (marker("del", author).is_match(&properties), marker("ins", author).is_match(&properties));
        if !deleted && !inserted {
            continue;
        }
        if if accept { deleted } else { inserted } {
            xml = format!("{}{}", &xml[..row.start], &xml[row.end..]);
            removed += 1;
            continue;
        }
        let cleared_properties = remove_first(&marker("ins", author), &remove_first(&marker("del", author), &properties));
        let rewritten = row_xml.replacen(&properties, &cleared_properties, 1);
        xml = format!("{}{rewritten}{}", &xml[..row.start], &xml[row.end..]);
        cleared += 1;
    }
    let survivors = Cell::new(0_usize);
    let pattern = format!(r"(<w:trPr(?:\s[^>]*)?>(?:(?!<\/w:trPr>)[\s\S])*?)<w:(?:ins|del)\b{}[^>]*\/>", revision_owner(author));
    let xml = compiled(&pattern, "g").replace_all_with(&xml, |found| {
        survivors.set(survivors.get() + 1);
        found.get(1).unwrap_or("").to_owned()
    });
    RowCounts { xml, removed, cleared: cleared + survivors.get() }
}

/// `resolveMarksInBody(documentXml, resolution, author)`: the paragraph marks of one body, one at a time (a join changes the
/// blocks that follow it).
fn resolve_marks_in_body(document_xml: &str, accept: bool, author: &str) -> MarkCounts {
    let merge_tag = if accept { "del" } else { "ins" };
    let clear_tag = if accept { "ins" } else { "del" };
    let mut xml = document_xml.to_owned();
    let (mut merged, mut cleared, mut unmerged) = (0, 0, 0);
    for _ in 0..10_000 {
        let model = docx_body_model(&xml);
        let Some(body) = model.body.as_ref() else { break };
        let mut replacement: Option<(usize, usize, String)> = None;
        for (index, block) in model.blocks.iter().enumerate() {
            if block.name != "w:p" {
                continue;
            }
            let own = paragraph_parts(&block.xml);
            if marked_paragraph(&own.properties, clear_tag, author) {
                replacement = Some((block.start, block.end, cleared_paragraph(&block.xml, clear_tag, author)));
                cleared += 1;
                break;
            }
            if !marked_paragraph(&own.properties, merge_tag, author) {
                continue;
            }
            let next = model.blocks.get(index + 1).filter(|next| next.name == "w:p");
            let Some(next) = next else {
                replacement = Some((block.start, block.end, cleared_paragraph(&block.xml, merge_tag, author)));
                unmerged += 1;
                break;
            };
            let second = paragraph_parts(&next.xml);
            replacement = Some((
                block.start,
                next.end,
                format!("{}{}{}{}</w:p>", second.open, second.properties, own.content, second.content),
            ));
            merged += 1;
            break;
        }
        let Some((start, end, replaced)) = replacement else { break };
        let inner = format!("{}{replaced}{}", &body.inner[..start], &body.inner[end..]);
        xml = format!("{}{inner}{}", &xml[..body.start], &xml[body.end..]);
    }
    MarkCounts { xml, merged, cleared, unmerged }
}

/// `resolveStoryParagraphMarks(xml, options)`: paragraph marks outside the main document part. A header or footer is one
/// paragraph sequence like the body; each footnote or endnote is a sequence of its own, so a mark never joins a note to the
/// next note.
fn resolve_story_paragraph_marks(xml: &str, accept: bool, author: &str) -> MarkCounts {
    if compiled(r"<w:body\b", "").is_match(xml) {
        return resolve_paragraph_marks(xml, accept, author);
    }
    let root = compiled(r"<w:(hdr|ftr|footnotes|endnotes)\b", "").captures(xml).and_then(|found| found.get(1).map(str::to_owned));
    let Some(root) = root else { return MarkCounts { xml: xml.to_owned(), merged: 0, cleared: 0, unmerged: 0 } };
    let tag = match root.as_str() {
        "hdr" => "w:hdr",
        "ftr" => "w:ftr",
        "footnotes" => "w:footnote",
        _ => "w:endnote",
    };
    let mut output = xml.to_owned();
    let mut totals = MarkCounts { xml: String::new(), merged: 0, cleared: 0, unmerged: 0 };
    for extent in element_extents(&output, tag).into_iter().rev() {
        let inner = output[extent.inner_start..extent.inner_end].to_owned();
        let resolved = resolve_paragraph_marks(&format!("<w:body>{inner}</w:body>"), accept, author);
        totals.merged += resolved.merged;
        totals.cleared += resolved.cleared;
        totals.unmerged += resolved.unmerged;
        let next = container_inner(&resolved.xml, "w:body", 0).map_or(inner, |body| body.inner);
        output = format!("{}{next}{}", &output[..extent.inner_start], &output[extent.inner_end..]);
    }
    MarkCounts { xml: output, ..totals }
}

/// Which tracked changes of a story are settled and how.
#[derive(Debug, Clone, Copy, Default)]
pub struct SettleOptions<'a> {
    /// `accept` (also when empty, Node's default) or anything else, which rejects.
    pub resolution: &'a str,
    /// The one wrapper at this place (1-based); 0 for all.
    pub target: usize,
    /// The wrapper with this `w:id`.
    pub id: &'a str,
    /// Only this reviewer's changes.
    pub author: &'a str,
}

/// What [`settle_docx_story`] settled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettledStory {
    pub xml: String,
    pub resolved: usize,
    pub merged: usize,
    pub cleared: usize,
    pub unmerged: usize,
    pub rows_removed: usize,
    pub rows_cleared: usize,
    pub property_changes: usize,
}

/// `settleDocxStory(xml, { resolution, target, id, author })`: settles the tracked changes of one story part (document body,
/// header, footer, footnotes, endnotes): wrappers first, then paragraph marks, table rows, and formatting records. A single
/// revision (ordinal or id) settles its wrapper alone, since marks and records carry no ordinal; `author` limits every stage
/// to one reviewer.
pub fn settle_docx_story(xml: &str, options: &SettleOptions<'_>) -> SettledStory {
    let resolution = if options.resolution.is_empty() { "accept" } else { options.resolution };
    let accept = resolution == "accept";
    let (wrappers_xml, resolved) = resolve_docx_revisions(
        xml,
        &ResolveOptions { resolution, target: options.target, id: options.id, author: options.author },
    );
    if options.target != 0 || !options.id.is_empty() {
        return SettledStory {
            xml: wrappers_xml,
            resolved,
            merged: 0,
            cleared: 0,
            unmerged: 0,
            rows_removed: 0,
            rows_cleared: 0,
            property_changes: 0,
        };
    }
    let marks = resolve_story_paragraph_marks(&wrappers_xml, accept, options.author);
    let rows = resolve_row_marks(&marks.xml, accept, options.author);
    let (properties_xml, property_changes) = resolve_docx_property_changes(&rows.xml, resolution, options.author);
    SettledStory {
        xml: properties_xml,
        resolved,
        merged: marks.merged,
        cleared: marks.cleared,
        unmerged: marks.unmerged,
        rows_removed: rows.removed,
        rows_cleared: rows.cleared,
        property_changes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adjacent_runs_of_one_format_become_one() {
        let xml = r#"<w:p><w:r w:rsidR="1"><w:rPr><w:b/></w:rPr><w:t>Hel</w:t></w:r><w:proofErr w:type="spellStart"/><w:r><w:rPr><w:b/></w:rPr><w:t>lo </w:t></w:r><w:r><w:t>x</w:t></w:r></w:p>"#;
        let done = normalize_docx_runs(xml);
        assert_eq!(
            done.xml,
            r#"<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Hello</w:t></w:r><w:r><w:t>x</w:t></w:r></w:p>"#
        );
        assert_eq!((done.merged, done.text_merged, done.proof_err_removed, done.rsid_stripped), (1, 1, 1, 1));
    }

    #[test]
    fn a_deleted_paragraph_mark_joins_the_next_paragraph() {
        let xml = r#"<w:body><w:p><w:pPr><w:rPr><w:del w:id="1" w:author="A"/></w:rPr></w:pPr><w:r><w:t>a</w:t></w:r></w:p><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>b</w:t></w:r></w:p></w:body>"#;
        let accepted = settle_docx_story(xml, &SettleOptions::default());
        assert_eq!(accepted.merged, 1);
        assert_eq!(
            accepted.xml,
            r#"<w:body><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>a</w:t></w:r><w:r><w:t>b</w:t></w:r></w:p></w:body>"#
        );
        let rejected = settle_docx_story(xml, &SettleOptions { resolution: "reject", ..SettleOptions::default() });
        assert_eq!((rejected.merged, rejected.cleared), (0, 1));
    }

    #[test]
    fn a_deleted_row_is_removed_and_an_inserted_one_is_kept() {
        let xml = r#"<w:body><w:tbl><w:tr><w:trPr><w:del w:id="1" w:author="A"/></w:trPr><w:tc><w:p/></w:tc></w:tr><w:tr><w:trPr><w:ins w:id="2" w:author="B"/></w:trPr><w:tc><w:p/></w:tc></w:tr></w:tbl></w:body>"#;
        let done = settle_docx_story(xml, &SettleOptions::default());
        assert_eq!((done.rows_removed, done.rows_cleared), (1, 1));
        assert_eq!(done.xml, r#"<w:body><w:tbl><w:tr><w:trPr></w:trPr><w:tc><w:p/></w:tc></w:tr></w:tbl></w:body>"#);
    }
}
