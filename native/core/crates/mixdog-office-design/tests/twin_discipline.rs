//! Twin test `discipline`: the recording of Node's office design modules (`native/core/fixtures/office-discipline/
//! golden.json`, written by `benchmarks/rust-core/recorders/record-office-discipline.mjs`) against this crate. Every
//! output value is compared, and the exact JSON text of each. Re-recording is `twin_live_discipline` (ignored: it
//! runs Node).

use mixdog_js::{json_number, json_stringify, to_number_of};
use mixdog_office_base::twin;
use mixdog_office_design::art_direction::resolve_office_art_direction;
use mixdog_office_design::content_model::{bind_office_content, normalize_office_content_model, office_number_format, summarize_office_content_model};
use mixdog_office_design::creative_director::{COMPOSE_OPERATIONS, apply_office_creative_brief, compose_operation, direct_office_story};
use mixdog_office_design::discipline::{
    MAX_ACCENT_HUE_FAMILIES, MAX_FONT_FAMILIES_PER_SLIDE, STATE_ROLES, contrast_ratio, design_discipline_brief, font_family_key, hsl_to_hex, is_motif_shape,
    is_picture_shape, is_safe_font_family, normalize_palette_tokens, normalize_typography_tokens, relative_luminance, saturated_hue_families, signed_visual_type,
};
use mixdog_office_design::table_input::{DEFAULT_FIELD, compose_table_rows};
use mixdog_office_design::tokens::{CompositionContext, compact_design, hex, merge, office_design_catalog, provenance_text, resolve_office_design, strings};
use serde_json::{Map, Value, json};

fn golden() -> Value {
    twin::load_golden("office-discipline")
}

fn cases<'a>(golden: &'a Value, section: &str) -> &'a [Value] {
    golden[section].as_array().unwrap_or_else(|| panic!("section {section}"))
}

/// Node's `{ value }` / `{ error }` of an attempt.
fn attempt(result: Result<Value, String>) -> Value {
    match result {
        Ok(value) => json!({ "value": value }),
        Err(error) => json!({ "error": error }),
    }
}

/// The recorded `{ value }` or `{ error }` of a case.
fn recorded(case: &Value) -> Value {
    if case.get("error").is_some() { json!({ "error": case["error"] }) } else { json!({ "value": case["value"] }) }
}

/// The output equals the recording value for value, and as JSON text.
fn check(what: &str, case: &Value, expected: &Value, actual: &Value) {
    let found = twin::differences(expected, actual);
    let shown = json_stringify(&case["input"]);
    let shown = shown.chars().take(160).collect::<String>();
    assert!(found.is_empty(), "{what} {shown}: {}", found.iter().take(8).cloned().collect::<Vec<_>>().join("; "));
    let (want, got) = (json_stringify(expected), json_stringify(actual));
    let at = want.bytes().zip(got.bytes()).position(|(a, b)| a != b);
    assert!(want == got, "{what} {shown}: the JSON text differs at byte {at:?} (recorded {} bytes, produced {})", want.len(), got.len());
}

fn number(value: &Value) -> f64 {
    to_number_of(Some(value))
}

fn optional_number(value: Option<f64>) -> Value {
    value.map_or(Value::Null, json_number)
}

fn context_of(recorded: &Value) -> CompositionContext {
    if recorded.is_null() {
        return CompositionContext { purpose: "explain".into(), expression_mode: "strong-fit".into(), recent_compositions: json!([]) };
    }
    CompositionContext {
        purpose: recorded["purpose"].as_str().expect("purpose").to_owned(),
        expression_mode: recorded["expressionMode"].as_str().expect("expressionMode").to_owned(),
        recent_compositions: recorded["recentCompositions"].clone(),
    }
}

fn library_of<'a>(golden: &'a Value, name: &Value) -> Option<&'a Value> {
    name.as_str().map(|name| &golden["libraries"][name])
}

fn typography_value(requested: &Value, fallback: &Value) -> Value {
    let result = normalize_typography_tokens(Some(requested), Some(fallback));
    json!({ "typography": result.typography, "replaced": result.replaced, "familyCount": result.family_count })
}

fn replay_discipline(g: &Value) {
    let d = &g["discipline"];
    assert_eq!(d["constants"]["maxFontFamiliesPerSlide"], json!(MAX_FONT_FAMILIES_PER_SLIDE));
    assert_eq!(d["constants"]["maxAccentHueFamilies"], json!(MAX_ACCENT_HUE_FAMILIES));
    assert_eq!(d["constants"]["stateRoles"], json!(STATE_ROLES));
    for case in cases(d, "fonts") {
        let name = case["input"].as_str().expect("font");
        assert_eq!(font_family_key(name), case["key"].as_str().expect("key"), "font key of {name:?}");
        assert_eq!(is_safe_font_family(name), case["safe"].as_bool().expect("safe"), "safe font {name:?}");
    }
    for case in cases(d, "typography") {
        let actual = attempt(Ok(typography_value(&case["input"]["requested"], &case["input"]["fallback"])));
        check("typography", case, &recorded(case), &actual);
    }
    for case in cases(d, "palettes") {
        let result = normalize_palette_tokens(&case["input"]);
        let actual = attempt(Ok(json!({ "colors": result.colors, "adjustments": result.adjustments })));
        check("palette", case, &recorded(case), &actual);
    }
    for case in cases(d, "hsl") {
        let input = case["input"].as_array().expect("triple");
        let hex = hsl_to_hex(number(&input[0]), number(&input[1]), number(&input[2]));
        assert_eq!(hex, case["hex"].as_str().expect("hex"), "hslToHex {}", case["input"]);
    }
    for case in cases(d, "contrast") {
        let input = case["input"].as_array().expect("pair");
        let (front, back) = (input[0].as_str().expect("colour"), input[1].as_str().expect("colour"));
        check("contrast ratio", case, &json!({ "v": case["ratio"] }), &json!({ "v": optional_number(contrast_ratio(front, back)) }));
        check("foreground luminance", case, &json!({ "v": case["foreground"] }), &json!({ "v": optional_number(relative_luminance(front)) }));
        check("background luminance", case, &json!({ "v": case["background"] }), &json!({ "v": optional_number(relative_luminance(back)) }));
    }
    for case in cases(d, "hueFamilies") {
        let values: Vec<&str> = case["input"].as_array().expect("list").iter().map(|value| value.as_str().expect("colour")).collect();
        assert_eq!(json!(saturated_hue_families(&values)), case["families"], "hue families of {}", case["input"]);
    }
    for case in cases(d, "brief") {
        check("brief", case, &recorded(case), &attempt(Ok(design_discipline_brief(Some(&case["input"])))));
    }
    for case in cases(d, "motif") {
        assert_eq!(is_motif_shape(&case["input"]), case["motif"].as_bool().expect("flag"), "motif {}", case["input"]);
        assert_eq!(is_picture_shape(&case["input"]), case["picture"].as_bool().expect("flag"), "picture {}", case["input"]);
    }
    for case in cases(d, "signed") {
        assert_eq!(signed_visual_type(&case["input"]), case["type"].as_str().expect("type"), "signed {}", case["input"]);
    }
}

fn replay_art_direction(g: &Value) {
    for case in cases(g, "artDirection") {
        let input = &case["input"];
        let options = &input["options"];
        let option = |key: &str, default: &'static str| options[key].as_str().unwrap_or(default).to_owned();
        let actual = resolve_office_art_direction(
            input["format"].as_str().expect("format"),
            &input["input"],
            &option("profile", ""),
            &option("purpose", "explain"),
            &option("expressionMode", "strong-fit"),
        );
        check("art direction", case, &recorded(case), &attempt(Ok(actual)));
    }
}

fn replay_table_input(g: &Value) {
    for case in cases(g, "tableInput") {
        let input = &case["input"];
        let result = if input.get("omitted").is_some() {
            compose_table_rows(None, DEFAULT_FIELD, true)
        } else {
            compose_table_rows(input.get("table"), input["field"].as_str().unwrap_or(DEFAULT_FIELD), input["strict"].as_bool().expect("strict"))
        };
        check("table input", case, &recorded(case), &attempt(result.map(Value::Array)));
    }
}

fn is_omitted(input: &Value) -> bool {
    input == &json!({ "omitted": true })
}

fn replay_content_model(g: &Value) {
    for case in cases(g, "contentModel") {
        let result = normalize_office_content_model(if is_omitted(&case["input"]) { None } else { Some(&case["input"]) });
        check("content model", case, &recorded(case), &attempt(result));
    }
    for case in cases(g, "numberFormat") {
        let input = if is_omitted(&case["input"]) { Value::Null } else { case["input"].clone() };
        assert_eq!(office_number_format(&input), case["format"].as_str().expect("format"), "number format of {}", case["input"]);
    }
    let good = normalize_office_content_model(Some(&g["goodModel"])).expect("the good model");
    let empty = normalize_office_content_model(Some(&json!({ "facts": [], "claims": [] }))).expect("the empty model");
    for case in cases(g, "bind") {
        let model = match case["model"].as_str().expect("model") {
            "good" => Some(&good),
            "empty" => Some(&empty),
            _ => None,
        };
        let result = bind_office_content(&case["operation"], model).map(|bound| json!({ "operation": bound.operation, "binding": bound.binding }));
        check("bind", case, &recorded(case), &attempt(result));
    }
    for case in cases(g, "summary") {
        let result = normalize_office_content_model(Some(&case["input"])).map(|model| summarize_office_content_model(Some(&model)));
        check("summary", case, &recorded(case), &attempt(result));
    }
}

fn replay_designs(g: &Value) {
    for case in cases(g, "designs") {
        let input = &case["input"];
        let result = resolve_office_design(
            input["format"].as_str().expect("format"),
            &input["request"],
            library_of(g, &input["library"]),
            &context_of(&case["composition"]),
        );
        check("design", case, &recorded(case), &attempt(result));
    }
    for case in cases(g, "catalog") {
        let input = &case["input"];
        let format = if input.get("omitted").is_some() { "" } else { input["format"].as_str().expect("format") };
        check("catalog", case, &recorded(case), &attempt(office_design_catalog(format, library_of(g, &input["library"]))));
    }
    for case in cases(g, "merge") {
        check("merge", case, &recorded(case), &attempt(Ok(merge(&case["input"]["base"], &case["input"]["override"]))));
    }
    for case in cases(g, "hex") {
        let input = &case["input"];
        check("hex", case, &json!({ "v": case["hex"] }), &json!({ "v": hex(Some(&input["value"]), input["fallback"].clone()) }));
    }
    for case in cases(g, "strings") {
        assert_eq!(json!(strings(Some(&case["input"]))), case["strings"], "strings of {}", case["input"]);
    }
    for case in cases(g, "provenance") {
        assert_eq!(provenance_text(Some(&case["input"])), case["text"].as_str().expect("text"), "provenance of {}", case["input"]);
    }
    for case in cases(g, "compact") {
        let input = &case["input"];
        let result = resolve_office_design(
            input["format"].as_str().expect("format"),
            &input["request"],
            library_of(g, &input["library"]),
            &context_of(&input["composition"]),
        )
        .map(|design| compact_design(&design));
        check("compact design", case, &recorded(case), &attempt(result));
    }
    for case in cases(g, "compactDesigns") {
        check("compact design of a literal", case, &recorded(case), &attempt(Ok(compact_design(&case["input"]))));
    }
}

fn replay_creative_director(g: &Value) {
    let source = &g["storyDesign"];
    let design = resolve_office_design(
        source["format"].as_str().expect("format"),
        &source["request"],
        None,
        &context_of(&source["composition"]),
    )
    .expect("the story design");
    let operations = cases(g, "storyOperations");
    for case in cases(g, "story") {
        let input = &case["input"];
        let list = &operations[input["operations"].as_u64().expect("index") as usize];
        let actual = direct_office_story(input["format"].as_str().expect("format"), list, &design);
        check("story", case, &recorded(case), &attempt(Ok(actual)));
    }
    for case in cases(g, "storyDefaults") {
        let input = &case["input"];
        let fallback = Value::Object(Map::new());
        let design = if input["design"].is_null() { &fallback } else { &input["design"] };
        let actual = direct_office_story(input["format"].as_str().expect("format"), &input["operations"], design);
        check("story with defaults", case, &recorded(case), &attempt(Ok(actual)));
    }
    for case in cases(g, "applyBrief") {
        let input = &case["input"];
        let creative = &g["briefCreatives"][input["creative"].as_str().expect("creative")];
        let actual = apply_office_creative_brief(&input["operation"], Some(creative), input["index"].as_u64().expect("index") as usize);
        check("creative brief", case, &recorded(case), &attempt(Ok(actual)));
    }
    let names = &g["composeOperation"];
    assert_eq!(compose_operation("docx"), names["docx"].as_str());
    assert_eq!(compose_operation("xlsx"), names["xlsx"].as_str());
    let keys: Vec<&str> = COMPOSE_OPERATIONS.iter().map(|(format, _)| *format).collect();
    assert_eq!(json!(keys), names["keys"]);
}

fn every_output_equals_the_recording() {
    let g = golden();
    replay_discipline(&g);
    replay_art_direction(&g);
    replay_table_input(&g);
    replay_content_model(&g);
    replay_designs(&g);
    replay_creative_director(&g);
}

#[test]
fn every_recorded_output_is_equal() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-office-design --test twin_discipline -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/design)"]
fn twin_live_discipline() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-discipline.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_output_equals_the_recording();
}
