//! Reading the text out of Word, PowerPoint and Excel packages built in the test: what the read tool shows for a
//! document, a deck and a workbook, and the refusals for what is not a readable package.

use mixdog_ooxml_text::{ExtractOptions, Limits, extract_ooxml_text_from_buffer, try_extract_ooxml_text_from_buffer};

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

/// A ZIP container with every entry stored.
fn package(entries: &[(&str, &str)]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, body) in entries {
        let offset = out.len() as u32;
        let crc = crc32(body.as_bytes());
        let size = body.len() as u32;
        let mut local = Vec::new();
        local.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        local.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        local.extend_from_slice(&crc.to_le_bytes());
        local.extend_from_slice(&size.to_le_bytes());
        local.extend_from_slice(&size.to_le_bytes());
        local.extend_from_slice(&(name.len() as u16).to_le_bytes());
        local.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&local);
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(body.as_bytes());
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&[20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        central.extend_from_slice(&[0; 12]);
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let central_at = out.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]);
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&central_at.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

fn extract(entries: &[(&str, &str)], filename: &str) -> String {
    extract_ooxml_text_from_buffer(&package(entries), filename, &ExtractOptions::default())
}

fn paragraph(text: &str) -> String {
    format!("<w:p><w:r><w:t>{text}</w:t></w:r></w:p>")
}

#[test]
fn a_word_document_reads_its_paragraphs_in_order_with_entities_decoded() {
    let body = format!("<w:document><w:body>{}{}</w:body></w:document>", paragraph("First &amp; foremost"), paragraph("Second"));
    let text = extract(&[("word/document.xml", &body)], "a.docx");
    assert_eq!(text, "First & foremost\nSecond");
}

#[test]
fn a_word_document_lists_its_headers_and_footers_after_the_body() {
    let body = format!("<w:document><w:body>{}</w:body></w:document>", paragraph("Body text"));
    let header = format!("<w:hdr>{}</w:hdr>", paragraph("Quarterly report"));
    let text = extract(&[("word/document.xml", &body), ("word/header1.xml", &header)], "a.docx");
    assert!(text.starts_with("Body text"), "{text}");
    assert!(text.contains("--- header ---\nQuarterly report"), "{text}");
}

#[test]
fn a_deck_reads_one_section_per_slide_in_slide_number_order_and_marks_an_empty_one() {
    let slide = |text: &str| format!("<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>");
    let two = slide("Second slide");
    let ten = slide("Tenth slide");
    let empty = "<p:sld><p:cSld><p:spTree></p:spTree></p:cSld></p:sld>";
    let text = extract(
        &[("ppt/slides/slide10.xml", &ten), ("ppt/slides/slide2.xml", &two), ("ppt/slides/slide3.xml", empty)],
        "deck.pptx",
    );
    assert_eq!(text, "--- slide 2 ---\nSecond slide\n\n--- slide 3 ---\n(no text)\n\n--- slide 10 ---\nTenth slide");
}

#[test]
fn a_package_without_slides_is_not_a_presentation() {
    let text = extract(&[("docProps/app.xml", "<Properties/>")], "deck.pptx");
    assert!(text.starts_with("Error: ") && text.contains("not a PPTX presentation"), "{text}");
}

#[test]
fn a_workbook_reads_each_sheet_by_name_with_cells_by_row_and_trailing_blanks_dropped() {
    let workbook = r#"<workbook><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>"#;
    let rels = r#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>"#;
    let sheet = concat!(
        "<worksheet><sheetData>",
        r#"<row r="1"><c r="A1" t="inlineStr"><is><t>Region</t></is></c><c r="B1" t="inlineStr"><is><t>Total</t></is></c></row>"#,
        r#"<row r="2"><c r="A2" t="inlineStr"><is><t>North</t></is></c><c r="B2"><v>42</v></c></row>"#,
        "</sheetData></worksheet>"
    );
    let text = extract(
        &[("xl/workbook.xml", workbook), ("xl/_rels/workbook.xml.rels", rels), ("xl/worksheets/sheet1.xml", sheet)],
        "book.xlsx",
    );
    assert!(text.starts_with("--- sheet Sales ---\n"), "{text}");
    assert!(text.contains("Region") && text.contains("Total") && text.contains("North") && text.contains("42"), "{text}");
    let region = text.lines().position(|line| line.contains("Region")).unwrap();
    let north = text.lines().position(|line| line.contains("North")).unwrap();
    assert!(region < north, "rows keep their order: {text}");
}

#[test]
fn text_longer_than_the_output_cap_is_cut_on_a_character_boundary_and_says_so() {
    let body = format!("<w:document><w:body>{}</w:body></w:document>", paragraph("가나다라마바사"));
    let options = ExtractOptions { max_output_bytes: 7 };
    let text = extract_ooxml_text_from_buffer(&package(&[("word/document.xml", &body)]), "a.docx", &options);
    assert_eq!(text, "가나\n... [office text truncated at 7 bytes]");
}

#[test]
fn a_package_without_the_expected_parts_is_an_error_line_or_nothing_for_the_quiet_entry() {
    let buffer = package(&[("readme.txt", "hello")]);
    let loud = extract_ooxml_text_from_buffer(&buffer, "a.docx", &ExtractOptions::default());
    assert!(loud.starts_with("Error: "), "{loud}");
    assert_eq!(try_extract_ooxml_text_from_buffer(&buffer, "a.docx", &Limits::default()), None);
}

#[test]
fn a_package_is_read_by_what_it_holds_when_the_extension_is_not_an_office_one() {
    let body = format!("<w:document><w:body>{}</w:body></w:document>", paragraph("Renamed"));
    let text = extract(&[("word/document.xml", &body)], "download.bin");
    assert_eq!(text, "Renamed");
}

// ---- the parts of a package beyond the main flow

use mixdog_ooxml_text::legacy::{legacy_office_label_package, ooxml_label_package, ooxml_mime_by_package};
use mixdog_ooxml_text::media::office_text_for_file;
use std::io::Write;

/// A ZIP container whose entries carry their own method: `(name, method, stored bytes, the bytes they hold)`.
fn container(entries: &[(&str, u16, Vec<u8>, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, method, stored, original) in entries {
        let offset = out.len() as u32;
        let crc = crc32(original);
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&[20, 0, 0, 0]);
        out.extend_from_slice(&method.to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(stored.len() as u32).to_le_bytes());
        out.extend_from_slice(&(original.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(stored);
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&[20, 0, 20, 0, 0, 0]);
        central.extend_from_slice(&method.to_le_bytes());
        central.extend_from_slice(&[0; 4]);
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&(stored.len() as u32).to_le_bytes());
        central.extend_from_slice(&(original.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        central.extend_from_slice(&[0; 12]);
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let central_at = out.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]);
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&central_at.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

fn deflate(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

fn word(paragraphs: &str) -> String {
    format!("<w:document><w:body>{paragraphs}</w:body></w:document>")
}

#[test]
fn a_footnote_is_cited_in_the_body_and_its_words_follow_under_the_notes_heading() {
    let body = word(&format!(
        "<w:p><w:r><w:t>Revenue grew</w:t></w:r><w:r><w:footnoteReference w:id=\"2\"/></w:r></w:p>{}",
        "<w:p><w:r><w:t>Costs fell</w:t></w:r><w:r><w:endnoteReference w:id=\"9\"/></w:r></w:p>"
    ));
    let footnotes = "<w:footnotes><w:footnote w:type=\"separator\" w:id=\"-1\"><w:p><w:r><w:t>rule</w:t></w:r></w:p></w:footnote>\
                     <w:footnote w:id=\"2\"><w:p><w:r><w:t>Source: audit</w:t></w:r></w:p></w:footnote></w:footnotes>";
    let text = extract(&[("word/document.xml", &body), ("word/footnotes.xml", footnotes)], "a.docx");
    assert_eq!(text, "Revenue grew[note 1]\nCosts fell[note 2]\n\n--- notes ---\n[note 1] Source: audit\n[note 2] (note text missing)");
}

#[test]
fn headers_and_footers_list_each_line_once_and_drop_bare_page_numbers() {
    let body = word(&paragraph("Body"));
    let header1 = format!("<w:hdr>{}</w:hdr>", paragraph("Confidential"));
    let header2 = format!("<w:hdr>{}</w:hdr>", paragraph("Confidential"));
    let footer1 = format!("<w:ftr>{}{}</w:ftr>", paragraph("Doc 7"), paragraph("12 / 40"));
    let text = extract(
        &[("word/document.xml", &body), ("word/header1.xml", &header1), ("word/header2.xml", &header2), ("word/footer1.xml", &footer1)],
        "a.docx",
    );
    assert_eq!(text, "Body\n\n--- header ---\nConfidential\n\n--- footer ---\nDoc 7");
}

#[test]
fn text_a_run_hides_is_shown_marked_and_a_visible_run_after_it_closes_the_mark() {
    let body = word("<w:p><w:r><w:t>Visible </w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>secret</w:t></w:r><w:r><w:t> end</w:t></w:r></w:p>");
    assert_eq!(extract(&[("word/document.xml", &body)], "a.docx"), "Visible [hidden: secret] end");
}

#[test]
fn a_word_table_keeps_cells_on_tabs_and_rows_on_lines_and_a_tab_or_break_is_kept() {
    let cell = |text: &str| format!("<w:tc>{}</w:tc>", paragraph(text));
    let table = format!("<w:tbl><w:tr>{}{}</w:tr><w:tr>{}{}</w:tr></w:tbl>", cell("A"), cell("B"), cell("C"), cell("D"));
    assert_eq!(extract(&[("word/document.xml", &word(&table))], "a.docx"), "A\tB\nC\tD");
    let inline = word("<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p>");
    assert_eq!(extract(&[("word/document.xml", &inline)], "a.docx"), "a\tb\nc");
}

#[test]
fn empty_paragraphs_never_leave_more_than_one_blank_line_and_an_empty_document_says_so() {
    let gap = word(&format!("{}<w:p></w:p><w:p></w:p><w:p></w:p>{}", paragraph("a"), paragraph("b")));
    assert_eq!(extract(&[("word/document.xml", &gap)], "a.docx"), "a\n\nb");
    assert_eq!(extract(&[("word/document.xml", &word(""))], "a.docx"), "(no text content in document)");
    let missing = extract(&[("xl/workbook.xml", "<workbook/>")], "a.docx");
    assert_eq!(missing, "Error: no word/document.xml part — not a DOCX document (or an encrypted one)");
}

#[test]
fn a_picture_is_named_by_its_description_on_a_line_of_its_own() {
    let figure = "<w:p><w:r><w:drawing><pic:cNvPr id=\"1\" descr=\"Logo\"/></w:drawing></w:r></w:p>";
    let body = word(&format!("{}{figure}{}", paragraph("Intro"), paragraph("After")));
    assert_eq!(extract(&[("word/document.xml", &body)], "a.docx"), "Intro\n[image: Logo]\nAfter");
}

const BOOK: &str = r#"<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Old" sheetId="2" state="hidden" r:id="rId2"/><sheet name="Gone" sheetId="3" r:id="rId3"/></sheets></workbook>"#;
const BOOK_RELS: &str = r#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Target="worksheets/sheet3.xml"/></Relationships>"#;

#[test]
fn a_workbook_shows_dates_percentages_and_cached_formula_values_as_the_sheet_does() {
    let styles = r#"<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/></numFmts><cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="10"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>"#;
    let strings = "<sst><si><t>Item</t></si><si><t>Due</t></si><si><r><t>Ra</t></r><r><t>te</t></r></si><si><t>Secret</t></si></sst>";
    // 46310 days after 1899-12-30 is 2026-10-15; a quarter day short of the next midnight is 18:00.
    let sheet = concat!(
        r#"<worksheet><cols><col min="4" max="4" hidden="1"/></cols><sheetData>"#,
        r#"<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>"#,
        r#"<row r="2"><c r="A2" t="inlineStr"><is><t>Tax</t></is></c><c r="B2" s="1"><v>46310</v></c><c r="C2" s="2"><v>0.928</v></c><c r="D2"><v>5</v></c><c r="E2" s="4"><v>46310.75</v></c></row>"#,
        r#"<row r="3" hidden="1"><c r="A3" t="inlineStr"><is><t>Draft</t></is></c><c r="B3"><v>1</v></c></row>"#,
        r#"<row r="4"><c r="A4"><f>SUM(1,9)</f><v>10</v></c><c r="E4" s="3"><v>46310</v></c></row>"#,
        "</sheetData></worksheet>"
    );
    let text = extract(
        &[
            ("xl/workbook.xml", BOOK),
            ("xl/_rels/workbook.xml.rels", BOOK_RELS),
            ("xl/styles.xml", styles),
            ("xl/sharedStrings.xml", strings),
            ("xl/worksheets/sheet1.xml", sheet),
            ("xl/worksheets/sheet2.xml", "<worksheet><sheetData/></worksheet>"),
        ],
        "book.xlsx",
    );
    assert_eq!(
        text,
        "--- sheet Data ---\nItem\tDue\tRate\tSecret\nTax\t2026-10-15\t92.80%\t5\t2026-10-15 18:00\n[hidden] Draft\t1\n10\t\t\t\t2026-10-15\n[hidden columns: D (Secret)]\
         \n\n--- sheet Old (hidden) ---\n(empty sheet)\n\n--- sheet Gone ---\n(sheet part missing)"
    );
}

#[test]
fn a_workbook_without_sheets_or_a_workbook_part_is_refused_and_a_chart_is_named_by_its_title() {
    let none = extract(&[("xl/workbook.xml", "<workbook><sheets/></workbook>")], "b.xlsx");
    assert_eq!(none, "Error: workbook declares no sheets");
    let none = extract(&[("word/x.xml", "<a/>")], "b.xlsx");
    assert_eq!(none, "Error: no xl/workbook.xml part — not an Excel workbook (or an encrypted one)");
    let book = r#"<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>"#;
    let rels = r#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>"#;
    let sheet = r#"<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>"#;
    let sheet_rels = r#"<Relationships><Relationship Id="rId1" Target="../drawings/drawing1.xml"/></Relationships>"#;
    let drawing = r#"<xdr:wsDr><xdr:twoCellAnchor><xdr:graphicFrame><a:graphic><a:graphicData><c:chart r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame></xdr:twoCellAnchor></xdr:wsDr>"#;
    let drawing_rels = r#"<Relationships><Relationship Id="rId1" Target="../charts/chart1.xml"/></Relationships>"#;
    let chart = "<c:chartSpace><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Revenue</a:t></a:r></a:p></c:rich></c:tx></c:title></c:chart></c:chartSpace>";
    let text = extract(
        &[
            ("xl/workbook.xml", book),
            ("xl/_rels/workbook.xml.rels", rels),
            ("xl/worksheets/sheet1.xml", sheet),
            ("xl/worksheets/_rels/sheet1.xml.rels", sheet_rels),
            ("xl/drawings/drawing1.xml", drawing),
            ("xl/drawings/_rels/drawing1.xml.rels", drawing_rels),
            ("xl/charts/chart1.xml", chart),
        ],
        "b.xlsx",
    );
    assert_eq!(text, "--- sheet S ---\nx\n[chart: Revenue]");
}

#[test]
fn a_deck_marks_hidden_slides_and_shapes_reads_tables_and_names_charts_and_puts_notes_after_the_slide() {
    let shape = |id: u32, extra: &str, text: &str| {
        format!("<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"s\"{extra}/></p:nvSpPr><p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>")
    };
    let slide = |attrs: &str, content: &str| format!("<p:sld{attrs}><p:cSld><p:spTree>{content}</p:spTree></p:cSld></p:sld>");
    let first = slide(" show=\"0\"", &format!("{}{}", shape(2, "", "Visible"), shape(3, " hidden=\"1\"", "Draft")));
    let second = slide("", &shape(2, "", "Second"));
    let cell = |text: &str| format!("<a:tc><a:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></a:txBody></a:tc>");
    let third = slide(
        "",
        &format!(
            "<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr>{}{}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>\
             <p:graphicFrame><a:graphic><a:graphicData uri=\"x/chart\"><c:chart r:id=\"rId2\"/></a:graphicData></a:graphic></p:graphicFrame>",
            cell("Q1"),
            cell("10")
        ),
    );
    let rels = r#"<Relationships><Relationship Id="rId1" Target="../notesSlides/notesSlide2.xml"/></Relationships>"#;
    let notes = "<p:notes><p:cSld><p:spTree>\
        <p:sp><p:nvSpPr><p:nvPr><p:ph type=\"sldImg\"/></p:nvPr></p:nvSpPr></p:sp>\
        <p:sp><p:nvSpPr><p:nvPr><p:ph type=\"body\" idx=\"1\"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Say hello</a:t></a:r></a:p><a:p><a:r><a:t>Then pause</a:t></a:r></a:p></p:txBody></p:sp>\
        </p:spTree></p:cSld></p:notes>";
    let text = extract(
        &[
            ("ppt/slides/slide1.xml", &first),
            ("ppt/slides/slide2.xml", &second),
            ("ppt/slides/_rels/slide2.xml.rels", rels),
            ("ppt/notesSlides/notesSlide2.xml", notes),
            ("ppt/slides/slide3.xml", &third),
        ],
        "deck.pptx",
    );
    assert_eq!(
        text,
        "--- slide 1 (hidden) ---\nVisible\n[hidden: Draft]\n\n--- slide 2 ---\nSecond\n[notes] Say hello\n        Then pause\n\n--- slide 3 ---\nQ1\t10\n[chart]"
    );
}

#[test]
fn compressed_entries_are_inflated_and_a_cap_below_the_part_size_gives_no_text() {
    let body = word(&paragraph(&"a".repeat(4096)));
    let packed = container(&[("word/document.xml", 8, deflate(body.as_bytes()), body.as_bytes())]);
    assert_eq!(extract_ooxml_text_from_buffer(&packed, "a.docx", &ExtractOptions::default()), "a".repeat(4096));
    let tight = Limits { max_part_bytes: 1024, ..Limits::default() };
    assert_eq!(try_extract_ooxml_text_from_buffer(&packed, "a.docx", &tight), None);
    let tight = Limits { max_container_bytes: 1024, ..Limits::default() };
    assert_eq!(try_extract_ooxml_text_from_buffer(&packed, "a.docx", &tight), None);
    assert!(try_extract_ooxml_text_from_buffer(&packed, "a.docx", &Limits { max_part_bytes: 1 << 20, ..Limits::default() }).is_some());
}

#[test]
fn an_unknown_compression_method_or_a_corrupt_stream_is_an_extraction_failure() {
    let odd = container(&[("word/document.xml", 12, b"xx".to_vec(), b"xx")]);
    assert_eq!(
        extract_ooxml_text_from_buffer(&odd, "a.docx", &ExtractOptions::default()),
        "Error: office extraction failed — unsupported ZIP compression method 12"
    );
    let broken = container(&[("word/document.xml", 8, vec![0xff; 16], b"<w:document/>")]);
    let text = extract_ooxml_text_from_buffer(&broken, "a.docx", &ExtractOptions::default());
    assert!(text.starts_with("Error: office extraction failed — "), "{text}");
    assert_eq!(try_extract_ooxml_text_from_buffer(&broken, "a.docx", &Limits::default()), None);
}

#[test]
fn a_file_is_read_from_disk_and_an_attached_file_is_lowered_from_its_base64() {
    use base64::Engine;
    let body = word(&paragraph("From disk"));
    let bytes = package(&[("word/document.xml", &body)]);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("memo.docx");
    std::fs::write(&path, &bytes).unwrap();
    assert_eq!(mixdog_ooxml_text::extract_ooxml_text(&mixdog_fsio::Unlaned, &path, &ExtractOptions::default()), "From disk");
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    assert_eq!(office_text_for_file(&encoded, "memo.docx").as_deref(), Some("From disk"));
    assert_eq!(office_text_for_file(&encoded, "memo.docx").as_deref(), Some("From disk"));
    assert_eq!(office_text_for_file(&base64::engine::general_purpose::STANDARD.encode(b"plain"), "memo.docx"), None);
}

#[test]
fn legacy_files_are_recognised_by_label_and_the_package_they_convert_to_is_named() {
    assert_eq!(legacy_office_label_package("application/msword; charset=binary", "a.bin"), "docx");
    assert_eq!(legacy_office_label_package("", "Budget.XLS"), "xlsx");
    assert_eq!(legacy_office_label_package("application/vnd.ms-powerpoint", ""), "pptx");
    assert_eq!(legacy_office_label_package("text/plain", "a.txt"), "");
    assert_eq!(ooxml_label_package(ooxml_mime_by_package("pptx").unwrap(), "x"), "pptx");
    assert_eq!(ooxml_label_package("", "Book.XLSM"), "xlsx");
    assert_eq!(ooxml_label_package("application/vnd.ms-excel.sheet.macroenabled.12", ""), "xlsx");
    assert_eq!(ooxml_label_package("", "notes.txt"), "");
    assert_eq!(ooxml_mime_by_package("odt"), None);
}
