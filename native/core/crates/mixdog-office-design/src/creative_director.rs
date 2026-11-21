//! `design/design-creative-director.mjs`: the story brief the Word and Excel composers write to. Decks are authored as
//! scripts (the pptx skill); the director briefs `compose_document` and `compose_sheet` operations only.

use mixdog_js::{js_to_lowercase, to_number_of, value_to_string};
use mixdog_office_base::values::{compact_value, plain_object, truthy};
use serde_json::{Map, Value, json};

use crate::discipline::design_discipline_brief;
use crate::{array_of, first_truthy, opt_prop, prop};

/// `COMPOSE_OPERATION`: the formats the director briefs and the operation each one's composer takes.
pub const COMPOSE_OPERATIONS: [(&str, &str); 2] = [("docx", "compose_document"), ("xlsx", "compose_sheet")];

/// `COMPOSE_OPERATION[format]`: absent for a format briefed by no director.
pub fn compose_operation(format: &str) -> Option<&'static str> {
    COMPOSE_OPERATIONS.iter().find(|(name, _)| *name == format).map(|(_, operation)| *operation)
}

fn is_filled(value: Option<&Value>) -> bool {
    array_of(value).is_some_and(|list| !list.is_empty())
}

fn evidence_kind(operation: &Value) -> &'static str {
    let has = |key: &str| prop(operation, key).is_some_and(truthy);
    if has("chart") {
        "chart"
    } else if is_filled(prop(operation, "allocations")) {
        "allocation"
    } else if is_filled(prop(operation, "steps")) {
        "timeline"
    } else if is_filled(prop(operation, "metrics")) {
        "scorecard"
    } else if has("table") {
        "decision-matrix"
    } else if is_filled(prop(operation, "columns")) {
        "comparison"
    } else if has("image") || has("imagePath") {
        "image"
    } else if has("visualText") {
        "statement"
    } else {
        "narrative"
    }
}

fn narrative_role(operation: &Value, index: usize, total: usize) -> &'static str {
    let kind = js_to_lowercase(&compact_value(prop(operation, "kind").unwrap_or(&Value::Null), 32));
    let narrative = evidence_kind(operation) == "narrative";
    if kind == "cover" {
        return "opening";
    }
    if kind == "closing" {
        return "decision-close";
    }
    if index == 0 && total > 1 && narrative {
        return "opening";
    }
    if index + 1 == total && total > 1 && narrative {
        return "decision-close";
    }
    if ["chart", "metrics", "statement"].contains(&kind.as_str()) {
        return if index <= 1 { "premise" } else { "proof" };
    }
    if ["comparison", "table"].contains(&kind.as_str()) {
        return "choice";
    }
    if kind == "process" {
        return "execution";
    }
    if (index as f64) < (total as f64) / 2.0 { "context" } else { "implication" }
}

fn focal_point_for(role: &str, evidence_kind: &str) -> &'static str {
    if role == "opening" {
        "thesis"
    } else if role == "decision-close" {
        "decision"
    } else if evidence_kind == "narrative" {
        "message"
    } else {
        "evidence"
    }
}

fn recommended_visual(operation: &Value, role: &str) -> String {
    let evidence = evidence_kind(operation);
    match evidence {
        "chart" => "annotated-chart".into(),
        "allocation" => "allocation".into(),
        "timeline" => "timeline".into(),
        "scorecard" | "decision-matrix" => "scorecard".into(),
        "comparison" => "allocation".into(),
        _ if role == "decision-close" => {
            if prop(operation, "visualText").is_some_and(truthy) {
                "decision-stamp".into()
            } else {
                "allocation".into()
            }
        }
        other => other.into(),
    }
}

fn compact_text(value: Option<&Value>, maximum: usize) -> String {
    compact_value(value.unwrap_or(&Value::Null), maximum)
}

fn operation_evidence(operation: &Value, content: Option<&Value>) -> Value {
    let claim_id = js_to_lowercase(&compact_text(prop(operation, "claimId"), 80));
    let claim = array_of(opt_prop(content, "claims"))
        .and_then(|claims| claims.iter().find(|entry| prop(entry, "id").and_then(Value::as_str) == Some(claim_id.as_str())));
    let mut fact_ids: Vec<String> = Vec::new();
    let mut add = |id: String| {
        if !fact_ids.contains(&id) {
            fact_ids.push(id);
        }
    };
    for id in array_of(opt_prop(claim, "factIds")).into_iter().flatten() {
        add(value_to_string(id));
    }
    for metric in array_of(prop(operation, "metrics")).into_iter().flatten() {
        if let Some(fact_id) = prop(metric, "factId").filter(|written| truthy(written)) {
            add(js_to_lowercase(&value_to_string(fact_id)));
        }
    }
    json!({
        "claimId": claim_id,
        "factIds": fact_ids,
        "source": compact_text(prop(operation, "source"), 240),
        "evidenceKind": evidence_kind(operation),
    })
}

fn operation_brief(operation: &Value, operation_index: usize, index: usize, total: usize, content: Option<&Value>, thesis: &Value, motif: &str) -> Value {
    let role = narrative_role(operation, index, total);
    let evidence = operation_evidence(operation, content);
    let message = compact_value(first_truthy(&[prop(operation, "title"), prop(operation, "takeaway"), Some(thesis)]).unwrap_or(&Value::Null), 220);
    let implication =
        compact_value(first_truthy(&[prop(operation, "takeaway"), prop(operation, "subtitle"), prop(operation, "body")]).unwrap_or(&Value::Null), 220);
    let focal_point = focal_point_for(role, evidence["evidenceKind"].as_str().unwrap_or(""));
    json!({
        "operationIndex": operation_index,
        "sequence": index + 1,
        "role": role,
        "message": message,
        "implication": implication,
        "evidence": evidence,
        "recommendedVisual": recommended_visual(operation, role),
        "focalPoint": focal_point,
        "density": if role == "opening" || role == "decision-close" { "light" } else { "balanced" },
        "motif": motif,
    })
}

/// `directOfficeStory(format, operations, design)`: the brief of each compose operation (its role in the narrative arc,
/// message, recommended visual, focal point and density) and the story's thesis, motif, discipline and evidence
/// coverage.
pub fn direct_office_story(format: &str, operations: &Value, design: &Value) -> Value {
    let normalized = js_to_lowercase(format);
    let compose_name = compose_operation(&normalized);
    let authored: Vec<(usize, &Value)> = array_of(Some(operations))
        .into_iter()
        .flatten()
        .enumerate()
        .filter(|(_, operation)| {
            plain_object(operation)
                && match (prop(operation, "op"), compose_name) {
                    (None, None) => true,
                    (Some(Value::String(op)), Some(name)) => op == name,
                    _ => false,
                }
        })
        .collect();
    let content = prop(design, "content").filter(|content| truthy(content));
    let thesis = compact_value(
        first_truthy(&[
            opt_prop(content, "decision"),
            opt_prop(content, "objective"),
            authored.first().and_then(|(_, operation)| prop(operation, "title")),
            prop(design, "intent"),
        ])
        .unwrap_or(&Value::Null),
        220,
    );
    let thesis_value = Value::String(thesis.clone());
    let selected = opt_prop(prop(design, "artDirection"), "selected");
    let motif = compact_value(
        first_truthy(&[opt_prop(opt_prop(selected, "deck"), "motif"), opt_prop(selected, "motif"), prop(design, "signature"), Some(&thesis_value)])
            .unwrap_or(&Value::Null),
        160,
    );
    let total = authored.len();
    let briefs: Vec<Value> = authored
        .iter()
        .enumerate()
        .map(|(index, (operation_index, operation))| operation_brief(operation, *operation_index, index, total, content, &thesis_value, &motif))
        .collect();
    let sourced = briefs
        .iter()
        .filter(|brief| {
            let evidence = &brief["evidence"];
            evidence["source"].as_str().is_some_and(|source| !source.is_empty()) || evidence["factIds"].as_array().is_some_and(|ids| !ids.is_empty())
        })
        .count();
    let length_of = |key: &str| array_of(opt_prop(content, key)).map_or(0, Vec::len);
    json!({
        "version": 1,
        "standard": "frontier-office-v1",
        "format": normalized,
        "thesis": thesis,
        "audience": compact_value(first_truthy(&[prop(design, "audience"), opt_prop(content, "audience")]).unwrap_or(&Value::Null), 160),
        "objective": compact_value(first_truthy(&[opt_prop(content, "objective"), prop(design, "intent")]).unwrap_or(&Value::Null), 220),
        "decision": compact_text(opt_prop(content, "decision"), 220),
        "motif": motif,
        "discipline": design_discipline_brief(prop(design, "tokens")),
        "narrativeArc": briefs.iter().map(|brief| brief["role"].clone()).collect::<Vec<_>>(),
        "evidenceCoverage": {
            "claims": length_of("claims"),
            "facts": length_of("facts"),
            "sourcedBriefs": sourced,
            "totalBriefs": briefs.len(),
        },
        "qualityFloor": {
            "nativeEvidence": true,
            "semanticVisuals": true,
            "noDefaultChartTreatment": true,
            "noRawTableSlides": true,
            "noUnderComposedContentSlides": true,
            "distinctOpeningAndClosing": true,
        },
        "briefs": briefs,
    })
}

/// `applyOfficeCreativeBrief(operation, creative, operationIndex)`: the operation with the brief written for it under
/// `creativeBrief`; the operation as given when there is none.
pub fn apply_office_creative_brief(operation: &Value, creative: Option<&Value>, operation_index: usize) -> Value {
    let Some(creative) = creative.filter(|creative| truthy(creative)) else {
        return operation.clone();
    };
    if !plain_object(operation) {
        return operation.clone();
    }
    let brief = array_of(prop(creative, "briefs")).and_then(|briefs| {
        briefs
            .iter()
            .find(|entry| to_number_of(prop(entry, "operationIndex")) == operation_index as f64 && prop(entry, "operationIndex").is_some_and(Value::is_number))
    });
    let Some(brief) = brief else {
        return operation.clone();
    };
    let mut written = Map::new();
    for key in ["role", "sequence", "message", "implication", "recommendedVisual", "focalPoint", "density", "motif", "evidence"] {
        if let Some(entry) = prop(brief, key) {
            written.insert(key.into(), entry.clone());
        }
    }
    let mut out = operation.clone();
    out.as_object_mut().expect("an object").insert("creativeBrief".into(), Value::Object(written));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn design() -> Value {
        json!({
            "intent": "Quarterly review",
            "audience": "leaders",
            "signature": "evidence loop",
            "content": {
                "decision": "Invest in docks", "objective": "obj", "audience": "ops",
                "facts": [{ "id": "a" }, { "id": "b" }],
                "claims": [{ "id": "c1", "text": "t", "factIds": ["a"] }],
            },
            "tokens": { "colors": { "accent": "1F7A55" }, "typography": { "display": "Cambria" } },
        })
    }

    #[test]
    fn a_story_briefs_each_compose_operation() {
        let operations = json!([
            { "op": "set_title" },
            { "op": "compose_document", "kind": "cover", "title": "  Cover   title " },
            { "op": "compose_document", "claimId": "C1", "metrics": [{ "factId": "B" }, { "label": "x" }], "source": "a.xlsx", "kind": "metrics" },
            { "op": "compose_document", "table": { "rows": [["a"]] }, "kind": "table", "title": "T", "takeaway": "so" },
            { "op": "compose_document", "kind": "closing", "visualText": "go", "body": "b" },
            "text",
        ]);
        let story = direct_office_story("DOCX", &operations, &design());
        assert_eq!(story["format"], json!("docx"));
        assert_eq!(story["thesis"], json!("Invest in docks"));
        assert_eq!(story["motif"], json!("evidence loop"));
        assert_eq!(story["narrativeArc"], json!(["opening", "premise", "choice", "decision-close"]));
        let briefs = story["briefs"].as_array().expect("briefs");
        assert_eq!(briefs[0]["operationIndex"], json!(1));
        assert_eq!(briefs[0]["message"], json!("Cover title"));
        assert_eq!(briefs[0]["density"], json!("light"));
        assert_eq!(briefs[1]["evidence"], json!({ "claimId": "c1", "factIds": ["a", "b"], "source": "a.xlsx", "evidenceKind": "scorecard" }));
        assert_eq!(briefs[1]["recommendedVisual"], json!("scorecard"));
        assert_eq!(briefs[1]["focalPoint"], json!("evidence"));
        assert_eq!(briefs[2]["implication"], json!("so"));
        assert_eq!(briefs[2]["recommendedVisual"], json!("scorecard"));
        assert_eq!(briefs[3]["recommendedVisual"], json!("decision-stamp"));
        assert_eq!(briefs[3]["focalPoint"], json!("decision"));
        assert_eq!(story["evidenceCoverage"], json!({ "claims": 1, "facts": 2, "sourcedBriefs": 1, "totalBriefs": 4 }));
        assert_eq!(story["discipline"]["colorRoles"], json!(["accent"]));
        assert_eq!(story["qualityFloor"]["noRawTableSlides"], json!(true));
    }

    #[test]
    fn a_format_without_a_composer_matches_operations_without_an_op() {
        let story = direct_office_story("pptx", &json!([{ "op": "compose_document" }, { "title": "bare" }]), &json!({}));
        assert_eq!(story["briefs"].as_array().map(Vec::len), Some(1));
        assert_eq!(story["briefs"][0]["operationIndex"], json!(1));
        assert_eq!(story["thesis"], json!("bare"));
        assert_eq!(direct_office_story("docx", &json!("x"), &json!({}))["briefs"], json!([]));
    }

    #[test]
    fn the_brief_is_written_into_the_operation() {
        let story = direct_office_story("docx", &json!([{ "op": "compose_document", "title": "A" }]), &design());
        let operation = json!({ "op": "compose_document", "title": "A", "creativeBrief": "old" });
        let applied = apply_office_creative_brief(&operation, Some(&story), 0);
        assert_eq!(applied["creativeBrief"]["role"], json!("context"));
        assert_eq!(applied["creativeBrief"]["message"], json!("A"));
        assert!(applied["creativeBrief"].get("operationIndex").is_none());
        assert_eq!(apply_office_creative_brief(&operation, Some(&story), 3), operation);
        assert_eq!(apply_office_creative_brief(&operation, None, 0), operation);
        assert_eq!(apply_office_creative_brief(&json!("x"), Some(&story), 0), json!("x"));
        assert_eq!(compose_operation("docx"), Some("compose_document"));
        assert_eq!(compose_operation("pdf"), None);
    }

    #[test]
    fn evidence_names_the_strongest_kind() {
        let kind = |operation: Value| evidence_kind(&operation);
        assert_eq!(kind(json!({ "chart": {} })), "chart");
        assert_eq!(kind(json!({ "allocations": [1] })), "allocation");
        assert_eq!(kind(json!({ "allocations": [] })), "narrative");
        assert_eq!(kind(json!({ "steps": [1] })), "timeline");
        assert_eq!(kind(json!({ "columns": [1] })), "comparison");
        assert_eq!(kind(json!({ "imagePath": "p.png" })), "image");
        assert_eq!(kind(json!({})), "narrative");
    }
}
