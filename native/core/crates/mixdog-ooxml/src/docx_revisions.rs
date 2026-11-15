//! `portable/docx-revisions.mjs`: the tracked changes of a WordprocessingML part. The revision wrappers (`w:ins`, `w:del`
//! and the move pair) are read into a tree with absolute offsets, which the redlining audit, the structural lint and
//! accept/reject all walk; formatting revisions (`w:rPrChange` and its kin) are resolved by pattern. The document is
//! edited as text, as the Node code does, with the same patterns (`JsRegex`), so a match is the one V8 finds. Offsets are
//! byte offsets into the part (Node's are UTF-16 units; the text between two offsets is the same).

use std::collections::{BTreeMap, HashMap, HashSet};

use mixdog_js::{js_trim, slice_utf16, utf16_len};
use serde_json::{Map, Value, json};

use crate::xml::{compiled, tag_pattern, xml_attribute, xml_decode, xml_encode};

const EXCERPT_CHARS: usize = 200;

/// How many foreign authors, and how many lines of a difference, a report lists.
const REPORTED_AUTHORS: usize = 10;
const REPORTED_LINES: usize = 6;

const REDLINING_GUIDANCE: [&str; 3] = [
    "Turn track_changes on before editing; an edit made while it is off leaves no <w:ins>/<w:del> and reads as untracked.",
    "To reject another author's insertion, nest a <w:del> inside their <w:ins> instead of editing its text; to restore their deletion, add a new <w:ins> after their <w:del>.",
    "A tracked change from the source is recognised by author, date, and text; rewriting one of those turns it into a new change and reports the text it carried as missing.",
];

/// Lookahead that pins a revision element to one reviewer. Word does not fix the attribute order, so the author is looked
/// for anywhere in the tag; an apostrophe may be written raw or as an entity. Empty when every reviewer is meant.
pub fn revision_owner(author: &str) -> String {
    if author.is_empty() {
        return String::new();
    }
    let encoded = tag_pattern(&xml_encode(author)).replace("&apos;", "(?:&apos;|')");
    format!(r#"(?=[^>]*\bw:author="{encoded}")"#)
}

/// The text Word draws for one `w:t` / `w:delText`: without `xml:space="preserve"` the edge whitespace never reaches the page.
pub fn rendered_word_text(attrs: &str, raw: &str) -> String {
    let value = xml_decode(raw);
    if compiled(r#"\bxml:space="preserve""#, "").is_match(attrs) {
        value
    } else {
        value.trim_matches(|c| matches!(c, ' ' | '\t' | '\r' | '\n')).to_owned()
    }
}

fn excerpt(text: &str) -> String {
    if utf16_len(text) > EXCERPT_CHARS { format!("{}…", slice_utf16(text, EXCERPT_CHARS)) } else { text.to_owned() }
}

/// Everything a tracked change carries, `w:t` and `w:delText` alike, so a deletion nested inside someone else's
/// insertion leaves that insertion's identity (author, date, text) intact.
fn revision_text(fragment: &str) -> String {
    let mut text = String::new();
    for found in compiled(r"<w:(t|delText)\b([^>]*)>([\s\S]*?)<\/w:\1>", "g").captures_iter(fragment) {
        text.push_str(&rendered_word_text(found.get(2).unwrap_or(""), found.get(3).unwrap_or("")));
    }
    text
}

/// A tracked change behaves as an insertion or as a deletion; a move pair is one of each.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevisionKind {
    Insertion,
    Deletion,
}

/// One tracked-change wrapper with the offsets of its opening tag, its content and its end.
#[derive(Debug, Clone)]
pub struct RevisionSpan {
    /// `ins`, `del`, `moveTo` or `moveFrom`.
    pub tag: String,
    pub kind: RevisionKind,
    pub attrs: String,
    pub start: usize,
    pub inner_start: usize,
    pub inner_end: usize,
    pub end: usize,
    pub id: String,
    pub author: String,
    pub date: String,
    pub text: String,
    pub children: Vec<RevisionSpan>,
    /// The place of the span in document order (`flatten_docx_revisions`).
    index: usize,
}

struct OpenSpan {
    tag: String,
    attrs: String,
    start: usize,
    inner_start: usize,
    closed: Option<(usize, usize, String)>,
    children: Vec<usize>,
}

fn closed_tree(arena: &[OpenSpan], ids: &[usize]) -> Vec<RevisionSpan> {
    let mut spans = Vec::new();
    for &id in ids {
        let open = &arena[id];
        let Some((inner_end, end, text)) = &open.closed else { continue };
        let kind = if open.tag == "ins" || open.tag == "moveTo" { RevisionKind::Insertion } else { RevisionKind::Deletion };
        spans.push(RevisionSpan {
            tag: open.tag.clone(),
            kind,
            attrs: open.attrs.clone(),
            start: open.start,
            inner_start: open.inner_start,
            inner_end: *inner_end,
            end: *end,
            id: xml_attribute(&open.attrs, "w:id"),
            author: xml_decode(&xml_attribute(&open.attrs, "w:author")),
            date: xml_attribute(&open.attrs, "w:date"),
            text: text.clone(),
            children: closed_tree(arena, &open.children),
            index: 0,
        });
    }
    spans
}

fn number_spans(spans: &mut [RevisionSpan], next: &mut usize) {
    for span in spans {
        span.index = *next;
        *next += 1;
        number_spans(&mut span.children, next);
    }
}

/// Tracked-change wrappers of a WordprocessingML part as a tree with absolute offsets: `w:ins` / `w:del` and the move
/// pair `w:moveTo` / `w:moveFrom`, which behave as an insertion and a deletion (`kind`). Self-closing `<w:ins/>` /
/// `<w:del/>` are paragraph-mark markers inside `w:rPr`, not wrappers, and are skipped; an unclosed wrapper is dropped
/// rather than guessed.
pub fn docx_revision_tree(xml: &str) -> Vec<RevisionSpan> {
    let mut arena: Vec<OpenSpan> = Vec::new();
    let mut roots: Vec<usize> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    for found in compiled(r"<(\/?)w:(ins|del|moveTo|moveFrom)\b([^>]*?)(\/?)>", "g").captures_iter(xml) {
        if found.get(4) == Some("/") {
            continue;
        }
        let tag = found.get(2).unwrap_or("");
        let range = found.range();
        if found.get(1) != Some("/") {
            let id = arena.len();
            arena.push(OpenSpan {
                tag: tag.to_owned(),
                attrs: found.get(3).unwrap_or("").to_owned(),
                start: range.start,
                inner_start: range.end,
                closed: None,
                children: Vec::new(),
            });
            match stack.last() {
                Some(&parent) => arena[parent].children.push(id),
                None => roots.push(id),
            }
            stack.push(id);
            continue;
        }
        let Some(depth) = stack.iter().rposition(|&open| arena[open].tag == tag) else { continue };
        let open = stack[depth];
        let text = revision_text(&xml[arena[open].inner_start..range.start]);
        arena[open].closed = Some((range.start, range.end, text));
        stack.truncate(depth);
    }
    let mut tree = closed_tree(&arena, &roots);
    number_spans(&mut tree, &mut 0);
    tree
}

/// Document order of the opening tags, parents before children: the order the snapshot numbers revisions in and
/// `resolve_revision` addresses.
pub fn flatten_docx_revisions(spans: &[RevisionSpan]) -> Vec<&RevisionSpan> {
    fn collect<'a>(spans: &'a [RevisionSpan], into: &mut Vec<&'a RevisionSpan>) {
        for span in spans {
            into.push(span);
            collect(&span.children, into);
        }
    }
    let mut flat = Vec::new();
    collect(spans, &mut flat);
    flat
}

fn revision_key(span: &RevisionSpan) -> String {
    [span.tag.as_str(), span.author.as_str(), span.date.as_str(), span.text.as_str()].join("\u{0}")
}

fn revision_group(span: &RevisionSpan) -> String {
    [span.tag.as_str(), span.author.as_str(), span.date.as_str()].join("\u{0}")
}

/// Modified-side wrappers (by document order) that do not reproduce a tracked change of the original. A change is
/// recognised by tag, author, date, and text; one the editor split into pieces (to reject part of it) still counts as the
/// original as long as the pieces keep author and date and spell the same text in sequence.
fn new_revisions(original: &[&RevisionSpan], modified: &[&RevisionSpan]) -> Vec<usize> {
    let mut pool: HashMap<String, Vec<usize>> = HashMap::new();
    for (at, span) in original.iter().enumerate() {
        pool.entry(revision_key(span)).or_default().push(at);
    }
    let mut matched: HashSet<usize> = HashSet::new();
    let mut leftover: Vec<usize> = Vec::new();
    for (at, span) in modified.iter().enumerate() {
        match pool.get_mut(&revision_key(span)).and_then(Vec::pop) {
            Some(found) => {
                matched.insert(found);
            }
            None => leftover.push(at),
        }
    }
    let mut unmatched_original: HashMap<String, String> = HashMap::new();
    for (at, span) in original.iter().enumerate() {
        if !matched.contains(&at) {
            unmatched_original.entry(revision_group(span)).or_default().push_str(&span.text);
        }
    }
    let mut groups: Vec<(String, Vec<usize>)> = Vec::new();
    let mut group_at: HashMap<String, usize> = HashMap::new();
    for at in leftover {
        let group = revision_group(modified[at]);
        let place = *group_at.entry(group.clone()).or_insert_with(|| {
            groups.push((group, Vec::new()));
            groups.len() - 1
        });
        groups[place].1.push(at);
    }
    let mut fresh = Vec::new();
    for (group, spans) in groups {
        let rebuilt: String = spans.iter().map(|&at| modified[at].text.as_str()).collect();
        if !rebuilt.is_empty() && rebuilt == unmatched_original.get(&group).map_or("", String::as_str) {
            continue;
        }
        fresh.extend(spans);
    }
    fresh
}

fn unwrap_deletion(inner: &str) -> String {
    let text = compiled(r"<w:delText\b", "g").replace_all_with(inner, |_| "<w:t".to_owned()).replace("</w:delText>", "</w:t>");
    compiled(r"<w:delInstrText\b", "g").replace_all_with(&text, |_| "<w:instrText".to_owned()).replace("</w:delInstrText>", "</w:instrText>")
}

/// Rebuilds `xml[from, to)` with the targeted wrappers undone: a targeted insertion disappears with its content, a
/// targeted deletion gives its text back; every other wrapper is kept with its children rebuilt the same way.
fn without_revisions(xml: &str, spans: &[RevisionSpan], from: usize, to: usize, is_target: &dyn Fn(&RevisionSpan) -> bool) -> String {
    let mut output = String::new();
    let mut cursor = from;
    for span in spans {
        output.push_str(&xml[cursor..span.start]);
        cursor = span.end;
        let targeted = is_target(span);
        if targeted && span.kind == RevisionKind::Insertion {
            continue;
        }
        let inner = without_revisions(xml, &span.children, span.inner_start, span.inner_end, is_target);
        if targeted {
            output.push_str(&unwrap_deletion(&inner));
        } else {
            output.push_str(&xml[span.start..span.inner_start]);
            output.push_str(&inner);
            output.push_str(&xml[span.inner_end..span.end]);
        }
    }
    output.push_str(&xml[cursor..to]);
    output
}

fn paragraph_lines(xml: &str) -> Vec<String> {
    let mut lines = Vec::new();
    for paragraph in compiled(r"<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>", "g").captures_iter(xml) {
        let mut text = String::new();
        for node in compiled(r"<w:t\b([^>]*)>([\s\S]*?)<\/w:t>", "g").captures_iter(paragraph.get(1).unwrap_or("")) {
            text.push_str(&rendered_word_text(node.get(1).unwrap_or(""), node.get(2).unwrap_or("")));
        }
        if !text.is_empty() {
            lines.push(text);
        }
    }
    lines
}

/// Where two lists of paragraphs differ: the common head and tail are cut away and what lies between is reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineDiff {
    /// The first differing paragraph, counted from 1.
    pub paragraph: usize,
    pub removed_lines: usize,
    pub added_lines: usize,
    pub before: Vec<String>,
    pub after: Vec<String>,
}

impl LineDiff {
    fn to_object(&self) -> Map<String, Value> {
        let mut map = Map::new();
        map.insert("paragraph".into(), json!(self.paragraph));
        map.insert("removedLines".into(), json!(self.removed_lines));
        map.insert("addedLines".into(), json!(self.added_lines));
        map.insert("before".into(), json!(self.before));
        map.insert("after".into(), json!(self.after));
        map
    }
}

fn line_diff(before: &[String], after: &[String]) -> LineDiff {
    let mut head = 0;
    while head < before.len() && head < after.len() && before[head] == after[head] {
        head += 1;
    }
    let mut tail = 0;
    while tail < before.len() - head && tail < after.len() - head && before[before.len() - 1 - tail] == after[after.len() - 1 - tail] {
        tail += 1;
    }
    let shown = |lines: &[String]| -> Vec<String> { lines[head..lines.len() - tail].iter().take(REPORTED_LINES).map(|line| excerpt(line)).collect() };
    LineDiff {
        paragraph: head + 1,
        removed_lines: before.len() - head - tail,
        added_lines: after.len() - head - tail,
        before: shown(before),
        after: shown(after),
    }
}

/// A new tracked change by an author other than the one asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForeignAuthor {
    /// `insertion` or `deletion`.
    pub kind: &'static str,
    pub author: String,
    pub text: String,
}

impl ForeignAuthor {
    fn to_object(&self) -> Map<String, Value> {
        let mut map = Map::new();
        map.insert("type".into(), json!(self.kind));
        map.insert("author".into(), json!(self.author));
        map.insert("text".into(), json!(self.text));
        map
    }
}

/// The result of the redlining audit of one part.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedliningAudit {
    pub author: String,
    pub existing_changes: usize,
    pub insertions: usize,
    pub deletions: usize,
    pub untracked_edits: Option<LineDiff>,
    pub foreign_authors: Vec<ForeignAuthor>,
    pub reason: String,
}

impl RedliningAudit {
    pub fn ok(&self) -> bool {
        self.reason.is_empty()
    }

    /// The audit as the tool answers it (`guidance` only when it failed).
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("requested".into(), json!(true));
        map.insert("ok".into(), json!(self.ok()));
        map.insert("author".into(), json!(self.author));
        map.insert("existingChanges".into(), json!(self.existing_changes));
        map.insert("newChanges".into(), json!({ "insertions": self.insertions, "deletions": self.deletions }));
        map.insert("untrackedEdits".into(), self.untracked_edits.as_ref().map_or(Value::Null, |diff| Value::Object(diff.to_object())));
        map.insert("foreignAuthors".into(), Value::Array(self.foreign_authors.iter().map(|entry| Value::Object(entry.to_object())).collect()));
        map.insert("reason".into(), json!(self.reason));
        if !self.ok() {
            map.insert("guidance".into(), json!(REDLINING_GUIDANCE));
        }
        Value::Object(map)
    }
}

/// Compares the current body with the source after undoing only the tracked changes that are new relative to the source:
/// whatever text still differs was edited without being tracked. With `author`, every new change must carry that author.
/// Only the document body is compared.
pub fn audit_docx_redlining(current_xml: &str, original_xml: &str, author: &str) -> RedliningAudit {
    let original_tree = docx_revision_tree(original_xml);
    let original_spans = flatten_docx_revisions(&original_tree);
    let modified_tree = docx_revision_tree(current_xml);
    let modified_spans = flatten_docx_revisions(&modified_tree);
    let fresh = new_revisions(&original_spans, &modified_spans);
    let fresh_indices: HashSet<usize> = fresh.iter().map(|&at| modified_spans[at].index).collect();
    let undone = without_revisions(current_xml, &modified_tree, 0, current_xml.len(), &|span| fresh_indices.contains(&span.index));
    let before = paragraph_lines(original_xml);
    let after = paragraph_lines(&undone);
    let untracked_edits = if before.join("\n") == after.join("\n") { None } else { Some(line_diff(&before, &after)) };
    let expected = js_trim(author).to_owned();
    let foreign_authors: Vec<ForeignAuthor> = if expected.is_empty() {
        Vec::new()
    } else {
        fresh
            .iter()
            .map(|&at| modified_spans[at])
            .filter(|span| span.author != expected)
            .take(REPORTED_AUTHORS)
            .map(|span| ForeignAuthor {
                kind: if span.tag == "ins" { "insertion" } else { "deletion" },
                author: span.author.clone(),
                text: excerpt(&span.text),
            })
            .collect()
    };
    let mut reasons: Vec<String> = Vec::new();
    if let Some(diff) = &untracked_edits {
        // A paragraph rewritten in place is one line out and one in: the larger side counts the paragraphs, not the sum.
        reasons.push(format!(
            "{} paragraph(s) differ from the source after undoing the new tracked changes: they were edited untracked, without <w:ins>/<w:del> (first at paragraph {}).",
            diff.removed_lines.max(diff.added_lines),
            diff.paragraph
        ));
    }
    if !foreign_authors.is_empty() {
        reasons.push(format!("{} new tracked change(s) carry an author other than \"{expected}\".", foreign_authors.len()));
    }
    let of_kind = |kind: RevisionKind| fresh.iter().filter(|&&at| modified_spans[at].kind == kind).count();
    RedliningAudit {
        author: expected.clone(),
        existing_changes: original_spans.len(),
        insertions: of_kind(RevisionKind::Insertion),
        deletions: of_kind(RevisionKind::Deletion),
        untracked_edits,
        foreign_authors,
        reason: reasons.join(" "),
    }
}

/// The story parts of a document by name (`word/document.xml`, headers, footers, notes) and their XML.
pub type StoryParts = BTreeMap<String, String>;

/// The result of the redlining audit across every story part.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoriesAudit {
    pub author: String,
    pub existing_changes: usize,
    pub insertions: usize,
    pub deletions: usize,
    /// The first part with an untracked edit and what differs in it.
    pub untracked_edits: Option<(String, LineDiff)>,
    pub foreign_authors: Vec<(ForeignAuthor, String)>,
    /// Each source part, whether it passed, and its new changes (insertions, deletions).
    pub parts: Vec<(String, bool, usize, usize)>,
    pub added_parts: Vec<String>,
    pub reason: String,
}

impl StoriesAudit {
    pub fn ok(&self) -> bool {
        self.reason.is_empty()
    }

    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("requested".into(), json!(true));
        map.insert("ok".into(), json!(self.ok()));
        map.insert("author".into(), json!(self.author));
        map.insert("existingChanges".into(), json!(self.existing_changes));
        map.insert("newChanges".into(), json!({ "insertions": self.insertions, "deletions": self.deletions }));
        let untracked = self.untracked_edits.as_ref().map_or(Value::Null, |(part, diff)| {
            let mut object = Map::new();
            object.insert("part".into(), json!(part));
            object.extend(diff.to_object());
            Value::Object(object)
        });
        map.insert("untrackedEdits".into(), untracked);
        let foreign = self.foreign_authors.iter().map(|(entry, part)| {
            let mut object = entry.to_object();
            object.insert("part".into(), json!(part));
            Value::Object(object)
        });
        map.insert("foreignAuthors".into(), Value::Array(foreign.collect()));
        let parts = self.parts.iter().map(|(part, ok, insertions, deletions)| {
            json!({ "part": part, "ok": ok, "newChanges": { "insertions": insertions, "deletions": deletions } })
        });
        map.insert("parts".into(), Value::Array(parts.collect()));
        map.insert("addedParts".into(), json!(self.added_parts));
        map.insert("reason".into(), json!(self.reason));
        if !self.ok() {
            map.insert("guidance".into(), json!(REDLINING_GUIDANCE));
        }
        Value::Object(map)
    }
}

/// The body audit applied to every story part the source has: a header, footer, or note edited untracked fails the same
/// way, and a foreign author anywhere is reported with its part. A part the edit created (a footer for page numbers, say)
/// is listed under `added_parts` rather than failed, since Word tracks no story's creation.
pub fn audit_docx_redlining_stories(current: &StoryParts, original: &StoryParts, author: &str) -> StoriesAudit {
    let audits: Vec<(&String, RedliningAudit)> = original
        .iter()
        .map(|(name, original_xml)| {
            let current_xml = current.get(name).map_or("", String::as_str);
            (name, audit_docx_redlining(current_xml, original_xml, author))
        })
        .collect();
    let untracked_edits = audits.iter().find_map(|(name, audit)| audit.untracked_edits.clone().map(|diff| ((*name).clone(), diff)));
    let body = compiled(r"^word\/document\.xml$", "i");
    let reasons: Vec<String> = audits
        .iter()
        .filter(|(_, audit)| !audit.reason.is_empty())
        .map(|(name, audit)| if body.is_match(name) { audit.reason.clone() } else { format!("{name}: {}", audit.reason) })
        .collect();
    let foreign_authors: Vec<(ForeignAuthor, String)> = audits
        .iter()
        .flat_map(|(name, audit)| audit.foreign_authors.iter().map(move |entry| (entry.clone(), (*name).clone())))
        .take(REPORTED_AUTHORS)
        .collect();
    StoriesAudit {
        author: js_trim(author).to_owned(),
        existing_changes: audits.iter().map(|(_, audit)| audit.existing_changes).sum(),
        insertions: audits.iter().map(|(_, audit)| audit.insertions).sum(),
        deletions: audits.iter().map(|(_, audit)| audit.deletions).sum(),
        untracked_edits,
        foreign_authors,
        parts: audits.iter().map(|(name, audit)| ((*name).clone(), audit.ok(), audit.insertions, audit.deletions)).collect(),
        added_parts: current.keys().filter(|name| !original.contains_key(*name)).cloned().collect(),
        reason: reasons.join(" "),
    }
}

fn count(fragment: &str, pattern: &str) -> usize {
    compiled(pattern, "g").find_iter(fragment).count()
}

/// One finding of the structural lint.
#[derive(Debug, Clone, PartialEq)]
pub struct LintFinding {
    /// `error` or `warning`.
    pub severity: &'static str,
    pub code: &'static str,
    pub message: String,
    /// What else the finding carries (`count`, `part`, `ids`), in the order Node lists it.
    pub extra: Vec<(&'static str, Value)>,
}

impl LintFinding {
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("severity".into(), json!(self.severity));
        map.insert("code".into(), json!(self.code));
        map.insert("message".into(), json!(self.message));
        for (key, value) in &self.extra {
            map.insert((*key).to_owned(), value.clone());
        }
        Value::Object(map)
    }
}

/// A story part's name and its XML.
#[derive(Debug, Clone, Copy)]
pub struct Story<'a> {
    pub part: &'a str,
    pub xml: &'a str,
}

/// A `Set` of strings that lists its members in the order they were first added.
#[derive(Default)]
struct OrderedSet {
    order: Vec<String>,
    seen: HashSet<String>,
}

impl OrderedSet {
    fn insert(&mut self, value: String) {
        if self.seen.insert(value.clone()) {
            self.order.push(value);
        }
    }

    fn contains(&self, value: &str) -> bool {
        self.seen.contains(value)
    }
}

fn marker_ids(source: &str, pattern: &str) -> Vec<String> {
    compiled(pattern, "g").captures_iter(source).map(|found| found.get(1).unwrap_or("").to_owned()).collect()
}

fn lint_story_revisions(part: &str, source: &str, findings: &mut Vec<LintFinding>) -> [Vec<String>; 3] {
    let mut text_in_deletion = 0;
    let mut instr_in_deletion = 0;
    let mut deleted_in_insertion = 0;
    let tree = docx_revision_tree(source);
    for span in flatten_docx_revisions(&tree) {
        let inner = &source[span.inner_start..span.inner_end];
        if span.kind == RevisionKind::Deletion {
            text_in_deletion += count(inner, r"<w:t\b");
            instr_in_deletion += count(inner, r"<w:instrText\b");
            continue;
        }
        let mut masked = inner.to_owned();
        let mut deleted_children: Vec<&RevisionSpan> = span.children.iter().filter(|entry| entry.kind == RevisionKind::Deletion).collect();
        deleted_children.sort_by(|a, b| b.start.cmp(&a.start));
        for child in deleted_children {
            masked = format!("{}{}", &masked[..child.start - span.inner_start], &masked[child.end - span.inner_start..]);
        }
        deleted_in_insertion += count(&masked, r"<w:delText\b");
    }
    let mut add = |severity: &'static str, code: &'static str, message: String, number: usize| {
        findings.push(LintFinding { severity, code, message, extra: vec![("count", json!(number)), ("part", json!(part))] });
    };
    if text_in_deletion > 0 {
        add("error", "text_in_deletion", format!("{text_in_deletion} <w:t> element(s) sit inside <w:del>; deleted text must be <w:delText>."), text_in_deletion);
    }
    if instr_in_deletion > 0 {
        add("error", "instr_text_in_deletion", format!("{instr_in_deletion} <w:instrText> element(s) sit inside <w:del>; use <w:delInstrText>."), instr_in_deletion);
    }
    if deleted_in_insertion > 0 {
        add(
            "error",
            "deleted_text_in_insertion",
            format!("{deleted_in_insertion} <w:delText> element(s) sit inside <w:ins> without a <w:del>; deleted text inside an insertion needs its own <w:del>."),
            deleted_in_insertion,
        );
    }
    let edge_space = compiled(r"^[ \t\r\n]|[ \t\r\n]$", "");
    let preserved = compiled(r#"\bxml:space="preserve""#, "");
    let mut unpreserved = 0;
    for node in compiled(r"<w:t\b([^>]*)>([\s\S]*?)<\/w:t>", "g").captures_iter(source) {
        if edge_space.is_match(&xml_decode(node.get(2).unwrap_or(""))) && !preserved.is_match(node.get(1).unwrap_or("")) {
            unpreserved += 1;
        }
    }
    if unpreserved > 0 {
        add(
            "warning",
            "whitespace_not_preserved",
            format!("{unpreserved} text element(s) start or end with a space but lack xml:space=\"preserve\"; Word drops that space."),
            unpreserved,
        );
    }
    [
        marker_ids(source, r#"<w:commentRangeStart\b[^>]*\bw:id="([^"]*)""#),
        marker_ids(source, r#"<w:commentRangeEnd\b[^>]*\bw:id="([^"]*)""#),
        marker_ids(source, r#"<w:commentReference\b[^>]*\bw:id="([^"]*)""#),
    ]
}

/// Structural faults Word rejects or silently misreads across the story parts (body, headers, footers, notes): text
/// elements inside the wrong revision wrapper, edge whitespace that is not preserved, and comment markers without a
/// partner or a comment. A body alone is a list of one story.
pub fn lint_docx_revisions(stories: &[Story<'_>], comments_xml: &str) -> Vec<LintFinding> {
    let mut findings = Vec::new();
    let mut starts = OrderedSet::default();
    let mut ends = OrderedSet::default();
    let mut references = OrderedSet::default();
    for story in stories {
        let [story_starts, story_ends, story_references] = lint_story_revisions(story.part, story.xml, &mut findings);
        story_starts.into_iter().for_each(|id| starts.insert(id));
        story_ends.into_iter().for_each(|id| ends.insert(id));
        story_references.into_iter().for_each(|id| references.insert(id));
    }
    let mut mismatches: Vec<String> = Vec::new();
    for id in &ends.order {
        if !starts.contains(id) {
            mismatches.push(format!("commentRangeEnd {id} has no commentRangeStart"));
        }
    }
    for id in &starts.order {
        if !ends.contains(id) {
            mismatches.push(format!("commentRangeStart {id} has no commentRangeEnd"));
        }
    }
    if !comments_xml.is_empty() {
        let mut known = OrderedSet::default();
        for found in compiled(r#"<w:comment\b[^>]*\bw:id="([^"]*)""#, "g").captures_iter(comments_xml) {
            known.insert(found.get(1).unwrap_or("").to_owned());
        }
        let mut every = OrderedSet::default();
        for id in starts.order.iter().chain(&ends.order).chain(&references.order) {
            every.insert(id.clone());
        }
        for id in &every.order {
            if !known.contains(id) {
                mismatches.push(format!("marker {id} references no comment"));
            }
        }
        let unanchored: Vec<&String> = known.order.iter().filter(|id| !references.contains(id)).collect();
        if !unanchored.is_empty() {
            findings.push(LintFinding {
                severity: "warning",
                code: "comment_not_anchored",
                message: format!("{} comment(s) have no commentReference in the document body and stay invisible in Word.", unanchored.len()),
                extra: vec![("ids", json!(unanchored.iter().take(REPORTED_AUTHORS).collect::<Vec<_>>()))],
            });
        }
    }
    if !mismatches.is_empty() {
        findings.push(LintFinding {
            severity: "error",
            code: "comment_marker_mismatch",
            message: mismatches.iter().take(5).cloned().collect::<Vec<_>>().join("; "),
            extra: vec![("count", json!(mismatches.len()))],
        });
    }
    findings
}

/// Which wrappers `resolve_docx_revisions` accepts or rejects.
#[derive(Debug, Clone, Copy, Default)]
pub struct ResolveOptions<'a> {
    /// `accept` (also when empty, Node's default) or anything else, which rejects as Node's `resolution === 'accept'` test does.
    pub resolution: &'a str,
    /// The one wrapper at this place (1-based, document order of the opening tags); 0 for all.
    pub target: usize,
    /// The wrapper with this `w:id`.
    pub id: &'a str,
    /// Every wrapper by this author.
    pub author: &'a str,
}

struct Resolver<'a> {
    source: &'a str,
    accept: bool,
    target: usize,
    wanted: &'a str,
    owner: &'a str,
    ordinal: usize,
    resolved: usize,
}

impl Resolver<'_> {
    fn rebuild(&mut self, spans: &[RevisionSpan], from: usize, to: usize) -> String {
        let mut output = String::new();
        let mut cursor = from;
        for span in spans {
            self.ordinal += 1;
            let mine = self.ordinal;
            output.push_str(&self.source[cursor..span.start]);
            cursor = span.end;
            let inner = self.rebuild(&span.children, span.inner_start, span.inner_end);
            let mut addressed = self.target == 0 || self.target == mine;
            if !self.wanted.is_empty() {
                addressed = span.id == self.wanted;
            } else if !self.owner.is_empty() {
                addressed = span.author == self.owner;
            }
            if !addressed {
                output.push_str(&self.source[span.start..span.inner_start]);
                output.push_str(&inner);
                output.push_str(&self.source[span.inner_end..span.end]);
                continue;
            }
            self.resolved += 1;
            let keep = (span.kind == RevisionKind::Insertion) == self.accept;
            if !keep {
                continue;
            }
            if span.kind == RevisionKind::Deletion {
                output.push_str(&unwrap_deletion(&inner));
            } else {
                output.push_str(&inner);
            }
        }
        output.push_str(&self.source[cursor..to]);
        output
    }
}

/// Accepts or rejects tracked-change wrappers: all of them, the one at `target` or with `id`, or every one by `author`.
/// Nested wrappers resolve inside out, so accepting everything in an insertion that holds a later deletion keeps the
/// inserted text minus the deleted part. Returns the XML and how many wrappers were resolved.
pub fn resolve_docx_revisions(document_xml: &str, options: &ResolveOptions<'_>) -> (String, usize) {
    let tree = docx_revision_tree(document_xml);
    let single = options.target != 0 || !options.id.is_empty();
    let mut resolver = Resolver {
        source: document_xml,
        accept: options.resolution.is_empty() || options.resolution == "accept",
        target: options.target,
        wanted: options.id,
        owner: options.author,
        ordinal: 0,
        resolved: 0,
    };
    let mut xml = resolver.rebuild(&tree, 0, document_xml.len());
    // Move range markers only delimit the wrappers; once every wrapper (or every wrapper of the reviewer) is resolved
    // they would point at nothing.
    if !single {
        let markers = format!(r"<w:move(?:From|To)Range(?:Start|End)\b{}[^>]*\/>", revision_owner(options.author));
        xml = compiled(&markers, "g").replace_all_with(&xml, |_| String::new());
    }
    (xml, resolver.resolved)
}

const PROPERTY_CHANGE: &str = r"<w:(rPr|pPr|tblPr|trPr|tcPr|sectPr|tblGrid)Change\b";

/// Puts back the previous properties a change record carries, for one kind of properties element. The change record is
/// the last child of its properties element and holds the previous properties; rejecting means the previous ones come
/// back. The head never crosses the element's own closing tag, so a properties element without a change record is not
/// stitched to the next one that has one.
fn restore_properties(xml: &str, tag: &str, owner: &str) -> String {
    let pattern = format!(
        r"<w:{tag}(\s[^>]*)?>((?:(?!<\/w:{tag}>)[\s\S])*?)<w:{tag}Change\b{owner}[^>]*>\s*(?:<w:{tag}\/>|<w:{tag}(?:\s[^>]*)?>([\s\S]*?)<\/w:{tag}>)\s*<\/w:{tag}Change>\s*<\/w:{tag}>"
    );
    compiled(&pattern, "g").replace_all_with(xml, |found| {
        let attrs = found.get(1).unwrap_or("");
        let head = found.get(2).unwrap_or("");
        let previous = found.get(3).unwrap_or("");
        if tag != "pPr" {
            return format!("<w:{tag}{attrs}>{previous}</w:{tag}>");
        }
        // A paragraph's own rPr and sectPr precede the change record and belong to the paragraph mark, not to the
        // changed properties.
        let run = compiled(r"<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>|<w:rPr\/>", "").find(head).map_or("", |range| &head[range]);
        let section = compiled(r"<w:sectPr\b[\s\S]*?<\/w:sectPr>|<w:sectPr\b[^>]*\/>", "").find(head).map_or("", |range| &head[range]);
        format!("<w:pPr{attrs}>{previous}{run}{section}</w:pPr>")
    })
}

/// Formatting revisions (`w:rPrChange`, `w:pPrChange`, table and section property changes, `w:numberingChange`) are not
/// wrappers around runs, so accept/reject of the wrappers alone leaves Word still showing a revised document. Accepting
/// drops the records; rejecting restores the previous properties they carry. Returns the XML and how many records it held.
pub fn resolve_docx_property_changes(document_xml: &str, resolution: &str, author: &str) -> (String, usize) {
    let mut xml = document_xml.to_owned();
    let owner = revision_owner(author);
    let changes = count(&xml, &format!("{PROPERTY_CHANGE}{owner}")) + count(&xml, &format!(r"<w:numberingChange\b{owner}"));
    if changes == 0 {
        return (xml, 0);
    }
    if resolution == "reject" {
        // Run properties first: a paragraph mark's rPrChange sits inside the pPr head that the pPr restoration keeps.
        for tag in ["rPr", "tcPr", "trPr", "tblPr", "tblGrid", "sectPr", "pPr"] {
            xml = restore_properties(&xml, tag, &owner);
        }
    }
    let wrapped = format!(r"<w:(rPr|pPr|tblPr|trPr|tcPr|sectPr|tblGrid|numbering)Change\b{owner}[^>]*>[\s\S]*?<\/w:\1Change>");
    xml = compiled(&wrapped, "g").replace_all_with(&xml, |_| String::new());
    let empty = format!(r"<w:(?:rPr|pPr|tblPr|trPr|tcPr|sectPr|tblGrid|numbering)Change\b{owner}[^>]*\/>");
    xml = compiled(&empty, "g").replace_all_with(&xml, |_| String::new());
    (xml, changes)
}

/// Number of formatting revisions a part carries; they are not wrappers, so the revision list does not number them, but a
/// clean copy needs them gone.
pub fn count_docx_property_changes(xml: &str) -> usize {
    count(xml, PROPERTY_CHANGE) + count(xml, r"<w:numberingChange\b")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(text: &str) -> String {
        format!(r#"<w:r><w:t xml:space="preserve">{text}</w:t></w:r>"#)
    }

    fn insertion(id: &str, author: &str, text: &str) -> String {
        format!(r#"<w:ins w:id="{id}" w:author="{author}" w:date="2026-01-01T00:00:00Z">{}</w:ins>"#, run(text))
    }

    fn deletion(id: &str, author: &str, text: &str) -> String {
        format!(
            r#"<w:del w:id="{id}" w:author="{author}" w:date="2026-01-01T00:00:00Z"><w:r><w:delText xml:space="preserve">{text}</w:delText></w:r></w:del>"#
        )
    }

    fn body(paragraphs: &[String]) -> String {
        let inner: String = paragraphs.iter().map(|paragraph| format!("<w:p>{paragraph}</w:p>")).collect();
        format!("<w:document><w:body>{inner}</w:body></w:document>")
    }

    #[test]
    fn the_tree_reads_nesting_ids_authors_and_skips_markers_and_unclosed_wrappers() {
        let inner = deletion("2", "Bo", "gone");
        let xml = format!(
            r#"<w:p><w:pPr><w:rPr><w:ins w:id="9"/></w:rPr></w:pPr><w:ins w:id="1" w:author="A &amp; B" w:date="d">{}{inner}</w:ins><w:del w:id="3">open"#,
            run("kept")
        );
        let tree = docx_revision_tree(&xml);
        assert_eq!(tree.len(), 1);
        let outer = &tree[0];
        assert_eq!((outer.tag.as_str(), outer.kind, outer.id.as_str(), outer.author.as_str()), ("ins", RevisionKind::Insertion, "1", "A & B"));
        assert_eq!(outer.text, "keptgone");
        assert_eq!(outer.children.len(), 1);
        assert_eq!(outer.children[0].kind, RevisionKind::Deletion);
        assert_eq!(flatten_docx_revisions(&tree).len(), 2);
    }

    #[test]
    fn edge_whitespace_is_text_only_when_preserved() {
        assert_eq!(rendered_word_text("", " a "), "a");
        assert_eq!(rendered_word_text(r#" xml:space="preserve""#, " a &amp; "), " a & ");
    }

    #[test]
    fn an_edit_that_is_tracked_passes_and_an_untracked_one_is_reported() {
        let original = body(&[run("Hello world")]);
        let tracked = body(&[format!("{}{}", run("Hello "), deletion("1", "Bo", "world")) + &insertion("2", "Bo", "there")]);
        let audit = audit_docx_redlining(&tracked, &original, "Bo");
        assert!(audit.ok(), "{}", audit.reason);
        assert_eq!((audit.insertions, audit.deletions), (1, 1));
        let untracked = body(&[run("Hello there")]);
        let failed = audit_docx_redlining(&untracked, &original, "");
        assert!(!failed.ok());
        assert_eq!(failed.untracked_edits.as_ref().map(|diff| diff.paragraph), Some(1));
        assert!(failed.reason.contains("1 paragraph(s) differ from the source"));
        assert_eq!(failed.to_value()["guidance"].as_array().map(Vec::len), Some(3));
    }

    #[test]
    fn a_new_change_by_another_author_is_foreign() {
        let original = body(&[run("a")]);
        let current = body(&[format!("{}{}", run("a"), insertion("1", "Eve", "b"))]);
        let audit = audit_docx_redlining(&current, &original, " Bo ");
        assert_eq!(audit.author, "Bo");
        assert_eq!(audit.foreign_authors, vec![ForeignAuthor { kind: "insertion", author: "Eve".into(), text: "b".into() }]);
        assert!(audit.reason.contains("author other than \"Bo\""));
    }

    #[test]
    fn a_change_split_into_pieces_is_still_the_original() {
        let whole = body(&[insertion("1", "Bo", "abcd")]);
        let split = body(&[format!("{}{}", insertion("1", "Bo", "ab"), insertion("2", "Bo", "cd"))]);
        let audit = audit_docx_redlining(&split, &whole, "");
        assert_eq!((audit.insertions, audit.deletions), (0, 0));
        assert!(audit.ok());
    }

    #[test]
    fn stories_are_audited_by_the_source_parts_and_added_parts_are_listed() {
        let mut original = StoryParts::new();
        original.insert("word/document.xml".into(), body(&[run("a")]));
        original.insert("word/header1.xml".into(), "<w:hdr><w:p><w:r><w:t>H</w:t></w:r></w:p></w:hdr>".into());
        let mut current = original.clone();
        current.insert("word/header1.xml".into(), "<w:hdr><w:p><w:r><w:t>X</w:t></w:r></w:p></w:hdr>".into());
        current.insert("word/footer1.xml".into(), "<w:ftr/>".into());
        let audit = audit_docx_redlining_stories(&current, &original, "");
        assert!(!audit.ok());
        assert_eq!(audit.untracked_edits.as_ref().map(|(part, _)| part.as_str()), Some("word/header1.xml"));
        assert_eq!(audit.added_parts, vec!["word/footer1.xml".to_owned()]);
        assert!(audit.reason.starts_with("word/header1.xml: 1 paragraph(s)"));
        let value = audit.to_value();
        assert_eq!(value["parts"][0]["part"], "word/document.xml");
        assert_eq!(value["parts"][0]["ok"], true);
    }

    #[test]
    fn the_lint_finds_text_in_deletions_and_unpreserved_space_and_comment_mismatches() {
        let xml = format!(
            r#"<w:body><w:del w:id="1"><w:r><w:t>kept</w:t><w:instrText>x</w:instrText></w:r></w:del><w:ins w:id="2"><w:r><w:delText>y</w:delText></w:r></w:ins><w:r><w:t> pad</w:t></w:r><w:commentRangeStart w:id="7"/><w:commentReference w:id="8"/></w:body>"#
        );
        let findings = lint_docx_revisions(&[Story { part: "word/document.xml", xml: &xml }], r#"<w:comments><w:comment w:id="7"/><w:comment w:id="9"/></w:comments>"#);
        let codes: Vec<&str> = findings.iter().map(|finding| finding.code).collect();
        assert_eq!(
            codes,
            ["text_in_deletion", "instr_text_in_deletion", "deleted_text_in_insertion", "whitespace_not_preserved", "comment_not_anchored", "comment_marker_mismatch"]
        );
        let mismatch = findings.last().map(LintFinding::to_value).unwrap_or(Value::Null);
        assert_eq!(mismatch["message"], "commentRangeStart 7 has no commentRangeEnd; marker 8 references no comment");
        assert_eq!(findings[0].to_value()["part"], "word/document.xml");
    }

    #[test]
    fn a_deletion_inside_an_insertion_is_not_deleted_text_in_an_insertion() {
        let xml = format!(r#"<w:ins w:id="1"><w:del w:id="2"><w:r><w:delText>z</w:delText></w:r></w:del></w:ins>"#);
        assert!(lint_docx_revisions(&[Story { part: "word/document.xml", xml: &xml }], "").is_empty());
    }

    #[test]
    fn resolving_accepts_or_rejects_by_place_id_author_or_everything() {
        let xml = format!("{}{}{}", insertion("1", "Bo", "A"), deletion("2", "Eve", "B"), insertion("3", "Eve", "C"));
        let (accepted, count) = resolve_docx_revisions(&xml, &ResolveOptions::default());
        assert_eq!(count, 3);
        assert_eq!(accepted, format!("{}{}", run("A"), run("C")));
        let (rejected, _) = resolve_docx_revisions(&xml, &ResolveOptions { resolution: "reject", ..ResolveOptions::default() });
        assert_eq!(rejected, run("B"));
        let (second, count) = resolve_docx_revisions(&xml, &ResolveOptions { target: 2, resolution: "reject", ..ResolveOptions::default() });
        assert_eq!(count, 1);
        assert!(second.contains(&insertion("1", "Bo", "A")) && second.contains(&run("B")));
        let (by_id, _) = resolve_docx_revisions(&xml, &ResolveOptions { id: "3", resolution: "reject", ..ResolveOptions::default() });
        assert!(!by_id.contains('C') && by_id.contains(&deletion("2", "Eve", "B")));
        let (by_author, count) = resolve_docx_revisions(&xml, &ResolveOptions { author: "Eve", ..ResolveOptions::default() });
        assert_eq!(count, 2);
        assert!(by_author.contains(&insertion("1", "Bo", "A")));
    }

    #[test]
    fn move_range_markers_go_when_every_wrapper_of_the_reviewer_is_resolved() {
        let xml = r#"<w:moveFromRangeStart w:id="1" w:author="Bo"/><w:moveFrom w:id="2" w:author="Bo"><w:r><w:delText>m</w:delText></w:r></w:moveFrom><w:moveFromRangeEnd w:id="1"/>"#;
        let (resolved, _) = resolve_docx_revisions(xml, &ResolveOptions { author: "Bo", ..ResolveOptions::default() });
        // The start marker names the reviewer and goes; the end marker names nobody and stays.
        assert_eq!(resolved, r#"<w:moveFromRangeEnd w:id="1"/>"#);
    }

    #[test]
    fn property_changes_are_dropped_on_accept_and_restored_on_reject() {
        let xml = r#"<w:r><w:rPr><w:b/><w:rPrChange w:id="1" w:author="Bo"><w:rPr><w:i/></w:rPr></w:rPrChange></w:rPr><w:t>x</w:t></w:r>"#;
        assert_eq!(count_docx_property_changes(xml), 1);
        let (accepted, changes) = resolve_docx_property_changes(xml, "accept", "");
        assert_eq!((accepted.as_str(), changes), (r#"<w:r><w:rPr><w:b/></w:rPr><w:t>x</w:t></w:r>"#, 1));
        let (rejected, _) = resolve_docx_property_changes(xml, "reject", "");
        assert_eq!(rejected, r#"<w:r><w:rPr><w:i/></w:rPr><w:t>x</w:t></w:r>"#);
        let (untouched, none) = resolve_docx_property_changes(xml, "reject", "Eve");
        assert_eq!((untouched.as_str(), none), (xml, 0));
    }

    #[test]
    fn a_paragraph_mark_keeps_its_own_run_properties_when_the_change_is_rejected() {
        let xml = r#"<w:pPr><w:rPr><w:b/></w:rPr><w:pPrChange w:id="1"><w:pPr><w:jc w:val="left"/></w:pPr></w:pPrChange></w:pPr>"#;
        let (rejected, _) = resolve_docx_property_changes(xml, "reject", "");
        assert_eq!(rejected, r#"<w:pPr><w:jc w:val="left"/><w:rPr><w:b/></w:rPr></w:pPr>"#);
    }

    #[test]
    fn the_owner_lookahead_accepts_an_apostrophe_either_way() {
        let owner = revision_owner("O'Neil");
        let pattern = compiled(&format!(r"<w:ins\b{owner}[^>]*>"), "");
        assert!(pattern.is_match(r#"<w:ins w:id="1" w:author="O&apos;Neil">"#));
        assert!(pattern.is_match(r#"<w:ins w:author="O'Neil">"#));
        assert!(!pattern.is_match(r#"<w:ins w:author="Neil">"#));
        assert_eq!(revision_owner(""), "");
    }
}
