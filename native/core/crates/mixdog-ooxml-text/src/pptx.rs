//! `.pptx`: one section per slide, in slide-number order, with hidden slides and shapes marked and the speaker notes
//! after the slide's own text.

use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::number_to_string;
use mixdog_js::string_to_number;
use std::sync::LazyLock;

use crate::Failure;
use crate::cap_output;
use crate::docx::PartKind;
use crate::docx::ooxml_part_text;
use crate::scan::BODY_PLACEHOLDER_RE;
use crate::scan::HIDDEN_SLIDE_RE;
use crate::scan::mark_hidden_slide_shapes;
use crate::scan::relationship_list;
use crate::scan::scan_elements;
use crate::zip::Zip;

static NOTES_TARGET_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"notesSlide\d+\.xml$", ""));

/// The `n` of `ppt/slides/slide<n>.xml`.
fn slide_number(name: &str) -> Option<&str> {
    let digits = name.strip_prefix("ppt/slides/slide")?.strip_suffix(".xml")?;
    (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then_some(digits)
}

/// Speaker notes carry what the slide does not say out loud. They live in a separate part, so a deck read without them
/// looks complete while the narration is missing; only the body placeholder is notes text, the rest of that part is the
/// slide thumbnail and its page number.
fn slide_notes_text(zip: &Zip, slide_part: &str) -> Result<String, Failure> {
    let rels_name = format!("{}.rels", slide_part.replacen("ppt/slides/", "ppt/slides/_rels/", 1).as_str());
    let rels = zip.part_text(&rels_name)?;
    let Some((_, target)) = relationship_list(&rels).into_iter().find(|(_, target)| NOTES_TARGET_RE.is_match(target)) else {
        return Ok(String::new());
    };
    let target = target.strip_prefix("../").unwrap_or(&target);
    let xml = zip.part_text(&format!("ppt/{target}"))?;
    let mut paragraphs = Vec::new();
    for shape in scan_elements(&xml, "p:sp") {
        if shape.inner.is_none() || !BODY_PLACEHOLDER_RE.is_match(shape.full) {
            continue;
        }
        let text = ooxml_part_text(shape.full, PartKind::Drawing, None)?;
        if !text.is_empty() {
            paragraphs.push(text);
        }
    }
    Ok(js_trim(&paragraphs.join("\n")).to_owned())
}

/// `presentationText`: one section per slide, in slide-number order.
pub fn presentation_text(zip: &Zip, max_output_bytes: usize) -> Result<String, Failure> {
    let mut slides: Vec<(&str, f64)> = zip.names().filter_map(|name| slide_number(name).map(|digits| (name, string_to_number(digits)))).collect();
    if slides.is_empty() {
        return Err(Failure::Format("no ppt/slides/*.xml parts — not a PPTX presentation (or an encrypted one)".into()));
    }
    // A stable sort by the number, as `Array.prototype.sort` with `a.n - b.n`.
    slides.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    let mut sections = Vec::with_capacity(slides.len());
    for (name, n) in slides {
        let xml = zip.part_text(name)?;
        let text = ooxml_part_text(&mark_hidden_slide_shapes(&xml)?, PartKind::Drawing, None)?;
        let notes = slide_notes_text(zip, name)?;
        // A hidden slide is not shown when the deck is presented; reading it as an ordinary page puts a withdrawn page in
        // the summary.
        let hidden = if HIDDEN_SLIDE_RE.is_match(&xml) { " (hidden)" } else { "" };
        let text = if text.is_empty() { "(no text)" } else { text.as_str() };
        let notes = if notes.is_empty() { String::new() } else { format!("\n[notes] {}", notes.replace('\n', "\n        ")) };
        sections.push(format!("--- slide {}{hidden} ---\n{text}{notes}", number_to_string(n)));
    }
    Ok(cap_output(&sections.join("\n\n"), max_output_bytes))
}
