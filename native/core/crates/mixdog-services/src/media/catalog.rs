//! Studio's model catalog projection (`runtime/media/catalog.mjs` `projectMediaModels`): the live
//! provider rows of a lane reduced to the image and video models our adapters implement, with
//! their labels, controls and default order, and the catalog failures' safe diagnostics
//! (`catalog-errors.mjs`).

use std::cmp::Ordering;
use std::collections::HashSet;
use std::sync::LazyLock;

use mixdog_js::js_trim;
use mixdog_js::locale_compare_en_numeric;
use mixdog_js::to_number;
use mixdog_js::value_to_string;
use regex::Regex;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// One selectable model of a lane (`{ id, label, controls, description?, requestModel? }`).
#[derive(Debug, Clone, PartialEq)]
pub struct Model {
    pub id: String,
    pub label: String,
    pub controls: Value,
    pub description: Option<String>,
    pub request_model: Option<String>,
}

/// `{ image, video }`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Projected {
    pub image: Vec<Model>,
    pub video: Vec<Model>,
}

impl Projected {
    pub fn of(&self, kind: &str) -> &[Model] {
        if kind == "video" { &self.video } else { &self.image }
    }
}

const IMAGE_API_LANES: [&str; 2] = ["openrouter", "nano-gpt"];
const IMAGE_API_MAX_REFERENCES: f64 = 16.0;

/// `imageApiLane(laneId)`.
pub fn image_api_lane(lane: &str) -> bool {
    IMAGE_API_LANES.contains(&lane)
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a static pattern")
}

fn google_lane(lane: &str) -> bool {
    lane == "gemini" || lane == "antigravity-oauth"
}

fn grok_lane(lane: &str) -> bool {
    lane == "xai" || lane == "grok-oauth"
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn methods_allow(row: &Value, method: &str) -> bool {
    match row.get("supportedGenerationMethods") {
        Some(Value::Array(methods)) => methods.iter().any(|m| m.as_str() == Some(method)),
        _ => true,
    }
}

fn image_tool_supported(row: &Value, id: &str) -> bool {
    if row.get("supportsImageGeneration") == Some(&Value::Bool(false)) {
        return false;
    }
    if let Some(Value::Array(tools)) = row.get("supportedTools") {
        return tools.iter().any(|t| t.as_str() == Some("image_generation"));
    }
    if row.get("supportsImageGeneration") == Some(&Value::Bool(true)) {
        return true;
    }
    static MAJOR: LazyLock<Regex> = LazyLock::new(|| re(r"^gpt-([0-9]+)(?:[.-]|$)"));
    static EXCLUDED: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)(?:^|-)(?:codex|nano|pro|chat|audio|realtime|search)(?:-|$)"));
    let major = MAJOR.captures(id).and_then(|c| c[1].parse::<f64>().ok());
    major.is_some_and(|major| major >= 5.0) && !EXCLUDED.is_match(id)
}

fn image_api_outputs_image(row: &Value) -> bool {
    let outputs = row.pointer("/architecture/output_modalities").and_then(Value::as_array);
    outputs.is_some_and(|o| o.iter().any(|m| m.as_str() == Some("image"))) && row.pointer("/capabilities/image_generation") != Some(&Value::Bool(false))
}

fn image_api_reference_cap(row: &Value) -> f64 {
    if let Some(descriptor) = row.pointer("/supported_parameters/input_references") {
        let max = to_number(descriptor.get("max").unwrap_or(&Value::Null));
        if descriptor.get("type").and_then(Value::as_str) == Some("range") && max.is_finite() {
            return max.trunc().clamp(0.0, IMAGE_API_MAX_REFERENCES);
        }
    }
    let inputs = row.pointer("/architecture/input_modalities").and_then(Value::as_array);
    let accepts = inputs.is_some_and(|i| i.iter().any(|m| m.as_str() == Some("image"))) && row.pointer("/capabilities/image_to_image") != Some(&Value::Bool(false));
    if accepts { IMAGE_API_MAX_REFERENCES } else { 0.0 }
}

fn image_api_controls(row: &Value) -> Value {
    let mut controls = Map::new();
    for (param, control) in [("aspect_ratio", "aspectRatio"), ("resolution", "resolution"), ("quality", "quality"), ("background", "background")] {
        let descriptor = row.pointer(&format!("/supported_parameters/{param}"));
        let values = match descriptor {
            Some(d) if d.get("type").and_then(Value::as_str) == Some("enum") => d.get("values").and_then(Value::as_array),
            _ => None,
        };
        let mut seen = HashSet::new();
        let values: Vec<Value> = values
            .map(|values| values.iter().map(|v| js_trim(&value_to_string(v)).to_owned()).filter(|s| !s.is_empty()).filter(|s| seen.insert(s.clone())).map(Value::String).collect())
            .unwrap_or_default();
        if !values.is_empty() {
            controls.insert(control.into(), Value::Array(values));
        }
    }
    controls.insert("maxReferences".into(), json!(image_api_reference_cap(row) as i64));
    Value::Object(controls)
}

fn kind_for(lane: &str, row: &Value, id: &str) -> Option<&'static str> {
    if row.get("deprecated") == Some(&Value::Bool(true)) || row.get("disabled") == Some(&Value::Bool(true)) {
        return None;
    }
    if image_api_lane(lane) {
        return image_api_outputs_image(row).then_some("image");
    }
    if lane == "openai-oauth" {
        return image_tool_supported(row, id).then_some("image");
    }
    if grok_lane(lane) {
        static IMAGE: LazyLock<Regex> = LazyLock::new(|| re(r"^grok-imagine-image(?:-|$)"));
        static VIDEO: LazyLock<Regex> = LazyLock::new(|| re(r"^grok-imagine-video(?:-|$)"));
        static VIDEO_15: LazyLock<Regex> = LazyLock::new(|| re(r"^grok-imagine-video-1\.5(?:-|$)"));
        if IMAGE.is_match(id) {
            return Some("image");
        }
        // This version requires a start image: Studio also permits prompt-only generation.
        return (VIDEO.is_match(id) && !VIDEO_15.is_match(id)).then_some("video");
    }
    if google_lane(lane) {
        static GEMINI_IMAGE: LazyLock<Regex> = LazyLock::new(|| re(r"^gemini-.*(?:^|-)image(?:-|$)"));
        if GEMINI_IMAGE.is_match(id) && methods_allow(row, "generateContent") {
            return Some("image");
        }
    }
    if lane == "gemini" {
        static OMNI: LazyLock<Regex> = LazyLock::new(|| re(r"^gemini-omni-(?:[0-9.]+-)?flash(?:-|$)"));
        static VEO: LazyLock<Regex> = LazyLock::new(|| re(r"^veo-3(?:\.[0-9]+)?-.*generate(?:-|$)"));
        if OMNI.is_match(id) {
            return Some("video");
        }
        if VEO.is_match(id) && methods_allow(row, "predictLongRunning") {
            return Some("video");
        }
    }
    None
}

fn version(id: &str) -> String {
    static LEAD: LazyLock<Regex> = LazyLock::new(|| re(r"^(?:gpt|gemini|veo)-([0-9]+(?:\.[0-9]+)*)"));
    static ANY: LazyLock<Regex> = LazyLock::new(|| re(r"(?:image|video|omni)-([0-9]+(?:\.[0-9]+)*)"));
    LEAD.captures(id).or_else(|| ANY.captures(id)).map_or_else(|| "0".to_owned(), |c| c[1].to_owned())
}

fn is_preferred(lane: &str, kind: &str, id: &str) -> bool {
    static MINI: LazyLock<Regex> = LazyLock::new(|| re(r"(?:^|-)mini(?:-|$)"));
    if lane == "openai-oauth" {
        return !MINI.is_match(id);
    }
    if lane == "gemini" && kind == "video" {
        return id.starts_with("gemini-omni-");
    }
    if google_lane(lane) && kind == "image" {
        static DEMOTED: LazyLock<Regex> = LazyLock::new(|| re(r"-lite-|preview|experimental"));
        return !DEMOTED.is_match(id);
    }
    true
}

fn google_image_label(id: &str) -> Option<&'static str> {
    match id {
        "gemini-2.5-flash-image" => Some("Nano Banana · Gemini 2.5 Flash Image"),
        "gemini-3.1-flash-image" => Some("Nano Banana 2 · Gemini 3.1 Flash Image"),
        "gemini-3.1-flash-lite-image" => Some("Nano Banana 2 Lite · Gemini 3.1 Flash Lite Image"),
        "gemini-3-pro-image" => Some("Nano Banana Pro · Gemini 3 Pro Image"),
        _ => None,
    }
}

fn strip_models_prefix(text: &str) -> &str {
    text.strip_prefix("models/").unwrap_or(text)
}

/// Official tiers and generations stay intact; no quality ranking is inferred.
fn model_label(lane: &str, row: &Value, id: &str) -> String {
    let first = ["displayName", "display", "label", "name"].iter().find_map(|key| row.get(*key).filter(|v| truthy(Some(v))));
    let mut label = strip_models_prefix(&first.map_or_else(|| id.to_owned(), value_to_string)).to_owned();
    if grok_lane(lane) {
        static QUALITY: LazyLock<Regex> = LazyLock::new(|| re(r"-quality$"));
        static DASH_DIGIT: LazyLock<Regex> = LazyLock::new(|| re(r"-([0-9])"));
        let mut text = id.to_owned();
        if let Some(rest) = text.strip_prefix("grok-imagine-image") {
            text = format!("Grok Imagine Image{rest}");
        } else if let Some(rest) = text.strip_prefix("grok-imagine-video") {
            text = format!("Grok Imagine Video{rest}");
        }
        let text = QUALITY.replace(&text, " Quality").into_owned();
        label = DASH_DIGIT.replace(&text, " $1").into_owned();
    } else if google_lane(lane) {
        static PREVIEW_TAIL: LazyLock<Regex> = LazyLock::new(|| re(r"-preview(?:-.*)?$"));
        if let Some(known) = google_image_label(&PREVIEW_TAIL.replace(id, "")) {
            label = known.to_owned();
        }
    }
    static PREVIEW: LazyLock<Regex> = LazyLock::new(|| re(r"-preview(?:-|$)"));
    static EXPERIMENTAL: LazyLock<Regex> = LazyLock::new(|| re(r"-experimental(?:-|$)"));
    if PREVIEW.is_match(id) && !label.to_lowercase().contains("preview") {
        label.push_str(" (Preview)");
    }
    if EXPERIMENTAL.is_match(id) && !label.to_lowercase().contains("experimental") {
        label.push_str(" (Experimental)");
    }
    label
}

struct Candidate {
    model: Model,
    created: f64,
}

fn compare(a: &Candidate, b: &Candidate) -> Ordering {
    static UNSTABLE: LazyLock<Regex> = LazyLock::new(|| re(r"preview|experimental"));
    let unstable = |c: &Candidate| UNSTABLE.is_match(&c.model.id);
    unstable(a)
        .cmp(&unstable(b))
        .then_with(|| b.created.partial_cmp(&a.created).unwrap_or(Ordering::Equal))
        .then_with(|| locale_compare_en_numeric(&version(&b.model.id), &version(&a.model.id)))
        .then_with(|| locale_compare_en_numeric(&b.model.id, &a.model.id))
}

/// `Number(value) || 0`.
fn created_of(row: &Value) -> f64 {
    let n = to_number(row.get("created").unwrap_or(&Value::Null));
    if n.is_nan() { 0.0 } else { n }
}

/// `projectMediaModels(lane, rows)`.
pub fn project_media_models(lane: &str, rows: &[Value]) -> Projected {
    let mut found: [Vec<Candidate>; 2] = [Vec::new(), Vec::new()];
    let mut seen = HashSet::new();
    for row in rows {
        let raw = ["id", "name"].iter().find_map(|key| row.get(*key).filter(|v| truthy(Some(v)))).map(value_to_string).unwrap_or_default();
        let id = js_trim(strip_models_prefix(&raw)).to_owned();
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        let Some(kind) = kind_for(lane, row, &id) else { continue };
        let controls = if image_api_lane(lane) {
            image_api_controls(row)
        } else if grok_lane(lane) && kind == "video" {
            json!({ "resolution": ["480p", "720p"] })
        } else if lane == "gemini" && id.starts_with("gemini-omni-") {
            json!({ "resolution": [], "durations": [], "maxReferences": 3 })
        } else {
            json!({})
        };
        let model = Model { label: model_label(lane, row, &id), id, controls, description: None, request_model: None };
        found[usize::from(kind == "video")].push(Candidate { model, created: created_of(row) });
    }
    let [image, video] = found;
    let mut result = Projected::default();
    for (kind, mut candidates) in [("image", image), ("video", video)] {
        candidates.sort_by(compare);
        if let Some(at) = candidates.iter().position(|c| is_preferred(lane, kind, &c.model.id)).filter(|at| *at > 0) {
            let preferred = candidates.remove(at);
            candidates.insert(0, preferred);
        }
        let models = candidates.into_iter().map(|c| c.model).collect();
        if kind == "image" { result.image = models } else { result.video = models }
    }
    if lane == "openai-oauth" {
        // The account catalog lists orchestrators, not selectable image engines: one explicitly
        // automatic route is exposed instead.
        result.image = result.image.first().map_or_else(Vec::new, |orchestrator| {
            vec![Model {
                id: "gpt-image-2".into(),
                label: "GPT Image 2".into(),
                description: Some("ChatGPT image engine. Output size/quality are chosen by ChatGPT; background can be transparent.".into()),
                request_model: Some(orchestrator.id.clone()),
                controls: json!({ "maxReferences": 5, "background": ["auto", "transparent", "opaque"] }),
            }]
        });
    }
    result
}

/// `MESSAGES[code]` of `catalog-errors.mjs`.
pub fn catalog_message(code: &str) -> Option<&'static str> {
    Some(match code {
        "MEDIA_BILLING_BLOCKED" => "API credits exhausted or spending limit reached. Check provider billing.",
        "MEDIA_AUTH_REJECTED" => "Authentication failed. Check the API key or reconnect the account.",
        "MEDIA_ACCESS_DENIED" => "Model catalog access denied. Check account permissions.",
        "MEDIA_RATE_LIMITED" => "Too many requests. Wait a moment and retry.",
        "MEDIA_CATALOG_TIMEOUT" => "Model catalog request timed out. Retry after checking the connection.",
        "MEDIA_CATALOG_UNAVAILABLE" => "Model catalog unavailable. Retry after checking the provider connection.",
        _ => return None,
    })
}

/// A catalog request's failure: the code a caller set (`catalogHttpError`) or the error's name.
#[derive(Debug, Clone, Default)]
pub struct CatalogFailure {
    pub code: Option<String>,
    pub timed_out: bool,
}

/// `catalogDiagnostic(error)`: the safe `(code, message)`.
pub fn catalog_diagnostic(failure: &CatalogFailure) -> (&'static str, &'static str) {
    const KNOWN: [&str; 6] = ["MEDIA_BILLING_BLOCKED", "MEDIA_AUTH_REJECTED", "MEDIA_ACCESS_DENIED", "MEDIA_RATE_LIMITED", "MEDIA_CATALOG_TIMEOUT", "MEDIA_CATALOG_UNAVAILABLE"];
    let code = match failure.code.as_deref() {
        Some(code) if KNOWN.contains(&code) => KNOWN.iter().find(|k| **k == code).copied().unwrap_or("MEDIA_CATALOG_UNAVAILABLE"),
        _ if failure.timed_out => "MEDIA_CATALOG_TIMEOUT",
        _ => "MEDIA_CATALOG_UNAVAILABLE",
    };
    (code, catalog_message(code).unwrap_or_default())
}

/// `catalogHttpError(status, text)`'s code.
pub fn catalog_http_code(status: u16, text: &str) -> &'static str {
    static BILLING: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)credit|spending limit|billing|insufficient_quota|payment required"));
    if BILLING.is_match(text) {
        return "MEDIA_BILLING_BLOCKED";
    }
    match status {
        401 => "MEDIA_AUTH_REJECTED",
        403 => "MEDIA_ACCESS_DENIED",
        429 => "MEDIA_RATE_LIMITED",
        408 | 504 => "MEDIA_CATALOG_TIMEOUT",
        _ => "MEDIA_CATALOG_UNAVAILABLE",
    }
}
