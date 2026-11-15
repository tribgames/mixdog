//! `design/composition-system.mjs`: the composition planner. Each composed operation is planned as one composition of
//! its format (a document layout, a sheet layout, a deck layout), chosen by scoring the candidates against the
//! operation's content topology, the purpose and expression mode of the request, the compositions the library used
//! recently and the ones already used in the same batch. The choice is seeded by the content, so one request always
//! gets the same composition. [`review_office_composition_sequence`] judges a whole batch for repetition.
//!
//! Plans and reviews are `serde_json` values built in the order Node's objects are built.

use std::cmp::Ordering;
use std::collections::HashMap;

use mixdog_js::{js_to_lowercase, js_trim, json_number, json_stringify, locale_compare, math, to_number_of, value_to_string};
use mixdog_office_base::values::{plain_object, sha256, stable_value, truthy};
use serde_json::{Map, Value, json};

use crate::table_input::{DEFAULT_FIELD, compose_table_rows};
use crate::tokens::CompositionContext;
use crate::{array_of, first_text, first_truthy, opt_prop, prop, text};

const PURPOSES: [&str; 5] = ["monitor", "decide", "compare", "explain", "inspect"];
const EXPRESSION_MODES: [&str; 3] = ["conservative", "strong-fit", "divergent"];

/// How often each composition has been planned so far in one batch (`usage`).
pub type CompositionUsage = HashMap<String, usize>;

/// One entry of the candidate tables. An empty list stands for a field Node leaves out.
struct Spec {
    id: &'static str,
    family: &'static str,
    purposes: &'static [&'static str],
    modes: &'static [&'static str],
    evidence: &'static [&'static str],
    densities: &'static [&'static str],
    novelty: f64,
}

const fn spec(
    id: &'static str,
    family: &'static str,
    purposes: &'static [&'static str],
    modes: &'static [&'static str],
    evidence: &'static [&'static str],
    densities: &'static [&'static str],
    novelty: f64,
) -> Spec {
    Spec { id, family, purposes, modes, evidence, densities, novelty }
}

const DOCX_CANDIDATES: [Spec; 4] = [
    spec("decision-brief", "decision", &["decide"], &["conservative", "strong-fit"], &["claims", "facts"], &["balanced", "dense"], 0.0),
    spec("evidence-brief", "evidence", &["decide", "compare", "inspect"], &["strong-fit", "divergent"], &["table", "facts"], &["balanced", "dense"], 1.0),
    spec("editorial-report", "narrative", &["explain"], &["strong-fit", "divergent"], &["narrative", "claims"], &["light", "balanced"], 1.0),
    spec("compact-memo", "memo", &["decide", "inspect"], &["conservative"], &["narrative"], &["balanced", "dense"], 0.0),
];

const XLSX_CANDIDATES: [Spec; 5] = [
    spec("monitor-dashboard", "monitor", &["monitor"], &["conservative", "strong-fit"], &["metrics", "table"], &["balanced", "dense"], 0.0),
    spec("trend-dashboard", "trend", &["monitor", "explain"], &["strong-fit", "divergent"], &["chart", "table"], &["balanced"], 1.0),
    spec("comparison-board", "comparison", &["compare", "decide"], &["strong-fit", "divergent"], &["chart", "metrics"], &["balanced", "dense"], 1.0),
    spec("analysis-sheet", "analysis", &["inspect", "explain"], &["conservative", "strong-fit"], &["table", "facts"], &["dense"], 0.0),
    spec("narrative-scorecard", "scorecard", &["monitor", "decide"], &["divergent"], &["metrics", "claims"], &["light", "balanced"], 2.0),
];

/// A deck layout of a slide kind: its `variant` is the spec's `id`.
const fn variant(
    id: &'static str,
    family: &'static str,
    purposes: &'static [&'static str],
    modes: &'static [&'static str],
    evidence: &'static [&'static str],
    novelty: f64,
) -> Spec {
    spec(id, family, purposes, modes, evidence, &[], novelty)
}

const COVER_VARIANTS: [Spec; 2] = [
    variant("editorial-left", "editorial", &[], &["conservative", "strong-fit"], &[], 0.0),
    variant("minimal-focus", "minimal", &[], &["strong-fit", "divergent"], &[], 1.0),
];
const STATEMENT_VARIANTS: [Spec; 2] = [
    variant("metric-statement", "evidence", &["decide", "monitor"], &[], &["metrics"], 0.0),
    variant("typographic-statement", "typography", &["decide", "explain"], &[], &["narrative"], 1.0),
];
const METRICS_VARIANTS: [Spec; 2] = [
    variant("asymmetric-metrics", "evidence", &["decide", "monitor"], &["conservative", "strong-fit"], &[], 0.0),
    variant("metric-band", "rhythm", &["monitor", "explain"], &["strong-fit", "divergent"], &[], 1.0),
];
const COMPARISON_VARIANTS: [Spec; 2] = [
    variant("contrast-panels", "comparison", &[], &["conservative", "strong-fit"], &[], 0.0),
    variant("aligned-evidence", "evidence", &[], &["strong-fit", "divergent"], &[], 1.0),
];
const PROCESS_VARIANTS: [Spec; 2] = [
    variant("horizontal-flow", "process", &[], &["conservative", "strong-fit"], &[], 0.0),
    variant("staggered-flow", "rhythm", &[], &["strong-fit", "divergent"], &[], 1.0),
];
const CHART_VARIANTS: [Spec; 2] = [
    variant("commentary-chart", "evidence", &["decide", "explain"], &[], &["narrative"], 0.0),
    variant("chart-led", "data", &["monitor", "compare"], &["strong-fit", "divergent"], &["chart"], 1.0),
];
const TABLE_VARIANTS: [Spec; 2] = [
    variant("table-led", "evidence", &[], &["conservative", "strong-fit"], &[], 0.0),
    variant("table-callout", "comparison", &[], &["strong-fit", "divergent"], &[], 1.0),
];
const SPLIT_VARIANTS: [Spec; 2] = [
    variant("visual-right", "split", &[], &["conservative", "strong-fit"], &[], 0.0),
    variant("visual-left", "editorial", &[], &["strong-fit", "divergent"], &[], 1.0),
];
const CONTENT_VARIANTS: [Spec; 2] = [
    variant("evidence-right", "evidence", &["decide", "inspect"], &[], &["visual"], 0.0),
    variant("editorial-wide", "typography", &["explain"], &["strong-fit", "divergent"], &["narrative"], 1.0),
];
const CLOSING_VARIANTS: [Spec; 2] = [
    variant("decision-left", "decision", &[], &["conservative", "strong-fit"], &[], 0.0),
    variant("decision-focus", "minimal", &[], &["strong-fit", "divergent"], &[], 1.0),
];

/// `PPTX_VARIANTS[kind] || PPTX_VARIANTS.content`.
fn pptx_variants(kind: &str) -> &'static [Spec; 2] {
    match kind {
        "cover" => &COVER_VARIANTS,
        "statement" => &STATEMENT_VARIANTS,
        "metrics" => &METRICS_VARIANTS,
        "comparison" => &COMPARISON_VARIANTS,
        "process" => &PROCESS_VARIANTS,
        "chart" => &CHART_VARIANTS,
        "table" => &TABLE_VARIANTS,
        "split" => &SPLIT_VARIANTS,
        "closing" => &CLOSING_VARIANTS,
        _ => &CONTENT_VARIANTS,
    }
}

/// A candidate as the scorer reads it.
struct Candidate {
    id: String,
    variant: Option<String>,
    family: String,
    purposes: Vec<String>,
    modes: Vec<String>,
    evidence: Vec<String>,
    densities: Vec<String>,
    novelty: f64,
}

fn owned(list: &[&str]) -> Vec<String> {
    list.iter().map(|entry| (*entry).to_owned()).collect()
}

impl Candidate {
    /// A document or sheet layout: identified by its id alone.
    fn of_format(entry: &Spec) -> Candidate {
        Candidate {
            id: entry.id.to_owned(),
            variant: None,
            family: entry.family.to_owned(),
            purposes: owned(entry.purposes),
            modes: owned(entry.modes),
            evidence: owned(entry.evidence),
            densities: owned(entry.densities),
            novelty: entry.novelty,
        }
    }
}

fn fingerprint_of(value: &Value) -> String {
    sha256(json_stringify(&stable_value(value)))
}

const DEFAULT_BOUNDARIES: [f64; 4] = [0.0, 1.0, 3.0, 8.0];

/// `bucket`: the size class of a count.
fn bucket(count: usize, boundaries: [f64; 4]) -> &'static str {
    let count = count as f64;
    if count <= boundaries[0] {
        "0"
    } else if count <= boundaries[1] {
        "1"
    } else if count <= boundaries[2] {
        "few"
    } else if count <= boundaries[3] {
        "several"
    } else {
        "many"
    }
}

/// `rowsOf`: the rows the composer will write, read leniently.
fn rows_of(table: Option<&Value>) -> usize {
    compose_table_rows(table, DEFAULT_FIELD, false).map_or(0, |rows| rows.len())
}

/// `textCount`: how many texts a value carries (a list counts its non-blank entries).
fn text_count(value: Option<&Value>) -> usize {
    match value {
        Some(Value::Array(entries)) => entries
            .iter()
            .filter(|entry| !js_trim(&if entry.is_null() { String::new() } else { value_to_string(entry) }).is_empty())
            .count(),
        None | Some(Value::Null) => 0,
        Some(Value::String(written)) if written.is_empty() => 0,
        Some(_) => 1,
    }
}

fn length_of(value: Option<&Value>) -> usize {
    array_of(value).map_or(0, Vec::len)
}

/// `String(value || '').trim().toLowerCase()`.
fn normalized_text(value: Option<&Value>) -> String {
    js_to_lowercase(js_trim(&text(value)))
}

fn normalize_purpose(value: Option<&Value>, fallback: &str) -> String {
    let normalized = normalized_text(value);
    if PURPOSES.contains(&normalized.as_str()) { normalized } else { fallback.to_owned() }
}

fn normalize_expression_mode(value: Option<&Value>) -> String {
    let normalized = normalized_text(value);
    if EXPRESSION_MODES.contains(&normalized.as_str()) { normalized } else { "strong-fit".to_owned() }
}

fn default_purpose(format: &str, input: &Value) -> &'static str {
    if format == "xlsx" {
        "monitor"
    } else if format == "csv" || format == "tsv" {
        "inspect"
    } else if opt_prop(prop(input, "content"), "decision").is_some_and(truthy) {
        "decide"
    } else {
        "explain"
    }
}

/// `normalizedRecentCompositions`: at most 24 recent entries, each reduced to its seven fields.
fn normalized_recent_compositions(value: Option<&Value>) -> Vec<Value> {
    array_of(value)
        .into_iter()
        .flatten()
        .filter(|entry| plain_object(entry))
        .take(24)
        .map(|entry| {
            let ids: Vec<Value> = array_of(prop(entry, "compositionIds"))
                .into_iter()
                .flatten()
                .map(|id| text(Some(id)))
                .filter(|id| !id.is_empty())
                .take(64)
                .map(Value::String)
                .collect();
            json!({
                "fingerprint": text(prop(entry, "fingerprint")),
                "format": text(prop(entry, "format")),
                "profile": text(prop(entry, "profile")),
                "purpose": text(prop(entry, "purpose")),
                "expressionMode": text(prop(entry, "expressionMode")),
                "compositionIds": ids,
                "createdAt": text(prop(entry, "createdAt")),
            })
        })
        .collect()
}

/// `resolveOfficeCompositionContext(format, input, { recentCompositions })`: the purpose and expression mode a
/// request is designed for, and its recent compositions, normalised. `input` is the request object.
pub fn resolve_office_composition_context(format: &str, input: &Value, recent_compositions: Option<&Value>) -> CompositionContext {
    let normalized_format = js_to_lowercase(format);
    let empty = Value::Object(Map::new());
    let composition = prop(input, "composition").filter(|composition| plain_object(composition)).unwrap_or(&empty);
    let fallback = default_purpose(&normalized_format, input);
    let purpose = first_text(&[prop(input, "purpose"), prop(composition, "purpose")]);
    let expression_mode = first_text(&[prop(input, "expressionMode"), prop(composition, "expressionMode")]);
    CompositionContext {
        purpose: normalize_purpose(Some(&Value::String(purpose)), fallback),
        expression_mode: normalize_expression_mode(Some(&Value::String(expression_mode))),
        recent_compositions: Value::Array(normalized_recent_compositions(recent_compositions)),
    }
}

/// What [`office_content_topology`] reads off an operation.
struct Topology {
    metrics: usize,
    columns: usize,
    steps: usize,
    rows: usize,
    table_rows: usize,
    chart_series: usize,
    paragraphs: usize,
    sections: usize,
    facts: usize,
    claims: usize,
    evidence: Vec<&'static str>,
    density: &'static str,
    signature: String,
}

impl Topology {
    fn value(&self) -> Value {
        json!({
            "metrics": self.metrics,
            "columns": self.columns,
            "steps": self.steps,
            "rows": self.rows,
            "tableRows": self.table_rows,
            "chartSeries": self.chart_series,
            "paragraphs": self.paragraphs,
            "sections": self.sections,
            "facts": self.facts,
            "claims": self.claims,
            "evidence": self.evidence,
            "density": self.density,
            "signature": self.signature,
        })
    }
}

fn office_content_topology(format: &str, operation: &Value, design: &Value) -> Topology {
    let sections: &[Value] = array_of(prop(operation, "sections")).map_or(&[], Vec::as_slice);
    let table_rows = sections.iter().fold(rows_of(prop(operation, "table")), |most, section| most.max(rows_of(prop(section, "table"))));
    let metrics = length_of(prop(operation, "metrics"));
    let columns = length_of(prop(operation, "columns"));
    let steps = length_of(prop(operation, "steps"));
    let rows = length_of(prop(operation, "rows"));
    let chart_series = length_of(opt_prop(prop(operation, "chart"), "series"));
    let paragraphs = text_count(prop(operation, "body"))
        + text_count(prop(operation, "bullets"))
        + sections
            .iter()
            .map(|section| {
                // `section?.paragraphs || section?.body`: the last operand is the answer when none is truthy.
                let (written, body) = (prop(section, "paragraphs"), prop(section, "body"));
                text_count(first_truthy(&[written, body]).or(body)) + text_count(prop(section, "bullets"))
            })
            .sum::<usize>();
    let facts = length_of(opt_prop(prop(design, "content"), "facts"));
    let claims = length_of(opt_prop(prop(design, "content"), "claims"));
    let has = |key: &str| prop(operation, key).is_some_and(truthy);
    let mut evidence: Vec<&'static str> = Vec::new();
    for (present, name) in [
        (metrics != 0, "metrics"),
        (table_rows != 0 || rows != 0, "table"),
        (has("chart") || chart_series != 0, "chart"),
        (has("image") || has("imagePath"), "image"),
        (has("visualText"), "visual"),
        (columns != 0, "comparison"),
        (steps != 0, "process"),
        (paragraphs != 0, "narrative"),
        (facts != 0, "facts"),
        (claims != 0, "claims"),
    ] {
        if present {
            evidence.push(name);
        }
    }
    let weight = metrics * 2 + columns * 2 + steps + (rows + table_rows).div_ceil(4) + paragraphs + claims;
    let density = if weight >= 14 {
        "dense"
    } else if weight <= 4 {
        "light"
    } else {
        "balanced"
    };
    evidence.sort_unstable();
    let signature = [
        js_to_lowercase(format),
        format!("m:{}", bucket(metrics, DEFAULT_BOUNDARIES)),
        format!("c:{}", bucket(columns, DEFAULT_BOUNDARIES)),
        format!("s:{}", bucket(steps, DEFAULT_BOUNDARIES)),
        format!("r:{}", bucket(rows + table_rows, [0.0, 3.0, 10.0, 24.0])),
        format!("p:{}", bucket(paragraphs, DEFAULT_BOUNDARIES)),
        format!("e:{}", evidence.join(",")),
    ]
    .join("|");
    Topology { metrics, columns, steps, rows, table_rows, chart_series, paragraphs, sections: sections.len(), facts, claims, evidence, density, signature }
}

/// `recentPenalty`: what using a composition again costs, by how recently the library used it.
fn recent_penalty(recent: &[Value], candidate_id: &str) -> f64 {
    recent.iter().take(8).enumerate().fold(0.0, |total, (index, entry)| {
        let used = array_of(prop(entry, "compositionIds")).is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(candidate_id)));
        if used { total + math::max(1.0, 4.0 - math::floor(index as f64 / 2.0)) } else { total }
    })
}

/// `stableTie`: a number in [0, 1] fixed by the seed and the candidate, which breaks a tie of scores.
fn stable_tie(seed: &str, id: &str) -> f64 {
    let digest = fingerprint_of(&Value::String(format!("{seed}\0{id}")));
    f64::from(u32::from_str_radix(&digest[..8], 16).expect("hex digits")) / f64::from(u32::MAX)
}

/// What the score of a candidate is read against.
struct Selection<'a> {
    purpose: &'a str,
    mode: &'a str,
    recent: &'a [Value],
    topology: &'a Topology,
    density: &'a str,
    seed: &'a str,
    explicit_variant: &'a str,
    layout_bias: &'a [String],
}

struct Selected {
    candidate: Candidate,
    history_penalty: f64,
}

fn select_candidate(candidates: Vec<Candidate>, usage: &CompositionUsage, selection: &Selection<'_>) -> Selected {
    let contains = |list: &[String], entry: &str| list.iter().any(|item| item == entry);
    let mut ranked: Vec<(Candidate, f64, f64)> = candidates
        .into_iter()
        .map(|candidate| {
            let mut score = 0.0;
            if contains(&candidate.purposes, selection.purpose) {
                score += 18.0;
            } else if !candidate.purposes.is_empty() {
                score -= 6.0;
            }
            if contains(&candidate.modes, selection.mode) {
                score += 5.0;
            }
            if contains(&candidate.densities, selection.density) {
                score += 3.0;
            }
            score += candidate.evidence.iter().filter(|entry| selection.topology.evidence.iter().any(|known| *known == entry.as_str())).count() as f64 * 3.0;
            if contains(selection.layout_bias, &candidate.family) {
                score += 6.0;
            }
            if selection.mode == "divergent" {
                score += candidate.novelty * 3.0;
            }
            if selection.mode == "conservative" {
                score -= candidate.novelty * 2.0;
            }
            if !selection.explicit_variant.is_empty()
                && (candidate.variant.as_deref() == Some(selection.explicit_variant) || candidate.id == selection.explicit_variant)
            {
                score += 100.0;
            }
            let history_penalty = recent_penalty(selection.recent, &candidate.id);
            score -= history_penalty;
            score -= usage.get(&candidate.id).copied().unwrap_or(0) as f64 * 7.0;
            score += stable_tie(selection.seed, &candidate.id);
            (candidate, score, history_penalty)
        })
        .collect();
    ranked.sort_by(|left, right| {
        let difference = right.1 - left.1;
        if difference > 0.0 {
            Ordering::Greater
        } else if difference < 0.0 {
            Ordering::Less
        } else {
            locale_compare(&left.0.id, &right.0.id)
        }
    });
    let (candidate, _, history_penalty) = ranked.swap_remove(0);
    Selected { candidate, history_penalty }
}

/// `resolvedPptxKind`: the slide kind an operation is laid out as.
fn resolved_pptx_kind(operation: &Value, topology: &Topology) -> String {
    // `String(operation.kind || 'content').toLowerCase()`: lowercased, not trimmed.
    let requested = js_to_lowercase(&first_text(&[prop(operation, "kind"), Some(&json!("content"))]));
    if requested != "content" || prop(operation, "layoutId").is_some_and(truthy) {
        return requested;
    }
    let has = |key: &str| prop(operation, key).is_some_and(truthy);
    let kind = if has("chart") {
        "chart"
    } else if has("table") {
        "table"
    } else if topology.metrics >= 2 {
        "metrics"
    } else if topology.columns >= 2 {
        "comparison"
    } else if topology.steps >= 2 {
        "process"
    } else if has("image") || has("imagePath") {
        "split"
    } else {
        "content"
    };
    kind.to_owned()
}

/// `a ?? b` of two properties.
fn nullish<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    first.filter(|value| !value.is_null()).or(second)
}

/// `Math.round(Number(value) || 0)`.
fn rounded(value: Option<&Value>) -> Value {
    let number = to_number_of(value);
    json_number(math::round(if number.is_nan() { 0.0 } else { number }))
}

/// The signature of one region of a deck plan written by the model.
fn region_signature(region: &Value) -> Value {
    let box_values: Vec<Value> = match prop(region, "box") {
        Some(Value::Array(written)) => written.iter().map(|value| rounded(Some(value))).collect(),
        _ => [
            nullish(prop(region, "x"), prop(region, "left")),
            nullish(prop(region, "y"), prop(region, "top")),
            nullish(prop(region, "w"), prop(region, "width")),
            nullish(prop(region, "h"), prop(region, "height")),
        ]
        .into_iter()
        .map(rounded)
        .collect(),
    };
    json!({
        "role": text(prop(region, "role")),
        "box": box_values,
        "direction": first_text(&[prop(region, "direction"), prop(region, "layout")]),
    })
}

/// One part of the seed's `[…].join('|')`: a missing part is empty, any other is its text.
fn joined_part(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(inner) => value_to_string(inner),
    }
}

/// Counts one more use of a composition in this batch and hands the plan back (`recordComposition`).
fn record_composition(usage: &mut CompositionUsage, plan: Value) -> Value {
    *usage.entry(text(prop(&plan, "id"))).or_insert(0) += 1;
    plan
}

fn object_of(fields: Vec<(&str, Value)>) -> Value {
    Value::Object(fields.into_iter().map(|(key, value)| (key.to_owned(), value)).collect())
}

/// `planOfficeComposition(format, operation, design, { usage })`: the composition one operation is laid out as. The
/// use is counted in `usage`, so the next operation of the batch is steered away from it.
pub fn plan_office_composition(format: &str, operation: &Value, design: &Value, usage: &mut CompositionUsage) -> Value {
    let normalized_format = js_to_lowercase(format);
    let topology = office_content_topology(&normalized_format, operation, design);
    let design_purpose = first_text(&[prop(design, "purpose"), Some(&json!("explain"))]);
    let purpose = normalize_purpose(prop(operation, "purpose"), &design_purpose);
    let mode = normalize_expression_mode(first_truthy(&[prop(operation, "expressionMode"), prop(design, "expressionMode")]));
    let recent = normalized_recent_compositions(prop(design, "recentCompositions"));
    let seed = match opt_prop(prop(design, "content"), "fingerprint").filter(|value| truthy(value)) {
        Some(fingerprint) => value_to_string(fingerprint),
        None => [prop(design, "intent"), prop(design, "audience"), prop(design, "signature"), prop(operation, "title")]
            .into_iter()
            .map(joined_part)
            .chain(std::iter::once(topology.signature.clone()))
            .collect::<Vec<_>>()
            .join("|"),
    };
    let written_density = first_text(&[prop(design, "density")]);
    let density = if written_density.is_empty() { topology.density.to_owned() } else { written_density };
    let explicit_variant = normalized_text(prop(operation, "variant"));
    let mut selection = Selection {
        purpose: &purpose,
        mode: &mode,
        recent: &recent,
        topology: &topology,
        density: &density,
        seed: &seed,
        explicit_variant: &explicit_variant,
        layout_bias: &[],
    };
    if normalized_format == "pptx" {
        let kind = resolved_pptx_kind(operation, &topology);
        if let Some(plan) = prop(operation, "plan").filter(|plan| plain_object(plan)) {
            if let Some(regions) = array_of(prop(plan, "regions")) {
                let signature = json!({
                    "kind": kind,
                    "units": first_text(&[prop(plan, "units"), Some(&json!("percent"))]),
                    "regions": regions.iter().map(region_signature).collect::<Vec<_>>(),
                    "readingOrder": first_truthy(&[prop(plan, "readingOrder")]).cloned().unwrap_or_else(|| json!([])),
                });
                let fingerprint = fingerprint_of(&signature)[..16].to_owned();
                let id = format!("{kind}:model:{fingerprint}");
                let history_penalty = recent_penalty(&recent, &id);
                return record_composition(
                    usage,
                    object_of(vec![
                        ("id", json!(id)),
                        ("family", json!("model-authored")),
                        ("kind", json!(kind)),
                        ("variant", json!(first_text(&[prop(plan, "name"), prop(plan, "visualType"), Some(&json!("custom"))]))),
                        ("purpose", json!(purpose)),
                        ("expressionMode", json!(mode)),
                        ("topology", topology.value()),
                        ("historyPenalty", json_number(history_penalty)),
                        ("source", json!("model-plan")),
                    ]),
                );
            }
        }
        let variants = pptx_variants(&kind);
        let mut candidates: Vec<Candidate> = variants
            .iter()
            .map(|entry| Candidate {
                id: format!("{kind}:{}", entry.id),
                variant: Some(entry.id.to_owned()),
                family: entry.family.to_owned(),
                purposes: if entry.purposes.is_empty() { vec![purpose.clone()] } else { owned(entry.purposes) },
                modes: owned(entry.modes),
                evidence: owned(entry.evidence),
                densities: Vec::new(),
                novelty: entry.novelty,
            })
            .collect();
        if !explicit_variant.is_empty() && !variants.iter().any(|entry| entry.id == explicit_variant) {
            candidates.push(Candidate {
                id: format!("{kind}:{explicit_variant}"),
                variant: Some(explicit_variant.clone()),
                family: kind.clone(),
                purposes: vec![purpose.clone()],
                modes: Vec::new(),
                evidence: Vec::new(),
                densities: Vec::new(),
                novelty: 0.0,
            });
        }
        let layout_bias: Vec<String> = array_of(opt_prop(opt_prop(opt_prop(prop(design, "artDirection"), "selected"), "deck"), "layoutBias"))
            .map(|bias| bias.iter().map(|entry| text(Some(entry))).collect())
            .unwrap_or_default();
        let selected = {
            selection.layout_bias = &layout_bias;
            select_candidate(candidates, usage, &selection)
        };
        return record_composition(
            usage,
            object_of(vec![
                ("id", json!(selected.candidate.id)),
                ("family", json!(selected.candidate.family)),
                ("kind", json!(kind)),
                ("variant", json!(selected.candidate.variant)),
                ("purpose", json!(purpose)),
                ("expressionMode", json!(mode)),
                ("topology", topology.value()),
                ("historyPenalty", json_number(selected.history_penalty)),
                ("source", json!(if explicit_variant.is_empty() { "content-planner" } else { "explicit" })),
            ]),
        );
    }
    let candidates: Vec<Candidate> = match normalized_format.as_str() {
        "docx" => DOCX_CANDIDATES.iter().map(Candidate::of_format).collect(),
        "xlsx" => XLSX_CANDIDATES.iter().map(Candidate::of_format).collect(),
        other => vec![Candidate {
            id: format!("{}-default", if other.is_empty() { "office" } else { other }),
            variant: None,
            family: "default".to_owned(),
            purposes: vec![purpose.clone()],
            modes: vec![mode.clone()],
            evidence: Vec::new(),
            densities: Vec::new(),
            novelty: 0.0,
        }],
    };
    let selected = select_candidate(candidates, usage, &selection);
    record_composition(
        usage,
        object_of(vec![
            ("id", json!(selected.candidate.id)),
            ("family", json!(selected.candidate.family)),
            ("purpose", json!(purpose)),
            ("expressionMode", json!(mode)),
            ("topology", topology.value()),
            ("historyPenalty", json_number(selected.history_penalty)),
            ("source", json!(if explicit_variant.is_empty() { "content-planner" } else { "explicit" })),
        ]),
    )
}

/// `compositionPlans`: the planned compositions of a batch, whether the caller passes the plans themselves or the
/// semantic entries that carry them.
fn composition_plans(compositions: Option<&Value>) -> Vec<&Value> {
    array_of(compositions)
        .into_iter()
        .flatten()
        .map(|entry| first_truthy(&[prop(entry, "composition")]).unwrap_or(entry))
        .filter(|entry| plain_object(entry) && prop(entry, "id").is_some_and(truthy))
        .collect()
}

/// `summarizeOfficeCompositions(format, compositions)`: the fingerprint and the ids of a batch's compositions.
pub fn summarize_office_compositions(format: &str, compositions: Option<&Value>) -> Value {
    let normalized_format = js_to_lowercase(format);
    let sequence: Vec<Value> = composition_plans(compositions)
        .into_iter()
        .map(|entry| {
            json!({
                "id": text(prop(entry, "id")),
                "family": text(prop(entry, "family")),
                "kind": text(prop(entry, "kind")),
                "purpose": text(prop(entry, "purpose")),
                "topology": text(opt_prop(prop(entry, "topology"), "signature")),
            })
        })
        .collect();
    if sequence.is_empty() {
        return json!({ "format": normalized_format, "fingerprint": "", "compositionIds": [], "count": 0 });
    }
    let ids: Vec<Value> = sequence.iter().map(|entry| entry["id"].clone()).collect();
    json!({
        "format": normalized_format,
        "fingerprint": fingerprint_of(&json!({ "format": normalized_format, "sequence": sequence })),
        "compositionIds": ids,
        "count": sequence.len(),
    })
}

/// `reviewOfficeCompositionSequence({ format, compositions, recentCompositions, allowRepetition })`: the summary of a
/// batch, the composition that makes up three quarters of four or more of its slides (`repeated`), and the recent
/// batch of the library it equals (`recentMatch`).
pub fn review_office_composition_sequence(format: &str, compositions: Option<&Value>, recent_compositions: Option<&Value>, allow_repetition: bool) -> Value {
    let plans = composition_plans(compositions);
    let summary = summarize_office_compositions(format, compositions);
    if allow_repetition || plans.is_empty() {
        return json!({ "summary": summary, "repeated": null, "recentMatch": null });
    }
    let eligible: Vec<&&Value> = plans.iter().filter(|entry| !["cover", "closing"].contains(&text(prop(entry, "kind")).as_str())).collect();
    let mut counts: Vec<(String, usize)> = Vec::new();
    for entry in &eligible {
        let id = text(prop(entry, "id"));
        match counts.iter_mut().find(|(known, _)| *known == id) {
            Some((_, count)) => *count += 1,
            None => counts.push((id, 1)),
        }
    }
    counts.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| locale_compare(&left.0, &right.0)));
    let repeated = match counts.first() {
        Some((id, count)) if eligible.len() >= 4 && *count as f64 / eligible.len() as f64 >= 0.75 => {
            json!({ "id": id, "count": count, "total": eligible.len() })
        }
        _ => Value::Null,
    };
    let fingerprint = text(prop(&summary, "fingerprint"));
    let recent_match = normalized_recent_compositions(recent_compositions)
        .into_iter()
        .find(|entry| !fingerprint.is_empty() && text(prop(entry, "fingerprint")) == fingerprint)
        .unwrap_or(Value::Null);
    json!({ "summary": summary, "repeated": repeated, "recentMatch": recent_match })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(format: &str, operation: Value, design: Value, usage: &mut CompositionUsage) -> Value {
        plan_office_composition(format, &operation, &design, usage)
    }

    #[test]
    fn the_context_reads_purpose_and_mode_with_their_fallbacks() {
        let context = resolve_office_composition_context("docx", &json!({ "content": { "decision": "go" } }), None);
        assert_eq!((context.purpose.as_str(), context.expression_mode.as_str()), ("decide", "strong-fit"));
        let context = resolve_office_composition_context("XLSX", &json!({ "composition": { "purpose": " Compare ", "expressionMode": "DIVERGENT" } }), None);
        assert_eq!((context.purpose.as_str(), context.expression_mode.as_str()), ("compare", "divergent"));
        assert_eq!(resolve_office_composition_context("csv", &json!({ "purpose": "nonsense" }), None).purpose, "inspect");
        assert_eq!(resolve_office_composition_context("pdf", &json!({}), None).purpose, "explain");
    }

    #[test]
    fn recent_compositions_keep_the_newest_24_with_their_fields() {
        let recent = json!([5, { "fingerprint": "f", "compositionIds": ["a", "", null, "b"], "extra": 1 }]);
        let context = resolve_office_composition_context("docx", &json!({}), Some(&recent));
        assert_eq!(
            context.recent_compositions,
            json!([{ "fingerprint": "f", "format": "", "profile": "", "purpose": "", "expressionMode": "", "compositionIds": ["a", "b"], "createdAt": "" }])
        );
        let many = Value::Array((0..30).map(|index| json!({ "fingerprint": index.to_string() })).collect());
        let context = resolve_office_composition_context("docx", &json!({}), Some(&many));
        assert_eq!(context.recent_compositions.as_array().map(Vec::len), Some(24));
    }

    #[test]
    fn a_document_is_planned_from_its_content_and_the_batch_spreads_the_choice() {
        let design = json!({ "purpose": "decide", "expressionMode": "conservative", "content": { "claims": [{}], "facts": [{}] } });
        let mut usage = CompositionUsage::new();
        let first = plan("docx", json!({ "op": "compose_document", "title": "T", "sections": [{ "paragraphs": ["a"] }] }), design.clone(), &mut usage);
        assert_eq!(first["id"], "decision-brief");
        assert_eq!(first["source"], "content-planner");
        assert_eq!(usage.get("decision-brief"), Some(&1));
        let again = plan("docx", json!({ "op": "compose_document", "title": "T", "sections": [{ "paragraphs": ["a"] }] }), design, &mut usage);
        assert_ne!(again["id"], first["id"], "a used composition is steered away from within a batch");
    }

    #[test]
    fn an_explicit_variant_wins_and_a_model_plan_is_fingerprinted() {
        let mut usage = CompositionUsage::new();
        let explicit = plan("xlsx", json!({ "variant": " Analysis-Sheet " }), json!({}), &mut usage);
        assert_eq!((explicit["id"].as_str(), explicit["source"].as_str()), (Some("analysis-sheet"), Some("explicit")));
        let slide = plan("pptx", json!({ "kind": "cover", "variant": "poster" }), json!({}), &mut usage);
        assert_eq!(slide["id"], "cover:poster");
        let modelled = plan(
            "pptx",
            json!({ "plan": { "name": "grid", "regions": [{ "role": "title", "x": 1.4, "y": 2, "w": 50, "h": 9 }] } }),
            json!({}),
            &mut usage,
        );
        assert!(modelled["id"].as_str().is_some_and(|id| id.starts_with("content:model:") && id.len() == "content:model:".len() + 16));
        assert_eq!((modelled["family"].as_str(), modelled["variant"].as_str(), modelled["source"].as_str()), (Some("model-authored"), Some("grid"), Some("model-plan")));
    }

    #[test]
    fn a_pptx_kind_follows_the_content_and_an_unknown_format_has_one_default() {
        let mut usage = CompositionUsage::new();
        assert_eq!(plan("pptx", json!({ "metrics": [1, 2] }), json!({}), &mut usage)["kind"], "metrics");
        assert_eq!(plan("pptx", json!({ "table": [[1]] }), json!({}), &mut usage)["kind"], "table");
        assert_eq!(plan("pdf", json!({}), json!({}), &mut usage)["id"], "pdf-default");
        assert_eq!(plan("", json!({}), json!({}), &mut usage)["id"], "office-default");
    }

    #[test]
    fn the_topology_counts_the_evidence_and_sizes_the_density() {
        let operation = json!({ "metrics": [1, 2], "rows": [[1], [2]], "chart": { "series": [1] }, "body": ["a", " "], "sections": [{ "table": [["h"], ["r"]], "bullets": "x" }] });
        let topology = office_content_topology("DOCX", &operation, &json!({}));
        assert_eq!((topology.metrics, topology.rows, topology.table_rows, topology.paragraphs, topology.chart_series), (2, 2, 2, 2, 1));
        assert_eq!(topology.evidence, vec!["chart", "metrics", "narrative", "table"]);
        assert_eq!(topology.signature, "docx|m:few|c:0|s:0|r:few|p:few|e:chart,metrics,narrative,table");
        assert_eq!(office_content_topology("docx", &json!({}), &json!({})).density, "light");
    }

    #[test]
    fn a_sequence_is_reviewed_for_repetition_and_for_a_recent_twin() {
        let batch = json!([
            { "composition": { "id": "cover:a", "kind": "cover" } },
            { "id": "x", "kind": "content" }, { "id": "x" }, { "id": "x" }, { "id": "y" }, { "kind": "no id" },
        ]);
        let review = review_office_composition_sequence("PPTX", Some(&batch), None, false);
        assert_eq!(review["repeated"], json!({ "id": "x", "count": 3, "total": 4 }));
        assert_eq!(review["summary"]["count"], 5);
        let twin = json!([{ "fingerprint": review["summary"]["fingerprint"] }]);
        let again = review_office_composition_sequence("pptx", Some(&batch), Some(&twin), false);
        assert_eq!(again["recentMatch"]["fingerprint"], review["summary"]["fingerprint"]);
        assert_eq!(review_office_composition_sequence("pptx", Some(&batch), None, true)["repeated"], Value::Null);
        assert_eq!(summarize_office_compositions("docx", None), json!({ "format": "docx", "fingerprint": "", "compositionIds": [], "count": 0 }));
    }
}
