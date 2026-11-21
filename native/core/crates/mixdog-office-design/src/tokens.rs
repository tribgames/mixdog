//! `design/design-tokens.mjs`: the profile packs (colours, typography, spacing and per-format sizes), the catalogue of
//! them, and `resolve_office_design`, which turns a design request into the design in force: the pack, the selected
//! art direction, the repaired palette and typography, the deck plan of a presentation, the content model and the
//! review switches.

use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_object_keys, js_to_lowercase, js_trim, json_number, to_number_of, value_to_string};
use mixdog_office_base::values::{plain_object, truthy};
use serde_json::{Map, Value, json};

use crate::art_direction::resolve_office_art_direction;
use crate::content_model::{normalize_office_content_model, summarize_office_content_model};
use crate::discipline::{normalize_palette_tokens, normalize_typography_tokens};
use crate::{array_of, first_text, first_truthy, is_not_false, opt_prop, prop, text};

pub use mixdog_office_base::labels::preset_labels;

const PPTX_BACKGROUND_MODES: [&str; 4] = ["sandwich", "light", "dark", "custom"];
const PPTX_TEMPLATE_MODES: [&str; 3] = ["prefer", "strict", "scratch"];
const PPTX_COMPOSITION_MODES: [&str; 2] = ["model", "legacy"];
const FORMATS: [&str; 6] = ["docx", "xlsx", "pptx", "pdf", "csv", "tsv"];

/// What `resolveOfficeCompositionContext` (the composition system) answers for a request: the purpose and expression
/// mode the art direction is chosen for, and the recent compositions of the library, normalised.
#[derive(Debug, Clone, PartialEq)]
pub struct CompositionContext {
    pub purpose: String,
    pub expression_mode: String,
    pub recent_compositions: Value,
}

/// `strings`: a list of the non-empty texts of a value that is a list, one text, or nothing.
pub fn strings(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => {
            items.iter().map(|entry| if entry.is_null() { String::new() } else { value_to_string(entry) }).filter(|entry| !entry.is_empty()).collect()
        }
        None | Some(Value::Null) => Vec::new(),
        Some(Value::String(written)) if written.is_empty() => Vec::new(),
        Some(other) => vec![value_to_string(other)],
    }
}

fn string_list(list: Vec<String>) -> Value {
    Value::Array(list.into_iter().map(Value::String).collect())
}

/// The requested list when it holds anything, else the direction's own.
fn listed_or_directed(requested: Option<&Value>, directed: Option<&Value>) -> Value {
    let listed = strings(requested);
    string_list(if listed.is_empty() { strings(directed) } else { listed })
}

/// The positive whole slide numbers of a list, once each, ascending.
fn slide_numbers(value: Option<&Value>) -> Value {
    let mut numbers: Vec<f64> = Vec::new();
    for entry in array_of(value).into_iter().flatten() {
        let number = to_number_of(Some(entry));
        if number.is_finite() && number.fract() == 0.0 && number > 0.0 && !numbers.contains(&number) {
            numbers.push(number);
        }
    }
    numbers.sort_by(f64::total_cmp);
    Value::Array(numbers.into_iter().map(json_number).collect())
}

fn known_mode(value: Option<&Value>, known: &[&str]) -> Option<String> {
    let mode = js_to_lowercase(&text(value));
    known.contains(&mode.as_str()).then_some(mode)
}

fn pack_entry(label: &str, best_for: &str, id: &str, colors: &[(&str, &str)], typography: [&str; 3], spacing: [u32; 4], formats: Value) -> Value {
    let colors: Map<String, Value> = colors.iter().map(|(role, hex)| ((*role).to_owned(), json!(hex))).collect();
    json!({
        "id": id,
        "label": label,
        "bestFor": best_for,
        "tokens": {
            "colors": colors,
            "typography": { "display": typography[0], "body": typography[1], "data": typography[2] },
            "spacing": { "compact": spacing[0], "block": spacing[1], "section": spacing[2], "page": spacing[3] },
        },
        "formats": formats,
    })
}

static DESIGN_PACKS: LazyLock<Map<String, Value>> = LazyLock::new(|| {
    let mut packs = Map::new();
    packs.insert(
        "executive".into(),
        pack_entry(
            "Executive",
            "Decision briefs, operating reviews, dashboards, and leadership presentations.",
            "executive",
            &[
                ("canvas", "F8F9F6"),
                ("ink", "17221C"),
                ("muted", "66716B"),
                ("accent", "1F7A55"),
                ("accent2", "D89224"),
                ("surface", "E8F1EC"),
                ("surface2", "DDE4DF"),
                ("inverse", "132C24"),
                ("onAccent", "FFFFFF"),
                ("onInverse", "FFFFFF"),
            ],
            ["Cambria", "Calibri", "Arial"],
            [10, 22, 40, 52],
            json!({
                "pptx": { "title": 40, "body": 17, "caption": 11, "canvasWidth": 960, "canvasHeight": 540 },
                "docx": { "title": 30, "heading1": 17, "heading2": 13, "body": 10.5, "margin": 50.4 },
                "xlsx": { "title": 20, "heading": 10, "body": 9.5, "tableStyle": "TableStyleMedium4" },
                "pdf": { "title": 29, "heading": 17, "body": 10.5, "margin": 50 },
            }),
        ),
    );
    packs.insert(
        "editorial".into(),
        pack_entry(
            "Editorial",
            "Reports, proposals, briefs, and narrative presentations.",
            "editorial",
            &[
                ("canvas", "FFFFFF"),
                ("ink", "171717"),
                ("muted", "5F6368"),
                ("accent", "C43E2F"),
                ("accent2", "D89B2B"),
                ("surface", "F1F2F4"),
                ("surface2", "E7E9EC"),
                ("inverse", "151515"),
                ("onAccent", "FFFFFF"),
                ("onInverse", "FFFFFF"),
            ],
            ["Bookman Old Style", "Calibri", "Calibri"],
            [12, 24, 42, 54],
            json!({
                "pptx": { "title": 40, "body": 18, "caption": 12, "canvasWidth": 960, "canvasHeight": 540 },
                "docx": { "title": 28, "heading1": 18, "heading2": 14, "body": 10.5, "margin": 64.8 },
                "xlsx": { "title": 18, "heading": 11, "body": 10, "tableStyle": "TableStyleMedium2" },
                "pdf": { "title": 28, "heading": 18, "body": 10.5, "margin": 54 },
            }),
        ),
    );
    packs.insert(
        "technical".into(),
        pack_entry(
            "Technical",
            "Product, engineering, architecture, and operational material.",
            "technical",
            &[
                ("canvas", "F7FAFC"),
                ("ink", "102A43"),
                ("muted", "627D98"),
                ("accent", "008C8C"),
                ("accent2", "E0A526"),
                ("surface", "E8F1F5"),
                ("surface2", "D9E7EC"),
                ("inverse", "0B1F33"),
                ("onAccent", "FFFFFF"),
                ("onInverse", "F7FAFC"),
            ],
            ["Arial", "Calibri", "Courier New"],
            [10, 22, 38, 50],
            json!({
                "pptx": { "title": 38, "body": 17, "caption": 12, "canvasWidth": 960, "canvasHeight": 540 },
                "docx": { "title": 26, "heading1": 17, "heading2": 13, "body": 10.5, "margin": 61.2 },
                "xlsx": { "title": 18, "heading": 11, "body": 10, "tableStyle": "TableStyleMedium4" },
                "pdf": { "title": 27, "heading": 17, "body": 10.5, "margin": 52 },
            }),
        ),
    );
    packs.insert(
        "data".into(),
        pack_entry(
            "Data",
            "Financial models, analytical reports, dashboards, and KPI reviews.",
            "data",
            &[
                ("canvas", "FFFFFF"),
                ("ink", "1F2933"),
                ("muted", "66788A"),
                ("accent", "287A4B"),
                ("accent2", "D97706"),
                ("surface", "EDF5F0"),
                ("surface2", "E3EAF0"),
                ("inverse", "183028"),
                ("onAccent", "FFFFFF"),
                ("onInverse", "FFFFFF"),
            ],
            ["Calibri", "Calibri", "Arial"],
            [9, 20, 36, 48],
            json!({
                "pptx": { "title": 38, "body": 17, "caption": 12, "canvasWidth": 960, "canvasHeight": 540 },
                "docx": { "title": 26, "heading1": 17, "heading2": 13, "body": 10, "margin": 57.6 },
                "xlsx": { "title": 18, "heading": 11, "body": 10, "tableStyle": "TableStyleMedium4" },
                "pdf": { "title": 27, "heading": 17, "body": 10, "margin": 50 },
            }),
        ),
    );
    packs
});

fn default_profile(format: &str) -> Option<&'static str> {
    match format {
        "docx" | "xlsx" | "pptx" | "pdf" => Some("executive"),
        "csv" | "tsv" => Some("data"),
        _ => None,
    }
}

/// A workbook's stated purpose picks its default profile (an explicit profile still wins); an unmatched or absent
/// purpose leaves the format's default.
static XLSX_PURPOSE_PROFILES: LazyLock<[(JsRegex, &'static str); 3]> = LazyLock::new(|| {
    [
        (JsRegex::new_static(r"(financ|analy|data|ledger|budget|재무|분석|데이터)", "i"), "data"),
        (JsRegex::new_static(r"(narrat|editorial|story|서사|보고)", "i"), "editorial"),
        (JsRegex::new_static(r"(technic|engineer|기술)", "i"), "technical"),
    ]
});

fn purpose_profile(format: &str, purpose: Option<&Value>, packs: &Map<String, Value>) -> String {
    if format != "xlsx" {
        return String::new();
    }
    let written = text(purpose);
    match XLSX_PURPOSE_PROFILES.iter().find(|(pattern, _)| pattern.is_match(&written)) {
        Some((_, id)) if packs.get(*id).is_some_and(truthy) => (*id).to_owned(),
        _ => String::new(),
    }
}

/// `merge(base, override)`: a deep copy of `base` with the entries of `override` laid over it; objects merge, every
/// other value replaces.
pub fn merge(base: &Value, overriding: &Value) -> Value {
    let Value::Object(entries) = overriding else {
        return base.clone();
    };
    let mut result = match base {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    for key in js_object_keys(entries) {
        let value = &entries[key];
        let merged = match result.get(key) {
            Some(current) if plain_object(value) && plain_object(current) => merge(current, value),
            _ => value.clone(),
        };
        result.insert(key.clone(), merged);
    }
    Value::Object(result)
}

/// `hex(value, fallback)`: the upper-case `RRGGBB` of a colour written with or without `#`, else the fallback.
pub fn hex(value: Option<&Value>, fallback: Value) -> Value {
    match crate::discipline::normalized_hex(&text(value)) {
        Some(normalized) => Value::String(normalized),
        None => fallback,
    }
}

/// The fields of a resolved design the tool result carries, with the content model summarised.
pub fn compact_design(design: &Value) -> Value {
    let mut compact = Map::new();
    let copy = |key: &str, compact: &mut Map<String, Value>| {
        if let Some(entry) = prop(design, key) {
            compact.insert(key.to_owned(), entry.clone());
        }
    };
    for key in [
        "profile",
        "label",
        "intent",
        "audience",
        "tone",
        "density",
        "purpose",
        "expressionMode",
        "signature",
        "source",
        "artDirection",
        "creative",
        "library",
        "tokens",
        "discipline",
        "format",
        "deck",
    ] {
        copy(key, &mut compact);
    }
    compact.insert("content".into(), summarize_office_content_model(prop(design, "content")));
    for key in ["slidePlans", "review"] {
        copy(key, &mut compact);
    }
    Value::Object(compact)
}

fn compact_library(library: Option<&Value>) -> Value {
    let Some(library) = library.filter(|library| plain_object(library)) else {
        return json!({ "source": "mixdog-starter", "pack": null, "template": null, "pinned": false, "warning": "" });
    };
    let mut template = Value::Null;
    if let Some(written) = prop(library, "template").filter(|template| truthy(template)) {
        let mut entry = Map::new();
        for key in ["id", "version", "source"] {
            entry.insert(key.into(), Value::String(text(prop(written, key))));
        }
        if let Some(coverage) = prop(library, "coverage").filter(|coverage| truthy(coverage)) {
            entry.insert("coverage".into(), coverage.clone());
        }
        template = Value::Object(entry);
    }
    let pack = match prop(library, "pack").filter(|pack| truthy(pack)) {
        Some(written) => json!({
            "id": text(prop(written, "id")),
            "version": text(prop(written, "version")),
            "keyId": text(prop(written, "keyId")),
        }),
        None => Value::Null,
    };
    json!({
        "source": first_text(&[prop(library, "source"), Some(&json!("mixdog-starter"))]),
        "pack": pack,
        "template": template,
        "templateIndexRevision": text(prop(library, "templateIndexRevision")),
        "recentCompositionCount": array_of(prop(library, "recentCompositions")).map_or(0, Vec::len),
        "pinned": prop(library, "pinned") == Some(&Value::Bool(true)),
        "warning": text(prop(library, "warning")),
    })
}

/// The packs in force: the built-in ones and the profiles of the library's pack, each laid over the pack it extends.
fn resolved_design_packs(library: Option<&Value>) -> Map<String, Value> {
    let mut output = DESIGN_PACKS.clone();
    let remote = opt_prop(opt_prop(library, "pack"), "profiles").filter(|profiles| plain_object(profiles));
    let Some(Value::Object(remote)) = remote else {
        return output;
    };
    for id in js_object_keys(remote) {
        let profile = &remote[id];
        let fallback_parent = if DESIGN_PACKS.contains_key(id) { id.clone() } else { "editorial".to_owned() };
        let parent_id = js_to_lowercase(&first_text(&[prop(profile, "extends"), Some(&Value::String(fallback_parent))]));
        let parent = DESIGN_PACKS.get(&parent_id).or_else(|| DESIGN_PACKS.get("editorial")).expect("the editorial pack");
        let mut base = parent.clone();
        let entries = base.as_object_mut().expect("a pack is an object");
        entries.insert("id".into(), Value::String(id.clone()));
        entries.insert("label".into(), first_truthy(&[prop(profile, "label")]).cloned().unwrap_or_else(|| Value::String(id.clone())));
        output.insert(id.clone(), merge(&base, profile));
    }
    output
}

fn checked_format(format: &str) -> Result<String, String> {
    let normalized = js_to_lowercase(format);
    if !normalized.is_empty() && !FORMATS.contains(&normalized.as_str()) {
        return Err(format!("Unsupported Office design format: {format}"));
    }
    Ok(normalized)
}

/// `officeDesignCatalog(format, { library })`: one row per profile with the formats it covers and, when a format is
/// named, its defaults.
pub fn office_design_catalog(format: &str, library: Option<&Value>) -> Result<Value, String> {
    let normalized = checked_format(format)?;
    let packs = resolved_design_packs(library);
    let mut rows = Vec::new();
    for key in js_object_keys(&packs) {
        let pack = &packs[key];
        let formats = prop(pack, "formats");
        let mut row = Map::new();
        for field in ["id", "label", "bestFor"] {
            if let Some(entry) = prop(pack, field) {
                row.insert(field.into(), entry.clone());
            }
        }
        let names: Vec<&String> = formats.and_then(Value::as_object).map(js_object_keys).unwrap_or_default();
        row.insert("formats".into(), json!(names));
        if !normalized.is_empty()
            && let Some(defaults) = opt_prop(formats, &normalized).filter(|defaults| truthy(defaults))
        {
            row.insert("defaults".into(), defaults.clone());
        }
        rows.push(Value::Object(row));
    }
    Ok(Value::Array(rows))
}

/// The pptx-only design fields: the slide plans and the authoring brief parsed from the script; the review holds the
/// saved deck to it.
fn pptx_design_fields(input: &Value, design: &mut Map<String, Value>) {
    let plans = match prop(input, "slidePlans") {
        Some(Value::Array(plans)) => Value::Array(plans.clone()),
        _ => Value::Array(Vec::new()),
    };
    design.insert("slidePlans".into(), plans);
    if let Some(brief) = prop(input, "brief").filter(|brief| plain_object(brief)) {
        design.insert("brief".into(), brief.clone());
    }
}

fn resolve_pptx_deck_plan(input: &Value, tokens: &Value, art_direction: &Value) -> Value {
    let empty = Value::Object(Map::new());
    let source = prop(input, "deck").filter(|deck| plain_object(deck)).unwrap_or(&empty);
    let direction = if prop(art_direction, "applyTokens").is_some_and(truthy) {
        opt_prop(prop(art_direction, "selected"), "deck").filter(|deck| truthy(deck)).unwrap_or(&empty)
    } else {
        &empty
    };
    let background_mode = known_mode(prop(source, "backgroundMode"), &PPTX_BACKGROUND_MODES)
        .or_else(|| known_mode(prop(direction, "backgroundMode"), &PPTX_BACKGROUND_MODES))
        .unwrap_or_else(|| "sandwich".to_owned());
    let defaults = match background_mode.as_str() {
        "dark" => ["inverse", "inverse", "inverse", "inverse"],
        "light" => ["canvas", "canvas", "canvas", "canvas"],
        _ => ["inverse", "canvas", "inverse", "inverse"],
    };
    let colors = prop(tokens, "colors").and_then(Value::as_object);
    let has_color = |role: &str| colors.is_some_and(|colors| colors.contains_key(role));
    let requested_roles = prop(source, "roles").filter(|roles| plain_object(roles)).unwrap_or(&empty);
    let mut roles = Map::new();
    for (key, fallback) in ["cover", "content", "section", "closing"].into_iter().zip(defaults) {
        let requested = js_trim(&text(prop(requested_roles, key))).to_owned();
        roles.insert(key.into(), Value::String(if has_color(&requested) { requested } else { fallback.to_owned() }));
    }
    let content_role = text(roles.get("content"));
    let dominant_color_role = first_text(&[prop(source, "dominantColorRole"), Some(&Value::String(content_role.clone()))]);
    let requested_template_mode = js_to_lowercase(js_trim(&text(prop(source, "templateMode"))));
    let requested_composition_mode = js_to_lowercase(js_trim(&text(prop(source, "compositionMode"))));
    let selected = prop(art_direction, "selected");
    let direction_ids: Vec<Value> =
        array_of(prop(art_direction, "candidates")).into_iter().flatten().filter_map(|candidate| prop(candidate, "id").cloned()).collect();
    let pick = |key: &str, fallback: &str| first_text(&[prop(source, key), prop(direction, key), Some(&Value::String(fallback.to_owned()))]);
    let mut plan = Map::new();
    plan.insert("backgroundMode".into(), Value::String(background_mode));
    plan.insert("dominantColorRole".into(), Value::String(if has_color(&dominant_color_role) { dominant_color_role } else { content_role }));
    plan.insert("motif".into(), Value::String(first_text(&[prop(source, "motif"), prop(direction, "motif"), prop(input, "signature")])));
    plan.insert("spacingScale".into(), Value::String(first_text(&[prop(source, "spacingScale"), Some(&json!("consistent"))])));
    plan.insert("imageTreatment".into(), Value::String(pick("imageTreatment", "contained-evidence")));
    plan.insert("layoutBias".into(), listed_or_directed(prop(source, "layoutBias"), prop(direction, "layoutBias")));
    plan.insert("grid".into(), Value::String(pick("grid", "twelve-column editorial grid")));
    plan.insert("shapeLanguage".into(), Value::String(pick("shapeLanguage", "native evidence fields")));
    plan.insert("chartTreatment".into(), Value::String(pick("chartTreatment", "native annotated chart")));
    plan.insert("densityPattern".into(), listed_or_directed(prop(source, "densityPattern"), prop(direction, "densityPattern")));
    plan.insert("motifRules".into(), listed_or_directed(prop(source, "motifRules"), prop(direction, "motifRules")));
    plan.insert("directionId".into(), Value::String(text(opt_prop(selected, "id"))));
    plan.insert("directionCandidates".into(), Value::Array(direction_ids));
    plan.insert("sectionSlides".into(), slide_numbers(prop(source, "sectionSlides")));
    plan.insert("roles".into(), Value::Object(roles));
    let template_mode = if PPTX_TEMPLATE_MODES.contains(&requested_template_mode.as_str()) { requested_template_mode } else { "scratch".to_owned() };
    let composition_mode = if PPTX_COMPOSITION_MODES.contains(&requested_composition_mode.as_str()) { requested_composition_mode } else { "model".to_owned() };
    plan.insert("templateMode".into(), Value::String(template_mode));
    plan.insert("compositionMode".into(), Value::String(composition_mode));
    plan.insert("enforce".into(), Value::Bool(is_not_false(prop(source, "enforce"))));
    plan.insert("requireSlidePlan".into(), Value::Bool(is_not_false(prop(source, "requireSlidePlan"))));
    Value::Object(plan)
}

/// The tokens of a request: the pack's, then the art direction's, then the request's own palette and typography, each
/// repaired by the discipline; with the record of what the discipline changed.
fn resolve_design_tokens(input: &Value, pack: &Value, art_direction: &Value) -> (Value, Value) {
    let direction_tokens = if prop(art_direction, "applyTokens").is_some_and(truthy) {
        let selected = prop(art_direction, "selected");
        json!({
            "colors": opt_prop(selected, "palette").cloned().unwrap_or(Value::Null),
            "typography": opt_prop(selected, "typography").cloned().unwrap_or(Value::Null),
        })
    } else {
        Value::Object(Map::new())
    };
    let empty = Value::Object(Map::new());
    let palette = prop(input, "palette").filter(|palette| plain_object(palette)).unwrap_or(&empty);
    let base_tokens = merge(prop(pack, "tokens").unwrap_or(&Value::Null), &direction_tokens);
    let typography_discipline = normalize_typography_tokens(prop(input, "typography"), prop(&base_tokens, "typography"));
    let base_colors = prop(&base_tokens, "colors").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut palette_source = base_colors.clone();
    for key in js_object_keys(palette.as_object().expect("an object")) {
        let fallback = first_truthy(&[base_colors.get(key), base_colors.get("ink")]).cloned().unwrap_or(Value::Null);
        palette_source.insert(key.clone(), hex(palette.get(key), fallback));
    }
    let palette_discipline = normalize_palette_tokens(&Value::Object(palette_source));
    let tokens = merge(
        &base_tokens,
        &json!({
            "colors": Value::Object(palette_discipline.colors.clone()),
            "typography": Value::Object(typography_discipline.typography.clone()),
        }),
    );
    let discipline = json!({
        "replacedFonts": typography_discipline.replaced,
        "fontFamilyCount": typography_discipline.family_count,
        "paletteAdjustments": palette_discipline.adjustments,
    });
    (tokens, discipline)
}

fn review_switches(input: &Value, format: &str) -> Value {
    let flag = |key: &str| Value::Bool(prop(input, key) == Some(&Value::Bool(true)));
    let required = format == "pptx" || (is_not_false(prop(input, "review")) && format != "csv" && format != "tsv");
    json!({
        "required": required,
        "allowTextOnly": flag("allowTextOnly"),
        "allowRepetition": flag("allowRepetition"),
        "allowDecorativeLines": flag("allowDecorativeLines"),
        "allowSyntheticVisuals": flag("allowSyntheticVisuals"),
        "allowFlatRhythm": flag("allowFlatRhythm"),
        "allowUnsafeFonts": flag("allowUnsafeFonts"),
        "frontier": is_not_false(prop(input, "frontier")) && first_truthy(&[prop(input, "content"), prop(input, "creative")]).is_some(),
    })
}

/// `resolveOfficeDesign(format, request, { library })`: the design in force for a request. `request` is a profile name
/// or a request object; `composition` is what the composition system makes of it (purpose, expression mode, recent
/// compositions). The errors are the texts of the ones Node throws.
pub fn resolve_office_design(format: &str, request: &Value, library: Option<&Value>, composition: &CompositionContext) -> Result<Value, String> {
    let normalized_format = js_to_lowercase(format);
    if !FORMATS.contains(&normalized_format.as_str()) {
        return Err(format!("Unsupported Office design format: {format}"));
    }
    let profile_request;
    let input = match request {
        Value::String(name) => {
            profile_request = json!({ "profile": name });
            &profile_request
        }
        object if plain_object(object) => object,
        _ => {
            profile_request = Value::Object(Map::new());
            &profile_request
        }
    };
    let packs = resolved_design_packs(library);
    let library_default = opt_prop(opt_prop(opt_prop(library, "pack"), "defaultProfiles"), &normalized_format);
    let purposed = Value::String(purpose_profile(&normalized_format, prop(input, "purpose"), &packs));
    let default = Value::String(default_profile(&normalized_format).unwrap_or("").to_owned());
    let profile = js_to_lowercase(&first_text(&[prop(input, "profile"), Some(&purposed), library_default, Some(&default), Some(&json!("editorial"))]));
    let Some(pack) = packs.get(&profile).filter(|pack| truthy(pack)) else {
        let known = js_object_keys(&packs).into_iter().map(String::as_str).collect::<Vec<_>>().join(", ");
        return Err(format!("Unknown Office design profile \"{profile}\". Use one of: {known}"));
    };
    let art_direction = resolve_office_art_direction(&normalized_format, input, &profile, &composition.purpose, &composition.expression_mode);
    let (tokens, discipline) = resolve_design_tokens(input, pack, &art_direction);
    let deck = (normalized_format == "pptx").then(|| resolve_pptx_deck_plan(input, &tokens, &art_direction));
    let density_written = js_to_lowercase(&text(prop(input, "density")));
    let density = if ["light", "balanced", "dense"].contains(&density_written.as_str()) { density_written } else { "balanced".to_owned() };
    let content = normalize_office_content_model(prop(input, "content"))?;
    let mut design = Map::new();
    let mut put = |key: &str, value: Value| {
        design.insert(key.to_owned(), value);
    };
    put("profile", Value::String(profile.clone()));
    if let Some(label) = prop(pack, "label") {
        put("label", label.clone());
    }
    if let Some(best_for) = prop(pack, "bestFor") {
        put("bestFor", best_for.clone());
    }
    for key in ["intent", "audience", "tone"] {
        put(key, Value::String(text(prop(input, key))));
    }
    put("density", Value::String(density));
    put("purpose", Value::String(composition.purpose.clone()));
    put("expressionMode", Value::String(composition.expression_mode.clone()));
    put("recentCompositions", composition.recent_compositions.clone());
    put("signature", Value::String(text(prop(input, "signature"))));
    put("source", Value::String(first_text(&[prop(input, "source"), opt_prop(library, "source"), Some(&json!("mixdog-starter"))])));
    put("artDirection", art_direction);
    put("creative", prop(input, "creative").filter(|creative| plain_object(creative)).cloned().unwrap_or(Value::Null));
    put("content", content);
    put("library", compact_library(library));
    put(
        "layouts",
        match opt_prop(library, "layouts") {
            Some(Value::Array(layouts)) => Value::Array(layouts.clone()),
            _ => Value::Array(Vec::new()),
        },
    );
    put("tokens", tokens);
    put("discipline", discipline);
    put("format", opt_prop(prop(pack, "formats"), &normalized_format).filter(|entry| truthy(entry)).cloned().unwrap_or_else(|| Value::Object(Map::new())));
    if let Some(deck) = deck {
        put("deck", deck);
    }
    if normalized_format == "pptx" {
        let mut fields = Map::new();
        pptx_design_fields(input, &mut fields);
        for (key, value) in fields {
            put(&key, value);
        }
    }
    put(
        "compositions",
        match prop(input, "compositions") {
            Some(Value::Array(compositions)) => Value::Array(compositions.clone()),
            _ => Value::Array(Vec::new()),
        },
    );
    put("review", review_switches(input, &normalized_format));
    Ok(Value::Object(design))
}

/// `provenanceText`: `document#target` for a source written as an object, the text for one written as a string.
pub fn provenance_text(source: Option<&Value>) -> String {
    let Some(source) = source.filter(|source| truthy(source)) else {
        return String::new();
    };
    if let Value::String(written) = source {
        return js_trim(written).to_owned();
    }
    if !plain_object(source) {
        return String::new();
    }
    let document = js_trim(&first_text(&[prop(source, "document"), prop(source, "label")])).to_owned();
    let target = js_trim(&text(prop(source, "target"))).to_owned();
    if document.is_empty() {
        return String::new();
    }
    if target.is_empty() { document } else { format!("{document}#{target}") }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_js::json_stringify;

    fn context(purpose: &str) -> CompositionContext {
        CompositionContext { purpose: purpose.into(), expression_mode: "strong-fit".into(), recent_compositions: json!([]) }
    }

    fn resolve(format: &str, request: Value) -> Value {
        resolve_office_design(format, &request, None, &context("explain")).expect("a design")
    }

    #[test]
    fn a_requested_face_is_kept_and_an_unsafe_one_is_listed() {
        let design = resolve("pptx", json!({ "typography": { "display": "Aptos Display", "body": "Consolas" }, "palette": { "inverse": "#07080B" } }));
        assert_eq!(design["tokens"]["typography"]["display"], json!("Aptos Display"));
        assert_eq!(design["tokens"]["typography"]["body"], json!("Consolas"));
        assert_eq!(design["discipline"]["replacedFonts"].as_array().map(Vec::len), Some(2));
        assert_ne!(design["tokens"]["colors"]["inverse"], json!("07080B"));
    }

    #[test]
    fn a_workbook_purpose_picks_its_profile() {
        let profile = |request: Value, format: &str| resolve(format, request)["profile"].clone();
        assert_eq!(profile(json!({ "purpose": "financial analysis" }), "xlsx"), json!("data"));
        assert_eq!(profile(json!({ "purpose": "narrative report" }), "xlsx"), json!("editorial"));
        assert_eq!(profile(json!({ "purpose": "technical spec" }), "xlsx"), json!("technical"));
        assert_eq!(profile(json!({ "purpose": "financial", "profile": "technical" }), "xlsx"), json!("technical"));
        assert_eq!(profile(json!({}), "xlsx"), json!("executive"));
        assert_eq!(profile(json!({ "purpose": "financial analysis" }), "docx"), json!("executive"));
        assert_eq!(profile(json!({}), "csv"), json!("data"));
        assert_eq!(profile(json!("Technical"), "pdf"), json!("technical"));
    }

    #[test]
    fn a_subject_specific_deck_keeps_explicit_brand_colors() {
        let design = resolve(
            "pptx",
            json!({
                "profile": "technical",
                "intent": "Launch a local-first coding harness for product leaders",
                "audience": "product and engineering leaders",
                "purpose": "decide",
                "expressionMode": "strong-fit",
                "palette": { "accent": "#00A896" },
                "signature": "local-first evidence loop",
            }),
        );
        assert_eq!(design["artDirection"]["candidates"].as_array().map(Vec::len), Some(3));
        assert_eq!(design["deck"]["directionId"], design["artDirection"]["selected"]["id"]);
        assert_eq!(design["deck"]["directionCandidates"].as_array().map(Vec::len), Some(3));
        assert!(text(prop(&design["deck"], "motif")).to_lowercase().contains("local-first evidence loop"));
        assert_eq!(design["tokens"]["colors"]["accent"], json!("00A896"));
        assert_eq!(design["review"]["required"], json!(true));
        assert_eq!(design["review"]["frontier"], json!(false));
    }

    #[test]
    fn a_library_pack_adds_profiles_and_defaults() {
        let library = json!({
            "source": "brand-pack",
            "pack": {
                "id": "brand", "version": "2.0.0", "keyId": "k1",
                "defaultProfiles": { "pptx": "brand" },
                "profiles": { "brand": { "extends": "technical", "label": "Brand", "tokens": { "colors": { "accent": "7C3AED" } } } },
            },
            "template": { "id": "t", "version": "1" },
            "coverage": { "layouts": 3 },
            "layouts": [{ "name": "Title" }],
            "recentCompositions": [{}, {}],
            "pinned": true,
        });
        let design = resolve_office_design("pptx", &json!({}), Some(&library), &context("explain")).expect("a design");
        assert_eq!(design["profile"], json!("brand"));
        assert_eq!(design["label"], json!("Brand"));
        assert_eq!(design["tokens"]["colors"]["accent"], json!("7C3AED"));
        assert_eq!(design["tokens"]["typography"]["data"], json!("Courier New"));
        assert_eq!(design["source"], json!("brand-pack"));
        assert_eq!(design["layouts"], json!([{ "name": "Title" }]));
        assert_eq!(design["library"]["pack"], json!({ "id": "brand", "version": "2.0.0", "keyId": "k1" }));
        assert_eq!(design["library"]["template"], json!({ "id": "t", "version": "1", "source": "", "coverage": { "layouts": 3 } }));
        assert_eq!(design["library"]["recentCompositionCount"], json!(2));
        assert_eq!(design["library"]["pinned"], json!(true));
        let catalog = office_design_catalog("docx", Some(&library)).expect("catalog");
        let ids: Vec<&str> = catalog.as_array().expect("rows").iter().filter_map(|row| row["id"].as_str()).collect();
        assert_eq!(ids, ["executive", "editorial", "technical", "data", "brand"]);
        assert_eq!(catalog[4]["defaults"]["margin"], json!(61.2));
        assert!(office_design_catalog("", None).expect("catalog")[0].get("defaults").is_none());
    }

    #[test]
    fn unknown_formats_and_profiles_are_refused() {
        assert_eq!(resolve_office_design("odt", &json!({}), None, &context("explain")), Err("Unsupported Office design format: odt".into()));
        assert_eq!(
            resolve_office_design("docx", &json!({ "profile": "Zine" }), None, &context("explain")),
            Err("Unknown Office design profile \"zine\". Use one of: executive, editorial, technical, data".into())
        );
        assert_eq!(office_design_catalog("odt", None), Err("Unsupported Office design format: odt".into()));
        let content_error = resolve_office_design("docx", &json!({ "content": "x" }), None, &context("explain"));
        assert_eq!(content_error, Err("Office design.content must be an object".into()));
    }

    #[test]
    fn the_deck_plan_reads_the_request_then_the_direction() {
        let design = resolve(
            "pptx",
            json!({
                "signature": "loop",
                "deck": { "backgroundMode": "DARK", "roles": { "cover": "accent", "content": "nope" }, "sectionSlides": [3, "2", 2, 0, 1.5], "layoutBias": ["a"], "templateMode": " Strict ", "enforce": false },
                "slidePlans": [{ "n": 1 }], "brief": { "x": 1 },
            }),
        );
        let deck = &design["deck"];
        assert_eq!(deck["backgroundMode"], json!("dark"));
        assert_eq!(deck["roles"], json!({ "cover": "accent", "content": "inverse", "section": "inverse", "closing": "inverse" }));
        assert_eq!(deck["dominantColorRole"], json!("inverse"));
        assert_eq!(deck["sectionSlides"], json!([2, 3]));
        assert_eq!(deck["layoutBias"], json!(["a"]));
        assert_eq!(deck["templateMode"], json!("strict"));
        assert_eq!(deck["compositionMode"], json!("model"));
        assert_eq!(deck["enforce"], json!(false));
        assert_eq!(deck["requireSlidePlan"], json!(true));
        assert_eq!(deck["motif"], json!("editorial crops and decisive whitespace · loop"));
        assert_eq!(design["slidePlans"], json!([{ "n": 1 }]));
        assert_eq!(design["brief"], json!({ "x": 1 }));
        assert!(resolve("docx", json!({}))["deck"].is_null());
        assert!(resolve("docx", json!({})).get("slidePlans").is_none());
    }

    #[test]
    fn helpers_read_values_as_the_script_does() {
        assert_eq!(strings(Some(&json!(["a", null, "", 3]))), ["a", "3"]);
        assert_eq!(strings(Some(&json!("x"))), ["x"]);
        assert!(strings(Some(&json!(""))).is_empty() && strings(None).is_empty());
        assert_eq!(hex(Some(&json!("#1f7a55")), json!("0")), json!("1F7A55"));
        assert_eq!(hex(Some(&json!("nope")), json!("0")), json!("0"));
        assert_eq!(
            json_stringify(&merge(&json!({ "a": { "b": 1, "c": 2 }, "d": [1] }), &json!({ "a": { "b": 3 }, "d": 5, "e": null }))),
            r#"{"a":{"b":3,"c":2},"d":5,"e":null}"#
        );
        assert_eq!(provenance_text(Some(&json!({ "document": " a.xlsx ", "target": "B2" }))), "a.xlsx#B2");
        assert_eq!(provenance_text(Some(&json!({ "label": "L" }))), "L");
        assert_eq!(provenance_text(Some(&json!(" s "))), "s");
        assert_eq!(provenance_text(Some(&json!(5))), "");
        assert_eq!(provenance_text(None), "");
    }

    #[test]
    fn the_compact_design_summarises_the_content() {
        let design = resolve("docx", json!({ "content": { "packageId": "p", "facts": [{ "id": "a", "value": 1 }] } }));
        let compact = compact_design(&design);
        assert_eq!(compact["content"]["factCount"], json!(1));
        assert!(compact.get("recentCompositions").is_none() && compact.get("deck").is_none());
        assert_eq!(compact["review"]["frontier"], json!(true));
        assert!(compact_design(&json!({}))["content"].is_null());
    }
}
