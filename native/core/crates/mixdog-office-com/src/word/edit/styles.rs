//! The style and formatting operations of `Invoke-WordOperation`: `set_document_font`, `define_styles`, `set_font`,
//! `set_paragraph_style`, `set_paragraph_format` and `set_list`.

use super::Com;
use super::Para;
use super::Value;
use super::cast_int;
use super::color_of;
use super::formatting;
use super::lists;
use super::lower;
use super::ordered;
use super::prop;
use super::r4;
use super::same;
use super::text_of;
use super::truthy;
use crate::com::Error;
use crate::com::Obj;
use crate::com::Result;

/// `set_document_font`: the document's own face and size, as the portable writer sets its default run properties: Normal
/// (wdStyleNormal, -1) is what every paragraph without its own reads and what a new one starts from.
pub(super) fn set_document_font(document: &Obj, op: &Value) -> Result<Value> {
    let props = prop(op, "properties");
    if !["name", "nameEastAsia", "size", "color"].iter().any(|key| truthy(&prop(&props, key))) {
        return Err(Error::host("set_document_font needs properties.name, nameEastAsia, size, or color"));
    }
    let normal = super::item(&document.get("Styles")?, -1)?;
    if truthy(&prop(&props, "name")) {
        normal.member("Font")?.set_member("Name", Com::from(text_of(&prop(&props, "name"))))?;
    }
    if truthy(&prop(&props, "nameEastAsia")) {
        normal.member("Font")?.set_member("NameFarEast", Com::from(text_of(&prop(&props, "nameEastAsia"))))?;
    }
    if truthy(&prop(&props, "size")) {
        normal.member("Font")?.set_member("Size", r4(&prop(&props, "size"))?)?;
    }
    if truthy(&prop(&props, "color")) {
        normal.member("Font")?.set_member("Color", color_of(&prop(&props, "color"))?)?;
    }
    Ok(ordered(vec![
        ("op", Value::string("set_document_font")),
        ("changed", Value::Bool(true)),
        ("name", Value::String(super::string(&normal.member("Font")?.member("Name")?))),
        ("nameEastAsia", Value::String(super::string(&normal.member("Font")?.member("NameFarEast")?))),
        ("size", Value::Double(super::double(&normal.member("Font")?.member("Size")?)?)),
    ]))
}

/// `define_styles`: Word's own styles defined once, as the portable writer patches styles.xml: built-in styles by their id,
/// so a Korean Word's "제목 1" is reached as "Heading 1".
pub(super) fn define_styles(document: &Obj, op: &Value) -> Result<Value> {
    let styles = prop(op, "styles");
    if !truthy(&styles) {
        return Err(Error::host("define_styles needs styles: { \"<style name>\": { fields } }"));
    }
    let mut defined: Vec<Value> = Vec::new();
    let mut not_found: Vec<Value> = Vec::new();
    let entries = match &styles {
        Value::Object(object) => object.entries.clone(),
        _ => Vec::new(),
    };
    for (name, fields) in entries {
        let wanted = formatting::style_value(&name);
        let style = document.get("Styles").and_then(|all| super::indexed(&all, "Item", &[wanted.into_com()])).ok().filter(super::is_object);
        let Some(style) = style else {
            not_found.push(Value::String(name));
            continue;
        };
        formatting::set_run_format(&style, &fields)?;
        let format = style.member("ParagraphFormat")?;
        if truthy(&prop(&fields, "alignment")) {
            format.set_member("Alignment", Com::I4(formatting::paragraph_alignment(&prop(&fields, "alignment"))))?;
        }
        formatting::set_paragraph_flow(&format, &fields)?;
        defined.push(Value::String(name));
    }
    let mut pairs = vec![("op", Value::string("define_styles")), ("changed", Value::Bool(!defined.is_empty())), ("styles", Value::Array(defined))];
    if !not_found.is_empty() {
        pairs.push(("styleNotFound", Value::Array(not_found)));
    }
    Ok(ordered(pairs))
}

/// `set_font`: the first occurrence of the phrase in the body takes the run format.
pub(super) fn set_font(document: &Obj, op: &Value) -> Result<Value> {
    let range = document.get("Content")?.member("Duplicate")?;
    if !truthy(&prop(op, "find")) {
        return Err(Error::host("set_font requires non-empty find"));
    }
    range.member("Find")?.call_member("ClearFormatting", &[])?;
    let arguments = [
        Com::from(text_of(&prop(op, "find"))),
        Com::Bool(false),
        Com::Bool(false),
        Com::Bool(false),
        Com::Bool(false),
        Com::Bool(false),
        Com::Bool(true),
        Com::I4(0),
        Com::Bool(false),
    ];
    if !super::truth(&range.member("Find")?.call_member("Execute", &arguments)?) {
        return Err(Error::host(format!("Font target not found in document body: {}", text_of(&prop(op, "find")))));
    }
    formatting::set_run_format(&range, &prop(op, "properties"))?;
    Ok(ordered(vec![("op", Value::string("set_font")), ("changed", Value::Bool(true))]))
}

/// `set_paragraph_style`.
pub(super) fn set_paragraph_style(document: &Obj, op: &Value) -> Result<Value> {
    let paragraph = super::item(&document.get("Paragraphs")?, cast_int(&prop(op, "paragraph"))?)?;
    let missing = formatting::set_style(&paragraph.member("Range")?, &text_of(&prop(op, "style")));
    let reported = missing.clone().filter(|name| !name.is_empty());
    let mut pairs =
        vec![("op", Value::string("set_paragraph_style")), ("changed", Value::Bool(reported.is_none())), ("style", Value::String(text_of(&prop(op, "style"))))];
    if let Some(name) = reported {
        pairs.push(("styleNotFound", Value::String(name)));
    }
    Ok(ordered(pairs))
}

/// `set_paragraph_format`: listKind and listLevel put the paragraph in a list, or take it out, as set_list does, and the
/// paragraph keeps its style there too.
pub(super) fn set_paragraph_format(document: &Obj, op: &Value) -> Result<Value> {
    let paragraph = Para::Real(super::item(&document.get("Paragraphs")?, cast_int(&prop(op, "paragraph"))?)?);
    let format = paragraph.format()?;
    let props = prop(op, "properties");
    let kind = prop(&props, "listKind");
    if truthy(&kind) {
        let list_kind = lower(&text_of(&kind));
        let apply = || -> Result<()> {
            if same(&list_kind, "none") {
                paragraph.range()?.member("ListFormat")?.call_member("RemoveNumbers", &[]).map(|_| ())
            } else if same(&list_kind, "number") {
                lists::apply_number(
                    document,
                    &paragraph,
                    cast_int(&prop(op, "paragraph"))?,
                    truthy(&prop(&props, "listContinue")),
                    &prop(&props, "listNumbering"),
                )
            } else {
                lists::apply_bullet(document, &paragraph)
            }
        };
        lists::in_list_style(document, apply)?;
        if !same(&list_kind, "none") && cast_int(&prop(&props, "listLevel"))? > 0 {
            let level = 3_i32.min(cast_int(&prop(&props, "listLevel"))? + 1);
            paragraph.range()?.member("ListFormat")?.set_member("ListLevelNumber", Com::I4(level))?;
        }
    }
    if truthy(&prop(&props, "alignment")) {
        format.set_member("Alignment", Com::I4(formatting::paragraph_alignment(&prop(&props, "alignment"))))?;
    }
    formatting::set_paragraph_flow(&format, &props)?;
    formatting::set_list_item_inset(&format, &props)?;
    formatting::set_tab_stops(&format, &props)?;
    if truthy(&prop(&props, "border")) {
        formatting::set_paragraph_border(&paragraph, &prop(&props, "border"))?;
    }
    Ok(ordered(vec![
        ("op", Value::string("set_paragraph_format")),
        ("changed", Value::Bool(true)),
        ("paragraph", Value::Int(cast_int(&prop(op, "paragraph"))?)),
    ]))
}

/// `set_list`: level counts from 0, as the portable writer's ilvl does. ListIndent on a list's first item shifts the whole
/// list instead of nesting it, so the level is set outright.
pub(super) fn set_list(document: &Obj, op: &Value) -> Result<Value> {
    let paragraph = Para::Real(super::item(&document.get("Paragraphs")?, cast_int(&prop(op, "paragraph"))?)?);
    let kind = lower(&text_of(&prop(op, "kind")));
    if same(&kind, "none") {
        paragraph.range()?.member("ListFormat")?.call_member("RemoveNumbers", &[])?;
    } else if same(&kind, "number") {
        // The document's own 1. / a. / i. list, as append_text numbers an item and the portable writer defines it.
        lists::apply_number(document, &paragraph, cast_int(&prop(op, "paragraph"))?, false, &prop(op, "numbering"))?;
    } else {
        lists::apply_bullet(document, &paragraph)?;
    }
    if !same(&kind, "none") && cast_int(&prop(op, "level"))? > 0 {
        let level = 3_i32.min(cast_int(&prop(op, "level"))? + 1);
        paragraph.range()?.member("ListFormat")?.set_member("ListLevelNumber", Com::I4(level))?;
    }
    Ok(ordered(vec![
        ("op", Value::string("set_list")),
        ("changed", Value::Bool(true)),
        ("paragraph", Value::Int(cast_int(&prop(op, "paragraph"))?)),
        ("kind", Value::String(if kind.is_empty() { "bullet".to_owned() } else { kind })),
    ]))
}
