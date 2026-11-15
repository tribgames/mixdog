//! The fonts of a rendered page draw their glyphs: a page whose text is set in a standard 14 font (no program in the
//! file), in an embedded TrueType program (simple with an encoding, and an Identity-H CID font with a `CIDToGIDMap`),
//! in an embedded CFF program and in a Type 3 font has ink where the text is and moves the text by the glyph widths.

use std::path::PathBuf;
use std::sync::Arc;

use mixdog_pdf::document::{Document, OpenOptions};
use mixdog_pdf::fontdraw::PageFonts;
use mixdog_pdf::fontfile::truetype::TrueTypeFont;
use mixdog_pdf::render::{RenderOptions, render_page};

const WIDTH: usize = 200;
const HEIGHT: usize = 100;

fn standard_font(file: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("assets/standard_fonts")
        .join(file);
    std::fs::read(path).expect("bundled font file")
}

fn stream(dict: &str, bytes: &[u8]) -> Vec<u8> {
    [
        format!("<< {dict} /Length {} >>\nstream\n", bytes.len()).as_bytes(),
        bytes,
        b"\nendstream",
    ]
    .concat()
}

/// A one-page PDF (200 by 100 points) drawing `content` with `font` (object 5) and `extra` objects numbered from 6.
fn pdf(content: &str, font: &str, extra: &[Vec<u8>]) -> Vec<u8> {
    let mut objects: Vec<Vec<u8>> = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"
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
    out.extend_from_slice(
        format!("trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").as_bytes(),
    );
    out
}

fn open(bytes: Vec<u8>) -> Document {
    let options = OpenOptions {
        use_system_fonts: false,
        ..OpenOptions::default()
    };
    Document::open(Arc::<[u8]>::from(bytes), &options).expect("opens")
}

/// The page rendered at scale 1 with the page's fonts, as one grey level per pixel.
fn render(bytes: Vec<u8>) -> Vec<u8> {
    let document = open(bytes);
    let page = document.page(0).expect("page");
    let fonts = PageFonts::new(&document);
    let rendered = render_page(
        &document,
        &page,
        &RenderOptions {
            scale: 1.0,
            fonts: Some(&fonts),
            drawing: Some(&fonts),
        },
    )
    .expect("renders");
    assert_eq!(
        (rendered.width() as usize, rendered.height() as usize),
        (WIDTH, HEIGHT)
    );
    rendered
        .rgba()
        .expect("pixels")
        .chunks_exact(4)
        .map(|p| p[0])
        .collect()
}

type Ink = (usize, usize, usize, usize, usize);

/// The dark pixels: `(first column, last column, first row, last row, count)`.
fn ink(grey: &[u8]) -> Option<Ink> {
    let mut found: Option<Ink> = None;
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            if grey[y * WIDTH + x] < 128 {
                found = Some(match found {
                    None => (x, x, y, y, 1),
                    Some((x0, x1, y0, y1, n)) => (x0.min(x), x1.max(x), y0.min(y), y1.max(y), n + 1),
                });
            }
        }
    }
    found
}

const HELVETICA: &str =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

#[test]
fn a_page_without_the_bridge_is_blank_and_with_it_has_text() {
    let bytes = pdf("BT /F1 40 Tf 20 30 Td (HI) Tj ET", HELVETICA, &[]);
    let document = open(bytes.clone());
    let page = document.page(0).expect("page");
    let blank = render_page(
        &document,
        &page,
        &RenderOptions {
            scale: 1.0,
            fonts: None,
            drawing: None,
        },
    )
    .expect("renders")
    .rgba()
    .expect("pixels");
    assert!(
        blank.chunks_exact(4).all(|p| p[0] == 255),
        "without fonts a page has no text"
    );
    assert!(ink(&render(bytes)).is_some(), "with the fonts the text is drawn");
}

#[test]
fn standard_font_text_is_drawn_where_the_text_is_and_advances_by_the_widths() {
    let one = ink(&render(pdf("BT /F1 40 Tf 20 30 Td (H) Tj ET", HELVETICA, &[]))).expect("H has ink");
    let two = ink(&render(pdf("BT /F1 40 Tf 20 30 Td (HI) Tj ET", HELVETICA, &[]))).expect("HI has ink");
    // The text starts at x 20 and its baseline is 30 from the bottom: row 70 from the top. A 40 pt Helvetica capital is
    // about 29 px tall.
    assert!(one.0 >= 20 && one.0 <= 24, "H starts at its left bearing, not at {}", one.0);
    assert!(one.2 >= 38 && one.3 <= 71, "H sits on the baseline: rows {}..{}", one.2, one.3);
    assert!(one.3 - one.2 >= 25, "H is as tall as a capital: rows {}..{}", one.2, one.3);
    // H is 722 thousandths wide: the I that follows is drawn after a pen at 20 + 28.88.
    assert_eq!(two.0, one.0);
    assert!(two.1 > one.1 + 8, "the second glyph is right of the first: {} against {}", two.1, one.1);
    assert!(two.4 > one.4, "two glyphs have more ink than one");
    let pen = 20.0 + 0.722 * 40.0;
    assert!(
        (two.1 as f64 - (pen + 0.278 * 40.0)).abs() < 8.0,
        "the I ends within its advance: {} for a pen at {pen}",
        two.1
    );
}

#[test]
fn every_standard_style_draws() {
    for name in [
        "Helvetica-Bold",
        "Helvetica-Oblique",
        "Times-Roman",
        "Times-Bold",
        "Times-Italic",
        "Courier",
        "Courier-Bold",
        "Arial",
        "ABCDEF+SomethingUnknown-Bold",
        "Symbol",
        "ZapfDingbats",
    ] {
        let font = format!("<< /Type /Font /Subtype /Type1 /BaseFont /{name} >>");
        let drawn = ink(&render(pdf("BT /F1 30 Tf 20 30 Td (Hag) Tj ET", &font, &[])));
        assert!(drawn.is_some_and(|ink| ink.4 > 30), "{name} draws text");
    }
}

fn liberation_regular() -> Vec<u8> {
    standard_font("LiberationSans-Regular.ttf")
}

fn glyph_of(program: &[u8], character: char) -> i64 {
    let ttf = TrueTypeFont::parse(program, "Liberation").expect("parses");
    let cmap = ttf.read_cmap_table(false, true).expect("cmap");
    cmap.mappings
        .iter()
        .find(|mapping| mapping.char_code == i64::from(u32::from(character)))
        .map(|mapping| mapping.glyph_id)
        .expect("the face has the character")
}

#[test]
fn an_embedded_true_type_program_with_an_encoding_draws_its_glyphs() {
    let program = liberation_regular();
    let font = "<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+LiberationSans /FirstChar 72 /LastChar 73 \
                /Widths [722 278] /Encoding /WinAnsiEncoding /FontDescriptor 6 0 R >>";
    let descriptor = "<< /Type /FontDescriptor /FontName /ABCDEF+LiberationSans /Flags 32 \
                      /FontBBox [-200 -200 1200 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 \
                      /StemV 80 /FontFile2 7 0 R >>";
    let file = stream(&format!("/Length1 {}", program.len()), &program);
    let bytes = pdf(
        "BT /F1 40 Tf 20 30 Td (HI) Tj ET",
        font,
        &[descriptor.as_bytes().to_vec(), file],
    );
    let drawn = ink(&render(bytes)).expect("the embedded glyphs are drawn");
    assert!(
        drawn.0 >= 20 && drawn.0 <= 26 && drawn.2 >= 38 && drawn.3 <= 71,
        "{drawn:?}"
    );
    assert!(drawn.4 > 150, "two capitals have ink: {drawn:?}");
    assert!(drawn.1 > 20 + 28, "the I is after the advance of H: {drawn:?}");
}

#[test]
fn an_identity_h_cid_font_reaches_its_glyphs_through_the_cid_to_gid_map() {
    let program = liberation_regular();
    let (h, i) = (glyph_of(&program, 'H') as u16, glyph_of(&program, 'I') as u16);
    // CID 1 is the glyph of H, CID 2 the glyph of I.
    let mut map = vec![0u8; 6];
    map[2..4].copy_from_slice(&h.to_be_bytes());
    map[4..6].copy_from_slice(&i.to_be_bytes());
    let font = "<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+LiberationSans /Encoding /Identity-H \
                /DescendantFonts [6 0 R] >>";
    let cid = "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+LiberationSans \
               /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R \
               /CIDToGIDMap 9 0 R /DW 1000 /W [1 [722 278]] >>";
    let descriptor = "<< /Type /FontDescriptor /FontName /ABCDEF+LiberationSans /Flags 4 \
                      /FontBBox [-200 -200 1200 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 \
                      /StemV 80 /FontFile2 8 0 R >>";
    let file = stream(&format!("/Length1 {}", program.len()), &program);
    let bytes = pdf(
        "BT /F1 40 Tf 20 30 Td <00010002> Tj ET",
        font,
        &[
            cid.as_bytes().to_vec(),
            descriptor.as_bytes().to_vec(),
            file,
            stream("", &map),
        ],
    );
    let drawn = ink(&render(bytes)).expect("the CID glyphs are drawn");
    assert!(
        drawn.0 >= 20 && drawn.0 <= 26 && drawn.2 >= 38 && drawn.3 <= 71,
        "{drawn:?}"
    );
    assert!(drawn.4 > 150, "{drawn:?}");
    assert!(
        drawn.1 > 20 + 28,
        "the second glyph follows the advance of the first: {drawn:?}"
    );
}

#[test]
fn an_embedded_cff_program_draws_through_the_names_of_its_encoding() {
    let program = standard_font("FoxitSerif.pfb");
    let font = "<< /Type /Font /Subtype /Type1 /BaseFont /ABCDEF+Serif /FirstChar 72 /LastChar 73 \
                /Widths [722 333] /Encoding /WinAnsiEncoding /FontDescriptor 6 0 R >>";
    let descriptor = "<< /Type /FontDescriptor /FontName /ABCDEF+Serif /Flags 34 /FontBBox [-200 -200 1200 900] \
                      /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 /FontFile3 7 0 R >>";
    let file = stream("/Subtype /Type1C", &program);
    let bytes = pdf(
        "BT /F1 40 Tf 20 30 Td (HI) Tj ET",
        font,
        &[descriptor.as_bytes().to_vec(), file],
    );
    let drawn = ink(&render(bytes)).expect("the CFF glyphs are drawn");
    assert!(drawn.2 >= 38 && drawn.3 <= 71 && drawn.4 > 100, "{drawn:?}");
}

#[test]
fn a_type3_glyph_procedure_is_drawn_and_advances_by_its_width() {
    let font = "<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] \
                /CharProcs << /sq 6 0 R >> /Encoding << /Type /Encoding /Differences [97 /sq] >> \
                /FirstChar 97 /LastChar 97 /Widths [1000] >>";
    let procedure = stream("", b"1000 0 d0 0 0 800 800 re f");
    let one = ink(&render(pdf(
        "BT /F1 20 Tf 20 30 Td (a) Tj ET",
        font,
        &[procedure.clone()],
    )))
    .expect("ink");
    let two = ink(&render(pdf(
        "BT /F1 20 Tf 20 30 Td (aa) Tj ET",
        font,
        &[procedure],
    )))
    .expect("ink");
    assert_eq!((one.0, one.1), (20, 35), "{one:?}");
    assert_eq!((two.0, two.1), (20, 55), "{two:?}");
}

#[test]
fn a_font_that_cannot_be_made_draws_nothing_and_does_not_stop_the_page() {
    // A font dictionary without a base font is an error font: its text draws nothing and the rest of the page does.
    let font = "<< /Type /Font /Subtype /Type1 >>";
    let bytes = pdf("0 0 50 50 re f BT /F1 40 Tf 20 30 Td (HI) Tj ET", font, &[]);
    let drawn = ink(&render(bytes)).expect("the rectangle is drawn");
    assert_eq!(drawn.4, 2500, "only the 50 by 50 rectangle: {drawn:?}");
}
