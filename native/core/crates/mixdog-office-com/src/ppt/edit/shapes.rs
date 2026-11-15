//! The shape operations of the deck editor: `add_textbox`, `add_shape`, `set_shape`, `delete_shape`, `z_order`, `align_shapes`,
//! `distribute_shapes`, `group_shapes`, `ungroup_shape`, `set_hyperlink`, and the helpers they share (`Set-PowerPointShadow`,
//! `Clamp-Unit`, `Ink-OnFill`, `Quiet-Ink`).

use crate::com::Error;
use crate::com::Result;
use crate::com::SafeArray;
use crate::com::Value as Com;
use crate::ppt::ink::ink_luminance;
use crate::ps::Value;
use crate::ps::collate;
use crate::ps::collate::SortOptions;
use crate::ps::convert;
use crate::ps::payload;
use crate::ps::text;

use super::array_of;
use super::as_int_nonzero;
use super::attempt;
use super::boolean;
use super::bstr;
use super::box_value;
use super::color;
use super::color_text;
use super::double;
use super::has_property;
use super::i4;
use super::int;
use super::int_value;
use super::office_flag;
use super::operation_property;
use super::pipeline;
use super::present;
use super::prop;
use super::put_path;
use super::r4;
use super::record;
use super::shape_of;
use super::single;
use super::slide_of;
use super::string_value;
use super::text::paragraph_alignment;
use super::text::set_font_name;
use super::text::set_paragraphs;
use super::text::vertical_anchor;
use super::text_of;
use super::truthy;
use super::walk;

/// `Clamp-Unit`: the value held between 0 and 1 (double overloads: an integer literal bound the Int32 ones and rounded every
/// fraction).
pub(crate) fn clamp_unit(value: f64) -> f64 {
    0.0_f64.max(1.0_f64.min(value))
}

/// `$text -match '^[0-9A-Fa-f]{6}$'` of a fill or field already trimmed of its `#`.
fn is_hex_colour(hex: &str) -> bool {
    hex.len() == 6 && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// `$text.Trim().TrimStart('#')`.
fn trimmed_hex(text: &str) -> String {
    text.trim().trim_start_matches('#').to_owned()
}

/// `Ink-OnFill`: white on a dark fill, near-black on a light one or on none, as the portable writer chooses it.
pub(crate) fn ink_on_fill(fill: &str) -> String {
    let hex = trimmed_hex(fill);
    if !is_hex_colour(&hex) {
        return "1F2429".to_owned();
    }
    let field = ink_luminance(&hex).unwrap_or(0.0);
    let white = 1.05 / (field + 0.05);
    let dark = ink_luminance("1F2429").unwrap_or(0.0);
    let ink = (field.max(dark) + 0.05) / (field.min(dark) + 0.05);
    (if white >= ink { "FFFFFF" } else { "1F2429" }).to_owned()
}

/// `Quiet-Ink`: grey enough to recede, the first step of its ladder that clears 4.5:1 against the slide's own field; a field
/// that cannot be read takes the light-slide grey.
pub(crate) fn quiet_ink(field: &str) -> String {
    let hex = trimmed_hex(field);
    if !is_hex_colour(&hex) {
        return "6A7179".to_owned();
    }
    let field_luminance = ink_luminance(&hex).unwrap_or(0.0);
    let light = field_luminance >= 0.4;
    let ladder: [&str; 3] = if light { ["6A7179", "5A616A", "474D55"] } else { ["A9B1B9", "C2C9D0", "D9DEE3"] };
    for candidate in ladder {
        let ink = ink_luminance(candidate).unwrap_or(0.0);
        if (ink.max(field_luminance) + 0.05) / (ink.min(field_luminance) + 0.05) >= 4.5 {
            return candidate.to_owned();
        }
    }
    (if light { "1F2429" } else { "FFFFFF" }).to_owned()
}

/// `Set-PowerPointShadow`: `true` is PowerPoint's own shadow; an object names its colour, transparency (0-1), blur and offsets
/// in points.
pub(crate) fn set_shadow(shape: &Com, shadow: &Value) -> Result<()> {
    put_path(shape, &["Shadow", "Visible"], i4(-1))?;
    let ink = prop(shadow, "color");
    if truthy(&ink) {
        put_path(shape, &["Shadow", "ForeColor", "RGB"], color(&ink)?)?;
    }
    for (name, member) in [("transparency", "Transparency"), ("blur", "Blur"), ("offsetX", "OffsetX"), ("offsetY", "OffsetY")] {
        let value = prop(shadow, name);
        if present(&value) {
            put_path(shape, &["Shadow", member], r4(single(&value)?))?;
        }
    }
    Ok(())
}

/// `[single]([double]$value / 100)`: a percentage as the fraction PowerPoint takes.
fn percentage(value: &Value) -> Result<Com> {
    Ok(r4((double(value)? / 100.0) as f32))
}

/// `if ($null -ne $value) { <target> = [single]$value }`.
fn put_single_if_present(shape: &Com, names: &[&str], value: &Value) -> Result<()> {
    if present(value) {
        put_path(shape, names, r4(single(value)?))?;
    }
    Ok(())
}

/// `if ($null -ne $value) { <target> = -1 or 0 }`.
fn put_flag_if_present(shape: &Com, names: &[&str], value: &Value) -> Result<()> {
    if present(value) {
        put_path(shape, names, office_flag(truthy(value)))?;
    }
    Ok(())
}

/// `delete_shape`.
pub(crate) fn delete_shape(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    shape_of(&slide, op)?.call_member("Delete", &[])?;
    Ok(record(vec![("op", Value::string("delete_shape")), ("changed", Value::Bool(true))]))
}

/// The margins and the paragraph spacing a text frame is given: `marginLeft` and the rest, `paragraphSpacing`.
fn put_margins(shape: &Com, props: &Value) -> Result<()> {
    for (name, member) in [("marginLeft", "MarginLeft"), ("marginTop", "MarginTop"), ("marginRight", "MarginRight"), ("marginBottom", "MarginBottom")] {
        put_single_if_present(shape, &["TextFrame", member], &prop(props, name))?;
    }
    put_single_if_present(shape, &["TextFrame", "TextRange", "ParagraphFormat", "SpaceBefore"], &prop(props, "paragraphSpacing"))
}

/// The alignment and the vertical anchor of the properties.
fn put_alignment(shape: &Com, props: &Value) -> Result<()> {
    let alignment = prop(props, "alignment");
    if truthy(&alignment) {
        put_path(shape, &["TextFrame", "TextRange", "ParagraphFormat", "Alignment"], i4(paragraph_alignment(&alignment)))?;
    }
    let anchor = prop(props, "verticalAlignment");
    if truthy(&anchor) {
        put_path(shape, &["TextFrame", "VerticalAnchor"], i4(vertical_anchor(&anchor)))?;
    }
    Ok(())
}

/// The paragraphs of an operation (`$op.PSObject.Properties['paragraphs']`): present, not `$null`, and not empty.
fn paragraphs_of(op: &Value) -> Option<Value> {
    let found = prop(op, "paragraphs");
    (has_property(op, "paragraphs") && present(&found) && !array_of(&found).is_empty()).then_some(found)
}

/// `add_textbox`: a text box with its text, face, fill, outline, spacing and shadow.
pub(crate) fn add_textbox(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let left = box_value(op, "left", 72)?;
    let top = box_value(op, "top", 72)?;
    let width = box_value(op, "width", 360)?;
    let height = box_value(op, "height", 72)?;
    let shape = slide.member("Shapes")?.call_member("AddTextbox", &[i4(1), r4(left), r4(top), r4(width), r4(height)])?;
    attempt(|| put_path(&shape, &["TextFrame", "AutoSize"], i4(0)));
    attempt(|| put_path(&shape, &["TextFrame2", "AutoSize"], i4(0)));
    match paragraphs_of(op) {
        Some(paragraphs) => {
            set_paragraphs(&shape, &paragraphs)?;
        }
        None => put_path(&shape, &["TextFrame", "TextRange", "Text"], bstr(&text_of(&prop(op, "text"))))?,
    }
    shape.set_member("Left", r4(left))?;
    shape.set_member("Top", r4(top))?;
    shape.set_member("Width", r4(width))?;
    shape.set_member("Height", r4(height))?;
    let font_size = operation_property(op, "fontSize", Value::Null);
    let font_name = operation_property(op, "fontName", Value::Null);
    let ink = operation_property(op, "color", Value::Null);
    if present(&font_size) {
        put_path(&shape, &["TextFrame", "TextRange", "Font", "Size"], r4(single(&font_size)?))?;
    }
    if present(&font_name) {
        set_font_name(&walk(&shape, &["TextFrame", "TextRange", "Font"])?, &text_of(&font_name))?;
    }
    if present(&ink) {
        put_path(&shape, &["TextFrame", "TextRange", "Font", "Color", "RGB"], color(&ink)?)?;
    }
    let props = prop(op, "properties");
    // The fill and outline a text box is given, drawn as the portable writer draws them.
    let fill_color = operation_property(op, "fillColor", Value::Null);
    if truthy(&fill_color) {
        put_path(&shape, &["Fill", "Visible"], i4(-1))?;
        shape.member("Fill")?.call_member("Solid", &[])?;
        put_path(&shape, &["Fill", "ForeColor", "RGB"], color(&fill_color)?)?;
    }
    let fill_transparency = operation_property(op, "fillTransparency", Value::Null);
    if present(&fill_transparency) {
        put_path(&shape, &["Fill", "Transparency"], percentage(&fill_transparency)?)?;
    }
    let line_color = operation_property(op, "lineColor", Value::Null);
    if truthy(&line_color) {
        put_path(&shape, &["Line", "Visible"], i4(-1))?;
        put_path(&shape, &["Line", "ForeColor", "RGB"], color(&line_color)?)?;
    }
    let line_transparency = operation_property(op, "lineTransparency", Value::Null);
    if present(&line_transparency) {
        put_path(&shape, &["Line", "Transparency"], percentage(&line_transparency)?)?;
    }
    let line_width = operation_property(op, "lineWidth", Value::Null);
    put_single_if_present(&shape, &["Line", "Weight"], &line_width)?;
    let alt_text = prop(&props, "altText");
    if present(&alt_text) {
        shape.set_member("AlternativeText", bstr(&text_of(&alt_text)))?;
    }
    put_single_if_present(&shape, &["Rotation"], &prop(&props, "rotation"))?;
    put_flag_if_present(&shape, &["TextFrame", "TextRange", "Font", "Bold"], &prop(&props, "bold"))?;
    put_flag_if_present(&shape, &["TextFrame", "TextRange", "Font", "Italic"], &prop(&props, "italic"))?;
    put_alignment(&shape, &props)?;
    put_margins(&shape, &props)?;
    let shadow = prop(&props, "shadow");
    if truthy(&shadow) {
        set_shadow(&shape, &shadow)?;
    }
    let name = prop(op, "name");
    if truthy(&name) {
        attempt(|| shape.set_member("Name", bstr(&text_of(&name))));
    }
    Ok(record(vec![
        ("op", Value::string("add_textbox")),
        ("changed", Value::Bool(true)),
        ("shape", Value::String(string_value(&shape.member("Name")?))),
    ]))
}

/// The portable writer's shape names (`GEOMETRY` of portable-slide-shapes.mjs) and the figure each draws.
const SHAPE_TYPES: [(&str, i32); 30] = [
    ("rectangle", 1),
    ("rect", 1),
    ("square", 1),
    ("parallelogram", 2),
    ("trapezoid", 3),
    ("diamond", 4),
    ("rounded_rectangle", 5),
    ("rounded_rect", 5),
    ("roundrect", 5),
    ("octagon", 6),
    ("triangle", 7),
    ("right_triangle", 8),
    ("oval", 9),
    ("ellipse", 9),
    ("circle", 9),
    ("hexagon", 10),
    ("can", 13),
    ("donut", 18),
    ("arrow", 33),
    ("right_arrow", 33),
    ("left_arrow", 34),
    ("up_arrow", 35),
    ("down_arrow", 36),
    ("pentagon", 51),
    ("chevron", 52),
    ("star", 92),
    ("callout", 105),
    ("plus", 163),
    ("minus", 164),
    ("cloud", 179),
];

fn shape_type_named(kind: &str) -> Option<i32> {
    SHAPE_TYPES.iter().find(|(name, _)| payload::names_equal(name, kind)).map(|(_, code)| *code)
}

/// `Use one of: ` and the names, `line` among them, in `Sort-Object` order.
fn shape_type_names() -> String {
    let mut names: Vec<Value> = SHAPE_TYPES.iter().map(|(name, _)| Value::string(name)).collect();
    names.push(Value::string("line"));
    collate::sort_values(&names, SortOptions::default()).iter().map(convert::to_ps_string).collect::<Vec<String>>().join(", ")
}

/// `([string]$shapeType).Trim().ToLowerInvariant() -replace '[\s-]+', '_'`.
fn shape_kind(shape_type: &Value) -> Result<String> {
    let lowered = text::to_lower_invariant(text_of(shape_type).trim());
    text::replace(&lowered, "[\\s-]+", "_", false).map_err(Error::host)
}

/// `add_shape`: a shape of the portable geometry names, with nothing drawn that was not asked for.
pub(crate) fn add_shape(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let shape_type_value = prop(op, "shapeType");
    let kind = shape_kind(&shape_type_value)?;
    let is_line = payload::names_equal(&kind, "line");
    let named_type = shape_type_named(&kind);
    if !is_line && named_type.is_none() && as_int_nonzero(&shape_type_value).is_none() {
        return Err(Error::host(format!("Unsupported shapeType: {}. Use one of: {}", text_of(&shape_type_value), shape_type_names())));
    }
    let left = box_value(op, "left", 72)?;
    let top = box_value(op, "top", 72)?;
    let width = box_value(op, "width", 180)?;
    let height = box_value(op, "height", 90)?;
    let (shape, shape_type) = if is_line {
        let line = slide.member("Shapes")?.call_member(
            "AddLine",
            &[r4(left), r4(top), Com::R8(f64::from(left) + f64::from(width)), Com::R8(f64::from(top) + f64::from(height))],
        )?;
        (line, 0)
    } else {
        let code = match (named_type, as_int_nonzero(&shape_type_value)) {
            (Some(code), _) => code,
            (None, Some(_)) => int(&shape_type_value)?,
            (None, None) => 1,
        };
        (slide.member("Shapes")?.call_member("AddShape", &[i4(code), r4(left), r4(top), r4(width), r4(height)])?, code)
    };
    let fill_color = operation_property(op, "fillColor", Value::Null);
    let line_color = operation_property(op, "lineColor", Value::Null);
    if truthy(&fill_color) && !is_line {
        put_path(&shape, &["Fill", "Visible"], boolean(true))?;
        put_path(&shape, &["Fill", "ForeColor", "RGB"], color(&fill_color)?)?;
    }
    if truthy(&line_color) {
        put_path(&shape, &["Line", "Visible"], boolean(true))?;
        put_path(&shape, &["Line", "ForeColor", "RGB"], color(&line_color)?)?;
    }
    // What the caller did not ask for is not drawn, as in the portable file: PowerPoint's own shape comes in the theme's
    // accent with a darker outline and white text, and on a light fill the words disappeared.
    if !is_line {
        if !truthy(&fill_color) {
            attempt(|| put_path(&shape, &["Fill", "Visible"], i4(0)));
        }
        if !truthy(&line_color) {
            attempt(|| put_path(&shape, &["Line", "Visible"], i4(0)));
        }
    }
    let fill_transparency = operation_property(op, "fillTransparency", Value::Null);
    if present(&fill_transparency) && !is_line {
        put_path(&shape, &["Fill", "Transparency"], percentage(&fill_transparency)?)?;
    }
    let line_transparency = operation_property(op, "lineTransparency", Value::Null);
    if present(&line_transparency) {
        put_path(&shape, &["Line", "Transparency"], percentage(&line_transparency)?)?;
    }
    let line_width = operation_property(op, "lineWidth", Value::Null);
    put_single_if_present(&shape, &["Line", "Weight"], &line_width)?;
    let rotation = operation_property(op, "rotation", Value::Null);
    if present(&rotation) && !is_line {
        shape.set_member("Rotation", r4(single(&rotation)?))?;
    }
    if !is_line {
        match paragraphs_of(op) {
            Some(paragraphs) => {
                set_paragraphs(&shape, &paragraphs)?;
            }
            None => {
                if has_property(op, "text") {
                    put_path(&shape, &["TextFrame", "TextRange", "Text"], bstr(&text_of(&prop(op, "text"))))?;
                }
            }
        }
    }
    let props = prop(op, "properties");
    // One try in the script: the first failure ends the whole block.
    attempt(|| {
        if !is_line && !truthy(&prop(&props, "color")) {
            // A paragraph that names its own colour keeps it, as in the portable file.
            let ink = color_text(&ink_on_fill(&text_of(&fill_color)))?;
            let specs: Vec<Value> = pipeline(&prop(op, "paragraphs")).into_iter().filter(present).collect();
            if specs.is_empty() {
                put_path(&shape, &["TextFrame", "TextRange", "Font", "Color", "RGB"], ink.clone())?;
            }
            for (at, spec) in specs.iter().enumerate() {
                if !truthy(&prop(spec, "color")) {
                    let paragraph = walk(&shape, &["TextFrame", "TextRange"])?.call_member("Paragraphs", &[i4(at as i32 + 1), i4(1)])?;
                    put_path(&paragraph, &["Font", "Color", "RGB"], ink.clone())?;
                }
            }
        }
        let font_name = prop(&props, "fontName");
        if truthy(&font_name) {
            set_font_name(&walk(&shape, &["TextFrame", "TextRange", "Font"])?, &text_of(&font_name))?;
        }
        let font_size = prop(&props, "fontSize");
        if truthy(&font_size) {
            put_path(&shape, &["TextFrame", "TextRange", "Font", "Size"], r4(single(&font_size)?))?;
        }
        let ink = prop(&props, "color");
        if truthy(&ink) {
            put_path(&shape, &["TextFrame", "TextRange", "Font", "Color", "RGB"], color(&ink)?)?;
        }
        put_flag_if_present(&shape, &["TextFrame", "TextRange", "Font", "Bold"], &prop(&props, "bold"))?;
        put_flag_if_present(&shape, &["TextFrame", "TextRange", "Font", "Italic"], &prop(&props, "italic"))?;
        put_alignment(&shape, &props)?;
        put_margins(&shape, &props)
    });
    let shadow = prop(&props, "shadow");
    if truthy(&shadow) {
        set_shadow(&shape, &shadow)?;
    }
    // The description set_shape writes, which the picture and contrast reviews read.
    let alt_text = prop(&props, "altText");
    if present(&alt_text) {
        shape.set_member("AlternativeText", bstr(&text_of(&alt_text)))?;
    }
    let name = prop(op, "name");
    if truthy(&name) {
        attempt(|| shape.set_member("Name", bstr(&text_of(&name))));
    }
    Ok(record(vec![
        ("op", Value::string("add_shape")),
        ("changed", Value::Bool(true)),
        ("shape", Value::String(string_value(&shape.member("Name")?))),
        ("shapeType", Value::Int(shape_type)),
    ]))
}

/// `set_shape`: placement, fill, outline, shadow and text face of a shape, from its `properties`. A colour named `null` takes
/// the fill or the outline away, and the percentages are percentages, as `add_shape` reads them.
pub(crate) fn set_shape(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let shape = shape_of(&slide, op)?;
    let props = prop(op, "properties");
    put_single_if_present(&shape, &["Left"], &prop(&props, "left"))?;
    put_single_if_present(&shape, &["Top"], &prop(&props, "top"))?;
    let width = prop(&props, "width");
    if truthy(&width) {
        shape.set_member("Width", r4(single(&width)?))?;
    }
    let height = prop(&props, "height");
    if truthy(&height) {
        shape.set_member("Height", r4(single(&height)?))?;
    }
    put_single_if_present(&shape, &["Rotation"], &prop(&props, "rotation"))?;
    let alt_text = prop(&props, "altText");
    if present(&alt_text) {
        shape.set_member("AlternativeText", bstr(&text_of(&alt_text)))?;
    }
    let fill_color = prop(&props, "fillColor");
    if has_property(&props, "fillColor") && !present(&fill_color) {
        put_path(&shape, &["Fill", "Visible"], i4(0))?;
    } else if truthy(&fill_color) {
        put_path(&shape, &["Fill", "Visible"], boolean(true))?;
        put_path(&shape, &["Fill", "ForeColor", "RGB"], color(&fill_color)?)?;
    }
    let fill_transparency = prop(&props, "fillTransparency");
    if present(&fill_transparency) {
        put_path(&shape, &["Fill", "Transparency"], percentage(&fill_transparency)?)?;
    }
    let line_color = prop(&props, "lineColor");
    if has_property(&props, "lineColor") && !present(&line_color) {
        put_path(&shape, &["Line", "Visible"], i4(0))?;
    } else if truthy(&line_color) {
        put_path(&shape, &["Line", "Visible"], boolean(true))?;
        put_path(&shape, &["Line", "ForeColor", "RGB"], color(&line_color)?)?;
    }
    let line_transparency = prop(&props, "lineTransparency");
    if present(&line_transparency) {
        put_path(&shape, &["Line", "Transparency"], percentage(&line_transparency)?)?;
    }
    put_single_if_present(&shape, &["Line", "Weight"], &prop(&props, "lineWidth"))?;
    let shadow = prop(&props, "shadow");
    if truthy(&shadow) {
        set_shadow(&shape, &shadow)?;
    }
    attempt(|| {
        put_margins(&shape, &props)?;
        put_alignment(&shape, &props)?;
        let font = walk(&shape, &["TextFrame", "TextRange", "Font"])?;
        let font_name = prop(&props, "fontName");
        if truthy(&font_name) {
            set_font_name(&font, &text_of(&font_name))?;
        }
        let font_size = prop(&props, "fontSize");
        if truthy(&font_size) {
            font.set_member("Size", r4(single(&font_size)?))?;
        }
        let bold = prop(&props, "bold");
        if present(&bold) {
            font.set_member("Bold", office_flag(truthy(&bold)))?;
        }
        let italic = prop(&props, "italic");
        if present(&italic) {
            font.set_member("Italic", office_flag(truthy(&italic)))?;
        }
        let ink = prop(&props, "color");
        if truthy(&ink) {
            walk(&font, &["Color"])?.set_member("RGB", color(&ink)?)?;
        }
        Ok(())
    });
    Ok(record(vec![
        ("op", Value::string("set_shape")),
        ("changed", Value::Bool(true)),
        ("shape", Value::String(string_value(&shape.member("Name")?))),
    ]))
}

/// `set_hyperlink`.
pub(crate) fn set_hyperlink(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let shape = shape_of(&slide, op)?;
    let link = shape.call_member("ActionSettings", &[i4(1)])?.member("Hyperlink")?;
    link.set_member("Address", bstr(&text_of(&prop(op, "address"))))?;
    link.set_member("SubAddress", bstr(&text_of(&prop(op, "subAddress"))))?;
    Ok(record(vec![
        ("op", Value::string("set_hyperlink")),
        ("changed", Value::Bool(true)),
        ("shape", Value::Int(int(&prop(op, "shape"))?)),
        ("address", Value::String(string_value(&link.member("Address")?))),
    ]))
}

/// `z_order`: `front`, `back`, `forward` or `backward`.
pub(crate) fn z_order(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let shape = shape_of(&slide, op)?;
    let command = text::to_lower_invariant(&text_of(&prop(op, "command")));
    let code = match command.as_str() {
        "front" => 0,
        "back" => 1,
        "forward" => 2,
        "backward" => 3,
        _ => return Err(Error::host("z_order command must be front, back, forward, or backward")),
    };
    shape.call_member("ZOrder", &[i4(code)])?;
    Ok(record(vec![
        ("op", Value::string("z_order")),
        ("changed", Value::Bool(true)),
        ("shape", Value::Int(int(&prop(op, "shape"))?)),
        ("command", Value::String(command)),
    ]))
}

/// `[object[]]@($op.shapes | ForEach-Object { [int]$_ })`: a `$null` piped to `ForEach-Object` runs it once, so no shapes are
/// one index 0, as `@($null)` is one item.
fn shape_indices(op: &Value) -> Result<Vec<i32>> {
    array_of(&prop(op, "shapes")).iter().map(int).collect()
}

fn index_array(indices: &[i32]) -> Com {
    Com::Array(SafeArray::one_d(0, indices.iter().map(|index| i4(*index)).collect()))
}

/// `align_shapes`.
pub(crate) fn align_shapes(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let command = text::to_lower_invariant(&text_of(&prop(op, "align")));
    let code = match command.as_str() {
        "left" => 0,
        "center" => 1,
        "right" => 2,
        "top" => 3,
        "middle" => 4,
        "bottom" => 5,
        _ => return Err(Error::host(format!("Unsupported shape alignment: {command}"))),
    };
    let indices = shape_indices(op)?;
    slide.member("Shapes")?.call_member("Range", &[index_array(&indices)])?.call_member("Align", &[i4(code), boolean(truthy(&prop(op, "relativeToSlide")))])?;
    Ok(record(vec![
        ("op", Value::string("align_shapes")),
        ("changed", Value::Bool(true)),
        ("shapes", Value::Array(array_of(&prop(op, "shapes")))),
        ("align", Value::String(command)),
    ]))
}

/// `distribute_shapes`.
pub(crate) fn distribute_shapes(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let command = text::to_lower_invariant(&text_of(&prop(op, "direction")));
    let code = match command.as_str() {
        "horizontal" => 0,
        "vertical" => 1,
        _ => return Err(Error::host(format!("Unsupported shape distribution: {command}"))),
    };
    let indices = shape_indices(op)?;
    slide
        .member("Shapes")?
        .call_member("Range", &[index_array(&indices)])?
        .call_member("Distribute", &[i4(code), boolean(truthy(&prop(op, "relativeToSlide")))])?;
    Ok(record(vec![
        ("op", Value::string("distribute_shapes")),
        ("changed", Value::Bool(true)),
        ("shapes", Value::Array(array_of(&prop(op, "shapes")))),
        ("direction", Value::String(command)),
    ]))
}

/// `group_shapes`.
pub(crate) fn group_shapes(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let indices = shape_indices(op)?;
    if indices.len() < 2 {
        return Err(Error::host("group_shapes requires at least two shape indexes"));
    }
    let shape = slide.member("Shapes")?.call_member("Range", &[index_array(&indices)])?.call_member("Group", &[])?;
    Ok(record(vec![
        ("op", Value::string("group_shapes")),
        ("changed", Value::Bool(true)),
        ("shape", Value::Int(int_value(&shape.member("ZOrderPosition")?)?)),
        ("name", Value::String(string_value(&shape.member("Name")?))),
    ]))
}

/// `ungroup_shape`.
pub(crate) fn ungroup_shape(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let shape = shape_of(&slide, op)?;
    let released = shape.call_member("Ungroup", &[])?;
    Ok(record(vec![
        ("op", Value::string("ungroup_shape")),
        ("changed", Value::Bool(true)),
        ("count", Value::Int(int_value(&released.member("Count")?)?)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_unit_is_held_between_zero_and_one_without_rounding_a_fraction() {
        assert_eq!(clamp_unit(0.5), 0.5);
        assert_eq!(clamp_unit(0.7), 0.7);
        assert_eq!(clamp_unit(-3.0), 0.0);
        assert_eq!(clamp_unit(9.0), 1.0);
    }

    #[test]
    fn ink_on_a_fill_is_white_on_dark_and_near_black_on_light_or_unreadable() {
        assert_eq!(ink_on_fill("0B5FFF"), "FFFFFF");
        assert_eq!(ink_on_fill("#101010"), "FFFFFF");
        assert_eq!(ink_on_fill("FFFFFF"), "1F2429");
        assert_eq!(ink_on_fill(""), "1F2429");
        assert_eq!(ink_on_fill("12345"), "1F2429");
    }

    #[test]
    fn quiet_ink_takes_the_first_step_of_its_ladder_that_clears_the_contrast() {
        assert_eq!(quiet_ink("FFFFFF"), "6A7179");
        assert_eq!(quiet_ink("#000000"), "A9B1B9");
        assert_eq!(quiet_ink(""), "6A7179");
        assert_eq!(quiet_ink("nonsense"), "6A7179");
        // A mid grey no step clears: the darkest ink on a light field, white on a dark one.
        assert_eq!(quiet_ink("808080"), "FFFFFF");
    }

    #[test]
    fn shape_indexes_are_cast_one_by_one_and_no_shapes_is_one_index_zero() {
        let op = |text: &str| crate::ps::payload::parse_payload(text).unwrap();
        assert_eq!(shape_indices(&op("{\"shapes\":[2,\"3\"]}")).unwrap(), vec![2, 3]);
        assert_eq!(shape_indices(&op("{\"shapes\":4}")).unwrap(), vec![4]);
        assert_eq!(shape_indices(&op("{}")).unwrap(), vec![0]);
        assert!(shape_indices(&op("{\"shapes\":[]}")).unwrap().is_empty());
    }

    #[test]
    fn the_shape_names_resolve_to_the_portable_figures_and_the_refusal_lists_line() {
        assert_eq!(shape_type_named("RoundRect"), Some(5));
        assert_eq!(shape_type_named("pentagon"), Some(51));
        assert_eq!(shape_type_named("blob"), None);
        assert!(shape_type_names().split(", ").any(|name| name == "line"));
        assert_eq!(shape_type_names().split(", ").count(), 31);
        assert_eq!(shape_kind(&Value::string("  Rounded Rectangle ")).unwrap(), "rounded_rectangle");
        assert_eq!(shape_kind(&Value::string("right-arrow")).unwrap(), "right_arrow");
    }
}
