//! `.docx`: the body, its notes, headers and footers; and the pass over one XML part that the Word and PowerPoint
//! readers share (`ooxmlPartText`).

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::is_js_space;
use mixdog_js::js_trim;

use crate::Failure;
use crate::cap_output;
use crate::scan::A;
use crate::scan::GRAPHIC_FRAME_OPEN_RE;
use crate::scan::collapse_newline_runs;
use crate::scan::decode_xml_entities;
use crate::scan::drawing_marker;
use crate::scan::first_group;
use crate::scan::flatten_lines;
use crate::scan::mark_hidden_word_runs;
use crate::scan::scan_elements;
use crate::scan::trim_trailing_breaks;
use crate::zip::Zip;

/// Which text and paragraph tags a part uses: Word's `w:t`/`w:p` or DrawingML's `a:t`/`a:p`.
#[derive(Clone, Copy)]
pub enum PartKind {
    Word,
    Drawing,
}

fn part_pattern(text_tag: &str, para_tag: &str) -> JsRegex {
    JsRegex::new_static(
        &format!(
            "<{text_tag}(?:\\s{A})?>([^<]*)</{text_tag}>\
             |</{para_tag}>\
             |</(?:w|a):tc>\
             |</(?:w|a):tr>\
             |<w:tab\\b{A}/>\
             |<(?:w|a):br\\b{A}/>\
             |<w:(?:foot|end)noteReference\\b{A}/>\
             |<(w:drawing|p:pic|p:graphicFrame)\\b{A}>"
        ),
        "",
    )
}

static WORD_PART_RE: LazyLock<JsRegex> = LazyLock::new(|| part_pattern("w:t", "w:p"));
static DRAWING_PART_RE: LazyLock<JsRegex> = LazyLock::new(|| part_pattern("a:t", "a:p"));
static TABLE_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<a:tbl\b", ""));
static NOTE_ID_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bw:id="(-?\d+)""#, ""));
static NOTE_TYPE_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bw:type=""#, ""));

impl PartKind {
    fn regex(self) -> &'static JsRegex {
        match self {
            PartKind::Word => &WORD_PART_RE,
            PartKind::Drawing => &DRAWING_PART_RE,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum NoteKind {
    Footnote,
    Endnote,
}

/// A footnote or endnote citation met in the body, in the order it appears.
pub struct Note {
    pub kind: NoteKind,
    pub id: String,
}

fn end_with_line(out: &mut String) {
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
}

/// `text.replace(/\n{3,}/g, '\n\n')`.
fn squeeze_blank_lines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run = 0usize;
    for c in text.chars() {
        if c == '\n' {
            run += 1;
            if run <= 2 {
                out.push('\n');
            }
        } else {
            run = 0;
            out.push(c);
        }
    }
    out
}

/// Sequential pass over one XML part: text runs are captured in document order; paragraph closes and explicit breaks
/// become newlines, tabs become tabs. A table keeps its shape (cells separated by tabs, rows by newlines) because one
/// value per line loses which column it belongs to. Everything else is markup and drops out.
pub fn ooxml_part_text(xml: &str, kind: PartKind, mut notes: Option<&mut Vec<Note>>) -> Result<String, Failure> {
    let pattern = kind.regex();
    let mut out = String::new();
    // A figure already ends its own line, so the paragraph that holds it must not add a second one and leave a blank
    // line in the middle of the prose.
    let mut after_figure = false;
    let mut absent_closes: HashSet<&str> = HashSet::new();
    let mut pos = 0;
    while let Some(found) = pattern.captures(&xml[pos..]) {
        let range = found.range();
        let start = pos + range.start;
        let mut end = pos + range.end;
        pos = end;
        if let Some(container) = found.get(2) {
            // Pair the container with its close tag; one whose close tag is absent from the rest of the part is plain markup.
            if absent_closes.contains(container) {
                continue;
            }
            let close = format!("</{container}>");
            let Some(offset) = xml[end..].find(&close) else {
                absent_closes.insert(container);
                continue;
            };
            end += offset + close.len();
            pos = end;
        }
        let token = &xml[start..end];
        if let Some(text) = found.get(1) {
            out.push_str(&decode_xml_entities(text)?);
            after_figure = false;
        } else if token.starts_with("<w:drawing") || token.starts_with("<p:pic") {
            end_with_line(&mut out);
            out.push_str(&drawing_marker(token)?);
            // A Word text box lives inside the drawing; its words stay readable.
            let mut boxes = Vec::new();
            for text_box in scan_elements(token, "w:txbxContent") {
                let Some(inner) = text_box.inner else { continue };
                let inside = ooxml_part_text(inner, kind, None)?;
                if !inside.is_empty() {
                    boxes.push(inside);
                }
            }
            let inside = boxes.join(" ");
            if !inside.is_empty() {
                out.push(' ');
                out.push_str(&collapse_newline_runs(&inside));
            }
            out.push('\n');
            after_figure = true;
        } else if token.starts_with("<w:footnoteReference") || token.starts_with("<w:endnoteReference") {
            // The citation is where the sentence puts it; the note's own words are collected under the body so the
            // source survives the read.
            if let Some(notes) = notes.as_deref_mut() {
                notes.push(Note {
                    kind: if token.starts_with("<w:endnoteReference") { NoteKind::Endnote } else { NoteKind::Footnote },
                    id: first_group(&NOTE_ID_RE, token).unwrap_or("").to_owned(),
                });
                out.push_str(&format!("[note {}]", notes.len()));
                after_figure = false;
            }
        } else if token.starts_with("<p:graphicFrame") {
            // The frame holds a table, a chart, or a diagram. A table is words the reader needs; the other two carry
            // none, so they are named.
            let opening = GRAPHIC_FRAME_OPEN_RE.find(token).map_or(0, |open| open.end);
            let inner = &token[opening..];
            let inner = inner.strip_suffix("</p:graphicFrame>").unwrap_or(inner);
            if TABLE_RE.is_match(inner) {
                let rows = ooxml_part_text(inner, kind, None)?;
                if !rows.is_empty() {
                    end_with_line(&mut out);
                    out.push_str(&rows);
                    out.push('\n');
                }
                after_figure = !rows.is_empty();
            } else {
                end_with_line(&mut out);
                out.push_str(&drawing_marker(token)?);
                out.push('\n');
                after_figure = true;
            }
        } else if token.ends_with(":tc>") {
            let kept = trim_trailing_breaks(&out).len();
            out.truncate(kept);
            out.push('\t');
            after_figure = false;
        } else if token.ends_with(":tr>") {
            let kept = trim_trailing_breaks(&out).len();
            out.truncate(kept);
            out.push('\n');
            after_figure = false;
        } else if token.contains("tab") {
            out.push('\t');
            after_figure = false;
        } else {
            if !after_figure {
                out.push('\n');
            }
            after_figure = false;
        }
    }
    // Collapse the trailing run of blank lines XML part endings produce.
    Ok(js_trim(&squeeze_blank_lines(&out)).to_owned())
}

/// A footnote is where a report keeps the source of the figure beside it, and it lives in its own part: read as body
/// text alone, every citation disappeared.
fn note_bodies(zip: &Zip, part: &str, tag: &str) -> Result<HashMap<String, String>, Failure> {
    let xml = zip.part_text(part)?;
    let mut bodies = HashMap::new();
    if xml.is_empty() {
        return Ok(bodies);
    }
    for element in scan_elements(&xml, tag) {
        let Some(inner) = element.inner else { continue };
        // The separator rules Word draws above the note area carry a type and no words; they are not notes.
        if NOTE_TYPE_RE.is_match(element.attrs) {
            continue;
        }
        let id = first_group(&NOTE_ID_RE, element.attrs).unwrap_or("").to_owned();
        bodies.insert(id, flatten_lines(&ooxml_part_text(inner, PartKind::Word, None)?));
    }
    Ok(bodies)
}

/// `/^[\d\s./\-–—]+$/`: nothing but digits, blanks and the punctuation of a page number.
fn is_page_number(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|c| c.is_ascii_digit() || is_js_space(c) || matches!(c, '.' | '/' | '-' | '–' | '—'))
}

/// `^word/<kind>\d+\.xml$`.
fn is_chrome_part(name: &str, kind: &str) -> bool {
    name.strip_prefix("word/")
        .and_then(|rest| rest.strip_prefix(kind))
        .and_then(|rest| rest.strip_suffix(".xml"))
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

/// A header and a footer print on every page: the confidentiality mark, the document number, the revision. They live in
/// their own parts, so a document read from the body alone loses what each of its pages says. The page number itself is
/// dropped: a bare numeral says nothing once the page is gone.
fn document_chrome_text(zip: &Zip) -> Result<String, Failure> {
    let mut sections = Vec::new();
    for kind in ["header", "footer"] {
        let mut seen: HashSet<String> = HashSet::new();
        let mut lines: Vec<String> = Vec::new();
        let mut names: Vec<&str> = zip.names().filter(|name| is_chrome_part(name, kind)).collect();
        names.sort_unstable();
        for name in names {
            let xml = mark_hidden_word_runs(&zip.part_text(name)?);
            for line in ooxml_part_text(&xml, PartKind::Word, None)?.split('\n') {
                let text = js_trim(line);
                // The same header repeats as the first-page and even-page variant.
                if text.is_empty() || seen.contains(text) || is_page_number(text) {
                    continue;
                }
                seen.insert(text.to_owned());
                lines.push(text.to_owned());
            }
        }
        if !lines.is_empty() {
            sections.push(format!("--- {kind} ---\n{}", lines.join("\n")));
        }
    }
    Ok(if sections.is_empty() { String::new() } else { format!("\n\n{}", sections.join("\n\n")) })
}

fn document_notes(zip: &Zip, notes: &[Note]) -> Result<String, Failure> {
    if notes.is_empty() {
        return Ok(String::new());
    }
    let footnotes = note_bodies(zip, "word/footnotes.xml", "w:footnote")?;
    let endnotes = note_bodies(zip, "word/endnotes.xml", "w:endnote")?;
    let lines: Vec<String> = notes
        .iter()
        .enumerate()
        .map(|(index, note)| {
            let bodies = if note.kind == NoteKind::Endnote { &endnotes } else { &footnotes };
            let body = bodies.get(&note.id).filter(|body| !body.is_empty()).map_or("(note text missing)", String::as_str);
            format!("[note {}] {body}", index + 1)
        })
        .collect();
    Ok(format!("\n\n--- notes ---\n{}", lines.join("\n")))
}

/// `docxText`.
pub fn docx_text(zip: &Zip, max_output_bytes: usize) -> Result<String, Failure> {
    if !zip.has("word/document.xml") {
        return Err(Failure::Format("no word/document.xml part — not a DOCX document (or an encrypted one)".into()));
    }
    let mut notes = Vec::new();
    let body = mark_hidden_word_runs(&zip.part_text("word/document.xml")?);
    let text = ooxml_part_text(&body, PartKind::Word, Some(&mut notes))?;
    let cited = document_notes(zip, &notes)?;
    let chrome = document_chrome_text(zip)?;
    let text = if text.is_empty() { "(no text content in document)" } else { text.as_str() };
    Ok(cap_output(&format!("{text}{cited}{chrome}"), max_output_bytes))
}
