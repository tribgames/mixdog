//! `core/docx-toc-pages.mjs`: the page numbers of a Word contents field.
//!
//! A contents field written by the portable backend caches its entries without pages: nothing had laid the document out, so a
//! report opened on "1. 요약 / 2. 원인" with no number beside either, an unfinished page in every preview and in any reader that
//! does not update fields. The preview render is that layout: the entries are found on its pages, the numbers written into the
//! cache, and the caller renders once more so the preview shows them.

use std::path::Path;

use mixdog_fsio::{ReadProof, WriteProof};
use mixdog_office_base::write_note::WriteNote;
use mixdog_office_pdf::analysis::layout::{LayoutOptions, extract_pdf_text_layout};
use mixdog_office_pdf::document::PdfSource;
use mixdog_ooxml::docx_operations::write_docx_toc_pages;
use mixdog_ooxml::package::{load_package, save_package};
use mixdog_ooxml::xml::compiled;

/// `numberDocxTableOfContents(docxPath, pdfPath)`: the page of every contents entry read from the rendered `pdf_path` and written
/// into the field of `docx_path`; whether the document changed (and so is to be rendered once more).
pub fn number_docx_table_of_contents<P: ReadProof + WriteProof>(proof: &P, note: &dyn WriteNote, docx_path: &Path, pdf_path: &Path) -> Result<bool, String> {
    let mut zip = load_package(proof, docx_path)?;
    let xml = zip.text("word/document.xml");
    if !compiled(r#"<w:fldSimple\b[^>]*\bw:instr="[^"]*TOC"#, "").is_match(&xml) {
        return Ok(false);
    }
    let options = LayoutOptions { shapes: false, ..LayoutOptions::default() };
    let layout = extract_pdf_text_layout(proof, PdfSource::Path(pdf_path), &options).map_err(|error| error.to_string())?;
    let whitespace = compiled(r"\s+", "g");
    let page_texts: Vec<String> = layout
        .pages
        .iter()
        .map(|page| {
            let text: String = page.items.iter().map(|item| item.text.as_str()).collect();
            whitespace.replace_all_with(&text, |_| String::new())
        })
        .collect();
    if !write_docx_toc_pages(&mut zip, &page_texts)? {
        return Ok(false);
    }
    save_package(proof, note, &zip, docx_path)?;
    Ok(true)
}
