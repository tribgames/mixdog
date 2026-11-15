//! `portable/portable-pptx-deck.mjs`: the deck-level operations of a presentation batch (slides added, deleted, moved,
//! kept, duplicated and imported; comments; provenance; notes; template tokens; text replacement; background, footer, slide
//! number, theme, layout, visibility and transition). Each handler takes the package and the slide roster the batch keeps
//! (`context.zip`, `context.slides`), the operation as the caller wrote it, and answers the object the operation reports.
//! Where a handler changes the slide list the roster is read again, as Node does.

use std::path::Path;

use mixdog_fsio::ReadProof;
use mixdog_js::{JsRegex, js_to_lowercase, json_number, math, number_to_string, string_to_number, to_number, value_to_string};
use mixdog_office_base::values::truthy;
use serde_json::{Map, Value, json};

use crate::opc::{
    add_package_relationship, clone_owned_slide_parts, ensure_content_type_override, next_relationship_id, part_relationship_path,
    posix, provenance_citation, relationship_target_by_type,
};
use crate::package::os_message;
use crate::pptx_core::{next_shape_id, presentation_slide_size, resolve_slide_background, set_slide_background};
use crate::pptx_package::{
    SLIDE_CONTENT_TYPE, SlideRef, add_presentation_slide, copy_slide_notes, delete_presentation_slide, ensure_comment_author,
    ensure_slide_comments, import_slides_into_presentation, move_presentation_slide, presentation_slides, read_slide_notes,
    select_slide_layout, set_slide_notes, slide_at, slide_id_entries, slide_layout_parts, write_slide_id_list,
};
use crate::slide_shapes::{
    SLIDE_SHAPE_TAGS, replace_first_text, text_body_xml, text_if_truthy, text_of, text_or_empty, to_emu,
};
use crate::template_tokens::{FillTemplate, fill_template_parts};
use crate::text_metrics::{contrast_ratio, relative_luminance};
use crate::xml::{
    OFFICE_RELATIONSHIP_BASE, ParagraphTags, compiled, container_inner, replace_across_runs, replace_in_paragraphs,
    top_level_elements, xml_attribute, xml_encode,
};
use crate::zipio::{Package, utc_now};

/// What a handler answers: the object the operation reports, or the message Node threw.
pub type Handled = Result<Value, String>;

fn slide_part_names(zip: &Package) -> Vec<String> {
    let pattern = compiled(r"^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$", "");
    zip.names().into_iter().filter(|name| pattern.is_match(name)).collect()
}

/// `op.name`, or null when the operation does not carry it.
fn field<'a>(op: &'a Value, name: &str) -> &'a Value {
    op.get(name).unwrap_or(&Value::Null)
}

/// `Number(op.name)`: NaN when the operation does not carry it.
fn number_of(op: &Value, name: &str) -> f64 {
    op.get(name).map_or(f64::NAN, to_number)
}

/// `Number(op.name)` as the JSON the result carries (a number that is not finite is null).
fn number_field(op: &Value, name: &str) -> Value {
    json_number(number_of(op, name))
}

/// `slides[Number(op.slide) - 1]`, or the error for a slide that is not there.
fn slide_of<'a>(slides: &'a [SlideRef], op: &Value) -> Result<&'a SlideRef, String> {
    slide_at(slides, field(op, "slide")).ok_or_else(|| format!("PPTX slide {} not found", text_of(op.get("slide"))))
}

/// `slidePath(slides, op.slide)`.
fn slide_part(slides: &[SlideRef], op: &Value) -> Result<String, String> {
    slide_of(slides, op).map(|slide| slide.path.clone())
}

/// `{ op: op.op, ... }`: the answer of an operation, in the order the entries are given.
fn answer(op: &Value, entries: Vec<(&str, Value)>) -> Value {
    let mut result = Map::new();
    result.insert("op".to_owned(), field(op, "op").clone());
    for (key, value) in entries {
        result.insert(key.to_owned(), value);
    }
    Value::Object(result)
}

/// `new RegExp(source, flags)`.
fn pattern(source: &str, flags: &str) -> Result<JsRegex, String> {
    JsRegex::new(source, flags)
}

/// `Number(xmlAttribute(entry, 'id')) || 0` of a slide id entry.
fn entry_id(entry: &str) -> f64 {
    let id = string_to_number(&xml_attribute(entry, "id"));
    if id.is_nan() { 0.0 } else { id }
}

/// `handleAddSlide`: a slide of the layout the operation names, at its index.
pub fn handle_add_slide(zip: &mut Package, slides: &mut Vec<SlideRef>, op: &Value) -> Handled {
    let created = add_presentation_slide(zip, op)?;
    *slides = presentation_slides(zip);
    Ok(answer(op, vec![("changed", json!(true)), ("slide", created["position"].clone()), ("layout", created["layout"].clone())]))
}

/// `handleDeleteSlide`.
pub fn handle_delete_slide(zip: &mut Package, slides: &mut Vec<SlideRef>, op: &Value) -> Handled {
    delete_presentation_slide(zip, slides, field(op, "slide"))?;
    *slides = presentation_slides(zip);
    Ok(answer(op, vec![("changed", json!(true)), ("slide", number_field(op, "slide"))]))
}

/// `handleMoveSlide`.
pub fn handle_move_slide(zip: &mut Package, slides: &mut Vec<SlideRef>, op: &Value) -> Handled {
    move_presentation_slide(zip, slides, field(op, "slide"), field(op, "index"))?;
    *slides = presentation_slides(zip);
    Ok(answer(op, vec![("changed", json!(true)), ("slide", number_field(op, "slide")), ("index", number_field(op, "index"))]))
}

/// `handleKeepSlides`: every slide but the ones listed is deleted, last first.
pub fn handle_keep_slides(zip: &mut Package, slides: &mut Vec<SlideRef>, op: &Value) -> Handled {
    let keep: Vec<f64> = op.get("slides").and_then(Value::as_array).map(|list| list.iter().map(to_number).collect()).unwrap_or_default();
    if keep.is_empty() {
        return Err("keep_slides requires slides".to_owned());
    }
    let mut removed = 0;
    for index in (1..=slides.len()).rev() {
        if keep.contains(&(index as f64)) {
            continue;
        }
        delete_presentation_slide(zip, &presentation_slides(zip), &json!(index))?;
        removed += 1;
    }
    *slides = presentation_slides(zip);
    Ok(answer(op, vec![("changed", json!(removed > 0)), ("removed", json!(removed)), ("remaining", json!(slides.len()))]))
}

/// `handleAddCommentOrDeleteComment` (`add_comment`, `delete_comment`).
pub fn handle_add_comment_or_delete_comment(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Handled {
    let slide = slide_of(slides, op)?;
    if field(op, "op").as_str() == Some("delete_comment") {
        let target = relationship_target_by_type(&zip.text(&part_relationship_path(&slide.path)), "comments");
        if target.is_empty() {
            return Err(format!("PPTX slide {} has no comments", text_of(op.get("slide"))));
        }
        let part = posix::normalize(&posix::join(&[&posix::dirname(&slide.path), &target]));
        let xml = zip.text(&part);
        let comment = number_to_string(number_of(op, "comment"));
        let found = pattern(&format!(r#"<p:cm\b[^>]*\bidx="{comment}"[^>]*>[\s\S]*?<\/p:cm>"#), "")?.find(&xml);
        let Some(found) = found else {
            return Err(format!("PPTX comment {} not found on slide {}", text_of(op.get("comment")), text_of(op.get("slide"))));
        };
        zip.set(&part, format!("{}{}", &xml[..found.start], &xml[found.end..]));
        return Ok(answer(op, vec![("changed", json!(true)), ("slide", number_field(op, "slide")), ("comment", number_field(op, "comment"))]));
    }
    let text = text_if_truthy(op.get("text"));
    if text.is_empty() {
        return Err("add_comment requires text".to_owned());
    }
    let or_default = |name: &str, default: &str| match op.get(name).filter(|value| truthy(value)) {
        Some(value) => value_to_string(value),
        None => default.to_owned(),
    };
    let author_id = ensure_comment_author(zip, &or_default("author", "Mixdog"), &or_default("initials", "MD"));
    let part = ensure_slide_comments(zip, slide);
    let xml = zip.text(&part);
    let highest = compiled(r#"<p:cm\b[^>]*\bidx="(\d+)""#, "g")
        .captures_iter(&xml)
        .map(|found| string_to_number(found.get(1).unwrap_or("")))
        .fold(0.0, math::max);
    let index = highest + 1.0;
    let now = utc_now();
    // `op.left ?? 12`: only an absent or null position takes the default.
    let position = |name: &str| number_to_string(math::max(0.0, to_emu(op.get(name).filter(|value| !value.is_null()).map_or(12.0, to_number))));
    let entry = format!(
        "<p:cm authorId=\"{}\" dt=\"{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z\" idx=\"{}\"><p:pos x=\"{}\" y=\"{}\"/><p:text>{}</p:text></p:cm>",
        number_to_string(author_id),
        now.year,
        now.month,
        now.day,
        now.hour,
        now.minute,
        now.second,
        number_to_string(index),
        position("left"),
        position("top"),
        xml_encode(&text)
    );
    zip.set(&part, replace_first_text(&xml, "</p:cmLst>", &format!("{entry}</p:cmLst>")));
    Ok(answer(op, vec![("changed", json!(true)), ("slide", number_field(op, "slide")), ("comment", json_number(index))]))
}

/// `handleAddProvenance`: the citation of a source added to a slide's notes unless they already carry it.
pub fn handle_add_provenance(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Handled {
    let citation = provenance_citation(field(op, "source"));
    if citation.is_empty() {
        return Err("add_provenance requires source with a document or label".to_owned());
    }
    let slide = slide_of(slides, op)?;
    let existing = read_slide_notes(zip, slide);
    if existing.contains(&citation) {
        return Ok(answer(op, vec![("changed", json!(false)), ("slide", number_field(op, "slide")), ("citation", json!(citation))]));
    }
    let notes = if existing.is_empty() { citation.clone() } else { format!("{existing}\n{citation}") };
    set_slide_notes(zip, slides, field(op, "slide"), &Value::String(notes))?;
    let slide_number = number_to_string(number_of(op, "slide"));
    let target = if op.get("shape").is_some_and(truthy) {
        format!("/slide[{slide_number}]/shape[{}]", number_to_string(number_of(op, "shape")))
    } else {
        format!("/slide[{slide_number}]")
    };
    Ok(answer(
        op,
        vec![("changed", json!(true)), ("slide", number_field(op, "slide")), ("target", json!(target)), ("citation", json!(citation))],
    ))
}

/// `handleDuplicateSlide`: a copy of a slide with the parts it owns (charts, diagrams, notes), listed after the original or
/// at `op.index`.
pub fn handle_duplicate_slide(zip: &mut Package, slides: &mut Vec<SlideRef>, op: &Value) -> Handled {
    let source = slide_of(slides, op)?.clone();
    let mut ordinal = 1;
    while zip.file(&format!("ppt/slides/slide{ordinal}.xml")).is_some() {
        ordinal += 1;
    }
    let duplicated = format!("ppt/slides/slide{ordinal}.xml");
    let source_xml = zip.text(&source.path);
    zip.set(&duplicated, source_xml);
    let source_relationships = zip.text(&part_relationship_path(&source.path));
    let mut copied_parts = Vec::new();
    if !source_relationships.is_empty() {
        let stripped =
            compiled(r#"<Relationship\b[^>]*\bType="[^"]*/notesSlide"[^>]*/>"#, "g").replace_all_with(&source_relationships, |_| String::new());
        zip.set(&part_relationship_path(&duplicated), stripped);
        // A copy that still pointed at the source's chart or diagram turned one edit into two changed pages, with nothing in
        // the result saying so.
        copied_parts = clone_owned_slide_parts(zip, &part_relationship_path(&duplicated));
        copy_slide_notes(zip, &source.path, &duplicated);
    }
    ensure_content_type_override(zip, &format!("/{duplicated}"), SLIDE_CONTENT_TYPE);
    let relationship_id = add_package_relationship(
        zip,
        "ppt/_rels/presentation.xml.rels",
        &format!("{OFFICE_RELATIONSHIP_BASE}/slide"),
        &format!("slides/slide{ordinal}.xml"),
        "",
    );
    let presentation = zip.text("ppt/presentation.xml");
    let mut entries = slide_id_entries(&presentation);
    let highest = entries.iter().map(|entry| entry_id(entry)).fold(255.0, math::max);
    let index = number_of(op, "index");
    let position = if index > 0.0 { math::min(index - 1.0, entries.len() as f64) } else { number_of(op, "slide") };
    // `Array.prototype.splice` truncates the position and keeps it inside the list.
    let at = position.trunc().max(0.0).min(entries.len() as f64) as usize;
    entries.insert(at, format!("<p:sldId id=\"{}\" r:id=\"{relationship_id}\"/>", number_to_string(highest + 1.0)));
    zip.set("ppt/presentation.xml", write_slide_id_list(&presentation, &entries));
    *slides = presentation_slides(zip);
    let mut result = vec![("changed", json!(true)), ("slide", json_number(position + 1.0))];
    if !copied_parts.is_empty() {
        result.push(("ownParts", json!(copied_parts)));
    }
    Ok(answer(op, result))
}

/// `handleSetNotes`.
pub fn handle_set_notes(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Handled {
    set_slide_notes(zip, slides, field(op, "slide"), field(op, "text"))?;
    Ok(answer(op, vec![("changed", json!(true)), ("slide", number_field(op, "slide"))]))
}

/// `handleFillTemplate`: the template tokens of every slide and notes part.
pub fn handle_fill_template(zip: &mut Package, op: &Value) -> Handled {
    let parts = slide_part_names(zip);
    let fill = FillTemplate { tokens: field(op, "tokens"), strict: op.get("strict").is_some_and(truthy) };
    fill_template_parts(zip, &parts, "a:t", &fill, &replace_across_runs)
        .map(|done| done.to_value())
}

/// `handleReplaceText`: text replaced paragraph by paragraph in every slide and notes part, or in one slide and its notes.
pub fn handle_replace_text(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Handled {
    let mut paths = slide_part_names(zip);
    // slide keeps the replacement on that page and its speaker notes.
    if op.get("slide").is_some() {
        let page = slide_part(slides, op)?;
        let notes = relationship_target_by_type(&zip.text(&part_relationship_path(&page)), "notesSlide");
        paths = vec![page.clone()];
        if !notes.is_empty() {
            paths.push(match notes.strip_prefix('/') {
                Some(rooted) => rooted.to_owned(),
                None => posix::normalize(&posix::join(&[&posix::dirname(&page), &notes])),
            });
        }
    }
    let find = text_if_truthy(op.get("find"));
    let replacement = text_or_empty(op.get("replace"));
    let mut count = 0;
    for path in paths {
        let replaced = replace_in_paragraphs(&zip.text(&path), &find, &replacement, &ParagraphTags::default())?;
        if replaced.count > 0 {
            zip.set(&path, replaced.xml);
        }
        count += replaced.count;
    }
    Ok(answer(op, vec![("changed", json!(count > 0)), ("count", json!(count))]))
}

/// The path `readFile` is given: a string, or the error Node's `readFile` throws for anything else.
fn file_path(op: &Value) -> Result<String, String> {
    let received = match op.get("path") {
        Some(Value::String(path)) => return Ok(path.clone()),
        None => "undefined".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::Bool(flag)) => format!("type boolean ({flag})"),
        Some(Value::Number(number)) => format!("type number ({number})"),
        Some(Value::Array(_)) => "an instance of Array".to_owned(),
        Some(Value::Object(_)) => "an instance of Object".to_owned(),
    };
    Err(format!("The \"path\" argument must be of type string or an instance of Buffer or URL. Received {received}"))
}

/// `handleImportSlides`: slides of another deck copied in after position `op.after`.
pub fn handle_import_slides<P: ReadProof>(proof: &P, zip: &mut Package, slides: &mut Vec<SlideRef>, op: &Value) -> Handled {
    let source = file_path(op)?;
    let merged = import_slides_into_presentation(proof, zip, &source, op.get("slides"), op.get("after"))?;
    *slides = presentation_slides(zip);
    let count = merged["count"].as_u64().unwrap_or(0);
    Ok(answer(op, vec![("changed", json!(count > 0)), ("count", json!(count)), ("source", json!(source))]))
}

/// `handleSetSlideBackground`.
pub fn handle_set_slide_background(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Handled {
    let path = slide_part(slides, op)?;
    let current = zip.text(&path);
    zip.set(&path, set_slide_background(&current, op.get("color"))?);
    Ok(answer(op, vec![("changed", json!(true)), ("slide", number_field(op, "slide"))]))
}

// Secondary ink for a footer or page number: grey enough to recede, dark (or light) enough against its own field to clear the
// 4.5:1 the audit asks of any text. A field we cannot read leaves the neutral that suits a white slide.
const QUIET_INK_ON_LIGHT: [&str; 3] = ["6A7179", "5A616A", "474D55"];
const QUIET_INK_ON_DARK: [&str; 3] = ["A9B1B9", "C2C9D0", "D9DEE3"];

fn quiet_ink(background: &str) -> &'static str {
    let bare = background.strip_prefix('#').unwrap_or(background);
    let characters: Vec<char> = bare.chars().collect();
    let field: String = characters[characters.len().saturating_sub(6)..].iter().collect::<String>().to_uppercase();
    if field.len() != 6 || !field.bytes().all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte)) {
        return QUIET_INK_ON_LIGHT[0];
    }
    let light = relative_luminance(&field).unwrap_or(1.0) >= 0.4;
    let ladder = if light { QUIET_INK_ON_LIGHT } else { QUIET_INK_ON_DARK };
    ladder
        .into_iter()
        .find(|candidate| contrast_ratio(candidate, &field).unwrap_or(0.0) >= 4.5)
        .unwrap_or(if light { "1F2429" } else { "FFFFFF" })
}

/// `handleSetFooterOrSetSlideNumber` (`set_footer`, `set_slide_number`): the slide's footer or page-number placeholder
/// replaced by a new one, in a tone that reads against the slide's own field.
pub fn handle_set_footer_or_set_slide_number(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Handled {
    let path = slide_part(slides, op)?;
    let current = zip.text(&path);
    let tree = container_inner(&current, "p:spTree", 0).ok_or_else(|| "PPTX slide shape tree is missing".to_owned())?;
    let footer = field(op, "op").as_str() == Some("set_footer");
    let placeholder = if footer { "ftr" } else { "sldNum" };
    let shapes = top_level_elements(&tree.inner, &SLIDE_SHAPE_TAGS);
    let mut inner = tree.inner.clone();
    let marker = compiled(&format!(r#"<p:ph\b[^>]*\btype="{placeholder}""#), "");
    for shape in shapes.iter().rev() {
        if marker.is_match(&shape.xml) {
            inner = format!("{}{}", &inner[..shape.start], &inner[shape.end..]);
        }
    }
    let hidden = !footer && op.get("visible") == Some(&Value::Bool(false));
    if !hidden {
        let (width, height) = presentation_slide_size(zip);
        let id = number_to_string(next_shape_id(&current));
        // A footer is quiet, not unreadable: the tone steps away from the field the slide actually shows and stops at the
        // contrast a reader needs.
        let ink = quiet_ink(&resolve_slide_background(zip, &path, &current)?);
        let body = if footer {
            text_body_xml(&json!({
                "paragraphs": [{ "text": text_if_truthy(op.get("text")) }],
                "defaults": { "fontSize": 10, "color": ink },
                "anchor": "center",
            }))
        } else {
            format!(
                "<a:bodyPr wrap=\"square\"><a:noAutofit/></a:bodyPr><a:lstStyle/><a:p><a:pPr algn=\"r\"/><a:fld id=\"{{{}}}\" type=\"slidenum\"><a:rPr lang=\"en-US\" sz=\"1000\"><a:solidFill><a:srgbClr val=\"{ink}\"/></a:solidFill></a:rPr><a:t>{}</a:t></a:fld></a:p>",
                uuid::Uuid::new_v4().hyphenated().to_string().to_uppercase(),
                number_to_string(number_of(op, "slide"))
            )
        };
        let shape = format!(
            "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{} {id}\"/><p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr><p:nvPr><p:ph type=\"{placeholder}\" sz=\"quarter\" idx=\"{}\"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr><p:txBody>{body}</p:txBody></p:sp>",
            if footer { "Footer Placeholder" } else { "Slide Number Placeholder" },
            if footer { 10 } else { 12 },
            number_to_string(to_emu(if footer { 58.0 } else { width - 158.0 })),
            number_to_string(to_emu(height - 40.0)),
            number_to_string(to_emu(if footer { width - 240.0 } else { 100.0 })),
            number_to_string(to_emu(24.0)),
        );
        inner.push_str(&shape);
    }
    zip.set(&path, format!("{}{inner}{}", &current[..tree.start], &current[tree.end..]));
    let mut result = vec![("changed", json!(true)), ("slide", number_field(op, "slide"))];
    if hidden {
        result.push(("visible", json!(false)));
    }
    Ok(answer(op, result))
}

/// `handleApplyTheme`: the theme part of another deck written over the deck's own theme parts.
pub fn handle_apply_theme<P: ReadProof>(proof: &P, zip: &mut Package, op: &Value) -> Handled {
    let source_path = file_path(op)?;
    let bytes = mixdog_fsio::read(proof, Path::new(&source_path)).map_err(|error| os_message(&error, "open", Path::new(&source_path)))?;
    let source = Package::load_unchecked(&bytes)?;
    let theme_pattern = compiled(r"^(?:ppt\/)?theme\/theme\d+\.xml$", "i");
    let Some(theme_part) = source.names().into_iter().find(|name| theme_pattern.is_match(name)) else {
        return Err(format!("apply_theme source has no theme part: {source_path}"));
    };
    let theme = source.text(&theme_part);
    let master_pattern = compiled(r"^ppt\/slideMasters\/slideMaster\d+\.xml$", "");
    let masters: Vec<String> = zip.names().into_iter().filter(|name| master_pattern.is_match(name)).collect();
    let mut targets: Vec<String> = Vec::new();
    for master in masters {
        let target = relationship_target_by_type(&zip.text(&part_relationship_path(&master)), "theme");
        if !target.is_empty() {
            let part = posix::normalize(&posix::join(&[&posix::dirname(&master), &target]));
            if !targets.contains(&part) {
                targets.push(part);
            }
        }
    }
    if targets.is_empty() {
        targets.push("ppt/theme/theme1.xml".to_owned());
    }
    // A theme identical to the one already in the deck restyles nothing. Saying "changed" there tells the caller the deck was
    // restyled and leaves them looking for a difference the file does not carry.
    let mut applied = Vec::new();
    for part in targets {
        if zip.text(&part) == theme {
            continue;
        }
        zip.set(&part, theme.clone());
        applied.push(part);
    }
    let unchanged = applied.is_empty();
    let mut result = vec![("changed", json!(!unchanged)), ("theme", json!(theme_part)), ("applied", json!(applied))];
    if unchanged {
        result.push(("unchangedReason", json!("the deck already uses this theme")));
    }
    Ok(answer(op, result))
}

/// `handleSetLayout`: the slide pointed at another layout of the deck.
pub fn handle_set_layout(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Handled {
    let path = slide_part(slides, op)?;
    let layouts = slide_layout_parts(zip);
    let layout = select_slide_layout(&layouts, op.get("layout"))?;
    let relationships = part_relationship_path(&path);
    let rels = zip.text(&relationships);
    let target = posix::relative("ppt/slides", &layout.path);
    let existing = compiled(r#"<Relationship\b[^>]*\bType="[^"]*/slideLayout"[^>]*/>"#, "").find(&rels);
    let next = match existing {
        Some(found) => {
            let block = &rels[found.clone()];
            let retargeted = match compiled(r#"\bTarget="[^"]*""#, "").find(block) {
                Some(attribute) => format!("{}Target=\"{}\"{}", &block[..attribute.start], xml_encode(&target), &block[attribute.end..]),
                None => block.to_owned(),
            };
            format!("{}{retargeted}{}", &rels[..found.start], &rels[found.end..])
        }
        None => replace_first_text(
            &rels,
            "</Relationships>",
            &format!(
                "<Relationship Id=\"{}\" Type=\"{OFFICE_RELATIONSHIP_BASE}/slideLayout\" Target=\"{}\"/></Relationships>",
                next_relationship_id(&rels),
                xml_encode(&target)
            ),
        ),
    };
    zip.set(&relationships, next);
    let described = if layout.name.is_empty() { layout.layout_type.clone() } else { layout.name.clone() };
    Ok(answer(op, vec![("changed", json!(true)), ("slide", number_field(op, "slide")), ("layout", json!(described))]))
}

/// `handleSetSlideVisibility`: PowerPoint keeps a hidden slide in the file and skips it when presenting, which is how an
/// appendix rides along with the deck it belongs to. The state lives on the slide element itself, so a deck can carry it
/// without a notes convention.
pub fn handle_set_slide_visibility(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Handled {
    let path = slide_part(slides, op)?;
    let Some(Value::Bool(visible)) = op.get("visible") else {
        return Err("set_slide_visibility requires visible: true or false".to_owned());
    };
    let current = zip.text(&path);
    let Some(open) = compiled(r"<p:sld\b[^>]*>", "").find(&current) else {
        return Err(format!("Slide part is not a presentation slide: {path}"));
    };
    let tag = &current[open.clone()];
    let stripped = match compiled(r#"\s*\bshow="[^"]*""#, "").find(tag) {
        Some(shown) => format!("{}{}", &tag[..shown.start], &tag[shown.end..]),
        None => tag.to_owned(),
    };
    let attributes = match stripped.strip_suffix('>') {
        Some(head) if !*visible => format!("{head} show=\"0\">"),
        _ => stripped,
    };
    zip.set(&path, format!("{}{attributes}{}", &current[..open.start], &current[open.end..]));
    Ok(answer(op, vec![("changed", json!(true)), ("slide", number_field(op, "slide")), ("visible", json!(*visible))]))
}

const TRANSITIONS: [(&str, &str); 9] = [
    ("fade", "<p:fade/>"),
    ("cut", "<p:cut/>"),
    ("push", "<p:push/>"),
    ("wipe", "<p:wipe/>"),
    ("split", "<p:split/>"),
    ("dissolve", "<p:dissolve/>"),
    ("cover", "<p:cover/>"),
    ("zoom", "<p:zoom/>"),
    ("none", ""),
];

/// `handleSetTransition`: the slide's transition replaced (or removed by `none`), placed after the colour map override.
pub fn handle_set_transition(zip: &mut Package, slides: &[SlideRef], op: &Value) -> Handled {
    let path = slide_part(slides, op)?;
    let current = zip.text(&path);
    // `String(op.effect || 'fade')`: a truthy effect that prints as nothing (an empty list) is not the default.
    let requested = js_to_lowercase(&op.get("effect").filter(|value| truthy(value)).map_or_else(|| "fade".to_owned(), value_to_string));
    let Some((_, effect)) = TRANSITIONS.iter().find(|(name, _)| *name == requested) else {
        let names: Vec<&str> = TRANSITIONS.iter().map(|(name, _)| *name).collect();
        return Err(format!("set_transition effect must be one of: {}", names.join(", ")));
    };
    let duration = number_of(op, "duration");
    let speed = if duration.is_finite() && duration >= 1500.0 {
        "slow"
    } else if duration.is_finite() && duration > 0.0 && duration <= 500.0 {
        "fast"
    } else {
        "med"
    };
    let advance_time = number_of(op, "advanceTime");
    let advance = if op.get("advanceOnTime") == Some(&Value::Bool(true)) && advance_time > 0.0 {
        format!(" advTm=\"{}\"", number_to_string(math::round(advance_time)))
    } else {
        String::new()
    };
    let element = if requested == "none" { String::new() } else { format!("<p:transition spd=\"{speed}\"{advance}>{effect}</p:transition>") };
    let stripped = match compiled(r"<p:transition\b[^>]*?(?:/>|>[\s\S]*?</p:transition>)", "").find(&current) {
        Some(found) => format!("{}{}", &current[..found.start], &current[found.end..]),
        None => current.clone(),
    };
    let anchor = compiled(r"<p:clrMapOvr\b[^>]*?(?:/>|>[\s\S]*?</p:clrMapOvr>)", "").find(&stripped);
    let next = match anchor {
        Some(found) if !element.is_empty() => format!("{}{element}{}", &stripped[..found.end], &stripped[found.end..]),
        _ if !element.is_empty() => replace_first_text(&stripped, "</p:sld>", &format!("{element}</p:sld>")),
        _ => stripped,
    };
    zip.set(&path, next);
    Ok(answer(op, vec![("changed", json!(true)), ("slide", number_field(op, "slide")), ("effect", json!(requested))]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_ink_clears_the_contrast_the_audit_asks_for() {
        assert_eq!(quiet_ink(""), "6A7179");
        assert_eq!(quiet_ink("not a colour"), "6A7179");
        for background in ["FFFFFF", "#F4F4F4", "0A1B2C", "000000"] {
            let field = background.trim_start_matches('#');
            let ink = quiet_ink(background);
            assert!(contrast_ratio(ink, field).unwrap() >= 4.5, "{background}: {ink}");
        }
        assert_eq!(quiet_ink("a1b2c3d4e5f6"), quiet_ink("D4E5F6"));
    }

    #[test]
    fn file_path_names_what_readfile_was_given() {
        assert!(file_path(&json!({})).unwrap_err().ends_with("Received undefined"));
        assert!(file_path(&json!({ "path": 5 })).unwrap_err().ends_with("Received type number (5)"));
        assert_eq!(file_path(&json!({ "path": "a.pptx" })).unwrap(), "a.pptx");
    }
}
