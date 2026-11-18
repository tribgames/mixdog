//! Text extraction: how a font turns codes into characters (ToUnicode maps, encodings with differences, the named
//! encodings, composite fonts, an embedded TrueType program), how glyph widths and the text state decide the width of
//! an item, where an item sits under the text and current matrices, the order of the items, and right-to-left text.

use mixdog_pdf::document::{Document, OpenOptions};
use mixdog_pdf::text::{TextContent, font_loader};

use crate::read_support::{FONT_RESOURCES, one_page, stream};

fn extract(content: &str, resources: &str, extra: &[(u32, Vec<u8>)]) -> TextContent {
    let document = Document::open(one_page(content, resources, extra), &OpenOptions::default()).expect("a document");
    let fonts = font_loader(&document);
    document.page(0).expect("a page").text_content(&document, &fonts).expect("the text")
}

fn strings(text: &TextContent) -> Vec<String> {
    text.items.iter().map(|item| item.text()).collect()
}

fn near(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

const DESCRIPTOR: &str = "<< /Type /FontDescriptor /FontName /CustomFont /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>";

/// A font of codes 1 to 3 with widths 500, 600, 700 whose characters come from `map` (`bfchar` lines).
fn mapped_font(map: &str) -> Vec<(u32, Vec<u8>)> {
    let cmap = format!(
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Test def /CMapType 2 def \
         1 begincodespacerange <00> <FF> endcodespacerange {map} endcmap CMapName currentdict /CMap defineresource pop end end"
    );
    vec![
        (
            6,
            b"<< /Type /Font /Subtype /Type1 /BaseFont /CustomFont /FirstChar 1 /LastChar 3 /Widths [500 600 700] /FontDescriptor 7 0 R /ToUnicode 8 0 R >>"
                .to_vec(),
        ),
        (7, DESCRIPTOR.as_bytes().to_vec()),
        (8, stream("", cmap.as_bytes())),
    ]
}

const CUSTOM: &str = "<< /Font << /F1 6 0 R >> >>";

#[test]
fn a_to_unicode_map_decides_the_characters_and_may_give_several_for_one_code() {
    let font = mapped_font("2 beginbfchar <01> <0041> <02> <00660069> endbfchar 1 beginbfrange <03> <03> <0058> endbfrange");
    let text = extract("BT /F1 10 Tf 20 100 Td (\\001\\002\\003) Tj ET", CUSTOM, &font);
    assert_eq!(strings(&text), vec!["AfiX"]);
}

#[test]
fn the_width_of_an_item_is_the_sum_of_the_glyph_widths_times_the_size() {
    let font = mapped_font("3 beginbfchar <01> <0041> <02> <0042> <03> <0043> endbfchar");
    let text = extract("BT /F1 10 Tf 20 100 Td (\\001\\002\\003) Tj ET", CUSTOM, &font);
    assert!(near(text.items[0].width, (500.0 + 600.0 + 700.0) * 10.0 / 1000.0), "{}", text.items[0].width);
    assert_eq!(text.items[0].height, 10.0);
}

#[test]
fn character_spacing_and_horizontal_scaling_widen_and_narrow_the_item() {
    let font = mapped_font("1 beginbfchar <01> <0041> endbfchar");
    // The item spans its glyphs and the character spacing between them (three glyphs of 5, two gaps of Tc); the
    // spacing after the last glyph moves the pen for what follows and is not part of the item. Tz scales all of it.
    let spaced = extract("BT /F1 10 Tf 2 Tc 20 100 Td (\\001\\001\\001) Tj ET", CUSTOM, &font);
    assert!(near(spaced.items[0].width, 3.0 * 5.0 + 2.0 * 2.0), "{}", spaced.items[0].width);
    let squeezed = extract("BT /F1 10 Tf 2 Tc 50 Tz 20 100 Td (\\001\\001\\001) Tj ET", CUSTOM, &font);
    assert!(near(squeezed.items[0].width, (3.0 * 5.0 + 2.0 * 2.0) * 0.5), "{}", squeezed.items[0].width);
}

#[test]
fn the_standard_fonts_have_their_published_metrics() {
    // Adobe's font metrics: Helvetica A is 667, Courier is 600 everywhere, Times-Roman A is 722.
    let courier = b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>".to_vec();
    let times = b"<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>".to_vec();
    let text = extract(
        "BT /F1 10 Tf 20 100 Td (AA) Tj /F2 10 Tf 0 -20 Td (AAA) Tj /F3 10 Tf 0 -20 Td (A) Tj ET",
        "<< /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >>",
        &[(6, courier), (7, times)],
    );
    // A move to a new line leaves an empty item that only marks the line end.
    let shown: Vec<_> = text.items.iter().filter(|item| !item.units.is_empty()).collect();
    assert_eq!(shown.iter().map(|item| item.text()).collect::<Vec<_>>(), vec!["AA", "AAA", "A"]);
    assert!(near(shown[0].width, 13.34), "{}", shown[0].width);
    assert!(near(shown[1].width, 18.0), "{}", shown[1].width);
    assert!(near(shown[2].width, 7.22), "{}", shown[2].width);
    assert_eq!(text.styles.len(), 3);
}

#[test]
fn an_encoding_with_differences_renames_the_codes_it_lists() {
    let font = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [65 /germandbls /Euro 70 /uni0416] >> >>".to_vec();
    let text = extract("BT /F1 12 Tf 20 100 Td (ABCF) Tj ET", "<< /Font << /F1 6 0 R >> >>", &[(6, font)]);
    assert_eq!(strings(&text), vec!["\u{df}\u{20ac}C\u{416}"]);
}

#[test]
fn the_named_encodings_map_the_upper_half_differently() {
    let mac = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /MacRomanEncoding >>".to_vec();
    let text = extract(
        "BT /F1 12 Tf 20 100 Td (\\200\\225) Tj /F2 12 Tf (\\212\\245) Tj ET",
        "<< /Font << /F1 5 0 R /F2 6 0 R >> >>",
        &[(6, mac)],
    );
    // WinAnsi: 0x80 is the euro sign, 0x95 a bullet. MacRoman: 0x8A is a with diaeresis, 0xA5 a bullet.
    // Both shows continue on one line, so they make one item.
    assert_eq!(strings(&text).concat(), "\u{20ac}\u{2022}\u{e4}\u{2022}");
}

#[test]
fn a_composite_font_reads_two_byte_codes_with_their_own_widths_and_the_default_width() {
    let cmap = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /T def /CMapType 2 def \
        1 begincodespacerange <0000> <FFFF> endcodespacerange 3 beginbfchar <0001> <0078> <0002> <0079> <0003> <007A> endbfchar \
        endcmap CMapName currentdict /CMap defineresource pop end end";
    let extra = vec![
        (
            6,
            b"<< /Type /Font /Subtype /Type0 /BaseFont /CustomCID /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 9 0 R >>".to_vec(),
        ),
        (
            7,
            b"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /CustomCID /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R /DW 1000 /W [1 [250 750]] >>".to_vec(),
        ),
        (8, DESCRIPTOR.as_bytes().to_vec()),
        (9, stream("", cmap.as_bytes())),
    ];
    let text = extract("BT /F1 10 Tf 20 100 Td <000100020003> Tj ET", CUSTOM, &extra);
    assert_eq!(strings(&text), vec!["xyz"]);
    // 250 + 750 from /W, 1000 from /DW.
    assert!(near(text.items[0].width, (250.0 + 750.0 + 1000.0) * 10.0 / 1000.0), "{}", text.items[0].width);
}

#[test]
fn a_right_to_left_text_is_reported_as_such_in_visual_order() {
    let font = mapped_font("2 beginbfchar <01> <05D0> <02> <05D1> endbfchar");
    let text = extract("BT /F1 10 Tf 20 100 Td (\\001\\002) Tj ET", CUSTOM, &font);
    assert_eq!(text.items.len(), 1);
    assert_eq!(text.items[0].dir.as_str(), "rtl");
    assert_eq!(text.items[0].text(), "\u{5d1}\u{5d0}");
}

#[test]
fn the_text_and_current_matrices_place_the_item() {
    let rotated = extract("BT /F1 12 Tf 0 1 -1 0 100 50 Tm (up) Tj ET", FONT_RESOURCES, &[]);
    assert_eq!(rotated.items[0].transform, [0.0, 12.0, -12.0, 0.0, 100.0, 50.0]);
    let scaled = extract("0.5 0 0 0.5 0 0 cm BT /F1 12 Tf 20 100 Td (half) Tj ET", FONT_RESOURCES, &[]);
    assert_eq!(scaled.items[0].transform, [6.0, 0.0, 0.0, 6.0, 10.0, 50.0]);
}

#[test]
fn items_come_in_the_order_of_the_content_not_of_the_page() {
    let text = extract(
        "BT /F1 12 Tf 20 20 Td (bottom) Tj 0 150 Td (top) Tj ET BT /F1 12 Tf 20 100 Td (middle) Tj ET",
        FONT_RESOURCES,
        &[],
    );
    assert_eq!(strings(&text), vec!["bottom", "top", "middle"]);
}

#[test]
fn text_of_an_embedded_truetype_program_is_read_through_its_character_map() {
    let program = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/assets/standard_fonts/LiberationSans-Regular.ttf"))
        .expect("the tracked font");
    let extra = vec![
        (
            6,
            b"<< /Type /Font /Subtype /TrueType /BaseFont /AAAAAA+Embedded /FirstChar 72 /LastChar 73 /Widths [722 278] /Encoding /WinAnsiEncoding /FontDescriptor 7 0 R >>".to_vec(),
        ),
        (
            7,
            b"<< /Type /FontDescriptor /FontName /AAAAAA+Embedded /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 8 0 R >>".to_vec(),
        ),
        (8, stream(&format!("/Length1 {}", program.len()), &program)),
    ];
    let text = extract("BT /F1 10 Tf 20 100 Td (HI) Tj ET", CUSTOM, &extra);
    assert_eq!(strings(&text), vec!["HI"]);
    assert!(near(text.items[0].width, (722.0 + 278.0) * 10.0 / 1000.0), "{}", text.items[0].width);
}
