//! The text operations of the deck editor: `replace_text`, `set_text`, `fit_text`, and the helpers the shape operations share
//! (`Set-PowerPointParagraphs`, `PowerPoint-ParagraphAlignment`, `PowerPoint-VerticalAnchor`, `Set-PowerPointFontName`).

use regex::Regex;

use crate::com::Error;
use crate::com::Result;
use crate::com::Value as Com;
use crate::ps::Value;
use crate::ps::text;

use super::ItemAt;
use super::array_of;
use super::attempt;
use super::bstr;
use super::color;
use super::i4;
use super::int;
use super::items;
use super::office_flag;
use super::present;
use super::prop;
use super::r4;
use super::record;
use super::shape_of;
use super::single;
use super::single_value;
use super::slide_of;
use super::string_value;
use super::text_of;
use super::truthy;
use super::walk;

/// `PowerPoint-ParagraphAlignment`: the alignment in the names the portable writer reads (centre is 2, a name it does not
/// know is left, 1).
pub(crate) fn paragraph_alignment(alignment: &Value) -> i32 {
    match text::to_lower_invariant(&text_of(alignment)).as_str() {
        "center" | "centre" => 2,
        "right" => 3,
        "justify" => 4,
        "distributed" => 5,
        _ => 1,
    }
}

/// `PowerPoint-VerticalAnchor`.
pub(crate) fn vertical_anchor(anchor: &Value) -> i32 {
    match text::to_lower_invariant(&text_of(anchor)).as_str() {
        "center" | "centre" | "middle" => 3,
        "bottom" => 4,
        _ => 1,
    }
}

/// `Set-PowerPointFontName`: a named face is the face of the Latin, East Asian and complex scripts alike.
pub(crate) fn set_font_name(font: &Com, name: &str) -> Result<()> {
    font.set_member("Name", bstr(name))?;
    font.set_member("NameFarEast", bstr(name))?;
    font.set_member("NameComplexScript", bstr(name))
}

/// The numbers of a paragraph's bullet: the hanging step (22 pt) the portable writer draws, one more per level.
const BULLET_STEP: f32 = 22.0;

/// `Set-PowerPointParagraphs`: the shape's text from the paragraph specs (joined by a carriage return), then each paragraph's
/// level, bullet and face. Answers how many paragraphs.
pub(crate) fn set_paragraphs(shape: &Com, paragraphs: &Value) -> Result<usize> {
    let specs = array_of(paragraphs);
    let joined: Vec<String> = specs.iter().map(|spec| text_of(&prop(spec, "text"))).collect();
    walk(shape, &["TextFrame", "TextRange"])?.set_member("Text", bstr(&joined.join("\r")))?;
    for (at, spec) in specs.iter().enumerate() {
        let index = at as i32 + 1;
        let paragraph = shape.member("TextFrame")?.member("TextRange")?.call_member("Paragraphs", &[i4(index), i4(1)])?;
        let level = prop(spec, "level");
        if present(&level) {
            paragraph.set_member("IndentLevel", i4((int(&level)? + 1).clamp(1, 5)))?;
        }
        let bullet = prop(spec, "bullet");
        if present(&bullet) {
            walk(&paragraph, &["ParagraphFormat", "Bullet"])?.set_member("Visible", office_flag(truthy(&bullet)))?;
        }
        if truthy(&bullet) {
            // The portable writer's bullet: an Arial dot hanging one step, one more per level. Visible alone took the box's
            // last list type (a Korean PowerPoint numbered the points) at the template's indents.
            attempt(|| {
                let bullet_format = walk(&paragraph, &["ParagraphFormat", "Bullet"])?;
                bullet_format.set_member("Type", i4(1))?;
                let bullet_format = walk(&paragraph, &["ParagraphFormat", "Bullet"])?;
                bullet_format.set_member("Character", i4(8226))?;
                walk(&paragraph, &["ParagraphFormat", "Bullet", "Font"])?.set_member("Name", bstr("Arial"))?;
                let format2 = shape.member("TextFrame2")?.member("TextRange")?.call_member("Paragraphs", &[i4(index), i4(1)])?.member("ParagraphFormat")?;
                let steps = f64::from((int(&level)?).clamp(0, 8) + 1);
                format2.set_member("LeftIndent", Com::R8(f64::from(BULLET_STEP) * steps))?;
                format2.set_member("FirstLineIndent", Com::R8(-1.0 * f64::from(BULLET_STEP)))
            });
        }
        let font_name = prop(spec, "fontName");
        if truthy(&font_name) {
            set_font_name(&paragraph.member("Font")?, &text_of(&font_name))?;
        }
        let font_size = prop(spec, "fontSize");
        if truthy(&font_size) {
            paragraph.member("Font")?.set_member("Size", r4(single(&font_size)?))?;
        }
        let bold = prop(spec, "bold");
        if present(&bold) {
            paragraph.member("Font")?.set_member("Bold", office_flag(truthy(&bold)))?;
        }
        let italic = prop(spec, "italic");
        if present(&italic) {
            paragraph.member("Font")?.set_member("Italic", office_flag(truthy(&italic)))?;
        }
        let ink = prop(spec, "color");
        if truthy(&ink) {
            walk(&paragraph, &["Font", "Color"])?.set_member("RGB", color(&ink)?)?;
        }
    }
    Ok(specs.len())
}

/// The UTF-16 offset of a byte offset of `text`: what `Match.Index` counts.
fn utf16_offset(text: &str, byte: usize) -> i32 {
    text[..byte].encode_utf16().count() as i32
}

/// The pattern `replace_text` matches `find` with: a space matches a space or a soft line break (char 11, the authored wrap),
/// never a paragraph end, so the text matches as the portable writer reads it.
fn replace_pattern(find: &str) -> Result<String> {
    let words: Vec<&str> = find.trim().split_whitespace().collect();
    if words.is_empty() {
        return Err(Error::host("replace_text requires non-empty find"));
    }
    let separator = "[ \\x0B]+";
    let escaped: Vec<String> = words.iter().map(|word| text::regex_escape(word)).collect();
    let mut pattern = escaped.join(separator);
    if find.chars().next().is_some_and(char::is_whitespace) {
        pattern = format!("{separator}{pattern}");
    }
    if find.chars().next_back().is_some_and(char::is_whitespace) {
        pattern.push_str(separator);
    }
    Ok(pattern)
}

/// `replace_text`: only the matched characters are rewritten, so the runs around them keep their weight and colour; the speaker
/// notes' body is rewritten with the slide, and `slide` keeps the replacement on that one page.
pub(crate) fn replace_text(presentation: &Com, op: &Value) -> Result<Value> {
    let find = text_of(&prop(op, "find"));
    let pattern = replace_pattern(&find)?;
    let matcher = Regex::new(&pattern).map_err(|error| Error::host(error.to_string()))?;
    let replacement = bstr(&text_of(&prop(op, "replace")));
    let mut total = 0;
    let mut shape_total = 0;
    let pages = if present(&prop(op, "slide")) { vec![slide_of(presentation, op)?] } else { items(&presentation.member("Slides")?)? };
    for slide in pages {
        // The speaker notes' body too, as the portable writer rewrites the notes part with the slide.
        let mut notes_body: Vec<Com> = Vec::new();
        attempt(|| {
            if crate::ppt::truth(&slide.member("HasNotesPage")?) {
                notes_body = vec![walk(&slide, &["NotesPage", "Shapes", "Placeholders"])?.item_at(2)?];
            }
            Ok(())
        });
        let mut shapes = items(&slide.member("Shapes")?)?;
        shapes.extend(notes_body);
        for shape in shapes {
            let outcome = (|| -> Result<Option<usize>> {
                if !(crate::ppt::truth(&shape.member("HasTextFrame")?) && crate::ppt::truth(&walk(&shape, &["TextFrame", "HasText"])?)) {
                    return Ok(None);
                }
                let range = walk(&shape, &["TextFrame", "TextRange"])?;
                let content = string_value(&range.member("Text")?);
                let found: Vec<(usize, usize)> = matcher.find_iter(&content).map(|hit| (hit.start(), hit.end())).collect();
                for &(start, end) in found.iter().rev() {
                    let from = utf16_offset(&content, start) + 1;
                    let length = content[start..end].encode_utf16().count() as i32;
                    range.call_member("Characters", &[i4(from), i4(length)])?.set_member("Text", replacement.clone())?;
                }
                Ok(Some(found.len()))
            })();
            if let Ok(Some(matches)) = outcome {
                if matches > 0 {
                    total += matches as i32;
                    shape_total += 1;
                }
            }
        }
    }
    Ok(record(vec![
        ("op", Value::string("replace_text")),
        ("changed", Value::Bool(total > 0)),
        ("count", Value::Int(total)),
        ("shapes", Value::Int(shape_total)),
    ]))
}

/// `set_text`.
pub(crate) fn set_text(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let shape = shape_of(&slide, op)?;
    walk(&shape, &["TextFrame", "TextRange"])?.set_member("Text", bstr(&text_of(&prop(op, "text"))))?;
    Ok(record(vec![("op", Value::string("set_text")), ("changed", Value::Bool(true))]))
}

/// `fit_text`: the box clamped to the slide, then the font stepped down a point at a time until the text fits or the minimum
/// is reached. Singles throughout, as the script's: single arithmetic comes back a double there, and the binder refuses a
/// double after a single.
pub(crate) fn fit_text(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let shape = shape_of(&slide, op)?;
    let minimum_size = prop(op, "minFontSize");
    let minimum = if truthy(&minimum_size) { single(&minimum_size)? } else { 8.0 };
    attempt(|| shape.member("TextFrame")?.set_member("AutoSize", i4(0)));
    attempt(|| shape.member("TextFrame2")?.set_member("AutoSize", i4(0)));
    let slide_width = single_value(&walk(presentation, &["PageSetup", "SlideWidth"])?)?;
    let shape_left = single_value(&shape.member("Left")?)?;
    let maximum_width = (f64::from(slide_width) - f64::from(shape_left)) as f32;
    let slide_height = single_value(&walk(presentation, &["PageSetup", "SlideHeight"])?)?;
    let shape_top = single_value(&shape.member("Top")?)?;
    let maximum_height = (f64::from(slide_height) - f64::from(shape_top)) as f32;
    let mut clamped = false;
    if single_value(&shape.member("Width")?)? > maximum_width {
        shape.set_member("Width", r4(maximum_width))?;
        clamped = true;
    }
    if single_value(&shape.member("Height")?)? > maximum_height {
        shape.set_member("Height", r4(maximum_height))?;
        clamped = true;
    }
    let font = walk(&shape, &["TextFrame", "TextRange", "Font"])?;
    let start_size = single_value(&font.member("Size")?)?;
    loop {
        if !(single_value(&font.member("Size")?)? > minimum) {
            break;
        }
        let bound_width = single_value(&walk(&shape, &["TextFrame2", "TextRange", "BoundWidth"])?)?;
        let width = single_value(&shape.member("Width")?)?;
        let too_wide = f64::from(bound_width) > f64::from(width) + 1.0;
        let too_tall = too_wide || {
            let bound_height = single_value(&walk(&shape, &["TextFrame2", "TextRange", "BoundHeight"])?)?;
            let height = single_value(&shape.member("Height")?)?;
            f64::from(bound_height) > f64::from(height) + 1.0
        };
        if !too_tall {
            break;
        }
        let size = single_value(&font.member("Size")?)?;
        font.set_member("Size", r4((f64::from(size) - 1.0) as f32))?;
    }
    let changed = clamped || single_value(&font.member("Size")?)? < start_size;
    let size_again = single_value(&font.member("Size")?)?;
    Ok(record(vec![
        ("op", Value::string("fit_text")),
        ("changed", Value::Bool(changed)),
        ("shape", Value::Int(int(&prop(op, "shape"))?)),
        ("fontSize", Value::Single(size_again)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alignment_and_anchor_names_follow_the_portable_writer() {
        assert_eq!(paragraph_alignment(&Value::string("Centre")), 2);
        assert_eq!(paragraph_alignment(&Value::string("justify")), 4);
        assert_eq!(paragraph_alignment(&Value::string("whatever")), 1);
        assert_eq!(vertical_anchor(&Value::string("middle")), 3);
        assert_eq!(vertical_anchor(&Value::string("BOTTOM")), 4);
        assert_eq!(vertical_anchor(&Value::Null), 1);
    }

    #[test]
    fn a_space_in_find_matches_a_space_or_a_soft_break_never_a_paragraph_end() {
        let pattern = replace_pattern("a b").unwrap();
        let matcher = Regex::new(&pattern).unwrap();
        assert!(matcher.is_match("a b"));
        assert!(matcher.is_match("a\u{b}b"));
        assert!(matcher.is_match("a \u{b} b"));
        assert!(!matcher.is_match("a\rb"));
    }

    #[test]
    fn leading_and_trailing_white_space_of_find_is_kept_as_a_separator() {
        assert_eq!(replace_pattern(" a ").unwrap(), "[ \\x0B]+a[ \\x0B]+");
        assert_eq!(replace_pattern("a").unwrap(), "a");
        assert_eq!(replace_pattern("   ").unwrap_err().message(), "replace_text requires non-empty find");
    }

    #[test]
    fn match_offsets_count_utf16_units() {
        let content = "가a😀b";
        assert_eq!(utf16_offset(content, content.find('b').unwrap()), 4);
    }
}
