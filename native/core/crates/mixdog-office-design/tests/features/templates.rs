//! The packaged template deck: what its inspection lists and how a selection of its slides becomes a new deck.

use std::path::PathBuf;

use mixdog_fsio::Unlaned;
use mixdog_office_design::templates::inspect::{create_pptx_slide_selection, pptx_slide_entries};
use mixdog_office_design::templates::inspect_office_template;
use mixdog_ooxml::zipio::Package;
use serde_json::json;

fn executive() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets/templates/mixdog-executive.pptx")
}

fn load(path: &std::path::Path) -> Package {
    Package::load(&std::fs::read(path).expect("a deck")).expect("a package")
}

/// The text runs of a slide, in order.
fn runs(package: &Package, part: &str) -> Vec<String> {
    let xml = package.text(part);
    let mut found = Vec::new();
    let mut rest = xml.as_str();
    while let Some(start) = rest.find("<a:t>") {
        let after = &rest[start + 5..];
        let end = after.find("</a:t>").expect("a closed run");
        found.push(after[..end].to_owned());
        rest = &after[end..];
    }
    found
}

#[test]
fn the_inspection_of_a_deck_lists_its_slides_in_order_with_a_kind_and_a_title_each() {
    let inspection = inspect_office_template(&Unlaned, &executive().to_string_lossy(), "pptx").expect("inspected");
    let slides = inspection["sampleSlides"].as_array().expect("slides");
    let source = load(&executive());
    assert_eq!(slides.len(), pptx_slide_entries(&source).len());
    for (at, slide) in slides.iter().enumerate() {
        assert_eq!(slide["slide"], at + 1);
        assert!(slide["kind"].as_str().is_some_and(|kind| !kind.is_empty()), "{slide}");
        assert!(slide["textChars"].is_number());
    }
}

#[test]
fn a_selection_of_slides_is_a_deck_of_exactly_those_slides_in_the_order_given() {
    let directory = tempfile::tempdir().expect("dir");
    let output = directory.path().join("picked.pptx");
    let source = load(&executive());
    let entries = pptx_slide_entries(&source);
    assert!(entries.len() >= 3);
    let answer = create_pptx_slide_selection(&Unlaned, &executive().to_string_lossy(), &json!([3, 1]), &output.to_string_lossy()).expect("selected");
    assert_eq!(answer["count"], 2);
    assert_eq!(answer["slides"], json!([3, 1]));
    let picked = load(&output);
    let picked_entries = pptx_slide_entries(&picked);
    assert_eq!(picked_entries.len(), 2);
    assert_eq!(runs(&picked, &picked_entries[0].name), runs(&source, &entries[2].name), "the first slide of the new deck is slide 3 of the source");
    assert_eq!(runs(&picked, &picked_entries[1].name), runs(&source, &entries[0].name));
    assert!(picked.text("docProps/app.xml").contains("<Slides>2</Slides>"));
}

#[test]
fn a_selection_that_is_empty_not_whole_or_beyond_the_deck_is_refused_and_writes_nothing() {
    let directory = tempfile::tempdir().expect("dir");
    let output = directory.path().join("never.pptx");
    let count = pptx_slide_entries(&load(&executive())).len();
    let source = executive().to_string_lossy().into_owned();
    let target = output.to_string_lossy().into_owned();
    for bad in [json!([]), json!([0]), json!([1.5]), json!([-1]), json!("1")] {
        assert_eq!(
            create_pptx_slide_selection(&Unlaned, &source, &bad, &target),
            Err("PPTX slide selection requires positive integer slide numbers".to_owned()),
            "{bad}"
        );
    }
    assert_eq!(
        create_pptx_slide_selection(&Unlaned, &source, &json!([count + 1]), &target),
        Err(format!("PPTX slide selection is outside source deck range 1-{count}"))
    );
    assert!(!output.exists());
}
