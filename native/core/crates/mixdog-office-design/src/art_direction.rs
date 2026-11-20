//! `design/design-art-direction.mjs`: three subject-seeded art directions per request, each a one-hue lightness-ladder
//! palette with a typography, a style and a creative system, ranked by how well they fit the purpose and mode.

use std::cmp::Ordering;
use std::sync::LazyLock;

use mixdog_js::{JsRegex, json_number, locale_compare_en};
use mixdog_office_base::values::{compact, plain_object, sha256, truthy};
use serde_json::{Map, Value, json};

use crate::discipline::{hsl_to_hex, normalize_palette_tokens};
use crate::{array_of, first_text, prop, text};

struct Blueprint {
    id: &'static str,
    label: &'static str,
    purposes: &'static [&'static str],
    modes: &'static [&'static str],
    hue_offset: f64,
    accent2_offset: f64,
    motif: &'static str,
    background_mode: &'static str,
    image_treatment: &'static str,
    layout_bias: &'static [&'static str],
    grid: &'static str,
    shape_language: &'static str,
    chart_treatment: &'static str,
    density_pattern: &'static [&'static str],
    motif_rules: &'static [&'static str],
    typography: [&'static str; 3],
    style: StyleBlueprint,
}

struct StyleBlueprint {
    id: &'static str,
    motif: &'static str,
    corners: &'static str,
    boundaries: &'static str,
    elevation: &'static str,
    composition: &'static str,
    page_rhythm: &'static [&'static str],
}

static DIRECTION_BLUEPRINTS: [Blueprint; 3] = [
    Blueprint {
        id: "evidence-grid",
        label: "Evidence Grid",
        purposes: &["monitor", "inspect", "compare", "decide"],
        modes: &["conservative", "strong-fit"],
        hue_offset: 0.0,
        accent2_offset: 38.0,
        motif: "measured evidence windows",
        background_mode: "light",
        image_treatment: "contained-evidence",
        layout_bias: &["evidence", "data", "comparison", "process"],
        grid: "twelve-column analytical grid with one dominant evidence field",
        shape_language: "square evidence fields, quiet dividers, numeric anchors",
        chart_treatment: "native chart with direct labels and a decision commentary rail",
        density_pattern: &["light opening", "dense proof", "balanced choice", "light close"],
        motif_rules: &["repeat measured windows", "use one dominant number per proof beat", "avoid equal card grids"],
        typography: ["Calibri", "Calibri", "Arial"],
        style: StyleBlueprint {
            id: "swiss-grid",
            motif: "grid-marks",
            corners: "sharp",
            boundaries: "rules-and-planes",
            elevation: "flat",
            composition: "one oversized geometric plane zoning the page; content flush to one axis; hero numeral at architectural scale",
            page_rhythm: &["anchor", "dense", "dense", "breathing", "anchor"],
        },
    },
    Blueprint {
        id: "editorial-contrast",
        label: "Editorial Contrast",
        purposes: &["decide", "explain", "compare"],
        modes: &["strong-fit", "divergent"],
        hue_offset: 22.0,
        accent2_offset: 168.0,
        motif: "editorial crops and decisive whitespace",
        background_mode: "sandwich",
        image_treatment: "editorial-crop",
        layout_bias: &["editorial", "typography", "evidence", "decision"],
        grid: "asymmetric editorial grid with controlled crops and wide outer margins",
        shape_language: "hairline fields, serif display contrast, offset captions",
        chart_treatment: "chart as editorial evidence with annotation blocks and selective labels",
        density_pattern: &["quiet opening", "alternating proof density", "decisive close"],
        motif_rules: &["repeat editorial crops", "pair serif thesis with sans evidence", "preserve asymmetry"],
        typography: ["Cambria", "Calibri", "Arial"],
        style: StyleBlueprint {
            id: "editorial",
            motif: "oversized-numeral",
            corners: "minimal",
            boundaries: "hairlines-and-columns",
            elevation: "flat",
            composition: "oversized numeral anchoring the page; asymmetric column split; a figure crossing a column edge; kicker → headline → standfirst hierarchy",
            page_rhythm: &["anchor", "dense", "breathing", "dense", "anchor"],
        },
    },
    Blueprint {
        id: "immersive-signal",
        label: "Immersive Signal",
        purposes: &["explain", "decide", "monitor"],
        modes: &["divergent"],
        hue_offset: -18.0,
        accent2_offset: 155.0,
        motif: "immersive fields with one sharp signal",
        background_mode: "dark",
        image_treatment: "full-bleed-focus",
        layout_bias: &["minimal", "rhythm", "split", "data"],
        grid: "cinematic split field with one oversized signal and compressed support",
        shape_language: "deep fields, oversized type, sharp signal chips",
        chart_treatment: "minimal native chart with luminous signal series and direct callouts",
        density_pattern: &["immersive opening", "high-contrast proof", "compressed decision close"],
        motif_rules: &["one sharp signal per slide", "alternate immersive and analytical fields", "never decorate without evidence"],
        typography: ["Arial", "Calibri", "Courier New"],
        style: StyleBlueprint {
            id: "dark-tech",
            motif: "halo-field",
            corners: "slight",
            boundaries: "glow-and-layering",
            elevation: "glow",
            composition: "concentric halo staging one central metric; oversized type floating on dark negative space; monospace labels with wide tracking",
            page_rhythm: &["anchor", "dense", "breathing", "dense", "anchor"],
        },
    },
];

fn strings(list: &[&str]) -> Value {
    json!(list)
}

/// The creative system a blueprint prescribes. Built fresh per call so the direction's own copy and the deck's copy
/// never share their lists.
fn creative_system_of(blueprint: &Blueprint) -> Map<String, Value> {
    let mut system = Map::new();
    system.insert("grid".into(), json!(blueprint.grid));
    system.insert("shapeLanguage".into(), json!(blueprint.shape_language));
    system.insert("chartTreatment".into(), json!(blueprint.chart_treatment));
    system.insert("densityPattern".into(), strings(blueprint.density_pattern));
    system.insert("motifRules".into(), strings(blueprint.motif_rules));
    system
}

fn hash(value: &str) -> String {
    sha256(value)
}

/// `Number.parseInt(hash.slice(0, digits), 16)`.
fn hash_number(hash: &str, digits: usize) -> f64 {
    f64::from(u32::from_str_radix(&hash[..digits], 16).unwrap_or(0))
}

fn stable_hue(value: &str) -> f64 {
    hash_number(&hash(value), 6) % 360.0
}

/// One hue family drives the whole palette as a lightness ladder: near-white canvas, tinted dark field, low-saturation
/// text, and a single saturated accent with one secondary. The result is then contrast-repaired like any palette.
fn direction_palette(hue: f64, blueprint: &Blueprint) -> Map<String, Value> {
    let primary = hue + blueprint.hue_offset;
    let immersive = blueprint.id == "immersive-signal";
    let secondary = primary + blueprint.accent2_offset;
    let pick = |plain: f64, immersive_value: f64| if immersive { immersive_value } else { plain };
    let source = json!({
        "canvas": hsl_to_hex(primary, 14.0, 97.0),
        "ink": hsl_to_hex(primary, 22.0, 14.0),
        "muted": hsl_to_hex(primary, 16.0, 40.0),
        "accent": hsl_to_hex(primary, pick(62.0, 74.0), pick(40.0, 46.0)),
        "accent2": hsl_to_hex(secondary, 64.0, 46.0),
        "surface": hsl_to_hex(primary, 20.0, 92.0),
        "surface2": hsl_to_hex(primary, 18.0, 85.0),
        "inverse": hsl_to_hex(primary, pick(26.0, 30.0), pick(14.0, 11.0)),
        "onAccent": "FFFFFF",
        "onInverse": hsl_to_hex(primary, 12.0, 96.0),
    });
    normalize_palette_tokens(&source).colors
}

fn object_or_empty(value: Option<&Value>) -> &Value {
    static EMPTY: LazyLock<Value> = LazyLock::new(|| Value::Object(Map::new()));
    value.filter(|inner| plain_object(inner)).unwrap_or(&EMPTY)
}

fn subject_seed(input: &Value, profile: &str) -> String {
    let art_direction = object_or_empty(prop(input, "artDirection"));
    let content = object_or_empty(prop(input, "content"));
    let joined = [
        prop(art_direction, "seed"),
        prop(input, "signature"),
        prop(input, "intent"),
        prop(content, "objective"),
        prop(content, "decision"),
        prop(content, "packageId"),
        prop(input, "audience"),
        prop(input, "tone"),
    ]
    .iter()
    .map(|entry| mixdog_js::js_trim(&text(*entry)).to_owned())
    .filter(|entry| !entry.is_empty())
    .collect::<Vec<_>>()
    .join("|");
    if joined.is_empty() { profile.to_owned() } else { joined }
}

struct Domain {
    id: &'static str,
    hue: Option<f64>,
}

static FINANCIAL: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(revenue|profit|investment|finance|growth|margin|매출|이익|투자|성장|재무)", "i"));
static HEALTHCARE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(health|patient|clinical|care|병원|환자|의료|건강)", "i"));
static CLIMATE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(climate|energy|sustain|carbon|환경|에너지|탄소|기후)", "i"));
static TECHNOLOGY: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"(product|software|platform|developer|ai|tech|제품|소프트웨어|플랫폼|개발|기술)", "i"));
static BOLD_TONE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(bold|dramatic|launch|premium|강렬|대담|출시)", "i"));
static EDITORIAL_TONE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(editorial|narrative|story|보고서|서사)", "i"));

fn subject_domain(input: &Value) -> Domain {
    let content = object_or_empty(prop(input, "content"));
    let mut parts: Vec<String> =
        [prop(input, "intent"), prop(input, "signature"), prop(input, "audience"), prop(input, "tone"), prop(content, "objective"), prop(content, "decision")]
            .iter()
            .map(|entry| text(*entry))
            .collect();
    if let Some(claims) = array_of(prop(content, "claims")) {
        parts.extend(claims.iter().map(|claim| text(prop(claim, "text"))));
    }
    let value = parts.join(" ");
    if FINANCIAL.is_match(&value) {
        return Domain { id: "financial-decision", hue: Some(158.0) };
    }
    if HEALTHCARE.is_match(&value) {
        return Domain { id: "healthcare", hue: Some(174.0) };
    }
    if CLIMATE.is_match(&value) {
        return Domain { id: "climate", hue: Some(112.0) };
    }
    if TECHNOLOGY.is_match(&value) {
        return Domain { id: "technology", hue: Some(214.0) };
    }
    Domain { id: "subject-seeded", hue: None }
}

fn subject_label(input: &Value) -> String {
    let content = object_or_empty(prop(input, "content"));
    let written = first_text(&[prop(input, "signature"), prop(input, "intent"), prop(content, "decision"), prop(content, "objective")]);
    compact(&written, 72)
}

/// `requestedDirection`: a string names a direction by id, an object is the direction's own request.
fn requested_direction(input: &Value) -> Value {
    match prop(input, "artDirection") {
        Some(Value::String(id)) => json!({ "id": id }),
        Some(object) if plain_object(object) => object.clone(),
        _ => Value::Object(Map::new()),
    }
}

struct ScoreContext<'a> {
    purpose: &'a str,
    expression_mode: &'a str,
    tone: &'a str,
    requested_id: &'a str,
    seed: &'a str,
}

fn direction_score(blueprint: &Blueprint, context: &ScoreContext) -> f64 {
    let mut score = 0.0;
    if blueprint.purposes.iter().any(|known| *known == context.purpose) {
        score += 20.0;
    }
    if blueprint.modes.iter().any(|known| *known == context.expression_mode) {
        score += 6.0;
    }
    if context.expression_mode == "divergent" && blueprint.id == "immersive-signal" {
        score += 10.0;
    }
    if context.expression_mode == "conservative" && blueprint.id == "evidence-grid" {
        score += 8.0;
    }
    if BOLD_TONE.is_match(context.tone) && blueprint.id == "immersive-signal" {
        score += 12.0;
    }
    if EDITORIAL_TONE.is_match(context.tone) && blueprint.id == "editorial-contrast" {
        score += 12.0;
    }
    if !context.requested_id.is_empty() && context.requested_id == blueprint.id {
        score += 1_000.0;
    }
    score += (hash_number(&hash(&format!("{}|{}", context.seed, blueprint.id)), 4) % 100.0) / 1_000.0;
    score
}

/// `resolveOfficeArtDirection(format, input, { profile, purpose, expressionMode })`: the ranked candidates, the
/// selected one, and whether its tokens apply to the design. The caller's defaults are an empty profile, purpose
/// `explain` and mode `strong-fit`.
pub fn resolve_office_art_direction(format: &str, input: &Value, profile: &str, purpose: &str, expression_mode: &str) -> Value {
    let request = object_or_empty(Some(input));
    let requested = requested_direction(request);
    let raw_subject = subject_label(request);
    let seed = subject_seed(request, profile);
    let domain = subject_domain(request);
    let base_hue = domain.hue.unwrap_or_else(|| stable_hue(&seed));
    let normalized_format = mixdog_js::js_to_lowercase(format);
    // A sheet is read on white cells: a dark-background blueprint is never offered for a workbook.
    let blueprints: Vec<&Blueprint> =
        DIRECTION_BLUEPRINTS.iter().filter(|blueprint| normalized_format != "xlsx" || blueprint.background_mode != "dark").collect();
    let tone = text(prop(request, "tone"));
    let requested_id = text(prop(&requested, "id"));
    let mut candidates: Vec<(Value, f64, String)> = blueprints
        .iter()
        .map(|blueprint| {
            let palette = direction_palette(base_hue, blueprint);
            let motif = if raw_subject.is_empty() { blueprint.motif.to_owned() } else { format!("{} · {raw_subject}", blueprint.motif) };
            let score = direction_score(blueprint, &ScoreContext { purpose, expression_mode, tone: &tone, requested_id: &requested_id, seed: &seed });
            let mut style = Map::new();
            let style_blueprint = &blueprint.style;
            style.insert("id".into(), json!(style_blueprint.id));
            style.insert("motif".into(), json!(style_blueprint.motif));
            style.insert("corners".into(), json!(style_blueprint.corners));
            style.insert("boundaries".into(), json!(style_blueprint.boundaries));
            style.insert("elevation".into(), json!(style_blueprint.elevation));
            style.insert("composition".into(), json!(style_blueprint.composition));
            style.insert("pageRhythm".into(), strings(style_blueprint.page_rhythm));
            let mut deck = Map::new();
            deck.insert("backgroundMode".into(), json!(blueprint.background_mode));
            deck.insert("motif".into(), json!(motif));
            deck.insert("imageTreatment".into(), json!(blueprint.image_treatment));
            deck.insert("layoutBias".into(), strings(blueprint.layout_bias));
            deck.extend(creative_system_of(blueprint));
            let candidate = json!({
                "id": blueprint.id,
                "label": blueprint.label,
                "rationale": format!("{} fits {purpose} through {}.", blueprint.label, blueprint.motif),
                "motif": motif,
                "palette": palette,
                "typography": { "display": blueprint.typography[0], "body": blueprint.typography[1], "data": blueprint.typography[2] },
                "style": style,
                "creativeSystem": creative_system_of(blueprint),
                "deck": deck,
                "score": json_number(score),
            });
            (candidate, score, blueprint.id.to_owned())
        })
        .collect();
    candidates
        .sort_by(|left, right| right.1.partial_cmp(&left.1).filter(|order| *order != Ordering::Equal).unwrap_or_else(|| locale_compare_en(&left.2, &right.2)));
    let mut selected = candidates[0].0.clone();
    let has_subject = !raw_subject.is_empty() || prop(&requested, "seed").is_some_and(truthy) || prop(&requested, "id").is_some_and(truthy);
    let disabled = prop(input, "artDirection") == Some(&Value::Bool(false)) || prop(&requested, "enabled") == Some(&Value::Bool(false));
    let mut source = "profile-default";
    if disabled {
        source = "disabled";
    } else if prop(&requested, "id").is_some_and(truthy) {
        source = "explicit";
    } else if has_subject {
        source = "content-seeded";
    }
    let reason = if prop(&requested, "id").is_some_and(truthy) { "explicit direction".to_owned() } else { format!("{purpose}/{expression_mode} fit") };
    selected.as_object_mut().expect("an object").insert("selectionReason".into(), Value::String(reason));
    json!({
        "format": normalized_format,
        "source": source,
        "seedFingerprint": hash(&seed)[..16],
        "subjectDomain": domain.id,
        "applyTokens": !disabled && has_subject,
        "selected": selected,
        "candidates": candidates.into_iter().map(|(candidate, _, _)| candidate).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn direction(format: &str, input: Value, mode: &str) -> Value {
        resolve_office_art_direction(format, &input, "", "explain", mode)
    }

    #[test]
    fn a_workbook_is_offered_no_dark_blueprint_and_accent2_varies_by_blueprint() {
        let input = json!({ "signature": "quarterly review", "tone": "bold dramatic launch", "expressionMode": "divergent" });
        let sheet = direction("xlsx", input.clone(), "divergent");
        let sheet_candidates = sheet["candidates"].as_array().expect("candidates");
        assert!(!sheet_candidates.iter().any(|candidate| candidate["deck"]["backgroundMode"] == json!("dark")));
        assert_ne!(sheet["selected"]["deck"]["backgroundMode"], json!("dark"));
        let deck = direction("pptx", input, "divergent");
        let candidates = deck["candidates"].as_array().expect("candidates");
        assert!(candidates.iter().any(|candidate| candidate["deck"]["backgroundMode"] == json!("dark")));
        let mut accents: Vec<String> = candidates.iter().map(|candidate| text(prop(&candidate["palette"], "accent2"))).collect();
        accents.sort();
        accents.dedup();
        assert_eq!(accents.len(), candidates.len());
    }

    #[test]
    fn the_selection_follows_the_request() {
        let pinned = direction("pptx", json!({ "artDirection": "editorial-contrast" }), "conservative");
        assert_eq!(pinned["selected"]["id"], json!("editorial-contrast"));
        assert_eq!(pinned["selected"]["selectionReason"], json!("explicit direction"));
        assert_eq!(pinned["source"], json!("explicit"));
        assert_eq!(pinned["applyTokens"], json!(true));
        let seeded = direction("pptx", json!({ "intent": "Launch a local-first coding product" }), "strong-fit");
        assert_eq!(seeded["source"], json!("content-seeded"));
        assert_eq!(seeded["subjectDomain"], json!("technology"));
        assert_eq!(seeded["selected"]["selectionReason"], json!("explain/strong-fit fit"));
        assert_eq!(seeded["selected"]["deck"]["motif"], json!("editorial crops and decisive whitespace · Launch a local-first coding product"));
        let off = direction("pptx", json!({ "signature": "x", "artDirection": false }), "strong-fit");
        assert_eq!(off["source"], json!("disabled"));
        assert_eq!(off["applyTokens"], json!(false));
        let bare = direction("pptx", json!({}), "strong-fit");
        assert_eq!(bare["source"], json!("profile-default"));
        assert_eq!(bare["applyTokens"], json!(false));
        assert_eq!(bare["candidates"].as_array().map(Vec::len), Some(3));
    }

    #[test]
    fn a_subject_picks_its_domain_hue() {
        assert_eq!(direction("docx", json!({ "intent": "매출 성장 보고" }), "strong-fit")["subjectDomain"], json!("financial-decision"));
        assert_eq!(direction("docx", json!({ "tone": "clinical" }), "strong-fit")["subjectDomain"], json!("healthcare"));
        assert_eq!(direction("docx", json!({ "audience": "에너지 팀" }), "strong-fit")["subjectDomain"], json!("climate"));
        assert_eq!(direction("docx", json!({ "audience": "ops" }), "strong-fit")["subjectDomain"], json!("subject-seeded"));
    }

    #[test]
    fn a_palette_is_one_hue_and_readable() {
        let sheet = direction("pptx", json!({ "signature": "evidence loop" }), "strong-fit");
        for candidate in sheet["candidates"].as_array().expect("candidates") {
            let palette = candidate["palette"].as_object().expect("palette");
            for role in ["canvas", "ink", "muted", "accent", "accent2", "surface", "surface2", "inverse", "onAccent", "onInverse", "inverse2", "positive"] {
                assert!(palette.contains_key(role), "{role}");
            }
            assert_eq!(candidate["typography"].as_object().map(Map::len), Some(3));
        }
        // The score of an unpinned direction stays under the pinning bonus.
        let scores: Vec<f64> = sheet["candidates"].as_array().expect("candidates").iter().filter_map(|c| c["score"].as_f64()).collect();
        assert_eq!(scores.len(), 3);
        assert!(scores.windows(2).all(|pair| pair[0] >= pair[1]) && scores[0] < 1_000.0);
    }
}
