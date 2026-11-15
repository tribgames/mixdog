//! Twin test `forms`: the form fields of Node (the recording `native/core/fixtures/office-forms/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-forms.mjs`: `pdf-forms.mjs` over pdf-lib) against this crate. Fields made
//! with `addFormField` and drawn with `updateFieldAppearances`, the inspector's field descriptions, `lintPdfFormFields`,
//! and a saved form filled by name with `fillFormValues` and measured with `clippedFormValues`. Field descriptions, lint
//! results, fill results, errors and clipped-value reports are equal exactly (numbers within 1e-9, relative); a widget's
//! appearance is compared as the content of its streams, token by token, which is stricter than the rendered page the
//! content paints. Re-recording is `twin_live_forms` (ignored: it runs Node).

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_office_base::twin;
use mixdog_office_pdf::forms::{
    FormFont, PdfForm, add_form_field, clipped_form_values, fill_form_values, lint_pdf_form_fields,
};
use mixdog_pdf::codec_glue::CodecFilters;
use mixdog_pdf::write::info::decode_text_string;
use mixdog_pdf::write::store::ObjectStore;
use mixdog_pdf::write::{LoadOptions, PdfDocument};
use mixdog_pdf::{Guard, Obj};
use serde_json::{Map, Value, json};

const SET: &str = "office-forms";
const RECORDER: &str = "benchmarks/rust-core/recorders/record-office-forms.mjs";
const TOLERANCE: f64 = 1e-9;

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= TOLERANCE * a.abs().max(b.abs()).max(1.0)
}

/// Two contents are the same when their tokens are: numbers within the tolerance, everything else exactly.
fn same_content(expected: &str, actual: &str) -> bool {
    let (left, right): (Vec<&str>, Vec<&str>) = (expected.split_whitespace().collect(), actual.split_whitespace().collect());
    left.len() == right.len()
        && left.iter().zip(&right).all(|(a, b)| {
            a == b
                || match (a.parse::<f64>(), b.parse::<f64>()) {
                    (Ok(x), Ok(y)) => close(x, y),
                    _ => false,
                }
        })
}

/// The paths at which two values differ: numbers within the tolerance, a `content` text token by token, everything else
/// exactly, object key order free.
fn differences(path: &str, expected: &Value, actual: &Value, out: &mut Vec<String>) {
    match (expected, actual) {
        (Value::Object(want), Value::Object(got)) => {
            for (key, value) in want {
                match got.get(key) {
                    Some(other) => differences(&format!("{path}/{key}"), value, other, out),
                    None => out.push(format!("{path}/{key}: missing from the output")),
                }
            }
            for key in got.keys().filter(|key| !want.contains_key(*key)) {
                out.push(format!("{path}/{key}: not in the recording"));
            }
        }
        (Value::Array(want), Value::Array(got)) => {
            if want.len() != got.len() {
                out.push(format!("{path}: {} items recorded, {} produced", want.len(), got.len()));
            }
            for (index, (a, b)) in want.iter().zip(got).enumerate() {
                differences(&format!("{path}/{index}"), a, b, out);
            }
        }
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap_or(f64::NAN), b.as_f64().unwrap_or(f64::NAN));
            if !close(a, b) {
                out.push(format!("{path}: recorded {a}, produced {b}"));
            }
        }
        (Value::String(a), Value::String(b)) if path.ends_with("/content") => {
            if !same_content(a, b) {
                out.push(format!("{path}: recorded {a:?}, produced {b:?}"));
            }
        }
        _ if expected == actual => {}
        _ => out.push(format!("{path}: recorded {expected}, produced {actual}")),
    }
}

fn assert_same(what: &str, expected: &Value, actual: &Value) {
    let mut found = Vec::new();
    differences("", expected, actual, &mut found);
    assert!(
        found.is_empty(),
        "{what} differs from the recording:\n{}",
        found.iter().take(12).cloned().collect::<Vec<_>>().join("\n")
    );
}

// ---- reading a document the way the recorder does ------------------------------------------------------------------

fn numbers(store: &ObjectStore, obj: Option<&Obj>) -> Vec<f64> {
    match obj.and_then(|obj| store.resolve(obj)) {
        Some(Obj::Array(items)) => items.iter().filter_map(|item| store.resolve(item).and_then(Obj::as_num)).collect(),
        _ => Vec::new(),
    }
}

fn rectangle(values: &[f64]) -> Value {
    json!([values[0], values[1], values[2] - values[0], values[3] - values[1]])
}

fn stream_record(store: &ObjectStore, entry: &Obj) -> Value {
    let resolved = store.resolve(entry).expect("an appearance object");
    let dict = resolved.dict_or_stream_dict().expect("a stream dictionary");
    let bbox = numbers(store, dict.get_raw("BBox"));
    let fonts: Vec<Value> = match store.lookup(dict, "Resources") {
        Some(Obj::Dict(resources)) => match store.lookup(resources, "Font") {
            Some(Obj::Dict(fonts)) => fonts.keys().map(|key| Value::String(key.to_owned())).collect(),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    };
    let content = match resolved {
        Obj::Stream(stream) => {
            let bytes = stream.decode(&CodecFilters, &Guard::unbounded()).expect("a stream that decodes");
            bytes.iter().map(|byte| char::from(*byte)).collect::<String>()
        }
        _ => panic!("an appearance that is not a stream"),
    };
    json!({ "box": rectangle(&bbox), "fonts": fonts, "content": content })
}

fn appearance_record(store: &ObjectStore, entry: Option<&Obj>) -> Value {
    let Some(entry) = entry else {
        return Value::Null;
    };
    match store.resolve(entry) {
        Some(Obj::Dict(mapping)) => {
            let mut map = Map::new();
            for (key, value) in mapping.iter() {
                map.insert(key.to_owned(), stream_record(store, value));
            }
            Value::Object(map)
        }
        _ => stream_record(store, entry),
    }
}

fn widget_record(store: &ObjectStore, widget: &mixdog_pdf::Dict) -> Value {
    let ap = match store.lookup(widget, "AP") {
        Some(Obj::Dict(ap)) => Some(ap.clone()),
        _ => None,
    };
    let pick = |key: &str| ap.as_ref().map_or(Value::Null, |ap| appearance_record(store, ap.get_raw(key)));
    let state = match store.lookup(widget, "AS") {
        Some(Obj::Name(name)) => Value::String(name.to_string()),
        _ => Value::Null,
    };
    let da = match store.lookup(widget, "DA") {
        Some(Obj::Str(bytes)) => Value::String(decode_text_string(bytes)),
        _ => Value::Null,
    };
    json!({
        "rect": rectangle(&numbers(store, widget.get_raw("Rect"))),
        "as": state,
        "flags": store.lookup(widget, "F").and_then(Obj::as_num).unwrap_or(0.0),
        "da": da,
        "normal": pick("N"),
        "down": pick("D"),
        "rollover": pick("R"),
    })
}

fn form_record(form: &PdfForm, doc: &mut PdfDocument) -> Value {
    let described = form.describe_fields(doc).expect("the fields");
    let fields = form.fields(doc).expect("the fields");
    let store = doc.store();
    let mut detail = Vec::new();
    for (field, description) in fields.iter().zip(&described) {
        let dict = store.dict(field.reference).expect("the field dictionary").clone();
        let kids: Vec<Arc<mixdog_pdf::Dict>> = match store.lookup(&dict, "Kids") {
            Some(Obj::Array(kids)) => kids
                .iter()
                .map(|kid| match store.resolve(kid) {
                    Some(Obj::Dict(widget)) => widget.clone(),
                    _ => panic!("a kid that is not a dictionary"),
                })
                .collect(),
            _ => vec![dict.clone()],
        };
        let da = match store.lookup(&dict, "DA") {
            Some(Obj::Str(bytes)) => Value::String(decode_text_string(bytes)),
            _ => Value::Null,
        };
        let indices = match store.lookup(&dict, "I") {
            Some(Obj::Array(_)) => json!(numbers(store, dict.get_raw("I"))),
            _ => Value::Null,
        };
        detail.push(json!({
            "name": description["name"],
            "da": da,
            "flags": store.lookup(&dict, "Ff").and_then(Obj::as_num).unwrap_or(0.0),
            "indices": indices,
            "widgets": kids.iter().map(|widget| widget_record(store, widget)).collect::<Vec<_>>(),
        }));
    }
    json!({ "described": described, "detail": detail })
}

// ---- building and loading ------------------------------------------------------------------------------------------

fn page_sizes(value: &Value) -> Vec<[f64; 2]> {
    value
        .as_array()
        .expect("pages")
        .iter()
        .map(|page| [page[0].as_f64().expect("width"), page[1].as_f64().expect("height")])
        .collect()
}

fn font_of(form: &mut PdfForm, doc: &mut PdfDocument) -> FormFont {
    form.default_font(doc).expect("the default font")
}

fn message(result: Result<(), mixdog_office_pdf::forms::FormError>) -> Value {
    match result {
        Ok(()) => Value::Null,
        Err(error) => Value::String(error.message().to_owned()),
    }
}

fn build(pages: &[[f64; 2]], fields: &[Value]) -> (PdfDocument, PdfForm, Vec<Value>, Value) {
    let mut doc = PdfDocument::create();
    for [width, height] in pages {
        doc.add_page(*width, *height).expect("a page");
    }
    let mut form = PdfForm::new();
    let font = font_of(&mut form, &mut doc);
    let mut added = Vec::new();
    for field in fields {
        let result = message(add_form_field(&mut form, &mut doc, field, Some(&font)));
        let failed = !result.is_null();
        added.push(result);
        if failed {
            break;
        }
    }
    let refreshed = message(form.update_field_appearances(&mut doc, Some(&font)));
    (doc, form, added, refreshed)
}

fn load(bytes: Vec<u8>) -> PdfDocument {
    let options = LoadOptions {
        ignore_encryption: false,
        filters: Arc::new(CodecFilters),
        guard: Guard::unbounded(),
    };
    PdfDocument::load(bytes, &options).expect("the saved form loads")
}

// ---- the tests -----------------------------------------------------------------------------------------------------

#[test]
fn created_fields_match_node() {
    let golden = twin::load_golden(SET);
    let cases = golden["create"].as_array().expect("create cases");
    assert!(cases.len() >= 15, "{} create cases", cases.len());
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let fields = case["fields"].as_array().expect("fields").clone();
        let (mut doc, form, added, refreshed) = build(&page_sizes(&case["pages"]), &fields);
        assert_same(&format!("{name}: the add results"), &case["added"], &Value::Array(added.clone()));
        assert_same(&format!("{name}: the refresh result"), &case["refreshed"], &refreshed);
        if added.iter().any(|entry| !entry.is_null()) || !refreshed.is_null() {
            continue;
        }
        let record = form_record(&form, &mut doc);
        assert_same(&format!("{name}: the fields"), &json!({ "described": case["described"], "detail": case["detail"] }), &record);
    }
}

#[test]
fn lint_matches_node() {
    let golden = twin::load_golden(SET);
    let cases = golden["lint"].as_array().expect("lint cases");
    assert!(cases.len() >= 10, "{} lint cases", cases.len());
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let mut fields = case["fields"].as_array().expect("fields").clone();
        let result = lint_pdf_form_fields(&mut fields, &page_sizes(&case["pages"]));
        assert_same(&format!("{name}: the lint"), &case["result"], &result);
        assert_same(&format!("{name}: the fields as adopted"), &case["adopted"], &Value::Array(fields));
    }
}

#[test]
fn filled_forms_match_node() {
    let golden = twin::load_golden(SET);
    let base = STANDARD.decode(golden["fillBase"]["pdf"].as_str().expect("the base form")).expect("base64");
    let cases = golden["fill"].as_array().expect("fill cases");
    assert!(cases.len() >= 25, "{} fill cases", cases.len());
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let mut doc = load(base.clone());
        let mut form = PdfForm::new();
        let font = font_of(&mut form, &mut doc);
        match fill_form_values(&mut form, &mut doc, &case["values"]) {
            Err(error) => {
                assert_eq!(case["error"].as_str(), Some(error.message()), "{name}: the error");
            }
            Ok(filled) => {
                assert!(case.get("error").is_none(), "{name}: Node refused, Rust filled");
                assert_same(&format!("{name}: the names filled"), &case["filled"], &json!(filled));
                form.update_field_appearances(&mut doc, Some(&font)).expect("the appearances");
                let clipped = clipped_form_values(&form, &mut doc, &case["values"], Some(&font.font)).expect("the clip check");
                assert_same(&format!("{name}: the clipped values"), &case["clipped"], &Value::Array(clipped));
                let record = form_record(&form, &mut doc);
                assert_same(&format!("{name}: the fields"), &json!({ "described": case["described"], "detail": case["detail"] }), &record);
            }
        }
    }
}

#[test]
fn clipped_values_need_a_font() {
    let golden = twin::load_golden(SET);
    let base = STANDARD.decode(golden["fillBase"]["pdf"].as_str().expect("the base form")).expect("base64");
    let mut doc = load(base);
    let form = PdfForm::new();
    let clipped = clipped_form_values(&form, &mut doc, &json!({ "tiny": "This does not fit the tiny box" }), None).expect("no font");
    assert_same("no font", &golden["clippedNoFont"], &Value::Array(clipped));
}

/// Re-records the fixture with Node and checks the recording is the one in the repository. Ignored: it runs Node (the
/// Node source of this checkout, or the tree `MIXDOG_NODE_TREE` names).
#[test]
#[ignore = "runs node: re-records the fixture"]
fn twin_live_forms() {
    let path = twin::repo_root().join("native/core/fixtures").join(SET).join("golden.json");
    let before = mixdog_testkit::read(&path);
    let printed = twin::run_recorder(RECORDER, &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder wrote nothing: {printed}");
    let after = mixdog_testkit::read(&path);
    assert!(before == after, "the recording differs from a new one");
}
