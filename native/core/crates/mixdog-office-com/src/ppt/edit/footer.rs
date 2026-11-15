//! The footer and the slide number: `Set-PowerPointFooterFace`, `set_footer` and `set_slide_number`.

use crate::com::Result;
use crate::com::Value as Com;
use crate::ppt::long_cast;
use crate::ps::Value;
use crate::ps::convert::color_hex;

use super::attempt;
use super::bstr;
use super::color_text;
use super::i4;
use super::int_value;
use super::items;
use super::office_flag;
use super::prop;
use super::put_path;
use super::r4;
use super::record;
use super::shapes::quiet_ink;
use super::single_value;
use super::slide_of;
use super::text_of;
use super::truthy;
use super::walk;

/// The colour of a slide's own background, as `RRGGBB`, when it is one solid colour (`$field` of the script), else nothing.
fn background_field(slide: &Com) -> Result<String> {
    let fill = slide.member("Background")?.member("Fill")?;
    if int_value(&fill.member("Type")?)? == 1 {
        Ok(color_hex(long_cast(&fill.member("ForeColor")?.member("RGB")?)?))
    } else {
        Ok(String::new())
    }
}

/// `Set-PowerPointFooterFace`: a footer or page number as the portable writer sets it, 10 pt in the quiet ink, the footer from
/// the left margin and the number at the right, 40 pt above the foot. PowerPoint's own placeholders kept the theme's 12 pt
/// grey, 3.2:1 on a dark slide background. Singles throughout: a double after a single is a cast the binder refuses.
pub(crate) fn set_footer_face(slide: &Com, footer: bool) -> Result<()> {
    let setup = slide.member("Parent")?.member("PageSetup")?;
    let width = single_value(&setup.member("SlideWidth")?)?;
    let height = single_value(&setup.member("SlideHeight")?)?;
    let field = background_field(slide)?;
    let ink = quiet_ink(&field);
    // ppPlaceholderFooter, ppPlaceholderSlideNumber
    let kind = if footer { 15 } else { 13 };
    for shape in items(&slide.member("Shapes")?)? {
        if int_value(&shape.member("Type")?)? != 14 || int_value(&walk(&shape, &["PlaceholderFormat", "Type"])?)? != kind {
            continue;
        }
        let left = if footer { 58.0 } else { f64::from(width) - 158.0 };
        shape.set_member("Left", r4(left as f32))?;
        shape.set_member("Top", r4((f64::from(height) - 40.0) as f32))?;
        let box_width = if footer { f64::from(width) - 240.0 } else { 100.0 };
        shape.set_member("Width", r4(box_width as f32))?;
        shape.set_member("Height", r4(24.0))?;
        put_path(&shape, &["TextFrame", "VerticalAnchor"], i4(3))?;
        let range = walk(&shape, &["TextFrame", "TextRange"])?;
        put_path(&range, &["Font", "Size"], r4(10.0))?;
        put_path(&range, &["Font", "Color", "RGB"], color_text(&ink)?)?;
        put_path(&range, &["ParagraphFormat", "Alignment"], i4(if footer { 1 } else { 3 }))?;
    }
    Ok(())
}

/// The footer the layout has a placeholder for, shown with its text and the quiet face.
fn placeholder_footer(slide: &Com, op: &Value) -> Result<()> {
    put_path(slide, &["HeadersFooters", "Footer", "Visible"], i4(-1))?;
    put_path(slide, &["HeadersFooters", "Footer", "Text"], bstr(&text_of(&prop(op, "text"))))?;
    set_footer_face(slide, true)
}

/// A layout with no footer placeholder refuses `HeadersFooters` ("Invalid request"), where the portable writer places the
/// footer itself: a quiet 10 pt line along the bottom edge, 58 pt in, 24 pt tall.
fn textbox_footer(presentation: &Com, slide: &Com, op: &Value) -> Result<()> {
    let width = single_value(&walk(presentation, &["PageSetup", "SlideWidth"])?)?;
    let height = single_value(&walk(presentation, &["PageSetup", "SlideHeight"])?)?;
    let band = slide.member("Shapes")?.call_member(
        "AddTextbox",
        &[i4(1), r4(58.0), Com::R8(f64::from(height) - 40.0), Com::R8(f64::from(width) - 240.0), r4(24.0)],
    )?;
    walk(&band, &["TextFrame", "TextRange"])?.set_member("Text", bstr(&text_of(&prop(op, "text"))))?;
    put_path(&band, &["TextFrame", "TextRange", "Font", "Size"], i4(10))?;
    put_path(&band, &["TextFrame", "VerticalAnchor"], i4(3))?;
    put_path(&band, &["TextFrame", "WordWrap"], i4(-1))?;
    // A text box shrinks to its line unless told not to; the footer keeps the 24 pt band.
    put_path(&band, &["TextFrame", "AutoSize"], i4(0))?;
    band.set_member("Height", r4(24.0))?;
    let field = background_field(slide)?;
    put_path(&band, &["TextFrame", "TextRange", "Font", "Color", "RGB"], color_text(&quiet_ink(&field))?)
}

/// `set_footer`.
pub(crate) fn set_footer(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let mut placed_by_layout = false;
    attempt(|| {
        placeholder_footer(&slide, op)?;
        placed_by_layout = true;
        Ok(())
    });
    if placed_by_layout {
        return Ok(record(vec![("op", Value::string("set_footer")), ("changed", Value::Bool(true))]));
    }
    textbox_footer(presentation, &slide, op)?;
    Ok(record(vec![("op", Value::string("set_footer")), ("changed", Value::Bool(true)), ("placed", Value::string("textbox"))]))
}

/// `set_slide_number`.
pub(crate) fn set_slide_number(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let visible = truthy(&prop(op, "visible"));
    put_path(&slide, &["HeadersFooters", "SlideNumber", "Visible"], office_flag(visible))?;
    if visible {
        set_footer_face(&slide, false)?;
    }
    Ok(record(vec![
        ("op", Value::string("set_slide_number")),
        ("changed", Value::Bool(true)),
        ("visible", Value::Bool(visible)),
    ]))
}
