//! Text extraction from the content streams of a page: pdf.js 6.4's `getTextContent` with its default options.
//! [`Page::text_content`] returns the page's text items (`str`, `dir`, `transform`, `width`, `height`, `fontName`,
//! `hasEOL`) and the styles of the fonts that showed text, exactly as `page.getTextContent()` does.
//!
//! `operators` reads the content stream (the operator table and the tolerance of bad operands), `state` holds the
//! text state, `evaluator` runs the operators (fonts through the document's [`FontLoader`], form XObjects,
//! `ExtGState` fonts) and `builder` is pdf.js's item builder.

use std::sync::Arc;

use crate::document::Document;
use crate::error::Result;
use crate::fonts::data::BidiDir;
use crate::fonts::font::FontLoader;
use crate::object::{Dict, Obj};
use crate::oplist::gstate::Matrix;
use crate::page::Page;

pub mod builder;
pub mod evaluator;
pub mod operators;
pub mod state;

/// One text item of a page (`TextItem`).
#[derive(Debug, Clone, PartialEq)]
pub struct TextItem {
    /// `str`, as UTF-16 code units (pdf.js's strings are, and the reordering of right-to-left text can leave a
    /// surrogate without its pair).
    pub units: Vec<u16>,
    pub dir: BidiDir,
    pub width: f64,
    pub height: f64,
    pub transform: Matrix,
    /// `fontName`: the loaded name of the font ([`TextContent::styles`] is keyed by it).
    pub font_name: Option<String>,
    pub has_eol: bool,
}

impl TextItem {
    /// `str` as a string (a lone surrogate becomes U+FFFD).
    pub fn text(&self) -> String {
        String::from_utf16_lossy(&self.units)
    }
}

/// The style of a font that showed text (`styles[loadedName]`).
#[derive(Debug, Clone, PartialEq)]
pub struct TextStyle {
    pub font_family: String,
    /// `NaN` where neither the font nor the standard metrics have one (JSON writes it `null`).
    pub ascent: f64,
    pub descent: f64,
    pub vertical: bool,
}

/// What `getTextContent` returns: the items in order and the styles in the order the fonts first showed text.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TextContent {
    pub items: Vec<TextItem>,
    pub styles: Vec<(String, TextStyle)>,
}

/// The fonts of a document for the text reader: pdf.js's per-document font cache and font ids (`g_d0_f1`, ...),
/// honouring the document's `ignore_errors`. One loader serves every page of the document, so a font that several
/// pages use is made once.
pub fn font_loader(document: &Document) -> FontLoader {
    FontLoader::new(document.doc_id(), document.options().ignore_errors)
        .with_system_fonts(document.options().use_system_fonts)
}

impl Page {
    /// `page.getTextContent()`. The cancellation check and the budget are the document's (`OpenOptions`); a failure
    /// inside the content stream ends the stream and keeps the items read so far when the document's
    /// `ignore_errors` is set, and is returned otherwise.
    pub fn text_content(&self, document: &Document, fonts: &FontLoader) -> Result<TextContent> {
        document.guard().check_now()?;
        let content = self.content(document)?;
        let resources = merged_resources(document, self)?;
        let mut text = TextContent::default();
        evaluator::Evaluator::new(document, fonts, self.view).get_text_content(
            content,
            None,
            &resources,
            state::StateManager::new(state::TextState::new()),
            &[],
            &mut text,
            0,
        )?;
        Ok(text)
    }
}

/// `Page.#getMergedResources`: when `/Contents` is one stream with a non-empty `/Resources` of its own, that
/// dictionary is merged over the page's (its entries first, sub-dictionaries merged key by key); otherwise the
/// page's resources.
fn merged_resources(document: &Document, page: &Page) -> Result<Arc<Dict>> {
    let xref = document.xref();
    let page_resources = page.resources(document)?;
    let Obj::Stream(stream) = xref.get(&page.dict, "Contents")? else {
        return Ok(page_resources);
    };
    let local = match xref.get(&stream.dict, "Resources")? {
        Obj::Dict(local) if !local.is_empty() => local,
        _ => return Ok(page_resources),
    };
    let merged = Dict::merge(&[Obj::Dict(local), Obj::Dict(page_resources)], true);
    Ok(Arc::new(merged.unwrap_or_default()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::OpenOptions;

    fn build(objects: &[(u32, Vec<u8>)]) -> Vec<u8> {
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (number, body) in objects {
            offsets.push((*number, pdf.len()));
            pdf.extend_from_slice(format!("{number} 0 obj\n").as_bytes());
            pdf.extend_from_slice(body);
            pdf.extend_from_slice(b"\nendobj\n");
        }
        let start = pdf.len();
        let size = objects.iter().map(|(n, _)| *n).max().unwrap_or(0) + 1;
        pdf.extend_from_slice(format!("xref\n0 {size}\n0000000000 65535 f \n").as_bytes());
        for number in 1..size {
            match offsets.iter().find(|(n, _)| *n == number) {
                Some((_, at)) => pdf.extend_from_slice(format!("{at:010} 00000 n \n").as_bytes()),
                None => pdf.extend_from_slice(b"0000000000 65535 f \n"),
            }
        }
        pdf.extend_from_slice(
            format!("trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n")
                .as_bytes(),
        );
        pdf
    }

    fn stream(dict: &str, content: &str) -> Vec<u8> {
        format!(
            "<< {dict} /Length {} >>\nstream\n{content}\nendstream",
            content.len()
        )
        .into_bytes()
    }

    /// A one-page document: Helvetica as object 5, `content` as the page's stream, extra objects from 6 on.
    fn text_of(content: &str, extra: &[(u32, Vec<u8>)], resources: &str) -> TextContent {
        let mut objects: Vec<(u32, Vec<u8>)> = vec![
            (1, b"<< /Type /Catalog /Pages 2 0 R >>".to_vec()),
            (2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec()),
            (
                3,
                format!(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources {resources} >>"
                )
                .into_bytes(),
            ),
            (4, stream("", content)),
            (
                5,
                b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
                    .to_vec(),
            ),
        ];
        objects.extend(extra.iter().cloned());
        let document =
            Document::open(build(&objects), &OpenOptions::default()).expect("a document");
        let fonts = font_loader(&document);
        document
            .page(0)
            .expect("a page")
            .text_content(&document, &fonts)
            .expect("the text")
    }

    const RESOURCES: &str = "<< /Font << /F1 5 0 R >> >>";

    fn strings(text: &TextContent) -> Vec<String> {
        text.items.iter().map(TextItem::text).collect()
    }

    #[test]
    fn a_line_of_text_is_one_item_with_its_font_style() {
        let text = text_of("BT /F1 12 Tf 20 100 Td (Hello world) Tj ET", &[], RESOURCES);
        assert_eq!(text.items.len(), 1);
        let item = &text.items[0];
        assert_eq!(item.text(), "Hello world");
        assert_eq!(item.dir, BidiDir::Ltr);
        assert_eq!(item.transform, [12.0, 0.0, 0.0, 12.0, 20.0, 100.0]);
        assert_eq!(item.height, 12.0);
        assert!(item.width > 40.0);
        assert!(!item.has_eol);
        assert_eq!(text.styles.len(), 1);
        assert_eq!(Some(&text.styles[0].0), item.font_name.as_ref());
        assert!(!text.styles[0].1.vertical);
    }

    #[test]
    fn a_move_to_the_next_line_ends_the_item_with_a_line_end() {
        let text = text_of(
            "BT /F1 12 Tf 20 100 Td (one) Tj 0 -14 Td (two) Tj ET",
            &[],
            RESOURCES,
        );
        assert_eq!(strings(&text), vec!["one", "two"]);
        assert!(text.items[0].has_eol);
        assert!(!text.items[1].has_eol);
    }

    #[test]
    fn the_quote_operator_starts_the_next_line_a_leading_down() {
        let text = text_of(
            "BT /F1 12 Tf 14 TL 20 100 Td (a) Tj (b) ' ET",
            &[],
            RESOURCES,
        );
        assert_eq!(strings(&text), vec!["a", "b"]);
        assert!(text.items[0].has_eol);
        assert_eq!(text.items[1].transform[5], 86.0);
    }

    #[test]
    fn a_kerning_gap_inside_a_word_adds_no_space_and_a_wide_one_adds_one() {
        let text = text_of(
            "BT /F1 12 Tf 20 100 Td [(AV) -20 (A) -300 (B)] TJ ET",
            &[],
            RESOURCES,
        );
        assert_eq!(strings(&text), vec!["AVA B"]);
    }

    #[test]
    fn text_outside_the_page_is_dropped() {
        let text = text_of("BT /F1 12 Tf 500 100 Td (gone) Tj ET", &[], RESOURCES);
        assert!(text.items.is_empty());
        assert!(text.styles.is_empty());
    }

    #[test]
    fn a_form_xobject_is_read_with_its_matrix_and_its_own_resources() {
        let form = stream(
            "/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Matrix [1 0 0 1 10 20] /Resources << /Font << /F1 5 0 R >> >>",
            "BT /F1 10 Tf 0 0 Td (inside) Tj ET",
        );
        let text = text_of(
            "BT /F1 12 Tf 20 100 Td (outside) Tj ET /Fm0 Do",
            &[(6, form)],
            "<< /Font << /F1 5 0 R >> /XObject << /Fm0 6 0 R >> >>",
        );
        assert_eq!(strings(&text), vec!["outside", "inside"]);
        assert_eq!(text.items[1].transform, [10.0, 0.0, 0.0, 10.0, 10.0, 20.0]);
        assert_eq!(text.styles.len(), 1);
    }

    #[test]
    fn a_form_that_paints_itself_stops_at_the_second_visit() {
        let form = stream(
            "/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << /Font << /F1 5 0 R >> /XObject << /Fm0 6 0 R >> >>",
            "BT /F1 10 Tf 5 50 Td (once) Tj ET /Fm0 Do",
        );
        let text = text_of("/Fm0 Do", &[(6, form)], "<< /XObject << /Fm0 6 0 R >> >>");
        assert_eq!(strings(&text), vec!["once"]);
    }

    #[test]
    fn a_show_operator_before_any_font_is_skipped() {
        let text = text_of(
            "BT 20 100 Td (nothing) Tj /F1 12 Tf (something) Tj ET",
            &[],
            RESOURCES,
        );
        assert_eq!(strings(&text), vec!["something"]);
    }

    #[test]
    fn a_stream_that_breaks_keeps_the_text_before_the_break() {
        let content = format!(
            "BT /F1 12 Tf 20 100 Td (kept) Tj ET {}Tj",
            "1 ".repeat(40)
        );
        let text = text_of(&content, &[], RESOURCES);
        assert_eq!(strings(&text), vec!["kept"]);
    }
}
