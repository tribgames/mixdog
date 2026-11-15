//! `Create-OwnedDocument`: a new document saved at its path, with the portable template's defaults where Office's own
//! template (a Korean Word's, for one) differs from them, so a document made through Word lays out as the portable
//! writer's does. Every default is set inside its own ignored failure; a later step that fails closes the new document.

use crate::com::Error;
use crate::com::Obj;
use crate::com::Result;
use crate::com::Value;
use crate::office::close_office_document;
use crate::office::item_of;
use crate::office::save_format_for_path;
use crate::office::set_office_visible;
use crate::office::text_of;

/// wdStyleNormal.
const STYLE_NORMAL: i32 = -1;
/// wdStyleTitle.
const STYLE_TITLE: i32 = -63;
/// wdStyleSubtitle.
const STYLE_SUBTITLE: i32 = -75;
/// wdStyleHeading1..4 with their size and the space before in points (the space after is 6 for all).
const HEADINGS: [(i32, i32, i32); 4] = [(-2, 16, 12), (-3, 14, 10), (-4, 13, 8), (-5, 12, 8)];
/// wdLineSpaceMultiple.
const LINE_SPACE_MULTIPLE: i32 = 5;
/// wdDontBalanceSingleByteDoubleByteWidth.
const DONT_BALANCE_WIDTHS: i32 = 16;
/// The portable page: 25 mm margins, the header and footer 12.5 mm in.
const MARGIN_POINTS: f32 = 70.9;
const HEADER_FOOTER_POINTS: f32 = 35.45;

/// `$document.Styles.Item(id)`.
fn style(document: &Obj, id: i32) -> Result<Value> {
    item_of(&document.get("Styles")?, id)
}

fn paragraph_format(document: &Obj, id: i32) -> Result<Value> {
    style(document, id)?.member("ParagraphFormat")
}

/// A Word document's defaults, as the portable template writes them.
fn apply_word_defaults(document: &Obj) -> Result<()> {
    // A Hangul word stays whole at the line end: Korean Word's Normal style ships with WordWrap off.
    let _ = paragraph_format(document, STYLE_NORMAL).and_then(|format| format.set_member("WordWrap", Value::Bool(true)));
    // Normal as the portable template writes it: 1.08 lines (259/240) and widow control on.
    let _ = (|| -> Result<()> {
        let normal = paragraph_format(document, STYLE_NORMAL)?;
        normal.set_member("LineSpacingRule", Value::I4(LINE_SPACE_MULTIPLE))?;
        normal.set_member("LineSpacing", Value::R4((12.0_f64 * 259.0 / 240.0) as f32))?;
        normal.set_member("WidowControl", Value::Bool(true))
    })();
    // Title and Subtitle flush left.
    let _ = paragraph_format(document, STYLE_TITLE).and_then(|format| format.set_member("Alignment", Value::I4(0)));
    let _ = paragraph_format(document, STYLE_SUBTITLE).and_then(|format| format.set_member("Alignment", Value::I4(0)));
    // The portable page's margins and header and footer distances.
    let _ = (|| -> Result<()> {
        let setup = document.get("PageSetup")?;
        for name in ["TopMargin", "BottomMargin", "LeftMargin", "RightMargin"] {
            setup.set_member(name, Value::R4(MARGIN_POINTS))?;
        }
        setup.set_member("HeaderDistance", Value::R4(HEADER_FOOTER_POINTS))?;
        setup.set_member("FooterDistance", Value::R4(HEADER_FOOTER_POINTS))
    })();
    let body_font = style(document, STYLE_NORMAL)?.member("Font")?;
    // Headings take the body face, bold, at 16 / 14 / 13 / 12 pt with 12 / 10 / 8 / 8 pt before and 6 pt after.
    for (id, size, before) in HEADINGS {
        let _ = (|| -> Result<()> {
            let heading = style(document, id)?;
            for name in ["Name", "NameFarEast"] {
                let font = heading.member("Font")?;
                font.set_member(name, Value::Str(text_of(&body_font.member(name)?)))?;
            }
            heading.member("Font")?.set_member("Bold", Value::Bool(true))?;
            heading.member("Font")?.set_member("Size", Value::I4(size))?;
            heading.member("ParagraphFormat")?.set_member("SpaceBefore", Value::I4(before))?;
            heading.member("ParagraphFormat")?.set_member("SpaceAfter", Value::I4(6))
        })();
    }
    // Korean Word balances single-byte against double-byte widths, which sets every space between Hangul words half a
    // Hangul wide; the portable template does not.
    let _ = document.put_with("Compatibility", &[Value::I4(DONT_BALANCE_WIDTHS)], Value::Bool(true));
    Ok(())
}

fn document_of(value: Value) -> Result<Obj> {
    value.into_obj().ok_or_else(|| Error::host("Microsoft Office did not answer a document."))
}

/// The steps of the creation; the document is handed out as soon as it exists so a failing step can close it.
fn build(app: &Obj, format: &str, path: &str, visible: bool, created: &mut Option<Obj>) -> Result<()> {
    let save_format = save_format_for_path(format, path).map_or(Value::Null, Value::I4);
    let save_arguments = [Value::from(path), save_format];
    match format {
        "docx" => {
            let document = document_of(app.get("Documents")?.call_member("Add", &[])?)?;
            *created = Some(document.clone());
            apply_word_defaults(&document)?;
            if document.call("SaveAs2", &save_arguments).is_err() {
                document.call("SaveAs", &save_arguments)?;
            }
        }
        "xlsx" => {
            let document = document_of(app.get("Workbooks")?.call_member("Add", &[])?)?;
            *created = Some(document.clone());
            document.call("SaveAs", &save_arguments)?;
        }
        "pptx" => {
            let document = document_of(app.get("Presentations")?.call_member("Add", &[Value::Bool(visible)])?)?;
            *created = Some(document.clone());
            document.call("SaveAs", &save_arguments)?;
        }
        _ => {}
    }
    if visible && let Some(document) = created.as_ref() {
        set_office_visible(Some(app), document, format);
    }
    Ok(())
}

/// `Create-OwnedDocument`: a failure is the text of the error, extended with what the cleanup of the half-made document
/// said when it failed too.
pub fn create_owned_document(app: &Obj, format: &str, path: &str, visible: bool) -> std::result::Result<Obj, String> {
    let mut created: Option<Obj> = None;
    match build(app, format, path, visible, &mut created) {
        Ok(()) => created.ok_or_else(|| format!("Unsupported Office session format: {format}")),
        Err(error) => {
            let mut message = error.message().to_owned();
            if let Some(document) = created
                && let Err(cleanup) = close_office_document(&document, format)
            {
                message.push_str(&format!("; document cleanup failed: {}", cleanup.message()));
            }
            Err(message)
        }
    }
}
