use mixdog_office_author::pptx_writer::{Hyperlink, Presentation, ShapeOptions, TableCell, TableOptions, TextContent, TextOptions, TextRun};
use mixdog_ooxml::zipio::Package;

fn deck_with_text(text: &str) -> Presentation {
    let mut deck = Presentation::new();
    deck.add_slide().add_text(TextContent::Plain(text.to_owned()), None).expect("text");
    deck
}

#[test]
fn a_written_deck_is_a_package_that_reads_back_with_the_text_of_its_slide() {
    let mut deck = deck_with_text("Quarterly results");
    deck.add_slide().add_notes("speaker notes");
    deck.set_title("Board deck");
    let bytes = deck.write().expect("bytes");
    let package = Package::load(&bytes).expect("a package");
    assert!(package.text("ppt/slides/slide1.xml").contains("Quarterly results"));
    assert!(package.contains("ppt/slides/slide2.xml"));
    assert!(package.text("ppt/notesSlides/notesSlide2.xml").contains("speaker notes"));
    assert!(package.text("docProps/core.xml").contains("Board deck"));
    assert_eq!(deck.slide_count(), 2);
}

#[test]
fn text_with_markup_characters_is_escaped_in_the_slide() {
    let package = deck_with_text("a < b & c").package().expect("package");
    let xml = package.text("ppt/slides/slide1.xml");
    assert!(xml.contains("a &lt; b &amp; c"), "{xml}");
}

#[test]
fn a_known_layout_sets_the_sheet_size_and_an_unknown_one_is_refused() {
    let mut deck = Presentation::new();
    deck.set_layout("LAYOUT_WIDE").expect("a built-in layout");
    deck.add_slide();
    let xml = deck.package().expect("package").text("ppt/presentation.xml");
    assert!(xml.contains("<p:sldSz cx=\"12192000\" cy=\"6858000\"/>"), "13.333 x 7.5 in is the wide slide: {xml}");
    assert!(deck.set_layout("LAYOUT_NOPE").is_err());
}

#[test]
fn a_hyperlink_with_neither_a_url_nor_a_slide_is_refused() {
    let mut deck = Presentation::new();
    deck.add_slide();
    let options = TextOptions {
        frame: ShapeOptions { hyperlink: Some(Hyperlink { tooltip: Some("nothing".to_owned()), ..Hyperlink::default() }), ..ShapeOptions::default() },
        ..TextOptions::default()
    };
    let refused = deck.slide_mut(0).expect("slide").add_text(TextContent::Runs(vec![TextRun { text: "x".to_owned(), options: Some(options) }]), None);
    assert!(refused.is_err());
}

#[test]
fn a_table_needs_rows_and_cannot_be_paged_automatically() {
    let mut deck = Presentation::new();
    deck.add_slide();
    let slide = deck.slide_mut(0).expect("slide");
    assert!(slide.add_table(Vec::new(), TableOptions::default()).is_err());
    assert!(slide.add_table(vec![vec![TableCell::Plain("a".to_owned())]], TableOptions { auto_page: true, ..TableOptions::default() }).is_err());
    slide.add_table(vec![vec![TableCell::Plain("cell text".to_owned())]], TableOptions::default()).expect("a one-cell table");
    assert!(deck.package().expect("package").text("ppt/slides/slide1.xml").contains("cell text"));
}

#[test]
fn a_chart_added_to_a_deck_brings_its_part_its_workbook_and_its_series() {
    use mixdog_office_author::pptx_writer::{ChartData, ChartKind, ChartOptions};
    let mut deck = Presentation::new();
    deck.add_slide();
    let months = |name: &str, values: [f64; 3]| ChartData {
        name: name.to_owned(),
        labels: vec![["Jan", "Feb", "Mar"].iter().map(|label| (*label).to_owned()).collect()],
        values: values.iter().map(|value| Some(*value)).collect(),
    };
    deck.add_chart(0, ChartKind::Bar, vec![months("North", [1.0, 2.0, 3.0]), months("South", [4.0, 5.0, 6.0])], ChartOptions::default()).expect("a chart");
    let package = deck.package().expect("package");
    let names = package.names();
    let chart =
        names.iter().find(|name| name.starts_with("ppt/charts/chart") && name.ends_with(".xml")).unwrap_or_else(|| panic!("no chart part in {names:?}"));
    let xml = package.text(chart);
    assert!(xml.contains("North") && xml.contains("South"), "both series are named in the chart");
    assert!(xml.contains("Jan") && xml.contains("Mar"));
    assert!(names.iter().any(|name| name.starts_with("ppt/embeddings/") && name.ends_with(".xlsx")), "the data travels in a workbook: {names:?}");
    assert!(package.text("ppt/slides/slide1.xml").contains("graphicFrame"));
    assert!(package.text("[Content_Types].xml").contains("drawingml.chart+xml"));
}

#[test]
fn a_deck_with_two_slides_numbers_its_parts_and_lists_both_in_the_presentation() {
    let mut deck = deck_with_text("one");
    deck.add_slide().add_text(TextContent::Plain("two".to_owned()), None).expect("text");
    let package = deck.package().expect("package");
    assert!(package.text("ppt/slides/slide1.xml").contains("one"));
    assert!(package.text("ppt/slides/slide2.xml").contains("two"));
    assert_eq!(package.text("ppt/presentation.xml").matches("<p:sldId ").count(), 2);
}
