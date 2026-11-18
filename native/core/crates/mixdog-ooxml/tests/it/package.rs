use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_ooxml::opc::{add_package_relationship, ensure_content_type_override, ensure_default_content_type, next_relationship_id, remove_package_relationship};
use mixdog_ooxml::fingerprint::{document_fingerprint, document_fingerprint_bytes};
use mixdog_ooxml::package::{load_package, open_package_bytes, package_buffer};
use mixdog_ooxml::placeholder_scan::placeholder_text_issues;
use mixdog_ooxml::portable::replace_across_runs;
use mixdog_ooxml::text_metrics::{BlockOptions, FontSpec, Paragraph, TextMeasurer};
use mixdog_ooxml::zipio::Package;
use serde_json::{Map, json};

use crate::support::Doc;

#[test]
fn a_package_written_and_read_again_keeps_every_part_byte_for_byte_and_in_order() {
    let mut package = Package::new();
    package.set("[Content_Types].xml", "<Types/>");
    package.set("word/document.xml", "<w:document>한글</w:document>");
    package.set("word/media/a.bin", vec![0u8, 1, 2, 255]);
    let bytes = package.generate().expect("a package");
    let again = Package::load(&bytes).expect("read back");
    assert_eq!(again.names(), package.names());
    assert_eq!(again.file("word/media/a.bin"), Some(&[0u8, 1, 2, 255][..]));
    assert_eq!(again.text("word/document.xml"), "<w:document>한글</w:document>");
    let mut smaller = again;
    smaller.remove("word/media/a.bin");
    assert!(!smaller.contains("word/media/a.bin") && smaller.contains("word/document.xml"));
    assert!(Package::load(b"not a zip at all").is_err());
    assert!(open_package_bytes(b"not a zip at all", "memo.docx").is_err());
}

#[test]
fn a_saved_document_reopens_to_the_same_package() {
    let doc = Doc::new("docx");
    let package = doc.package();
    let regenerated = package_buffer(&package).expect("a buffer");
    assert_eq!(Package::load(&regenerated).expect("read back").names(), package.names());
    assert_eq!(load_package(&Unlaned, &doc.path).expect("loaded").text("word/document.xml"), package.text("word/document.xml"));
}

#[test]
fn relationships_get_the_next_free_id_and_can_be_removed() {
    let mut package = Package::new();
    package.set("[Content_Types].xml", "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"></Types>");
    let rels = "word/_rels/document.xml.rels";
    let first = add_package_relationship(&mut package, rels, "http://example.test/rel/a", "a.xml", "");
    let second = add_package_relationship(&mut package, rels, "http://example.test/rel/b", "https://example.com/x", "External");
    assert_eq!((first.as_str(), second.as_str()), ("rId1", "rId2"));
    assert!(package.text(rels).contains("TargetMode=\"External\""));
    assert_eq!(next_relationship_id(&package.text(rels)), "rId3");
    remove_package_relationship(&mut package, rels, "rId1");
    assert!(!package.text(rels).contains("a.xml") && package.text(rels).contains("example.com"));
    assert_eq!(next_relationship_id(&package.text(rels)), "rId3");
}

#[test]
fn a_content_type_is_declared_once_however_often_it_is_ensured() {
    let mut package = Package::new();
    package.set("[Content_Types].xml", "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"></Types>");
    for _ in 0..2 {
        ensure_content_type_override(&mut package, "/word/comments.xml", "application/x-comments");
        ensure_default_content_type(&mut package, "png", "image/png");
    }
    let types = package.text("[Content_Types].xml");
    assert_eq!(types.matches("PartName=\"/word/comments.xml\"").count(), 1);
    assert_eq!(types.matches("Extension=\"png\"").count(), 1);
}

#[test]
fn validation_reports_a_relationship_whose_target_part_is_missing() {
    let doc = Doc::new("docx");
    doc.assert_valid();
    let mut package = doc.package();
    add_package_relationship(&mut package, "word/_rels/document.xml.rels", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image", "media/none.png", "");
    std::fs::write(&doc.path, package_buffer(&package).expect("a buffer")).expect("written");
    let report = doc.validate();
    assert_eq!(report["ok"], json!(false), "{report}");
    assert!(!report["missingRelationships"].as_array().expect("a list").is_empty(), "{report}");
}

#[test]
fn validation_reports_a_missing_main_part_and_a_part_that_is_not_xml() {
    let doc = Doc::new("docx");
    let mut package = doc.package();
    package.set("word/styles.xml", "<w:styles><unclosed></w:styles>");
    std::fs::write(&doc.path, package_buffer(&package).expect("a buffer")).expect("written");
    let report = doc.validate();
    assert_eq!(report["ok"], json!(false));
    assert!(!report["malformedXml"].as_array().expect("a list").is_empty(), "{report}");
    package.remove("word/document.xml");
    std::fs::write(&doc.path, package_buffer(&package).expect("a buffer")).expect("written");
    let report = doc.validate();
    assert!(report["missing"].as_array().expect("a list").iter().any(|name| name == "word/document.xml"), "{report}");
}

#[test]
fn the_fingerprint_follows_the_content_and_not_the_save() {
    let doc = Doc::new("docx");
    let before = document_fingerprint(&Unlaned, &doc.path, "docx").expect("a fingerprint");
    assert_eq!(document_fingerprint(&Unlaned, &doc.path, "docx").expect("again"), before);
    let bytes = std::fs::read(&doc.path).expect("the file");
    assert_eq!(document_fingerprint_bytes(&bytes, "docx").expect("bytes"), before);
    doc.apply(json!([{ "op": "append_text", "text": "changed" }]));
    assert_ne!(document_fingerprint(&Unlaned, &doc.path, "docx").expect("after"), before);
    assert!(document_fingerprint_bytes(b"junk", "docx").is_err());
}

#[test]
fn placeholder_text_is_flagged_at_its_path_and_real_text_is_not() {
    let flagged = placeholder_text_issues("Lorem ipsum dolor sit amet", "/body/p[1]", &Map::new());
    assert!(!flagged.is_empty());
    assert!(flagged.iter().all(|issue| issue["path"] == json!("/body/p[1]")));
    assert!(placeholder_text_issues("Revenue grew 12% on the quarter.", "/body/p[2]", &Map::new()).is_empty());
}

#[test]
fn a_replacement_matches_across_run_boundaries_and_lands_in_the_first_run() {
    let xml = "<w:p><w:r><w:t>Hel</w:t></w:r><w:r><w:t>lo wor</w:t></w:r><w:r><w:t>ld!</w:t></w:r></w:p>";
    let replaced = replace_across_runs(xml, "w:t", "Hello world", "Bye").expect("a replacement");
    assert_eq!(replaced.count, 1);
    assert!(replaced.xml.contains(">Bye<") && replaced.xml.contains(">!<"), "{}", replaced.xml);
    assert_eq!(replace_across_runs(xml, "w:t", "absent", "x").expect("none").count, 0);
}

fn registry() -> Registry {
    let mut registry = Registry::new();
    for name in ["LiberationSans-Regular.ttf", "LiberationSans-Bold.ttf"] {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../mixdog-pdf/assets/standard_fonts").join(name);
        registry.register_file(&Unlaned, &path, Some("Liberation Sans")).expect("a face");
    }
    registry
}

fn spec(size: f64, bold: bool) -> FontSpec {
    FontSpec { font_name: Some("Liberation Sans".to_owned()), font_size: Some(size), bold, italic: false }
}

#[test]
fn text_width_grows_with_the_text_and_the_size_and_a_bold_face_is_measured_as_bold() {
    let registry = registry();
    let measurer = TextMeasurer::new(&Unlaned, &registry);
    assert!(measurer.font_available("Liberation Sans"));
    assert!(!measurer.font_available("No Such Family"));
    let one = measurer.measure_text_width("H", &spec(16.0, false)).expect("a width");
    let two = measurer.measure_text_width("HH", &spec(16.0, false)).expect("a width");
    assert!((two - 2.0 * one).abs() < 0.05, "{one} {two}");
    let big = measurer.measure_text_width("HH", &spec(32.0, false)).expect("a width");
    assert!((big - 2.0 * two).abs() < 0.1, "{two} {big}");
    let bold = measurer.measure_text_width("Hello world", &spec(16.0, true)).expect("a width");
    let plain = measurer.measure_text_width("Hello world", &spec(16.0, false)).expect("a width");
    assert!(bold > plain);
    assert_eq!(measurer.measure_text_width("", &spec(16.0, false)).expect("empty"), 0.0);
}

#[test]
fn a_paragraph_wraps_at_spaces_within_the_measure_and_a_narrower_measure_needs_more_lines() {
    let registry = registry();
    let measurer = TextMeasurer::new(&Unlaned, &registry);
    let font = spec(16.0, false);
    let text = "the quick brown fox jumps over the lazy dog";
    let lines = measurer.wrap_paragraph(text, 120.0, &font).expect("lines");
    assert!(lines.len() > 1);
    assert_eq!(lines.join(" ").split_whitespace().collect::<Vec<_>>().join(" "), text);
    for line in &lines {
        assert!(measurer.measure_text_width(line.trim_end(), &font).expect("a width") <= 120.0 + 0.01, "{line}");
    }
    let paragraph = Paragraph { text: text.to_owned(), font_name: Some("Liberation Sans".to_owned()), font_size: Some(16.0), ..Paragraph::default() };
    let wide = measurer.measure_text_block(std::slice::from_ref(&paragraph), &BlockOptions { width: 400.0, ..BlockOptions::default() }).expect("a block");
    let narrow = measurer.measure_text_block(std::slice::from_ref(&paragraph), &BlockOptions { width: 120.0, ..BlockOptions::default() }).expect("a block");
    assert!(narrow.lines > wide.lines && narrow.height > wide.height);
    assert_eq!(narrow.lines, lines.len());
}
