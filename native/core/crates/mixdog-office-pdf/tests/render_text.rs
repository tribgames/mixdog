//! A page rendered for a person or a check has its text: the preview image of a PDF whose text is set in a standard 14
//! font, and the same text in an embedded TrueType program, has dark pixels where the text is (Node's pdf.js drew the
//! text through its canvas; a page without it is a blank white page that the render review reports as `blank_page`).

use std::path::Path;
use std::sync::Arc;

use mixdog_fonts::registry::Registry;
use mixdog_office_base::write_note::WriteNote;
use mixdog_office_pdf::{RenderPagesOptions, render_pdf_pages};
use mixdog_raster::Image;

struct Quiet;

impl WriteNote for Quiet {
    fn note_write(&self, _path: &Path) {}
}

fn stream(dict: &str, bytes: &[u8]) -> Vec<u8> {
    [format!("<< {dict} /Length {} >>\nstream\n", bytes.len()).as_bytes(), bytes, b"\nendstream"].concat()
}

fn pdf(content: &str, font: &str, extra: &[Vec<u8>]) -> Vec<u8> {
    let mut objects: Vec<Vec<u8>> = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"
            .to_vec(),
        stream("", content.as_bytes()),
        font.as_bytes().to_vec(),
    ];
    objects.extend(extra.iter().cloned());
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref = out.len();
    let size = objects.len() + 1;
    out.extend_from_slice(format!("xref\n0 {size}\n0000000000 65535 f \n").as_bytes());
    for offset in offsets {
        out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(format!("trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").as_bytes());
    out
}

/// The dark pixels of the first image of the PDF rendered for a person.
fn dark_pixels(name: &str, bytes: Vec<u8>) -> usize {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("render-text").join(name);
    if mixdog_testkit::exists(&dir) {
        mixdog_testkit::remove_dir_all(&dir);
    }
    mixdog_testkit::create_dir_all(&dir);
    let path = dir.join("doc.pdf");
    mixdog_testkit::write(&path, bytes);
    let rendered = tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("runtime")
        .block_on(render_pdf_pages(
            mixdog_rt::testing::tokens(),
            Arc::new(Registry::new()),
            Arc::new(Quiet),
            &path,
            RenderPagesOptions::default(),
        ))
        .expect("renders");
    let image = Image::decode(rendered.images[0].png()).expect("PNG");
    image.rgba().chunks_exact(4).filter(|pixel| pixel[0] < 128 && pixel[1] < 128 && pixel[2] < 128).count()
}

#[test]
fn a_page_with_standard_font_text_is_not_blank() {
    let font = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
    let text = dark_pixels("standard", pdf("BT /F1 36 Tf 30 100 Td (Review text) Tj ET", font, &[]));
    let none = dark_pixels("empty", pdf("0 0 1 1 re W n", font, &[]));
    assert_eq!(none, 0);
    assert!(text > 400, "the text is drawn: {text} dark pixels");
}

#[test]
fn a_page_with_an_embedded_true_type_subset_is_not_blank() {
    let face = mixdog_testkit::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../mixdog-pdf/assets/standard_fonts/LiberationSans-Bold.ttf"));
    let font = "<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+LiberationSans-Bold /FirstChar 32 /LastChar 126 \
                /Widths [278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 389 584] \
                /Encoding /WinAnsiEncoding /FontDescriptor 6 0 R >>";
    let descriptor = "<< /Type /FontDescriptor /FontName /ABCDEF+LiberationSans-Bold /Flags 32 /FontBBox [-200 -300 1200 1000] \
                      /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 140 /FontFile2 7 0 R >>";
    let file = stream(&format!("/Length1 {}", face.len()), &face);
    let bytes = pdf(
        "BT /F1 36 Tf 30 100 Td (Review text) Tj ET",
        font,
        &[descriptor.as_bytes().to_vec(), file],
    );
    let drawn = dark_pixels("embedded", bytes);
    assert!(drawn > 400, "the embedded glyphs are drawn: {drawn} dark pixels");
}
