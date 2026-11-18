//! The Excel builder: a measured sheet becomes a workbook whose parts read back with the sheet's name and text.

use std::collections::BTreeMap;

use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_office_author::xlsx_build::build_xlsx_from_sheets;
use mixdog_ooxml::zipio::Package;
use serde_json::{Value, json};

fn text(value: &str, left: f64, top: f64) -> Value {
    json!({
        "rect": { "left": left, "top": top, "right": left + 120.0, "bottom": top + 20.0 },
        "text": value, "font": "Malgun Gothic", "size": 11, "bold": false, "italic": false, "color": "374151", "align": "left", "lines": 1, "indent": 0,
    })
}

fn sheet(name: &str, texts: Vec<Value>) -> Value {
    json!({ "name": name, "texts": texts, "boxes": [], "tables": [], "charts": [], "pictures": [], "padRight": 0, "padBottom": 0, "gridlines": false })
}

/// The registry a host builds from its font folders; here the one tracked face, under the family the texts name.
fn registry() -> Registry {
    let face = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../mixdog-pdf/assets/standard_fonts/LiberationSans-Regular.ttf");
    let mut registry = Registry::new();
    registry.register_file(&Unlaned, &face, Some("Malgun Gothic")).expect("the tracked face registers");
    registry
}

fn build(sheets: Vec<Value>) -> Result<Package, String> {
    let built = build_xlsx_from_sheets(&Unlaned, &registry(), &json!({ "sheets": sheets, "notes": [] }), &BTreeMap::new(), "Report")?;
    Ok(Package::load(&built.bytes).expect("a package"))
}

#[test]
fn every_measured_sheet_is_a_worksheet_with_its_name_and_its_text() {
    let package = build(vec![sheet("보고", vec![text("제목", 0.0, 0.0), text("합계", 0.0, 40.0)]), sheet("Ops", vec![text("second sheet", 0.0, 0.0)])]).expect("built");
    let workbook = package.text("xl/workbook.xml");
    assert!(workbook.contains("name=\"보고\"") && workbook.contains("name=\"Ops\""), "{workbook}");
    // The builder writes every text as a set_range operation, and the portable writer keeps a text in its cell as an inline string.
    assert!(package.contains("xl/worksheets/sheet1.xml") && package.contains("xl/worksheets/sheet2.xml"));
    let (first, second) = (package.text("xl/worksheets/sheet1.xml"), package.text("xl/worksheets/sheet2.xml"));
    for word in ["제목", "합계"] {
        assert!(first.contains(&format!("<is><t>{word}</t></is>")), "{word} is missing from the first sheet: {first}");
    }
    assert!(second.contains("<is><t>second sheet</t></is>") && !second.contains("제목"), "{second}");
}

#[test]
fn a_workbook_without_a_sheet_is_refused_with_the_way_to_write_one() {
    let refused = build(Vec::new()).err().expect("refused");
    assert_eq!(refused, "The HTML holds no <section data-sheet=\"이름\">; every worksheet is one section with its sheet name.");
}
