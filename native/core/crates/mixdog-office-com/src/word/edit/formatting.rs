//! `office-word-formatting.ps1`, `Set-WordTabStops`, `Word-StyleValue` and `Set-WordStyle`: the run, paragraph and border
//! formatting every Word operation shares. Each property is set through the object the script set it through (one `Font`
//! object serves a whole run format), in the script's order.

use super::Com;
use super::Para;
use super::Value;
use super::cast_double;
use super::cast_single;
use super::color_of;
use super::flag;
use super::lower;
use super::prop;
use super::r4;
use super::same;
use super::text_of;
use super::truthy;
use crate::com::Result;
use crate::ps::convert;

/// The widths Word's own lines come in, in eighths of a point.
const LINE_WIDTHS: [i32; 9] = [2, 4, 6, 8, 12, 18, 24, 36, 48];

/// `Set-WordLatinFont`: the Latin face alone, through `NameAscii` and `NameOther`.
pub(super) fn set_latin_font(font: &Com, name: &str) -> Result<()> {
    font.set_member("NameAscii", Com::from(name))?;
    font.set_member("NameOther", Com::from(name))
}

/// `Set-WordRunFormat`: points, with independent script fonts, through one `Font` object.
pub(super) fn set_run_format(range: &Com, props: &Value) -> Result<()> {
    let font = range.member("Font")?;
    let name = prop(props, "name");
    if truthy(&name) {
        set_latin_font(&font, &text_of(&name))?;
    }
    let east_asian = prop(props, "nameEastAsia");
    if truthy(&east_asian) {
        font.set_member("NameFarEast", Com::from(text_of(&east_asian)))?;
    }
    let size = prop(props, "size");
    if truthy(&size) {
        font.set_member("Size", r4(&size)?)?;
    }
    for (key, member, on) in [("bold", "Bold", -1), ("italic", "Italic", -1), ("underline", "Underline", 1), ("hidden", "Hidden", -1)] {
        let value = prop(props, key);
        if !value.is_null() {
            font.set_member(member, flag(&value, on))?;
        }
    }
    let color = prop(props, "color");
    if truthy(&color) {
        font.set_member("Color", color_of(&color)?)?;
    }
    Ok(())
}

/// The distance from each border side the portable writer's `w:space` sets.
fn distance_member(side: &str) -> &'static str {
    match lower(side).as_str() {
        "top" => "DistanceFromTop",
        "left" => "DistanceFromLeft",
        "right" => "DistanceFromRight",
        _ => "DistanceFromBottom",
    }
}

/// `Set-WordParagraphBorder`: side indexes, the line the portable writer draws, widths snapped to Word's own, the gap to the
/// text in points.
pub(super) fn set_paragraph_border(paragraph: &Para, spec: &Value) -> Result<()> {
    let side = text_of(&prop(spec, "side"));
    let side_index = match lower(&side).as_str() {
        "top" => -1,
        "left" => -2,
        "right" => -4,
        _ => -3,
    };
    let border = super::item(&paragraph.borders()?, side_index)?;
    let line_style = match lower(&text_of(&prop(spec, "style"))).as_str() {
        "dashed" | "dash" => 3,
        "dotted" | "dot" => 2,
        "double" => 7,
        _ => 1,
    };
    border.set_member("LineStyle", Com::I4(line_style))?;
    let size = prop(spec, "size");
    if truthy(&size) {
        let size = cast_double(&size)?;
        let mut nearest = LINE_WIDTHS[0];
        for width in LINE_WIDTHS {
            if (f64::from(width) - size).abs() < (f64::from(nearest) - size).abs() {
                nearest = width;
            }
        }
        border.set_member("LineWidth", Com::I4(nearest))?;
    }
    let color = prop(spec, "color");
    if truthy(&color) {
        border.set_member("Color", color_of(&color)?)?;
    }
    let space = prop(spec, "space");
    if !space.is_null() && !convert::to_ps_string(&space).is_empty() {
        let gap = cast_single(&space)?;
        paragraph.borders()?.set_member(distance_member(&side), Com::R4(gap))?;
    }
    Ok(())
}

/// `Word-ParagraphAlignment`: centre, both and distribute as well as the Word names.
pub(super) fn paragraph_alignment(alignment: &Value) -> i32 {
    match lower(&text_of(alignment)).as_str() {
        "center" | "centre" => 1,
        "right" => 2,
        "justify" | "both" => 3,
        "distribute" => 4,
        _ => 0,
    }
}

/// `Set-WordParagraphFlow`: spacing, line spacing (rules 3 and 4), keep and break flags, indents, and the paragraph's field.
pub(super) fn set_paragraph_flow(format: &Com, props: &Value) -> Result<()> {
    for (key, member) in [("spacingBefore", "SpaceBefore"), ("spacingAfter", "SpaceAfter")] {
        let value = prop(props, key);
        if !value.is_null() {
            format.set_member(member, r4(&value)?)?;
        }
    }
    let line_spacing = prop(props, "lineSpacing");
    if !line_spacing.is_null() {
        // A minimum (wdLineSpaceAtLeast, 3) unless lineSpacingRule:'exact' holds the line at it (wdLineSpaceExactly, 4).
        let rule = if same(&lower(&text_of(&prop(props, "lineSpacingRule"))), "exact") { 4 } else { 3 };
        format.set_member("LineSpacingRule", Com::I4(rule))?;
        format.set_member("LineSpacing", r4(&line_spacing)?)?;
    }
    for (key, member) in
        [("keepWithNext", "KeepWithNext"), ("keepTogether", "KeepTogether"), ("widowControl", "WidowControl"), ("pageBreakBefore", "PageBreakBefore")]
    {
        let value = prop(props, key);
        if !value.is_null() {
            format.set_member(member, flag(&value, -1))?;
        }
    }
    for (key, member) in [("indentLeft", "LeftIndent"), ("indentRight", "RightIndent"), ("indentFirstLine", "FirstLineIndent")] {
        let value = prop(props, key);
        if !value.is_null() {
            format.set_member(member, r4(&value)?)?;
        }
    }
    let shading = prop(props, "shading");
    if truthy(&shading) {
        format.member("Shading")?.set_member("BackgroundPatternColor", color_of(&shading)?)?;
    }
    Ok(())
}

/// `Set-WordListItemInset`: indentLeft places the mark of an item this call puts in a list and the text hangs one list step
/// (18 pt) after it; an indentFirstLine given with it stands.
pub(super) fn set_list_item_inset(format: &Com, props: &Value) -> Result<()> {
    let kind = prop(props, "listKind");
    if !truthy(&kind) || same(&lower(&text_of(&kind)), "none") {
        return Ok(());
    }
    let left = prop(props, "indentLeft");
    if left.is_null() || !prop(props, "indentFirstLine").is_null() {
        return Ok(());
    }
    format.set_member("LeftIndent", Com::R4(cast_single(&left)? + 18.0))?;
    format.set_member("FirstLineIndent", Com::I4(-18))
}

/// A line's alignment name (left, center or centre, right, justify) or the refusal that names the operation's field.
pub(super) fn line_alignment(name: &Value, refusal: &str) -> Result<i32> {
    Ok(match lower(&text_of(name)).as_str() {
        "center" | "centre" => 1,
        "right" => 2,
        "justify" => 3,
        "left" => 0,
        _ => return Err(crate::com::Error::host(format!("{refusal} must be left, center, right, or justify, not {}", text_of(name)))),
    })
}

/// `Set-WordTabStops`: the stops replace the paragraph's own.
pub(super) fn set_tab_stops(format: &Com, props: &Value) -> Result<()> {
    let stops = prop(props, "tabStops");
    if !truthy(&stops) {
        return Ok(());
    }
    format.member("TabStops")?.call_member("ClearAll", &[])?;
    for tab in crate::ps::pipeline_items(&stops) {
        let alignment = match lower(&text_of(&prop(&tab, "alignment"))).as_str() {
            "center" => 1,
            "right" => 2,
            "decimal" => 3,
            "bar" => 4,
            _ => 0,
        };
        let leader = match lower(&text_of(&prop(&tab, "leader"))).as_str() {
            "dot" | "dots" | "dotted" => 1,
            "dash" | "hyphen" => 2,
            "line" | "underscore" => 3,
            "heavy" => 4,
            "middledot" => 5,
            _ => 0,
        };
        let position = cast_single(&prop(&tab, "position"))?;
        format.member("TabStops")?.call_member("Add", &[Com::R4(position), Com::I4(alignment), Com::I4(leader)])?;
    }
    Ok(())
}

/// What `Word-StyleValue` answers: the built-in style's id, or the name as it came.
pub(super) enum StyleValue {
    Id(i32),
    Name(String),
}

impl StyleValue {
    /// `(Word-StyleValue $name) -ne -1`, false: the style is Normal (by id, or a name that reads as that number).
    pub(super) fn is_normal(&self) -> bool {
        match self {
            StyleValue::Id(id) => *id == -1,
            StyleValue::Name(name) => name == "-1",
        }
    }

    pub(super) fn into_com(self) -> Com {
        match self {
            StyleValue::Id(id) => Com::I4(id),
            StyleValue::Name(name) => Com::from(name),
        }
    }
}

/// `Word-StyleValue`: built-in styles go by their id, so a Korean Word that names Quote "인용" still finds it.
pub(super) fn style_value(name: &str) -> StyleValue {
    let key = lower(&name.replace([' ', '-'], ""));
    let id = match key.as_str() {
        "quote" => -181,
        "intensequote" => -182,
        "normal" => -1,
        "heading1" => -2,
        "heading2" => -3,
        "heading3" => -4,
        "heading4" => -5,
        "heading5" => -6,
        "heading6" => -7,
        "heading7" => -8,
        "heading8" => -9,
        "heading9" => -10,
        "title" => -63,
        "subtitle" => -75,
        "tablegrid" => -155,
        "caption" => -35,
        "listparagraph" => -180,
        "listbullet" => -49,
        "listbullet2" => -55,
        "listbullet3" => -56,
        "listnumber" => -50,
        "listnumber2" => -59,
        "listnumber3" => -60,
        "nospacing" => -158,
        "bodytext" => -67,
        "footnotetext" => -30,
        "endnotetext" => -44,
        "header" => -32,
        "footer" => -33,
        "tocheading" => -267,
        "toc1" => -20,
        "toc2" => -21,
        "toc3" => -22,
        "hyperlink" => -86,
        "strong" => -88,
        "emphasis" => -89,
        "subtleemphasis" => -261,
        "intenseemphasis" => -262,
        "booktitle" => -265,
        "blocktext" => -85,
        "plaintext" => -91,
        _ => return StyleValue::Name(name.to_owned()),
    };
    StyleValue::Id(id)
}

/// `Set-WordStyle`: a named style set on a range or a table; a name the document does not hold leaves the formatting as it
/// was and is returned for the result to report.
pub(super) fn set_style(target: &Com, name: &str) -> Option<String> {
    match target.set_member("Style", style_value(name).into_com()) {
        Ok(()) => None,
        Err(_) => Some(name.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_built_in_style_goes_by_its_id_whatever_its_spelling() {
        assert!(matches!(style_value("Heading 1"), StyleValue::Id(-2)));
        assert!(matches!(style_value("list-bullet 2"), StyleValue::Id(-55)));
        assert!(matches!(style_value("Brand Table"), StyleValue::Name(name) if name == "Brand Table"));
        assert!(style_value("NORMAL").is_normal());
    }

    #[test]
    fn alignment_knows_the_portable_writers_names() {
        for (name, code) in [("centre", 1), ("Center", 1), ("right", 2), ("both", 3), ("justify", 3), ("distribute", 4), ("left", 0), ("", 0)] {
            assert_eq!(paragraph_alignment(&Value::string(name)), code, "{name}");
        }
    }
}
