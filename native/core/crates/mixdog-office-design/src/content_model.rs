//! `design/content-model.mjs`: the facts and claims of a document, normalised once (ids in any script, number
//! formats, sources), summarised, and bound into a semantic operation.

use std::collections::HashMap;
use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_object_keys, js_to_lowercase, js_trim, json_stringify, value_to_string};
use mixdog_office_base::values::{clone, plain_object, sha256, stable_value, truthy};
use serde_json::{Map, Value, json};

use crate::{array_of, first_text, first_truthy, prop, text, text_of};

static SAFE_ID: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$", "u"));

/// A content id names a figure inside this package, so it takes letters of any script. The message names the entry it
/// came from, since a list of facts all fail alike. `value` is `String(value ?? '')`, so an absent one is empty.
fn safe_id(value: Option<&Value>, label: &str, location: &str) -> Result<String, String> {
    let at = if location.is_empty() { String::new() } else { format!(" ({location})") };
    let written = match value {
        None | Some(Value::Null) => String::new(),
        Some(inner) => value_to_string(inner),
    };
    let normalized = js_to_lowercase(js_trim(&written));
    if normalized.is_empty() {
        return Err(format!("Office content {label} is required{at}"));
    }
    if !SAFE_ID.is_match(&normalized) {
        return Err(format!("Office content {label} \"{normalized}\" must use 1-64 letters, digits, dots, underscores, or hyphens{at}"));
    }
    Ok(normalized)
}

fn normalize_source(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(Value::String(written)) => Some(Value::String(js_trim(written).to_owned())),
        Some(object) if plain_object(object) => {
            let document = js_trim(&text(prop(object, "document"))).to_owned();
            if document.is_empty() {
                return None;
            }
            let mut source = Map::new();
            source.insert("document".into(), Value::String(document));
            for key in ["target", "label"] {
                if let Some(entry) = prop(object, key).filter(|entry| truthy(entry)) {
                    source.insert(key.into(), Value::String(value_to_string(entry)));
                }
            }
            Some(Value::Object(source))
        }
        _ => None,
    }
}

/// What a fact may carry. The keys are checked because an unread one is worse than a rejected one: the figure ships in
/// the wrong notation and nothing says so.
const FACT_KEYS: [&str; 8] = ["id", "label", "value", "unit", "detail", "numberFormat", "format", "source"];

/// A caller writes the format the way they say it out loud. Named formats reach the spreadsheet notation the composers
/// already apply; an explicit pattern is taken as written.
const NAMED_NUMBER_FORMATS: [(&str, &str); 7] =
    [("percent", "0.0%"), ("percentage", "0.0%"), ("number", "#,##0"), ("integer", "#,##0"), ("decimal", "#,##0.0"), ("currency", "#,##0"), ("money", "#,##0")];

/// `officeNumberFormat`: one resolution for every figure the composers print, for a bound fact and a preset's metric
/// alike. Empty when the entry names none.
pub fn office_number_format(entry: &Value) -> String {
    let written = js_trim(&first_text(&[prop(entry, "numberFormat"), prop(entry, "format")])).to_owned();
    if written.is_empty() {
        return String::new();
    }
    let lowered = js_to_lowercase(&written);
    NAMED_NUMBER_FORMATS.iter().find(|(name, _)| *name == lowered).map_or(written, |(_, notation)| (*notation).to_owned())
}

fn source_text(value: &Value) -> String {
    match value {
        Value::String(written) => written.clone(),
        object if plain_object(object) => {
            let document = text(prop(object, "document"));
            let target = text(prop(object, "target"));
            let label = text(prop(object, "label"));
            let target = if target.is_empty() { String::new() } else { format!("#{target}") };
            let label = if label.is_empty() { String::new() } else { format!(" ({label})") };
            format!("{document}{target}{label}")
        }
        _ => String::new(),
    }
}

fn unique(ids: Vec<String>) -> Vec<String> {
    let mut seen = Vec::new();
    for id in ids {
        if !seen.contains(&id) {
            seen.push(id);
        }
    }
    seen
}

/// `normalizeOfficeContentModel`: `Value::Null` for an absent model, else the normalised facts and claims with the
/// fingerprint of the whole. The errors are the texts of the ones Node throws.
pub fn normalize_office_content_model(value: Option<&Value>) -> Result<Value, String> {
    let value = match value {
        None | Some(Value::Null) => return Ok(Value::Null),
        Some(inner) => inner,
    };
    if !plain_object(value) {
        return Err("Office design.content must be an object".into());
    }
    let empty = Vec::new();
    let raw_facts = array_of(prop(value, "facts")).unwrap_or(&empty);
    let raw_claims = array_of(prop(value, "claims")).unwrap_or(&empty);
    if raw_facts.len() > 1_000 || raw_claims.len() > 500 {
        return Err("Office content model exceeds the supported fact or claim count".into());
    }
    let mut fact_ids: Vec<String> = Vec::new();
    let mut facts = Vec::new();
    for (index, fact) in raw_facts.iter().enumerate() {
        if !plain_object(fact) {
            return Err("Office content facts must be objects".into());
        }
        let named = match prop(fact, "label").filter(|label| truthy(label)) {
            Some(label) => format!(": {}", value_to_string(label)),
            None => String::new(),
        };
        let id = safe_id(prop(fact, "id"), "fact id", &format!("fact {}{named}", index + 1))?;
        if fact_ids.contains(&id) {
            return Err(format!("Office content model has duplicate fact id {id}"));
        }
        fact_ids.push(id.clone());
        // A key the model does not read is dropped, and the figure then ships in the wrong notation. The natural
        // spellings reach numberFormat, and anything else is named rather than ignored.
        let number_format = office_number_format(fact);
        let source = normalize_source(prop(fact, "source"));
        let unknown: Vec<&String> = js_object_keys(fact.as_object().expect("an object")).into_iter().filter(|key| !FACT_KEYS.contains(&key.as_str())).collect();
        if !unknown.is_empty() {
            return Err(format!(
                "Office content fact {id} has unknown key(s): {}. A fact takes: {}.",
                unknown.iter().map(|key| key.as_str()).collect::<Vec<_>>().join(", "),
                FACT_KEYS.join(", ")
            ));
        }
        let mut entry = Map::new();
        entry.insert("id".into(), Value::String(id.clone()));
        entry.insert("label".into(), Value::String(first_text(&[prop(fact, "label"), Some(&Value::String(id))])));
        // A fact written without a value carries none: `JSON.stringify` leaves an undefined value out.
        if let Some(fact_value) = prop(fact, "value") {
            entry.insert("value".into(), clone(fact_value));
        }
        for key in ["unit", "detail"] {
            if let Some(written) = prop(fact, key).filter(|written| truthy(written)) {
                entry.insert(key.into(), Value::String(value_to_string(written)));
            }
        }
        if !number_format.is_empty() {
            entry.insert("numberFormat".into(), Value::String(number_format));
        }
        if let Some(source) = source.filter(truthy) {
            entry.insert("source".into(), source);
        }
        facts.push(Value::Object(entry));
    }
    let mut claim_ids: Vec<String> = Vec::new();
    let mut claims = Vec::new();
    for (index, claim) in raw_claims.iter().enumerate() {
        if !plain_object(claim) {
            return Err("Office content claims must be objects".into());
        }
        let named = match prop(claim, "text").filter(|written| truthy(written)) {
            Some(written) => format!(": {}", value_to_string(written)),
            None => String::new(),
        };
        let id = safe_id(prop(claim, "id"), "claim id", &format!("claim {}{named}", index + 1))?;
        if claim_ids.contains(&id) {
            return Err(format!("Office content model has duplicate claim id {id}"));
        }
        claim_ids.push(id.clone());
        // The references are the point of a claim, so `facts` is accepted as an alias of `factIds`.
        let references = array_of(prop(claim, "factIds")).or_else(|| array_of(prop(claim, "facts"))).unwrap_or(&empty);
        let mut resolved = Vec::new();
        for entry in references {
            resolved.push(safe_id(Some(entry), &format!("claim {id} fact reference"), "")?);
        }
        let fact_refs = unique(resolved);
        for fact_id in &fact_refs {
            if !fact_ids.contains(fact_id) {
                return Err(format!("Office content claim {id} references unknown fact {fact_id}"));
            }
        }
        let mut entry = Map::new();
        entry.insert("id".into(), Value::String(id));
        entry.insert("text".into(), Value::String(js_trim(&text(prop(claim, "text"))).to_owned()));
        entry.insert("factIds".into(), json!(fact_refs));
        if let Some(implication) = prop(claim, "implication").filter(|written| truthy(written)) {
            entry.insert("implication".into(), Value::String(value_to_string(implication)));
        }
        claims.push(Value::Object(entry));
    }
    let package_id = match prop(value, "packageId").filter(|written| truthy(written)) {
        Some(written) => safe_id(Some(written), "package id", "")?,
        None => String::new(),
    };
    let mut normalized = Map::new();
    normalized.insert("packageId".into(), Value::String(package_id));
    for key in ["audience", "objective", "decision", "period"] {
        normalized.insert(key.into(), Value::String(text(prop(value, key))));
    }
    normalized.insert("facts".into(), Value::Array(facts));
    normalized.insert("claims".into(), Value::Array(claims));
    let normalized = Value::Object(normalized);
    let fingerprint = sha256(json_stringify(&stable_value(&normalized)));
    let mut with_fingerprint = normalized;
    with_fingerprint.as_object_mut().expect("an object").insert("fingerprint".into(), Value::String(fingerprint));
    Ok(with_fingerprint)
}

/// `summarizeOfficeContentModel`: the counts and identity of a normalised model, null for none.
pub fn summarize_office_content_model(model: Option<&Value>) -> Value {
    let Some(model) = model.filter(|model| truthy(model)) else {
        return Value::Null;
    };
    let facts = array_of(prop(model, "facts")).map_or(&[][..], Vec::as_slice);
    let claims = array_of(prop(model, "claims")).map_or(0, Vec::len);
    let field = |key: &str| prop(model, key).cloned();
    let mut summary = Map::new();
    for key in ["packageId", "fingerprint", "audience", "objective", "decision", "period"] {
        if let Some(entry) = field(key) {
            summary.insert(key.into(), entry);
        }
    }
    summary.insert("factCount".into(), json!(facts.len()));
    summary.insert("claimCount".into(), json!(claims));
    summary.insert("sourcedFactCount".into(), json!(facts.iter().filter(|fact| prop(fact, "source").is_some_and(truthy)).count()));
    Value::Object(summary)
}

/// What [`bind_office_content`] answers: the operation with its references resolved and, when a model was given, the
/// binding that records what was used.
#[derive(Debug, Clone, PartialEq)]
pub struct BoundOperation {
    pub operation: Value,
    pub binding: Option<Value>,
}

/// `used`: the ids a binding has touched, in first-use order.
#[derive(Default)]
struct Used(Vec<String>);

impl Used {
    fn add(&mut self, id: &str) {
        if !self.0.iter().any(|known| known == id) {
            self.0.push(id.to_owned());
        }
    }
}

struct Facts<'a> {
    by_id: HashMap<&'a str, &'a Value>,
}

impl<'a> Facts<'a> {
    fn fact(&self, id: Option<&Value>, used: &mut Used) -> Result<&'a Value, String> {
        let normalized = safe_id(id, "fact reference", "")?;
        let resolved = self.by_id.get(normalized.as_str()).copied().ok_or_else(|| format!("Office semantic operation references unknown fact {normalized}"))?;
        used.add(&normalized);
        Ok(resolved)
    }

    /// `resolveValue`: a `{ factId, field }` entry becomes that field of the fact; every other value is rebuilt around
    /// the ones inside it. `None` is JavaScript's `undefined`: it leaves an object key out and reads as null in a list.
    fn resolve_value(&self, entry: &Value, used: &mut Used) -> Result<Option<Value>, String> {
        match entry {
            Value::Array(items) => {
                let mut resolved = Vec::with_capacity(items.len());
                for item in items {
                    resolved.push(self.resolve_value(item, used)?.unwrap_or(Value::Null));
                }
                Ok(Some(Value::Array(resolved)))
            }
            Value::Object(map) => {
                if let Some(fact_id) = map.get("factId").filter(|written| truthy(written)) {
                    let resolved = self.fact(Some(fact_id), used)?;
                    let field = match map.get("field").filter(|written| truthy(written)) {
                        Some(written) => value_to_string(written),
                        None => "value".to_owned(),
                    };
                    // A fact always owns `value`, set or not.
                    return match prop(resolved, &field) {
                        Some(found) => Ok(Some(clone(found))),
                        None if field == "value" => Ok(None),
                        None => Err(format!("Office fact {} has no field {field}", text(prop(resolved, "id")))),
                    };
                }
                let mut rebuilt = Map::new();
                for key in js_object_keys(map) {
                    if let Some(child) = self.resolve_value(&map[key], used)? {
                        rebuilt.insert(key.clone(), child);
                    }
                }
                Ok(Some(Value::Object(rebuilt)))
            }
            other => Ok(Some(other.clone())),
        }
    }
}

/// `bindOfficeContent`: resolves the fact and claim references of one semantic operation against the model.
pub fn bind_office_content(operation: &Value, model: Option<&Value>) -> Result<BoundOperation, String> {
    let Some(model) = model.filter(|model| truthy(model)) else {
        return Ok(BoundOperation { operation: operation.clone(), binding: None });
    };
    if !plain_object(operation) {
        return Ok(BoundOperation { operation: operation.clone(), binding: None });
    }
    let empty = Vec::new();
    let model_facts = array_of(prop(model, "facts")).unwrap_or(&empty);
    let facts = Facts { by_id: model_facts.iter().map(|fact| (prop(fact, "id").and_then(Value::as_str).unwrap_or(""), fact)).collect() };
    let claims: HashMap<&str, &Value> =
        array_of(prop(model, "claims")).unwrap_or(&empty).iter().map(|claim| (prop(claim, "id").and_then(Value::as_str).unwrap_or(""), claim)).collect();
    let mut used = Used::default();
    let mut bound = clone(operation);
    let map = bound.as_object_mut().expect("an object");
    if let Some(claim_ref) = map.get("claimId").filter(|written| truthy(written)).cloned() {
        let claim_id = safe_id(Some(&claim_ref), "claim reference", "")?;
        let claim = claims.get(claim_id.as_str()).copied().ok_or_else(|| format!("Office semantic operation references unknown claim {claim_id}"))?;
        for fact_id in array_of(prop(claim, "factIds")).unwrap_or(&empty) {
            used.add(&text_of(fact_id));
        }
        let claim_text = prop(claim, "text").cloned().unwrap_or(Value::Null);
        let claim_line = first_truthy(&[prop(claim, "implication"), prop(claim, "text")]).cloned().unwrap_or(Value::Null);
        if !map.get("title").is_some_and(truthy) {
            map.insert("title".into(), claim_text.clone());
        }
        if !map.get("takeaway").is_some_and(truthy) {
            map.insert("takeaway".into(), claim_line.clone());
        }
        // The claim is the sentence the document exists to make. When the caller also titled the operation, binding
        // it to the title alone dropped it.
        if map.get("op") == Some(&json!("compose_document")) && !map.get("summary").is_some_and(truthy) && map.get("title") != Some(&claim_text) {
            map.insert("summary".into(), claim_line);
        }
    }
    if let Some(Value::Array(metrics)) = map.get("metrics").cloned() {
        let mut resolved_metrics = Vec::with_capacity(metrics.len());
        for metric in &metrics {
            let fact_ref = prop(metric, "factId").filter(|written| truthy(written));
            let Some(fact_ref) = fact_ref.filter(|_| plain_object(metric)) else {
                resolved_metrics.push(facts.resolve_value(metric, &mut used)?.unwrap_or(Value::Null));
                continue;
            };
            let resolved = facts.fact(Some(fact_ref), &mut used)?;
            let mut entry = metric.as_object().expect("an object").clone();
            // The unit stays a unit: it closes on the figure the composers print, where parking it in `detail` left an
            // orphan word on a row of otherwise empty cells.
            match prop(metric, "value").filter(|written| !written.is_null()).cloned().or_else(|| prop(resolved, "value").map(clone)) {
                Some(found) => entry.insert("value".into(), found),
                None => entry.shift_remove("value"),
            };
            entry.insert("label".into(), first_truthy(&[prop(metric, "label"), prop(resolved, "label")]).cloned().unwrap_or(Value::Null));
            if let Some(unit) = first_truthy(&[prop(metric, "unit"), prop(resolved, "unit")]) {
                entry.insert("unit".into(), Value::String(value_to_string(unit)));
            }
            let or_empty = |key: &str| first_truthy(&[prop(metric, key), prop(resolved, key)]).cloned().unwrap_or_else(|| Value::String(String::new()));
            entry.insert("detail".into(), or_empty("detail"));
            entry.insert("numberFormat".into(), or_empty("numberFormat"));
            resolved_metrics.push(Value::Object(entry));
        }
        map.insert("metrics".into(), Value::Array(resolved_metrics));
    }
    for key in ["rows", "table", "chart", "columns", "steps", "allocations", "annotations", "gates", "actions"] {
        let Some(current) = map.get(key).filter(|current| !current.is_null()).cloned() else {
            continue;
        };
        match facts.resolve_value(&current, &mut used)? {
            Some(resolved) => map.insert(key.into(), resolved),
            None => map.shift_remove(key),
        };
    }
    let mut sources: Vec<String> = Vec::new();
    for id in &used.0 {
        let Some(source) = facts.by_id.get(id.as_str()).and_then(|fact| prop(fact, "source")).filter(|source| truthy(source)) else {
            continue;
        };
        let rendered = source_text(source);
        if !sources.contains(&rendered) {
            sources.push(rendered);
        }
    }
    if !map.get("source").is_some_and(truthy) && !sources.is_empty() {
        map.insert("source".into(), Value::String(sources.join("; ")));
    }
    let claim_id = match map.get("claimId").filter(|written| truthy(written)) {
        Some(written) => js_to_lowercase(&value_to_string(written)),
        None => String::new(),
    };
    let mut fact_ids = used.0.clone();
    fact_ids.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    let binding = json!({
        "packageId": prop(model, "packageId").cloned().unwrap_or(Value::Null),
        "contentFingerprint": prop(model, "fingerprint").cloned().unwrap_or(Value::Null),
        "claimId": claim_id,
        "factIds": fact_ids,
        "sources": sources,
    });
    Ok(BoundOperation { operation: bound, binding: Some(binding) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_js::json_stringify;

    fn model(facts: Value, claims: Value) -> Result<Value, String> {
        normalize_office_content_model(Some(&json!({ "packageId": "운영_리뷰", "facts": facts, "claims": claims })))
    }

    #[test]
    fn content_ids_take_the_packages_own_language_and_name_the_entry_that_fails() {
        let facts = json!([{ "id": "정시_출고율", "label": "정시 출고율", "value": 0.928, "numberFormat": "0.0%" }]);
        let bound = model(facts.clone(), json!([{ "id": "출고율_상승", "text": "정시 출고율이 올랐다", "factIds": ["정시_출고율"] }])).expect("model");
        assert_eq!(bound["facts"][0]["id"], json!("정시_출고율"));
        assert_eq!(bound["claims"][0]["factIds"], json!(["정시_출고율"]));
        // A claim that names its references "facts" binds to them as well.
        let aliased = model(facts, json!([{ "id": "출고율_상승", "text": "정시 출고율이 올랐다", "facts": ["정시_출고율"] }])).expect("model");
        assert_eq!(aliased["claims"][0]["factIds"], json!(["정시_출고율"]));
        let missing = model(json!([{ "label": "정시 출고율", "value": 0.928 }]), json!([])).expect_err("an id is required");
        assert!(missing.contains("fact id is required (fact 1: 정시 출고율)"), "{missing}");
        let spaced = model(json!([{ "id": "정시 출고율", "value": 0.928 }]), json!([])).expect_err("a space is not an id");
        assert!(spaced.contains("fact id \"정시 출고율\" must use 1-64 letters"), "{spaced}");
    }

    #[test]
    fn a_model_is_normalised_and_fingerprinted() {
        let value = json!({
            "packageId": " Q3.Review ", "objective": "ship", "audience": 5,
            "facts": [
                { "id": "Rev", "value": 1.5, "unit": "M", "format": "percent", "source": { "document": "a.xlsx", "target": "B2" } },
                { "id": "n", "label": "Count", "detail": "d", "numberFormat": "0.00", "source": " s " },
            ],
            "claims": [{ "id": "c1", "text": " up ", "facts": ["REV", "rev"], "implication": "grow" }],
        });
        let normalized = normalize_office_content_model(Some(&value)).expect("model");
        assert_eq!(normalized["packageId"], json!("q3.review"));
        assert_eq!(normalized["audience"], json!("5"));
        assert_eq!(
            normalized["facts"][0],
            json!({
                "id": "rev", "label": "rev", "value": 1.5, "unit": "M", "numberFormat": "0.0%",
                "source": { "document": "a.xlsx", "target": "B2" }
            })
        );
        assert_eq!(normalized["facts"][1]["source"], json!("s"));
        assert!(normalized["facts"][1].get("value").is_none());
        assert_eq!(normalized["claims"][0], json!({ "id": "c1", "text": "up", "factIds": ["rev"], "implication": "grow" }));
        assert_eq!(normalized["fingerprint"].as_str().map(str::len), Some(64));
        let summary = summarize_office_content_model(Some(&normalized));
        assert_eq!(summary["factCount"], json!(2));
        assert_eq!(summary["sourcedFactCount"], json!(2));
        assert_eq!(summary["claimCount"], json!(1));
        assert_eq!(summarize_office_content_model(None), Value::Null);
        assert_eq!(normalize_office_content_model(None), Ok(Value::Null));
    }

    #[test]
    fn a_model_refuses_what_it_cannot_read() {
        let err = |facts: Value, claims: Value| model(facts, claims).expect_err("refused");
        assert_eq!(normalize_office_content_model(Some(&json!("x"))), Err("Office design.content must be an object".into()));
        assert!(
            err(json!([{ "id": "a", "color": 1 }]), json!([]))
                .contains("fact a has unknown key(s): color. A fact takes: id, label, value, unit, detail, numberFormat, format, source.")
        );
        assert!(err(json!([{ "id": "a" }, { "id": "A" }]), json!([])).contains("duplicate fact id a"));
        assert!(err(json!([{ "id": "a" }]), json!([{ "id": "c", "factIds": ["b"] }])).contains("claim c references unknown fact b"));
        assert!(err(json!([1]), json!([])).contains("facts must be objects"));
        assert!(err(json!([]), json!([{ "id": "c" }, { "id": "C" }])).contains("duplicate claim id c"));
        assert_eq!(office_number_format(&json!({ "format": "Percent" })), "0.0%");
        assert_eq!(office_number_format(&json!({ "numberFormat": " 0.00 " })), "0.00");
        assert_eq!(office_number_format(&json!({})), "");
    }

    #[test]
    fn binding_resolves_facts_claims_and_sources() {
        let normalized = model(
            json!([
                { "id": "rev", "label": "Revenue", "value": 47210, "unit": "orders", "numberFormat": "#,##0", "source": { "document": "q3.xlsx", "target": "B2", "label": "sales" } },
                { "id": "gone", "label": "Gone" }
            ]),
            json!([{ "id": "up", "text": "Revenue grew", "factIds": ["rev"], "implication": "Invest" }]),
        )
        .expect("model");
        let operation = json!({
            "op": "compose_document", "claimId": "UP", "title": "Own title",
            "metrics": [{ "factId": "rev", "label": "" }, { "label": "plain", "value": 1 }],
            "rows": [[{ "factId": "rev" }, { "factId": "rev", "field": "label" }], [{ "factId": "gone" }]],
        });
        let bound = bind_office_content(&operation, Some(&normalized)).expect("bound");
        let out = &bound.operation;
        assert_eq!(out["takeaway"], json!("Invest"));
        assert_eq!(out["summary"], json!("Invest"));
        assert_eq!(out["title"], json!("Own title"));
        assert_eq!(out["metrics"][0], json!({ "factId": "rev", "label": "Revenue", "value": 47210, "unit": "orders", "detail": "", "numberFormat": "#,##0" }));
        assert_eq!(out["rows"], json!([[47210, "Revenue"], [null]]));
        assert_eq!(out["source"], json!("q3.xlsx#B2 (sales)"));
        assert_eq!(
            bound.binding,
            Some(json!({
                "packageId": "운영_리뷰", "contentFingerprint": normalized["fingerprint"], "claimId": "up",
                "factIds": ["gone", "rev"], "sources": ["q3.xlsx#B2 (sales)"]
            }))
        );
        assert_eq!(json_stringify(out).find("\"op\""), Some(1));
        let unknown = bind_office_content(&json!({ "claimId": "nope" }), Some(&normalized)).expect_err("unknown claim");
        assert_eq!(unknown, "Office semantic operation references unknown claim nope");
        let field = bind_office_content(&json!({ "rows": [{ "factId": "rev", "field": "colour" }] }), Some(&normalized)).expect_err("no such field");
        assert_eq!(field, "Office fact rev has no field colour");
        // A value that resolves to nothing leaves its key out without moving the keys after it.
        let unset = bind_office_content(
            &json!({ "metrics": [{ "factId": "gone", "value": null, "label": "L", "z": 1 }], "rows": { "factId": "gone" }, "after": 1 }),
            Some(&normalized),
        )
        .expect("bound");
        assert_eq!(json_stringify(&unset.operation), r#"{"metrics":[{"factId":"gone","label":"L","z":1,"detail":"","numberFormat":""}],"after":1}"#);
        let untouched = bind_office_content(&operation, None).expect("no model");
        assert_eq!(untouched, BoundOperation { operation: operation.clone(), binding: None });
    }
}
