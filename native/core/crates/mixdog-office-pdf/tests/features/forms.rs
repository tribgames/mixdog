//! Form fields: those the writer lays out are found by name, filled by name, and read back from the saved file.

use std::sync::Arc;

use mixdog_fsio::Unlaned;
use mixdog_office_pdf::forms::{PdfForm, add_form_field, fill_form_values};
use mixdog_office_pdf::writer::create_pdf;
use mixdog_pdf::Guard;
use mixdog_pdf::codec_glue::CodecFilters;
use mixdog_pdf::embed::FontEnv;
use mixdog_pdf::write::{LoadOptions, PdfDocument, SaveOptions};
use mixdog_raster::svg::SvgFonts;
use serde_json::{Value, json};

fn load(bytes: Vec<u8>) -> PdfDocument {
    let options = LoadOptions { ignore_encryption: false, filters: Arc::new(CodecFilters), guard: Guard::unbounded() };
    PdfDocument::load(bytes, &options).expect("the form loads")
}

fn form_bytes() -> Vec<u8> {
    let directory = std::env::temp_dir().join(format!("mixdog-office-pdf-forms-{}", std::process::id()));
    mixdog_testkit::create_dir_all(&directory);
    let path = directory.join("form.pdf");
    let spec = json!({
        "blocks": [
            { "type": "heading", "text": "Approval" },
            { "type": "fieldRow", "items": [
                { "name": "who", "label": "Name" },
                { "name": "when", "label": "Date", "fieldType": "dropdown", "options": ["Mon", "Tue"] }
            ] },
            { "type": "fieldRow", "items": [
                { "name": "ok", "type": "checkbox", "label": "Agreed" },
                { "name": "pick", "type": "radio", "label": "Choice", "options": [{ "value": "a", "label": "Alpha" }, { "value": "b", "label": "Beta" }] }
            ] }
        ]
    });
    create_pdf(&Unlaned, &FontEnv::default(), &SvgFonts::none(), &path.to_string_lossy(), &spec).expect("written");
    mixdog_testkit::read(&path)
}

fn described(doc: &mut PdfDocument) -> Vec<Value> {
    PdfForm::new().describe_fields(doc).expect("described")
}

fn field<'a>(fields: &'a [Value], name: &str) -> &'a Value {
    fields.iter().find(|field| field["name"] == name).unwrap_or_else(|| panic!("no field {name}"))
}

#[test]
fn the_fields_a_document_was_written_with_are_listed_with_their_names_and_kinds() {
    let mut doc = load(form_bytes());
    let fields = described(&mut doc);
    let names: Vec<&str> = fields.iter().map(|field| field["name"].as_str().expect("name")).collect();
    assert_eq!(names, ["who", "when", "ok", "pick"]);
    assert_eq!(field(&fields, "who")["type"], "text");
    assert_eq!(field(&fields, "when")["type"], "dropdown");
    assert_eq!(field(&fields, "ok")["type"], "checkbox");
    assert_eq!(field(&fields, "pick")["type"], "radio");
    assert_eq!(field(&fields, "who")["path"], "/field[1]");
    assert!(field(&fields, "who")["widgets"].as_array().is_some_and(|widgets| !widgets.is_empty()));
}

#[test]
fn values_filled_by_name_survive_saving_and_loading_again() {
    let mut doc = load(form_bytes());
    let mut form = PdfForm::new();
    let filled = fill_form_values(&mut form, &mut doc, &json!({ "who": "Ada Lovelace", "ok": true, "pick": "b", "when": "Tue" })).expect("filled");
    assert_eq!(filled.len(), 4);
    let saved = doc.save(SaveOptions::default());
    let mut again = load(saved);
    let fields = described(&mut again);
    assert_eq!(field(&fields, "who")["value"], "Ada Lovelace");
    assert_eq!(field(&fields, "pick")["value"], "b");
    assert!(field(&fields, "when")["value"].to_string().contains("Tue"), "{}", field(&fields, "when"));
    let before = described(&mut load(form_bytes()));
    assert_ne!(field(&fields, "ok")["value"], field(&before, "ok")["value"], "the checkbox changed");
}

#[test]
fn a_name_the_form_does_not_have_or_an_option_it_does_not_offer_is_refused_with_what_exists() {
    let mut doc = load(form_bytes());
    let mut form = PdfForm::new();
    let missing = fill_form_values(&mut form, &mut doc, &json!({ "nobody": "x" })).unwrap_err();
    assert_eq!(missing.message(), "PDF form has no field named nobody; fields: who, when, ok, pick");
    let option = fill_form_values(&mut form, &mut doc, &json!({ "when": "zzz" })).unwrap_err();
    assert_eq!(option.message(), "Field when has no option zzz; options: Mon, Tue");
}

#[test]
fn a_field_added_to_a_page_is_listed_and_fillable_and_a_taken_name_or_missing_page_is_refused() {
    let mut doc = load(form_bytes());
    let mut form = PdfForm::new();
    add_form_field(&mut form, &mut doc, &json!({ "name": "extra", "type": "text", "page": 1, "x": 40, "y": 40, "width": 120, "height": 20 }), None)
        .expect("added");
    let names: Vec<String> = described(&mut doc).iter().map(|field| field["name"].as_str().expect("name").to_owned()).collect();
    assert_eq!(names, ["who", "when", "ok", "pick", "extra"]);
    fill_form_values(&mut form, &mut doc, &json!({ "extra": "typed in" })).expect("filled");
    assert_eq!(field(&described(&mut doc), "extra")["value"], "typed in");
    let taken = add_form_field(&mut form, &mut doc, &json!({ "name": "who", "page": 1, "x": 1, "y": 1, "width": 10, "height": 10 }), None).unwrap_err();
    assert_eq!(taken.message(), "A field already exists with the specified name: \"who\"");
    let off_the_end = add_form_field(&mut form, &mut doc, &json!({ "name": "late", "page": 9, "x": 1, "y": 1, "width": 10, "height": 10 }), None).unwrap_err();
    assert_eq!(off_the_end.message(), "PDF page out of range: 9");
}
