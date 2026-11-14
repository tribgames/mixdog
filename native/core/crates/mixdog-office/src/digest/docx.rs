//! The Word digest: a paragraph of one plain run repeats its text in that run, and the main part's text repeats every
//! paragraph and cell; the header, footer and note parts carry text nothing else in the snapshot does, so they stay.
//! Word (COM) reports every flag as its resolved zero, single-precision points and character offsets.

use mixdog_js::{number_to_string, to_number_of};
use serde_json::Value;

use super::common::{
    Object, digest_object_with, entries, filtered, is_bool, is_number, is_str, is_zero_or_false, remove, round2, round_all,
    strict_equals,
};

/// A paragraph's format names what it sets: the resolved zero of every flag says nothing.
fn quiet_paragraph_format_entry(key: &str, value: &Value) -> bool {
    matches!(key, "alignment" | "spacingBefore" | "keepWithNext" | "keepTogether" | "pageBreakBefore") && is_zero_or_false(value)
}

/// An empty face name and a font that is neither bold, italic nor underlined.
fn quiet_paragraph_font_entry(key: &str, value: &Value) -> bool {
    match key {
        "name" => is_str(Some(value), ""),
        "bold" | "italic" | "underline" => is_bool(Some(value), false),
        _ => false,
    }
}

/// Without the character offsets Word read the paragraph at, and a page range that is one page.
fn quiet_paragraph(raw: &Value) -> Value {
    let Value::Object(map) = raw else { return raw.clone() };
    let mut paragraph = map.clone();
    remove(&mut paragraph, "start");
    remove(&mut paragraph, "end");
    if paragraph.contains_key("pageEnd") && strict_equals(paragraph.get("pageEnd"), paragraph.get("pageStart")) {
        remove(&mut paragraph, "pageEnd");
    }
    if let Some(Value::Object(font)) = paragraph.get("font") {
        let font = filtered(font, |key, value| !quiet_paragraph_font_entry(key, value));
        if font.is_empty() {
            remove(&mut paragraph, "font");
        } else {
            paragraph.insert("font".to_owned(), Value::Object(font));
        }
    }
    Value::Object(paragraph)
}

fn paragraph_digest(entry: &Value) -> Value {
    let raw = quiet_paragraph(entry);
    let Value::Object(map) = &raw else { return raw };
    let mut paragraph = map.clone();
    if let Some(Value::Object(format)) = map.get("format") {
        let format = filtered(format, |key, value| !matches!(value, Value::Array(items) if items.is_empty()) && !quiet_paragraph_format_entry(key, value));
        paragraph.insert("format".to_owned(), Value::Object(round_all(&format)));
    }
    let plain_run = match paragraph.get("runs") {
        Some(Value::Array(runs)) if runs.len() == 1 => match &runs[0] {
            Value::Object(run) => {
                strict_equals(run.get("text"), paragraph.get("text")) && run.keys().all(|key| matches!(key.as_str(), "path" | "index" | "text"))
            }
            _ => false,
        },
        _ => false,
    };
    if plain_run {
        remove(&mut paragraph, "runs");
    }
    Value::Object(paragraph)
}

/// The body's order in runs: consecutive paragraphs as one span, so the order says only where a table falls.
fn block_order_digest(blocks: &[Value]) -> Vec<Value> {
    struct Span<'a> {
        kind: Option<&'a Value>,
        from: f64,
        to: f64,
        path: Option<&'a Value>,
    }
    let mut spans: Vec<Span<'_>> = Vec::new();
    for block in blocks {
        let index = to_number_of(block.get("index"));
        let is_paragraph = is_str(block.get("type"), "paragraph");
        let extends = is_paragraph && spans.last().is_some_and(|last| is_str(last.kind, "paragraph") && index == last.to + 1.0);
        if extends {
            if let Some(last) = spans.last_mut() {
                last.to = index;
            }
        } else {
            spans.push(Span { kind: block.get("type"), from: index, to: index, path: block.get("path") });
        }
    }
    spans
        .iter()
        .map(|span| {
            if is_str(span.kind, "paragraph") && span.to > span.from {
                Value::from(format!("/body/p[{}..{}]", number_to_string(span.from), number_to_string(span.to)))
            } else {
                // A path that is absent reads as null inside a list.
                span.path.cloned().unwrap_or(Value::Null)
            }
        })
        .collect()
}

fn table_digest(table: &Value) -> Value {
    digest_object_with(table, |table| {
        let mut rest = table.clone();
        remove(&mut rest, "start");
        remove(&mut rest, "end");
        if is_number(rest.get("alignment"), 0.0) {
            remove(&mut rest, "alignment");
        }
        if rest.contains_key("pageEnd") && strict_equals(rest.get("pageEnd"), rest.get("pageStart")) {
            remove(&mut rest, "pageEnd");
        }
        rest
    })
}

/// Word (COM) states a section's margins in single-precision points (70.9000015258789), its orientation by number, and a
/// header that is its own as `linkToPrevious:false`.
fn section_digest(section: &Value) -> Value {
    digest_object_with(section, |section| {
        let mut rest = section.clone();
        for key in ["topMargin", "bottomMargin", "leftMargin", "rightMargin", "columnSpacing"] {
            if let Some(margin @ Value::Number(_)) = rest.get(key) {
                let rounded = round2(margin);
                rest.insert(key.to_owned(), rounded);
            }
        }
        if is_number(rest.get("orientation"), 0.0) {
            rest.insert("orientation".to_owned(), Value::from("portrait"));
        } else if is_number(rest.get("orientation"), 1.0) {
            rest.insert("orientation".to_owned(), Value::from("landscape"));
        }
        // A single column is every section's default; a section says so only when it lays its text out in more.
        if is_number(rest.get("columns"), 1.0) {
            remove(&mut rest, "columns");
        }
        // A story Word breaks into paragraphs with \r reads with \n, as the portable reader joins them; an empty header or
        // footer (Word keeps one on every section) says nothing.
        if let Some(Value::Array(stories)) = rest.get("stories") {
            let stories: Vec<Value> = stories
                .iter()
                .filter(|story| !(story.is_object() && is_str(story.get("text"), "")))
                .map(story_digest)
                .collect();
            if stories.is_empty() {
                remove(&mut rest, "stories");
            } else {
                rest.insert("stories".to_owned(), Value::Array(stories));
            }
        }
        rest
    })
}

fn story_digest(story: &Value) -> Value {
    digest_object_with(story, |story| {
        let mut kept = story.clone();
        if is_bool(kept.get("linkToPrevious"), false) {
            remove(&mut kept, "linkToPrevious");
        }
        if let Some(Value::String(text)) = kept.get("text") {
            let joined = lines_joined(text);
            kept.insert("text".to_owned(), Value::String(joined));
        }
        kept
    })
}

/// `text.replace(/\r\n?/g, '\n')`.
fn lines_joined(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(c);
        }
    }
    out
}

/// A comment that is open and unanswered says so by omission, as the portable reader writes it.
fn comment_digest(comment: &Value) -> Value {
    digest_object_with(comment, |comment| {
        let mut rest = comment.clone();
        if is_bool(rest.get("resolved"), false) {
            remove(&mut rest, "resolved");
        }
        if matches!(rest.get("replies"), Some(Value::Array(replies)) if replies.is_empty()) {
            remove(&mut rest, "replies");
        }
        rest
    })
}

/// The document a model reads.
pub fn docx_document_digest(document: &Value) -> Value {
    let Value::Object(map) = document else { return document.clone() };
    if !is_str(map.get("format"), "docx") {
        return document.clone();
    }
    let Some(Value::Array(source)) = map.get("paragraphs") else { return document.clone() };
    let paragraphs: Vec<Value> = source.iter().map(paragraph_digest).collect();
    // Only a snapshot holding every paragraph makes the main part's text redundant; a paged one may be the only place the
    // rest of the body shows.
    let complete = !is_bool(map.get("pagination").and_then(|pagination| pagination.get("hasMore")), true) && !is_bool(map.get("truncated"), true);
    // A part left with its name alone says nothing the paragraphs do not.
    let parts: Option<Vec<Value>> = match map.get("parts") {
        Some(Value::Array(parts)) => Some(
            parts
                .iter()
                .filter(|part| {
                    let redundant = complete
                        && is_str(part.get("part"), "word/document.xml")
                        && !paragraphs.is_empty()
                        && part.as_object().is_some_and(|part| part.keys().all(|key| key == "part" || key == "text"));
                    !redundant
                })
                .cloned()
                .collect(),
        ),
        _ => None,
    };
    // A family the counts already call empty (comments, revisions, notes, controls, images) reads the same absent.
    let mut digest: Object = entries(map)
        .into_iter()
        .filter(|(_, value)| !matches!(value, Value::Array(items) if items.is_empty()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    // Word (COM) places a table by character offsets and reports its left alignment as 0.
    if let Some(Value::Array(tables)) = digest.get("tables") {
        let tables = tables.iter().map(table_digest).collect();
        digest.insert("tables".to_owned(), Value::Array(tables));
    }
    if let Some(Value::Array(sections)) = digest.get("sections") {
        let sections = sections.iter().map(section_digest).collect();
        digest.insert("sections".to_owned(), Value::Array(sections));
    }
    if let Some(Value::Array(comments)) = digest.get("comments") {
        let comments = comments.iter().map(comment_digest).collect();
        digest.insert("comments".to_owned(), Value::Array(comments));
    }
    if let Some(blocks) = map.get("blockOrder").and_then(Value::as_array).filter(|blocks| !blocks.is_empty()) {
        digest.insert("blockOrder".to_owned(), Value::Array(block_order_digest(blocks)));
    }
    match parts.filter(|parts| !parts.is_empty()) {
        Some(parts) => {
            digest.insert("parts".to_owned(), Value::Array(parts));
        }
        None => remove(&mut digest, "parts"),
    }
    digest.insert("paragraphs".to_owned(), Value::Array(paragraphs));
    Value::Object(digest)
}
