//! The slide operations of the deck editor: adding, deleting, moving and duplicating slides, importing and keeping slides,
//! visibility, transitions, animations, the background, the layout, the theme, notes, comments and provenance.

use crate::com::Error;
use crate::com::Result;
use crate::com::Value as Com;
use crate::office::get_full_path;
use crate::ps::Value;
use crate::ps::payload;
use crate::ps::text;

use super::ItemAt;
use super::array_of;
use super::as_int_nonzero;
use super::boolean;
use super::bstr;
use super::color;
use super::count;
use super::i4;
use super::int;
use super::int_value;
use super::item;
use super::layout::powerpoint_layout;
use super::present;
use super::prop;
use super::put_path;
use super::r4;
use super::record;
use super::shape_of;
use super::single;
use super::slide_index;
use super::slide_of;
use super::string_value;
use super::text_of;
use super::truthy;
use super::walk;

/// `add_slide`: at `index` (the end unless given), in the layout named, or in the layout of the slide it follows (as New Slide
/// does, and as the portable writer does) unless that is a title page, where the blank default follows instead of a second
/// cover.
pub(crate) fn add_slide(presentation: &Com, op: &Value) -> Result<Value> {
    let index_given = prop(op, "index");
    let index = if truthy(&index_given) { int(&index_given)? } else { count(&presentation.member("Slides")?)? + 1 };
    let mut custom_layout: Option<Com> = None;
    if text_of(&prop(op, "layout")).chars().all(char::is_whitespace) && count(&presentation.member("Slides")?)? > 0 {
        let slides = presentation.member("Slides")?;
        let total = count(&presentation.member("Slides")?)?;
        let before = slides.item_at(std::cmp::max(1, total.min(index - 1)))?;
        if int_value(&before.member("Layout")?)? != 1 {
            custom_layout = Some(before.member("CustomLayout")?);
        }
    }
    if let Some(custom_layout) = custom_layout {
        let slide = presentation.member("Slides")?.call_member("AddSlide", &[i4(index), custom_layout.clone()])?;
        return Ok(record(vec![
            ("op", Value::string("add_slide")),
            ("changed", Value::Bool(true)),
            ("slide", Value::Int(slide_index(&slide)?)),
            ("layout", Value::Int(int_value(&custom_layout.member("Index")?)?)),
            ("layoutName", Value::String(string_value(&custom_layout.member("Name")?))),
        ]));
    }
    let layout = powerpoint_layout(presentation, &prop(op, "layout"))?;
    let slide = presentation.member("Slides")?.call_member("AddSlide", &[i4(index), layout.layout.clone()])?;
    Ok(record(vec![
        ("op", Value::string("add_slide")),
        ("changed", Value::Bool(true)),
        ("slide", Value::Int(slide_index(&slide)?)),
        ("layout", Value::Int(layout.index)),
        ("layoutName", Value::String(string_value(&layout.layout.member("Name")?))),
    ]))
}

/// `delete_slide`.
pub(crate) fn delete_slide(presentation: &Com, op: &Value) -> Result<Value> {
    slide_of(presentation, op)?.call_member("Delete", &[])?;
    Ok(record(vec![("op", Value::string("delete_slide")), ("changed", Value::Bool(true))]))
}

/// `move_slide`.
pub(crate) fn move_slide(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = int(&prop(op, "slide"))?;
    let target = presentation.member("Slides")?.item_at(slide)?;
    target.call_member("MoveTo", &[i4(int(&prop(op, "index"))?)])?;
    Ok(record(vec![("op", Value::string("move_slide")), ("changed", Value::Bool(true))]))
}

/// `duplicate_slide`.
pub(crate) fn duplicate_slide(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = int(&prop(op, "slide"))?;
    let copies = presentation.member("Slides")?.item_at(slide)?.call_member("Duplicate", &[])?;
    let copy = copies.item_at(1)?;
    let index = prop(op, "index");
    if truthy(&index) {
        copy.call_member("MoveTo", &[i4(int(&index)?)])?;
    }
    Ok(record(vec![("op", Value::string("duplicate_slide")), ("changed", Value::Bool(true)), ("slide", Value::Int(slide_index(&copy)?))]))
}

/// `import_slides`: the slides of another saved deck inserted after a slide (`InsertFromFile`).
pub(crate) fn import_slides(presentation: &Com, op: &Value) -> Result<Value> {
    if count(&presentation.member("Slides")?)? == 0 {
        return Err(Error::host("import_slides cannot target a zero-slide presentation; import as the first batch of a new background deck"));
    }
    let after_given = prop(op, "after");
    let after = if present(&after_given) { int(&after_given)? } else { count(&presentation.member("Slides")?)? };
    let mut inserted = 0;
    let source_path = text_of(&prop(op, "path"));
    let open_presentations = presentation.member("Application")?.member("Presentations")?;
    let mut candidate_index = 1;
    while candidate_index <= count(&open_presentations)? {
        let candidate = item(&open_presentations, candidate_index)?;
        // A source deck that is open cannot be inserted from: the failure of the comparison itself is ignored.
        let open_as_source = || -> Result<bool> {
            let same_deck = match (candidate.as_obj(), presentation.as_obj()) {
                (Some(found), Some(target)) => found.same_object(target),
                _ => false,
            };
            if same_deck {
                return Ok(false);
            }
            let theirs = get_full_path(&string_value(&candidate.member("FullName")?)).map_err(Error::host)?;
            let ours = get_full_path(&source_path).map_err(Error::host)?;
            Ok(theirs.to_uppercase() == ours.to_uppercase())
        };
        if open_as_source().unwrap_or(false) {
            return Err(Error::host("import_slides requires the saved source deck to be closed before import"));
        }
        candidate_index += 1;
    }
    let slides = prop(op, "slides");
    if truthy(&slides) {
        for source_slide in array_of(&slides) {
            let number = int(&source_slide)?;
            let added = presentation.member("Slides")?.call_member("InsertFromFile", &[bstr(&source_path), i4(after + inserted), i4(number), i4(number)])?;
            inserted += int_value(&added)?;
        }
    } else {
        let added = presentation.member("Slides")?.call_member("InsertFromFile", &[bstr(&source_path), i4(after)])?;
        inserted = int_value(&added)?;
    }
    Ok(record(vec![
        ("op", Value::string("import_slides")),
        ("changed", Value::Bool(inserted > 0)),
        ("count", Value::Int(inserted)),
        ("after", Value::Int(after)),
        ("source", Value::String(source_path)),
    ]))
}

/// `keep_slides`: every slide that is not listed is deleted, last first.
pub(crate) fn keep_slides(presentation: &Com, op: &Value) -> Result<Value> {
    let mut keep: Vec<i32> = Vec::new();
    for number in array_of(&prop(op, "slides")) {
        keep.push(int(&number)?);
    }
    let mut removed = 0;
    let mut index = count(&presentation.member("Slides")?)?;
    while index >= 1 {
        if !keep.contains(&index) {
            presentation.member("Slides")?.item_at(index)?.call_member("Delete", &[])?;
            removed += 1;
        }
        index -= 1;
    }
    Ok(record(vec![
        ("op", Value::string("keep_slides")),
        ("changed", Value::Bool(removed > 0)),
        ("removed", Value::Int(removed)),
        ("remaining", Value::Int(count(&presentation.member("Slides")?)?)),
    ]))
}

/// `set_slide_visibility`.
pub(crate) fn set_slide_visibility(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let visible_given = prop(op, "visible");
    if !present(&visible_given) {
        return Err(Error::host("set_slide_visibility requires visible: true or false"));
    }
    let visible = truthy(&visible_given);
    put_path(&slide, &["SlideShowTransition", "Hidden"], i4(if visible { 0 } else { -1 }))?;
    Ok(record(vec![
        ("op", Value::string("set_slide_visibility")),
        ("changed", Value::Bool(true)),
        ("slide", Value::Int(slide_index(&slide)?)),
        ("visible", Value::Bool(visible)),
    ]))
}

/// The transition effects by name.
const TRANSITIONS: [(&str, i32); 7] = [("none", 0), ("fade", 3849), ("push", 3850), ("wipe", 3844), ("split", 3586), ("reveal", 3847), ("random", 513)];

/// `set_transition`: the effect by name or code, the advance on a time and the speed from the duration.
pub(crate) fn set_transition(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let effect = prop(op, "effect");
    let kind = text::to_lower_invariant(&text_of(&effect));
    if !kind.is_empty() {
        let transition = slide.member("SlideShowTransition")?;
        let code = match TRANSITIONS.iter().find(|(name, _)| payload::names_equal(name, &kind)) {
            Some((_, code)) => *code,
            None if as_int_nonzero(&effect).is_some() => int(&effect)?,
            None => return Err(Error::host(format!("Unknown transition effect: {kind}"))),
        };
        transition.set_member("EntryEffect", i4(code))?;
    }
    let advance_on_time = prop(op, "advanceOnTime");
    if present(&advance_on_time) {
        put_path(&slide, &["SlideShowTransition", "AdvanceOnTime"], boolean(truthy(&advance_on_time)))?;
    }
    let advance_time = prop(op, "advanceTime");
    if present(&advance_time) {
        put_path(&slide, &["SlideShowTransition", "AdvanceTime"], r4(single(&advance_time)?))?;
    }
    let duration = prop(op, "duration");
    if present(&duration) {
        let seconds = single(&duration)?;
        let speed = if seconds <= 0.5 {
            1
        } else if seconds <= 1.5 {
            2
        } else {
            3
        };
        put_path(&slide, &["SlideShowTransition", "Speed"], i4(speed))?;
    }
    Ok(record(vec![
        ("op", Value::string("set_transition")),
        ("changed", Value::Bool(true)),
        ("slide", Value::Int(slide_index(&slide)?)),
        ("effect", Value::Int(int_value(&walk(&slide, &["SlideShowTransition", "EntryEffect"])?)?)),
    ]))
}

const ANIMATION_EFFECTS: [(&str, i32); 6] = [("appear", 1), ("fly", 2), ("fade", 10), ("wipe", 22), ("zoom", 23), ("float", 30)];
const ANIMATION_TRIGGERS: [(&str, i32); 3] = [("onclick", 1), ("withprevious", 2), ("afterprevious", 3)];

/// `[string]$value -replace '[\s_-]', ''` lower-cased: `on_click` and `after_previous` are the separator spelling of the
/// same triggers, as in the portable writer.
fn animation_key(value: &Value) -> Result<String> {
    let squeezed = text::replace(&text_of(value), "[\\s_-]", "", false).map_err(Error::host)?;
    Ok(text::to_lower_invariant(&squeezed))
}

/// The code a name or a number stands for in a table, else `fallback`.
fn code_of(table: &[(&str, i32)], key: &str, given: &Value, fallback: i32) -> Result<i32> {
    if let Some((_, code)) = table.iter().find(|(name, _)| payload::names_equal(name, key)) {
        return Ok(*code);
    }
    if as_int_nonzero(given).is_some() {
        return int(given);
    }
    Ok(fallback)
}

/// `add_animation`.
pub(crate) fn add_animation(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let shape = shape_of(&slide, op)?;
    let effect_given = prop(op, "effect");
    let trigger_given = prop(op, "trigger");
    let effect_key = animation_key(&effect_given)?;
    let trigger_key = animation_key(&trigger_given)?;
    let effect_type = code_of(&ANIMATION_EFFECTS, &effect_key, &effect_given, 10)?;
    let trigger_type = code_of(&ANIMATION_TRIGGERS, &trigger_key, &trigger_given, 1)?;
    let effect = walk(&slide, &["TimeLine", "MainSequence"])?.call_member("AddEffect", &[shape, i4(effect_type), i4(0), i4(trigger_type)])?;
    let duration = prop(op, "duration");
    if present(&duration) {
        put_path(&effect, &["Timing", "Duration"], r4(single(&duration)?))?;
    }
    let delay = prop(op, "delay");
    if present(&delay) {
        put_path(&effect, &["Timing", "TriggerDelayTime"], r4(single(&delay)?))?;
    }
    Ok(record(vec![
        ("op", Value::string("add_animation")),
        ("changed", Value::Bool(true)),
        ("slide", Value::Int(slide_index(&slide)?)),
        ("shape", Value::Int(int(&prop(op, "shape"))?)),
        ("effect", Value::Int(effect_type)),
    ]))
}

/// `set_slide_background`.
pub(crate) fn set_slide_background(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    slide.set_member("FollowMasterBackground", boolean(false))?;
    put_path(&slide, &["Background", "Fill", "Visible"], boolean(true))?;
    put_path(&slide, &["Background", "Fill", "ForeColor", "RGB"], color(&prop(op, "color"))?)?;
    Ok(record(vec![("op", Value::string("set_slide_background")), ("changed", Value::Bool(true))]))
}

/// `set_layout`.
pub(crate) fn set_layout(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let layout = powerpoint_layout(presentation, &prop(op, "layout"))?;
    slide.set_member("CustomLayout", layout.layout.clone())?;
    Ok(record(vec![
        ("op", Value::string("set_layout")),
        ("changed", Value::Bool(true)),
        ("layout", Value::Int(layout.index)),
        ("layoutName", Value::String(string_value(&layout.layout.member("Name")?))),
    ]))
}

/// `apply_theme`.
pub(crate) fn apply_theme(presentation: &Com, op: &Value) -> Result<Value> {
    if !truthy(&prop(op, "path")) {
        return Err(Error::host("apply_theme requires path"));
    }
    presentation.call_member("ApplyTheme", &[bstr(&text_of(&prop(op, "path")))])?;
    Ok(record(vec![("op", Value::string("apply_theme")), ("changed", Value::Bool(true)), ("path", Value::String(text_of(&prop(op, "path"))))]))
}

/// `$slide.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange`: the speaker notes' body.
fn notes_range(slide: &Com) -> Result<Com> {
    walk(slide, &["NotesPage", "Shapes", "Placeholders"])?.item_at(2)?.member("TextFrame")?.member("TextRange")
}

/// `set_notes`.
pub(crate) fn set_notes(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    notes_range(&slide)?.set_member("Text", bstr(&text_of(&prop(op, "text"))))?;
    Ok(record(vec![("op", Value::string("set_notes")), ("changed", Value::Bool(true))]))
}

/// `add_comment`.
pub(crate) fn add_comment(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let left = if present(&prop(op, "left")) { single(&prop(op, "left"))? } else { 20.0 };
    let top = if present(&prop(op, "top")) { single(&prop(op, "top"))? } else { 20.0 };
    let author = if truthy(&prop(op, "author")) { text_of(&prop(op, "author")) } else { "Mixdog".to_owned() };
    let initials = if truthy(&prop(op, "initials")) { text_of(&prop(op, "initials")) } else { "MD".to_owned() };
    let comment = slide.member("Comments")?.call_member("Add", &[r4(left), r4(top), bstr(&author), bstr(&initials), bstr(&text_of(&prop(op, "text")))])?;
    Ok(record(vec![
        ("op", Value::string("add_comment")),
        ("changed", Value::Bool(true)),
        ("slide", Value::Int(slide_index(&slide)?)),
        ("comment", Value::Int(int_value(&comment.member("Index")?)?)),
    ]))
}

/// `delete_comment`.
pub(crate) fn delete_comment(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let index = int(&prop(op, "comment"))?;
    if index < 1 || index > count(&slide.member("Comments")?)? {
        return Err(Error::host(format!("PowerPoint comment index out of range: {index}")));
    }
    slide.member("Comments")?.item_at(index)?.call_member("Delete", &[])?;
    Ok(record(vec![
        ("op", Value::string("delete_comment")),
        ("changed", Value::Bool(true)),
        ("slide", Value::Int(slide_index(&slide)?)),
        ("comment", Value::Int(index)),
    ]))
}

/// `Provenance-Text`: the citation the operation carries.
pub(crate) fn provenance_text(op: &Value) -> Result<String> {
    let citation = text_of(&prop(op, "citation"));
    if citation.chars().all(char::is_whitespace) {
        return Err(Error::host("add_provenance requires source with a document or label"));
    }
    Ok(citation)
}

/// `add_provenance`: the citation joins the slide's notes unless the notes already hold it.
pub(crate) fn add_provenance(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let citation = provenance_text(op)?;
    let range = notes_range(&slide)?;
    let existing = string_value(&range.member("Text")?);
    if text::is_not_match(&existing, &text::regex_escape(&citation), false).map_err(Error::host)? {
        let joined = if existing.chars().all(char::is_whitespace) { citation.clone() } else { format!("{}\r{citation}", existing.trim_end()) };
        range.set_member("Text", bstr(&joined))?;
    }
    let target = if truthy(&prop(op, "shape")) {
        format!("/slide[{}]/shape[{}]", slide_index(&slide)?, int(&prop(op, "shape"))?)
    } else {
        format!("/slide[{}]", slide_index(&slide)?)
    };
    Ok(record(vec![
        ("op", Value::string("add_provenance")),
        ("changed", Value::Bool(true)),
        ("target", Value::String(target)),
        ("citation", Value::String(citation)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ps::payload::parse_payload;

    #[test]
    fn animation_names_ignore_separators_and_case() {
        assert_eq!(animation_key(&Value::string("After_Previous")).unwrap(), "afterprevious");
        assert_eq!(animation_key(&Value::string("on click")).unwrap(), "onclick");
        assert_eq!(animation_key(&Value::Null).unwrap(), "");
    }

    #[test]
    fn an_animation_code_is_a_name_then_a_number_then_the_default() {
        let given = Value::string("onclick");
        assert_eq!(code_of(&ANIMATION_TRIGGERS, "afterprevious", &given, 1).unwrap(), 3);
        assert_eq!(code_of(&ANIMATION_EFFECTS, "unknown", &Value::string("23"), 10).unwrap(), 23);
        assert_eq!(code_of(&ANIMATION_EFFECTS, "unknown", &Value::string("0"), 10).unwrap(), 10);
        assert_eq!(code_of(&ANIMATION_EFFECTS, "", &Value::Null, 10).unwrap(), 10);
    }

    #[test]
    fn a_provenance_without_a_citation_is_refused() {
        let none = parse_payload("{}").unwrap();
        assert_eq!(provenance_text(&none).unwrap_err().message(), "add_provenance requires source with a document or label");
        let blank = parse_payload("{\"citation\":\"  \"}").unwrap();
        assert!(provenance_text(&blank).is_err());
        let cited = parse_payload("{\"citation\":\"Source: Model!B2\"}").unwrap();
        assert_eq!(provenance_text(&cited).unwrap(), "Source: Model!B2");
    }
}
