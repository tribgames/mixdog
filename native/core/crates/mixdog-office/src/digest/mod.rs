//! What a model reads of an office action's result: `finalizeOfficeResult` of `core/office-core.mjs`.
//!
//! A result is read by a model, not by eye, so what another field of the same result already says, what a default says
//! and what the runtime keeps for itself are left out: the design catalogue, the design and the review guidance after
//! their first delivery, passed validation detail, empty lists and nulls, the per-format quiet defaults of a document
//! snapshot. The caller passes a copy; the stored session state keeps the full value.
//!
//! Values are parsed JSON in Node's insertion order (`serde_json` with `preserve_order`); every removal keeps the other
//! keys in place, and serialising with `mixdog_js::json_stringify` lists integer-like keys first as a JavaScript object
//! does. A field that is absent in Node is absent here, never null.

pub mod common;
pub mod docx;
pub mod pdf;
pub mod pptx;
pub mod tabular;
pub mod xlsx;

use mixdog_js::{json_number, json_stringify, math, to_number, to_number_of, value_to_string};
use mixdog_office_base::formats::is_tabular_format;
use mixdog_office_base::values::truthy;
use serde_json::Value;

use common::{
    Object, filtered, is_bool, is_positive, is_str, is_truthy, js_length, remove, same_value, strict_equals, without_empty,
    without_empty_object,
};

/// The disclosure a deck whose brief declared its figures illustrative carries on every result the author reads.
pub const FACTS_SAMPLE_DISCLOSURE: &str = "The brief declares facts: sample \u{2014} every figure on this deck is illustrative. Tell the user so in the delivery and never present the numbers as measured.";

/// The session fields a result's digest reads and keeps between results.
#[derive(Clone, Debug, Default)]
pub struct ResultSession {
    /// The document path (`session.target`); empty when the session has none.
    pub target: String,
    /// The document format (`docx`, `xlsx`, `pptx`, `pdf`, `csv`, `tsv`); empty when unknown.
    pub format: String,
    /// The file extension the session opened (`docm`, `xltx`...); empty when unknown.
    pub file_kind: String,
    /// The deck was authored by script (`session.authored === true`).
    pub authored: bool,
    /// The authored brief declared `factsMode: 'sample'`.
    pub facts_mode_sample: bool,
    /// The design as last delivered (`session.deliveredDesign`): the serialised design without its creative brief.
    pub delivered_design: Option<String>,
    /// The review guidance as last delivered (`session.deliveredModelReview`).
    pub delivered_model_review: Option<String>,
}

/// The arguments of [`finalize_office_result`].
pub struct FinalizeOptions<'a> {
    /// The action the result answers (`create`, `open`, `qa`, `finalize`...); empty for none.
    pub action: &'a str,
    pub session: Option<&'a mut ResultSession>,
    /// The milliseconds the call took (`performance.now() - startedAt`).
    pub elapsed_ms: f64,
}

fn artifact_type(format: &str) -> &'static str {
    if format == "xlsx" || is_tabular_format(format) {
        "spreadsheet"
    } else if format == "pptx" {
        "presentation"
    } else if format == "pdf" {
        "pdf"
    } else {
        "document"
    }
}

/// What a caller needs back of a design is the design in force: its profile, tokens, the selected direction and any
/// warning. The catalogue it was chosen from (every available layout, the rejected direction candidates, the
/// composition history) is input the caller already holds.
fn office_design_digest(design: &Value) -> Value {
    let Value::Object(map) = design else { return design.clone() };
    // A document opened as it is keeps its own look: what it answers is where the design stands and what review is owed.
    let tokens_unapplied = is_bool(map.get("artDirection").and_then(|direction| direction.get("applyTokens")), false);
    if is_str(map.get("source"), "existing-document") && tokens_unapplied {
        let mut digest = Object::new();
        digest.insert("source".to_owned(), map["source"].clone());
        if let Some(review) = map.get("review").filter(|review| truthy(review)) {
            let mut required = Object::new();
            required.insert("required".to_owned(), Value::Bool(is_bool(review.get("required"), true)));
            digest.insert("review".to_owned(), Value::Object(required));
        }
        if let Some(warning) = map.get("library").and_then(|library| library.get("warning")).filter(|warning| truthy(warning)) {
            digest.insert("warning".to_owned(), warning.clone());
        }
        return Value::Object(digest);
    }
    let mut digest = map.clone();
    for key in ["layouts", "recentCompositions"] {
        remove(&mut digest, key);
    }
    if let Some(Value::Object(direction)) = digest.get("artDirection") {
        let mut rest = direction.clone();
        remove(&mut rest, "candidates");
        if let Some(Value::Array(candidates)) = direction.get("candidates") {
            rest.insert("candidateCount".to_owned(), Value::from(candidates.len()));
        }
        // A direction whose tokens were not applied names its style and motif; its own palette and faces contradict the
        // `tokens` in force beside it, and its `deck` block repeats `creativeSystem` field for field.
        if is_bool(rest.get("applyTokens"), false) {
            if let Some(Value::Object(selected)) = rest.get("selected") {
                let mut selected = selected.clone();
                for key in ["palette", "typography", "deck"] {
                    remove(&mut selected, key);
                }
                rest.insert("selected".to_owned(), Value::Object(selected));
            }
        }
        digest.insert("artDirection".to_owned(), Value::Object(rest));
    }
    // The library receipt names where the design came from and any warning; its template-index hash and composition
    // count are the runtime's bookkeeping, and an unset pack, template, pin or warning says nothing.
    if let Some(Value::Object(library)) = digest.get("library") {
        let mut library = library.clone();
        remove(&mut library, "templateIndexRevision");
        remove(&mut library, "recentCompositionCount");
        let library = filtered(&library, |_, entry| !entry.is_null() && !is_str(Some(entry), "") && !is_bool(Some(entry), false));
        digest.insert("library".to_owned(), Value::Object(library));
    }
    // The creative brief's discipline restates the tokens (faces by role, palette slots, the list of colour roles); its
    // rules are what it adds.
    if is_truthy(digest.get("tokens")) {
        let discipline = digest.get("creative").and_then(|creative| creative.get("discipline")).and_then(Value::as_object).cloned();
        if let (Some(mut kept), Some(Value::Object(creative))) = (discipline, digest.get("creative").cloned()) {
            for key in ["typographyRoles", "paletteSlots", "colorRoles"] {
                remove(&mut kept, key);
            }
            let mut creative = creative;
            creative.insert("discipline".to_owned(), Value::Object(kept));
            digest.insert("creative".to_owned(), Value::Object(creative));
        }
    }
    // An unset intent, audience or content reads the same absent as empty.
    let unset: Vec<String> =
        digest.iter().filter(|(_, entry)| entry.is_null() || is_str(Some(*entry), "")).map(|(key, _)| key.clone()).collect();
    for key in unset {
        remove(&mut digest, &key);
    }
    Value::Object(digest)
}

/// A preset (`compose_document`, `compose_sheet`) expands one call into dozens of cell, run and style writes; each
/// succeeded the same way, so they come back as a count per operation. A write that did not change, or reports anything
/// past its address, stays in place, as does every object a later call names (a table, a chart).
fn preset_results(results: Vec<Value>, semantic: Option<&Value>) -> Vec<Value> {
    if !matches!(semantic, Some(Value::Array(operations)) if !operations.is_empty()) {
        return results;
    }
    let mut applied = Object::new();
    let mut kept = Vec::new();
    for entry in results {
        let routine = is_bool(entry.get("changed"), true)
            && matches!(entry.get("op"), Some(Value::String(op)) if matches!(op.as_str(), "append_text" | "set_table_cell_style" | "set_style" | "merge_cells" | "set_cell" | "set_row_height"))
            && entry.as_object().is_some_and(|fields| {
                fields.keys().all(|field| {
                    matches!(field.as_str(), "op" | "changed" | "style" | "table" | "row" | "col" | "sheet" | "cell" | "range")
                })
            });
        if routine {
            let op = value_to_string(&entry["op"]);
            let count = applied.get(&op).and_then(Value::as_u64).unwrap_or(0) + 1;
            applied.insert(op, Value::from(count));
        } else {
            kept.push(entry);
        }
    }
    if !applied.is_empty() {
        let mut summary = Object::new();
        summary.insert("applied".to_owned(), Value::Object(applied));
        kept.push(Value::Object(summary));
    }
    kept
}

/// A trust read that found nothing says only that, and the untrusted-data policy stays on anything that did not come from
/// this session's own writing; the scan bookkeeping is the runtime's.
fn trust_digest(trust: &Value) -> Value {
    let Value::Object(map) = trust else { return trust.clone() };
    if is_positive(map.get("findingCount")) || matches!(map.get("findings"), Some(Value::Array(findings)) if !findings.is_empty()) {
        return trust.clone();
    }
    let mut digest = Object::new();
    if let Some(risk) = map.get("risk") {
        digest.insert("risk".to_owned(), risk.clone());
    }
    if let Some(policy) = map.get("policy").filter(|policy| truthy(policy)) {
        if !is_str(map.get("source"), "created-document") {
            digest.insert("policy".to_owned(), policy.clone());
        }
    }
    if is_bool(map.get("complete"), false) {
        digest.insert("complete".to_owned(), Value::Bool(false));
    }
    if let Some(warning) = map.get("warning").filter(|warning| truthy(warning)) {
        digest.insert("warning".to_owned(), warning.clone());
    }
    Value::Object(digest)
}

/// `${issue?.code}|${issue?.path}|${issue?.message}`.
fn issue_key(issue: &Value) -> String {
    let part = |name: &str| issue.get(name).map_or_else(|| "undefined".to_owned(), value_to_string);
    format!("{}|{}|{}", part("code"), part("path"), part("message"))
}

/// A QA verdict as a model reads it. The full record stays on the transaction; the result drops what another field of the
/// same result already carries (the pre-fix list when nothing was fixed, the preview's images and coverage, a visual review
/// repeated at the top) and the raw pixel measurements the issues were derived from. Passed checklist items reduce to the
/// summary counts.
fn model_facing_qa_result(result: &Value, top_visual_review: Option<&Value>, finalized: bool) -> Value {
    let Value::Object(source) = result else { return result.clone() };
    let Some(Value::Object(source_review)) = source.get("review") else { return result.clone() };
    let mut compact = source.clone();
    if js_length(source.get("fixes")).is_none_or(|length| length == 0) {
        remove(&mut compact, "issuesBefore");
    }
    if same_value(compact.get("visualReview"), top_visual_review) {
        remove(&mut compact, "visualReview");
    }
    let reported: Vec<String> = match source.get("issuesAfter") {
        Some(Value::Array(issues)) => issues.iter().map(issue_key).collect(),
        _ => Vec::new(),
    };
    let all_reported = |issues: Option<&Value>| match issues {
        Some(Value::Array(issues)) => issues.iter().all(|issue| reported.contains(&issue_key(issue))),
        _ => false,
    };
    // The advisory list is a subset of issuesAfter; naming the codes says which ones do not hold the file back without
    // sending each finding twice.
    let advisory = compact.get("advisoryIssues").cloned();
    if let Some(Value::Array(issues)) = &advisory {
        if all_reported(advisory.as_ref()) {
            let mut codes: Vec<Value> = Vec::new();
            for code in issues.iter().filter_map(|issue| issue.get("code")).filter(|code| truthy(code)) {
                if !codes.iter().any(|seen| json_stringify(seen) == json_stringify(code)) {
                    codes.push(code.clone());
                }
            }
            remove(&mut compact, "advisoryIssues");
            if !codes.is_empty() {
                compact.insert("advisoryCodes".to_owned(), Value::Array(codes));
            }
        }
    }
    let mut review = source_review.clone();
    if let Some(Value::Object(design)) = review.get("design") {
        let mut design = design.clone();
        if all_reported(design.get("issues")) {
            remove(&mut design, "issues");
        }
        // A finalized document is saved and closed: guidance for the next review pass has no pass left to guide.
        if finalized {
            remove(&mut design, "modelReview");
        }
        review.insert("design".to_owned(), Value::Object(design));
    }
    if finalized {
        remove(&mut review, "polishPlan");
    }
    // The critique entries are the ones the caller just submitted; once accepted and closed, the verdict stands on its
    // status without echoing them back.
    if finalized {
        if let Some(Value::Object(critique)) = compact.get("visualCritique") {
            if let Some(Value::Array(entries_list)) = critique.get("entries") {
                let count = entries_list.len();
                let mut verdict = critique.clone();
                remove(&mut verdict, "entries");
                verdict.insert("entryCount".to_owned(), Value::from(count));
                compact.insert("visualCritique".to_owned(), Value::Object(verdict));
            }
        }
    }
    if let Some(trust) = review.get("trust").filter(|trust| truthy(trust)) {
        let digest = trust_digest(trust);
        review.insert("trust".to_owned(), digest);
    }
    // A comparison that had nothing to compare against says so by its absence.
    if is_bool(compact.get("baseline").and_then(|baseline| baseline.get("available")), false) {
        remove(&mut compact, "baseline");
    }
    if let Some(diff) = review.get("visualDiff") {
        let none_drawn = is_bool(diff.get("available"), false)
            && js_length(diff.get("pages")).is_none_or(|length| length == 0)
            && js_length(diff.get("images")).is_none_or(|length| length == 0);
        if none_drawn {
            remove(&mut review, "visualDiff");
        }
    }
    let preview = source.get("preview").filter(|preview| truthy(preview));
    if preview.is_some() {
        for key in ["images", "visualCoverage", "output"] {
            remove(&mut review, key);
        }
    }
    // A measured read (render:false) drew no page: an aesthetic score of no confidence, a quality score built on a render
    // that did not happen, and a render-coverage item failing by design all read as defects the page does not have.
    let measure_only = is_str(preview.and_then(|preview| preview.get("visualCoverage")).and_then(|coverage| coverage.get("mode")), "measure-only");
    if let Some(Value::Object(render)) = review.get("render") {
        let mut render = render.clone();
        let aesthetics = render.get("aesthetics").cloned();
        remove(&mut render, "pages");
        remove(&mut render, "aesthetics");
        if let Some(Value::Object(aesthetics)) = aesthetics {
            let no_confidence = to_number_of(aesthetics.get("confidence")) == 0.0;
            if !(measure_only || no_confidence) {
                let mut scores = aesthetics.clone();
                remove(&mut scores, "pages");
                render.insert("aesthetics".to_owned(), Value::Object(scores));
            }
        }
        review.insert("render".to_owned(), Value::Object(render));
    }
    if measure_only {
        remove(&mut review, "quality");
    }
    if let Some(Value::Array(items)) = review.get("checklist").and_then(|checklist| checklist.get("items")) {
        let render_owed = |item: &Value| measure_only && is_str(item.get("id"), "full-render-coverage");
        let dropped = items.iter().filter(|item| render_owed(item)).count();
        let kept: Vec<Value> = items.iter().filter(|item| !is_str(item.get("status"), "pass") && !render_owed(item)).cloned().collect();
        let summary = review.get("checklist").and_then(|checklist| checklist.get("summary")).filter(|summary| truthy(summary)).cloned();
        if let Some(Value::Object(checklist)) = review.get("checklist") {
            let mut checklist = checklist.clone();
            checklist.insert("items".to_owned(), Value::Array(kept));
            if let (true, Some(Value::Object(summary))) = (dropped > 0, summary) {
                let mut summary = summary;
                let total = to_number_of(summary.get("total")) - dropped as f64;
                let failed = if is_truthy(summary.get("failed")) { to_number_of(summary.get("failed")) } else { 0.0 };
                summary.insert("total".to_owned(), json_number(total));
                summary.insert("failed".to_owned(), json_number(math::max(0.0, failed - dropped as f64)));
                checklist.insert("summary".to_owned(), Value::Object(summary));
            }
            review.insert("checklist".to_owned(), Value::Object(checklist));
        }
    }
    if measure_only {
        if let Some(Value::Object(preview)) = compact.get("preview") {
            if matches!(preview.get("images"), Some(Value::Array(images)) if images.is_empty()) {
                let mut preview = preview.clone();
                remove(&mut preview, "images");
                compact.insert("preview".to_owned(), Value::Object(preview));
            }
        }
    }
    let quality_review = review.get("quality").and_then(|quality| quality.get("visualReview"));
    let repeated = [top_visual_review, source.get("visualReview")]
        .into_iter()
        .flatten()
        .find(|entry| same_value(Some(*entry), quality_review))
        .is_some_and(truthy);
    if repeated {
        let status = quality_review.and_then(|visual| visual.get("status")).cloned();
        if let Some(Value::Object(quality)) = review.get("quality") {
            let mut quality = quality.clone();
            let mut visual = Object::new();
            if let Some(status) = status {
                visual.insert("status".to_owned(), status);
            }
            quality.insert("visualReview".to_owned(), Value::Object(visual));
            review.insert("quality".to_owned(), Value::Object(quality));
        }
    }
    compact.insert("review".to_owned(), Value::Object(review));
    Value::Object(compact)
}

/// The check entries a passed finalize check answers without: its verdict and whatever departs from the default stay.
fn passed_check_detail(check: &str, key: &str, field: &Value, entry: &Object) -> bool {
    match (check, key) {
        ("schema", "rawValid" | "version" | "available" | "cached" | "downloaded" | "officeVersion" | "validation") => true,
        ("schema", "omittedErrors") => !is_positive(Some(field)),
        // Not saved is news in a live or visible session: only the saved state goes.
        ("native", "opened" | "reopened" | "persisted" | "documentSaved") => matches!(field, Value::Bool(true)),
        ("native", "snapshotFingerprint") => true,
        ("native", "excelDpiRepairs") => !is_positive(Some(field)),
        ("native", "issueCount") => {
            to_number(field) == entry.get("issues").and_then(Value::as_array).map_or(0.0, |issues| issues.len() as f64)
        }
        _ => false,
    }
}

/// A finalize's package check lists every fault family, almost all of them empty. An empty list or a null reads the same
/// as an absent one, the session and path repeat the result's own, and the validator's install path is the runtime's
/// business; what is left is what the check found.
fn finalize_validation_digest(validation: &Object, result: &Object, session: Option<&ResultSession>) -> Object {
    let mut digest = without_empty_object(validation);
    for key in ["session", "path"] {
        if strict_equals(digest.get(key), result.get(key)) {
            remove(&mut digest, key);
        }
    }
    if let Some(session) = session.filter(|session| !session.target.is_empty()) {
        if is_str(digest.get("path"), &session.target) {
            remove(&mut digest, "path");
        }
    }
    // The session's mode and backend ride the review beside this check.
    let review = result.get("review");
    if review.and_then(|review| review.get("mode")).is_some() {
        remove(&mut digest, "mode");
    }
    if review.and_then(|review| review.get("backend")).is_some() {
        remove(&mut digest, "backend");
    }
    if let Some(Value::Object(schema)) = digest.get_mut("schema") {
        remove(schema, "path");
    }
    // The package's own bookkeeping (its entry count, main part and content type, the name of the check that ran)
    // describes a package that opened; a missing main content type is a fault and stays.
    for key in ["format", "entries", "mainPart", "mainContentType", "validation"] {
        remove(&mut digest, key);
    }
    if is_bool(digest.get("mainContentTypeMissing"), false) {
        remove(&mut digest, "mainContentTypeMissing");
    }
    let quiet_security = digest.get("security").is_some_and(|security| {
        is_str(security.get("macroExecution"), "disabled")
            && !is_truthy(security.get("digitalSignatureInvalidated"))
            && security.as_object().is_some_and(|fields| fields.len() <= 2)
    });
    if quiet_security {
        remove(&mut digest, "security");
    }
    for check in ["schema", "native"] {
        let Some(Value::Object(entry)) = digest.get(check) else { continue };
        if !is_bool(entry.get("ok"), true) {
            continue;
        }
        let answer = filtered(entry, |key, field| !passed_check_detail(check, key, field, entry));
        digest.insert(check.to_owned(), Value::Object(answer));
    }
    let gate_passed = digest
        .get("postSaveGate")
        .is_some_and(|gate| is_bool(gate.get("ok"), true) && !is_positive(gate.get("criticalCount")));
    if gate_passed {
        remove(&mut digest, "postSaveGate");
    }
    // The baseline names what differs from the opened file. The file it was, the backend that saved it and an unbroken
    // signature repeat the session; the parts Office adds whenever it saves (headers, theme, font table) are its
    // normalisation, not the edit: a redline's own added parts stay under redlining.
    if let Some(Value::Object(baseline)) = digest.get("baseline") {
        let mut rest = baseline.clone();
        for key in ["original", "originalEntries", "savedBy", "compared", "digitalSignatureInvalidated"] {
            remove(&mut rest, key);
        }
        if is_bool(baseline.get("applicationSaved"), true) {
            remove(&mut rest, "addedParts");
        }
        if is_truthy(baseline.get("digitalSignatureInvalidated")) {
            rest.insert("digitalSignatureInvalidated".to_owned(), Value::Bool(true));
        }
        if is_bool(baseline.get("compared"), false) {
            rest.insert("compared".to_owned(), Value::Bool(false));
        }
        digest.insert("baseline".to_owned(), Value::Object(rest));
    }
    digest
}

/// The document a model reads, by format; every digest copies and leaves the stored record whole.
pub fn office_document_digest(document: &Value) -> Value {
    let Value::Object(map) = document else { return document.clone() };
    match map.get("format") {
        Some(Value::String(format)) => match format.as_str() {
            "pptx" => pptx::pptx_document_digest(document),
            "xlsx" => xlsx::xlsx_document_digest(document),
            "docx" => docx::docx_document_digest(document),
            "pdf" => pdf::pdf_document_digest(document),
            other if is_tabular_format(other) => tabular::tabular_document_digest(document),
            _ => document.clone(),
        },
        _ => document.clone(),
    }
}

/// The design in force rides on every batch of a session (`commitBatch` returns `session.design`), four kilobytes of tokens,
/// direction and brief that were already delivered with the create. It goes out once per session and again only when it
/// changes; later results say which profile holds and that it is unchanged.
fn design_once(design: &Value, session: Option<&mut ResultSession>) -> Value {
    let (Some(session), Value::Object(map)) = (session, design) else { return design.clone() };
    // The creative brief is rebuilt for each batch's own operations, so it is not what says the design changed: keyed on it,
    // every batch resent the whole design. What holds across the session (profile, direction, tokens, format) is the key.
    let mut held = map.clone();
    remove(&mut held, "creative");
    let key = json_stringify(&Value::Object(held));
    if session.delivered_design.as_deref() != Some(key.as_str()) {
        session.delivered_design = Some(key);
        return design.clone();
    }
    let mut unchanged = Object::new();
    for field in ["profile", "authoring"] {
        if let Some(value) = map.get(field).filter(|value| truthy(value)) {
            unchanged.insert(field.to_owned(), value.clone());
        }
    }
    unchanged.insert("unchanged".to_owned(), Value::Bool(true));
    Value::Object(unchanged)
}

/// The review guidance is the same list on every qa and finalize of a session; it goes out once, and a later review
/// repeats it only if it changes.
fn model_review_once(design: &Value, session: Option<&mut ResultSession>) -> Value {
    let (Some(session), Value::Object(map)) = (session, design) else { return design.clone() };
    let Some(guidance @ Value::Array(_)) = map.get("modelReview") else { return design.clone() };
    let key = json_stringify(guidance);
    if session.delivered_model_review.as_deref() == Some(key.as_str()) {
        let mut rest = map.clone();
        remove(&mut rest, "modelReview");
        return Value::Object(rest);
    }
    session.delivered_model_review = Some(key);
    design.clone()
}

/// `{ ...container, design: modelReviewOnce(container.design, session) }` for the object a review sits in.
fn review_once(container: &Value, session: Option<&mut ResultSession>) -> Option<Value> {
    let Value::Object(map) = container else { return None };
    let design = map.get("design").filter(|design| truthy(design))?;
    let mut rebuilt = map.clone();
    rebuilt.insert("design".to_owned(), model_review_once(design, session));
    Some(Value::Object(rebuilt))
}

fn with_object<R>(value: &mut Object, key: &str, update: impl FnOnce(&mut Object) -> R) -> Option<R> {
    match value.get_mut(key) {
        Some(Value::Object(inner)) => Some(update(inner)),
        _ => None,
    }
}

/// An operation's result names what it did; an empty string field says nothing.
fn without_blank(entry: &Value) -> Value {
    match entry {
        Value::Object(map) => Value::Object(filtered(map, |_, field| !is_str(Some(field), ""))),
        other => other.clone(),
    }
}

fn digested_results(results: &[Value], semantic: Option<&Value>) -> Value {
    Value::Array(preset_results(results.iter().map(without_blank).collect(), semantic))
}

/// Shapes a result for the model that reads it, in Node's order. `value` is the caller's copy; anything but an object is
/// returned as it came.
pub fn finalize_office_result(value: Value, options: FinalizeOptions<'_>) -> Value {
    let FinalizeOptions { action, mut session, elapsed_ms } = options;
    let mut value = match value {
        Value::Object(map) => map,
        other => return other,
    };
    if action == "qa" {
        if let Value::Object(compact) = model_facing_qa_result(&Value::Object(value.clone()), None, false) {
            value = compact;
        }
        if let Some(review) = value.get("review").and_then(|review| review_once(review, session.as_deref_mut())) {
            value.insert("review".to_owned(), review);
        }
    }
    // create/open with finalize:true answer with a finalize result of their own.
    let finalizing = action == "finalize" || matches!(value.get("finalized"), Some(Value::Bool(_)));
    if finalizing && is_truthy(value.get("review")) {
        let finalized = is_bool(value.get("finalized"), true);
        let review = model_facing_qa_result(&value["review"], value.get("visualReview"), finalized);
        let inner = review.get("review").and_then(|inner| review_once(inner, session.as_deref_mut()));
        let review = match (review, inner) {
            (Value::Object(mut outer), Some(inner)) => {
                outer.insert("review".to_owned(), inner);
                Value::Object(outer)
            }
            (review, _) => review,
        };
        value.insert("review".to_owned(), review);
    }
    if finalizing {
        // The reopened file's full shape inventory proves persistence, which its fingerprint and issue count already state;
        // the inventory itself is a snapshot the caller can ask for.
        with_object(&mut value, "validation", |validation| {
            with_object(validation, "native", |native| {
                if is_truthy(native.get("snapshot")) {
                    remove(native, "snapshot");
                }
            })
        });
        if let Some(Value::Object(validation)) = value.get("validation") {
            let digest = finalize_validation_digest(validation, &value, session.as_deref());
            value.insert("validation".to_owned(), Value::Object(digest));
        }
        // A refused finalize ran no recalculation or review to report.
        for key in ["recalculation", "review"] {
            if value.get(key).is_some_and(Value::is_null) {
                remove(&mut value, key);
            }
        }
        // A document composed without the preset composer has no composition to report.
        if value.get("composition").is_some_and(|composition| truthy(composition) && !is_positive(composition.get("count"))) {
            remove(&mut value, "composition");
        }
        if value.get("compositionHistory").is_some_and(Value::is_null) {
            remove(&mut value, "compositionHistory");
        }
        // A script-authored deck carries its design in its own brief; the session's preset design was never applied to it
        // and only misdescribes the deck.
        if session.as_deref().is_some_and(|session| session.authored) {
            remove(&mut value, "design");
        }
    }
    if matches!(action, "create" | "open" | "attach") {
        // A session that opened as expected (in the background, fresh, nothing brought forward, no window to isolate) says
        // so by omission; a visible, reused or foregrounded one still says what happened.
        for key in ["foregroundActivated", "reused", "visible", "created"] {
            if is_bool(value.get(key), false) {
                remove(&mut value, key);
            }
        }
        if value.get("backgroundIsolation").is_some_and(Value::is_null) {
            remove(&mut value, "backgroundIsolation");
        }
    }
    // A delimited file has no styles, pages or composition: the design a session carries by default describes nothing in it,
    // and its review is structural: the verdict, what remains, and that the structural read covered it.
    if session.as_deref().is_some_and(|session| is_tabular_format(&session.format)) {
        remove(&mut value, "design");
        // `design: undefined` serialises as absent.
        with_object(&mut value, "batch", |batch| {
            if is_truthy(batch.get("design")) {
                remove(batch, "design");
            }
        });
        if finalizing {
            if let Some(Value::Object(review)) = value.get("review") {
                let mut structural = Object::new();
                for key in ["ok", "issuesAfter", "fixes"] {
                    if let Some(entry) = review.get(key) {
                        structural.insert(key.to_owned(), entry.clone());
                    }
                }
                if let Some(coverage) = review.get("preview").and_then(|preview| preview.get("visualCoverage")).filter(|c| truthy(c)) {
                    let mut preview = Object::new();
                    preview.insert("visualCoverage".to_owned(), coverage.clone());
                    structural.insert("preview".to_owned(), Value::Object(preview));
                }
                value.insert("review".to_owned(), without_empty(&Value::Object(structural)));
            }
        }
    }
    if let Some(design) = value.get("design").filter(|design| truthy(design)) {
        let digest = design_once(&office_design_digest(design), session.as_deref_mut());
        value.insert("design".to_owned(), digest);
    }
    if let Some(design) = value.get("batch").and_then(|batch| batch.get("design")).filter(|design| truthy(design)) {
        let digest = design_once(&office_design_digest(design), session.as_deref_mut());
        with_object(&mut value, "batch", |batch| batch.insert("design".to_owned(), digest));
    }
    if let Some(trust) = value.get("trust").filter(|trust| truthy(trust)) {
        let digest = trust_digest(trust);
        value.insert("trust".to_owned(), digest);
    }
    if let Some(document) = value.get("document").filter(|document| truthy(document)) {
        let digest = office_document_digest(document);
        value.insert("document".to_owned(), digest);
    }
    if let Some(trust) = value.get("batch").and_then(|batch| batch.get("trust")).filter(|trust| truthy(trust)) {
        let digest = trust_digest(trust);
        with_object(&mut value, "batch", |batch| batch.insert("trust".to_owned(), digest));
    }
    // A recalculation reports what it computed and every error it met; how the LibreOffice save was normalized and how many
    // bytes it wrote are the runtime's.
    if let Some(Value::Object(recalculation)) = value.get("recalculation") {
        let mut rest = recalculation.clone();
        remove(&mut rest, "normalized");
        remove(&mut rest, "outputBytes");
        let mut digest = without_empty_object(&rest);
        if matches!(digest.get("errorSummary"), Some(Value::Object(summary)) if summary.is_empty()) {
            remove(&mut digest, "errorSummary");
        }
        value.insert("recalculation".to_owned(), Value::Object(digest));
    }
    if let Some(Value::Array(results)) = value.get("results") {
        let digest = digested_results(results, value.get("semanticOperations"));
        value.insert("results".to_owned(), digest);
    }
    if let Some(Value::Array(results)) = value.get("batch").and_then(|batch| batch.get("results")) {
        let digest = digested_results(results, value.get("batch").and_then(|batch| batch.get("semanticOperations")));
        with_object(&mut value, "batch", |batch| batch.insert("results".to_owned(), digest));
    }
    let duration = math::max(0.0, to_number(&Value::from(math::to_fixed(elapsed_ms, 2))));
    let mut metrics = match value.get("metrics") {
        Some(Value::Object(metrics)) => metrics.clone(),
        _ => Object::new(),
    };
    metrics.insert("durationMs".to_owned(), json_number(duration));
    value.insert("metrics".to_owned(), Value::Object(metrics));
    // A deck whose brief declared its figures illustrative carries that disclosure on every result the author reads, so the
    // delivery says so.
    if session.as_deref().is_some_and(|session| session.facts_mode_sample) && matches!(action, "author" | "qa" | "render" | "finalize") {
        value.insert("factsMode".to_owned(), Value::from("sample"));
        value.insert("disclosure".to_owned(), Value::from(FACTS_SAMPLE_DISCLOSURE));
    }
    attach_office_artifacts(&mut value, action, session.as_deref());
    Value::Object(value)
}

/// The file an action produced or edited, named as an artifact of the result.
fn attach_office_artifacts(value: &mut Object, action: &str, session: Option<&ResultSession>) {
    let operation = if action == "create" || (action == "author" && is_truthy(value.get("output"))) {
        "create"
    } else if action == "render" {
        "render"
    } else if matches!(action, "batch" | "commit" | "rollback" | "save" | "secure" | "finalize") {
        "edit"
    } else {
        ""
    };
    let path = if matches!(action, "render" | "secure") {
        value.get("output").cloned()
    } else if !operation.is_empty() {
        session.map(|session| Value::from(session.target.as_str()))
    } else {
        None
    };
    let Some(path) = path.filter(|path| truthy(path)) else { return };
    if operation.is_empty() {
        return;
    }
    let fallback = if action == "secure" { "pdf" } else { "" };
    let pick = |own: Option<&str>| match own {
        Some(own) if !own.is_empty() => own.to_owned(),
        _ => fallback.to_owned(),
    };
    let format = pick(session.map(|session| session.format.as_str()));
    let file_kind = pick(session.map(|session| session.file_kind.as_str()));
    let mut artifact = Object::new();
    artifact.insert("type".to_owned(), Value::from(artifact_type(&format)));
    artifact.insert("format".to_owned(), Value::from(format));
    artifact.insert("fileKind".to_owned(), Value::from(file_kind));
    artifact.insert("operation".to_owned(), Value::from(operation));
    artifact.insert("path".to_owned(), path);
    value.insert("artifacts".to_owned(), Value::Array(vec![Value::Object(artifact)]));
    value.insert("outputCount".to_owned(), Value::from(1));
    value.insert("expectedOutputCount".to_owned(), Value::from(1));
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn run(value: Value, action: &str, session: Option<&mut ResultSession>) -> String {
        json_stringify(&finalize_office_result(value, FinalizeOptions { action, session, elapsed_ms: 12.5 }))
    }

    fn session(format: &str) -> ResultSession {
        ResultSession {
            target: format!("C:/docs/a.{format}"),
            format: format.to_owned(),
            file_kind: format.to_owned(),
            ..ResultSession::default()
        }
    }

    #[test]
    fn a_value_that_is_not_an_object_is_returned_as_it_came() {
        assert_eq!(run(json!("text"), "batch", None), "\"text\"");
        assert_eq!(run(json!([1, 2]), "batch", None), "[1,2]");
    }

    #[test]
    fn the_duration_has_two_decimals_and_follows_the_metrics_in_place() {
        let first = run(json!({ "metrics": { "durationMs": 99, "calls": 2 }, "z": 1 }), "x", None);
        assert_eq!(first, r#"{"metrics":{"durationMs":12.5,"calls":2},"z":1}"#);
        let value = finalize_office_result(json!({}), FinalizeOptions { action: "", session: None, elapsed_ms: 3.1415 });
        assert_eq!(json_stringify(&value), r#"{"metrics":{"durationMs":3.14}}"#);
    }

    #[test]
    fn a_session_that_opened_as_expected_says_so_by_omission() {
        let raw = json!({
            "id": "s", "visible": false, "created": false, "reused": true, "foregroundActivated": false, "backgroundIsolation": null
        });
        assert_eq!(run(raw, "open", None), r#"{"id":"s","reused":true,"metrics":{"durationMs":12.5}}"#);
    }

    #[test]
    fn the_design_goes_out_once_and_later_results_say_it_is_unchanged() {
        let design = json!({
            "profile": "clean", "authoring": "preset", "layouts": [1], "tokens": { "a": 1 }, "intent": "", "creative": { "thesis": "t" }
        });
        let mut held = session("docx");
        let first = run(json!({ "design": design.clone() }), "create", Some(&mut held));
        assert_eq!(
            first,
            concat!(
                r#"{"design":{"profile":"clean","authoring":"preset","tokens":{"a":1},"creative":{"thesis":"t"}},"#,
                r#""metrics":{"durationMs":12.5},"#,
                r#""artifacts":[{"type":"document","format":"docx","fileKind":"docx","operation":"create","path":"C:/docs/a.docx"}],"#,
                r#""outputCount":1,"expectedOutputCount":1}"#
            )
        );
        let mut other = design.clone();
        other["creative"] = json!({ "thesis": "another" });
        let second = run(json!({ "batch": { "design": other } }), "batch", Some(&mut held));
        assert!(second.starts_with(r#"{"batch":{"design":{"profile":"clean","authoring":"preset","unchanged":true}}"#), "{second}");
    }

    #[test]
    fn a_design_that_changed_is_delivered_again() {
        let mut held = session("pptx");
        run(json!({ "design": { "profile": "a" } }), "batch", Some(&mut held));
        let again = run(json!({ "design": { "profile": "b" } }), "batch", Some(&mut held));
        assert!(again.starts_with(r#"{"design":{"profile":"b"}"#), "{again}");
    }

    #[test]
    fn a_document_opened_as_it_is_answers_with_where_its_design_stands() {
        let design = json!({
            "source": "existing-document", "artDirection": { "applyTokens": false }, "review": { "required": true, "x": 1 },
            "profile": "p", "library": { "warning": "w" }
        });
        assert_eq!(
            json_stringify(&office_design_digest(&design)),
            r#"{"source":"existing-document","review":{"required":true},"warning":"w"}"#
        );
    }

    #[test]
    fn the_art_direction_loses_its_candidates_and_unapplied_palette() {
        let design = json!({
            "artDirection": { "candidates": [1, 2, 3], "applyTokens": false, "selected": { "style": "s", "palette": {}, "typography": {}, "deck": {} } },
            "library": { "source": "pack", "pack": null, "templateIndexRevision": "r", "warning": "", "pinned": false },
            "tokens": { "t": 1 },
            "creative": { "discipline": { "rules": ["r"], "paletteSlots": [] } },
            "recentCompositions": [1]
        });
        assert_eq!(
            json_stringify(&office_design_digest(&design)),
            concat!(
                r#"{"artDirection":{"applyTokens":false,"selected":{"style":"s"},"candidateCount":3},"#,
                r#""library":{"source":"pack"},"tokens":{"t":1},"creative":{"discipline":{"rules":["r"]}}}"#
            )
        );
    }

    #[test]
    fn preset_writes_that_succeeded_alike_come_back_as_a_count() {
        let raw = json!({
            "semanticOperations": [{ "op": "compose_sheet" }],
            "results": [
                { "op": "set_cell", "changed": true, "cell": "A1", "note": "" },
                { "op": "set_cell", "changed": true, "cell": "A2" },
                { "op": "set_cell", "changed": false, "cell": "A3" },
                { "op": "add_chart", "changed": true, "chart": "c" }
            ]
        });
        assert_eq!(
            run(raw, "batch", None),
            concat!(
                r#"{"semanticOperations":[{"op":"compose_sheet"}],"#,
                r#""results":[{"op":"set_cell","changed":false,"cell":"A3"},{"op":"add_chart","changed":true,"chart":"c"},"#,
                r#"{"applied":{"set_cell":2}}],"metrics":{"durationMs":12.5}}"#
            )
        );
    }

    #[test]
    fn a_trust_read_that_found_nothing_says_only_that() {
        let trust = json!({
            "risk": "low", "complete": true, "policy": "p", "source": "opened", "scanned": 4, "findingCount": 0, "findings": []
        });
        assert_eq!(json_stringify(&trust_digest(&trust)), r#"{"risk":"low","policy":"p"}"#);
        let created = json!({ "risk": "low", "policy": "p", "source": "created-document", "complete": false, "warning": "w" });
        assert_eq!(json_stringify(&trust_digest(&created)), r#"{"risk":"low","complete":false,"warning":"w"}"#);
        let found = json!({ "risk": "high", "findingCount": 1, "scanned": 4 });
        assert_eq!(trust_digest(&found), found);
    }

    #[test]
    fn a_passed_validation_answers_with_its_verdict() {
        let raw = json!({
            "finalized": true,
            "session": "s",
            "validation": {
                "session": "s", "path": "C:/docs/a.xlsx", "format": "xlsx", "entries": 9, "mode": "visible",
                "schema": { "ok": true, "rawValid": true, "version": "x", "omittedErrors": 0, "errors": [] },
                "native": { "ok": true, "opened": true, "documentSaved": false, "snapshot": { "s": 1 }, "issueCount": 0, "issues": [] },
                "security": { "macroExecution": "disabled" },
                "postSaveGate": { "ok": true, "criticalCount": 0 },
                "baseline": { "original": "o", "applicationSaved": true, "addedParts": ["p"], "compared": true, "changed": 2 }
            },
            "review": null, "recalculation": null, "composition": { "count": 0 }, "compositionHistory": null
        });
        let mut held = session("xlsx");
        assert_eq!(
            run(raw, "finalize", Some(&mut held)),
            concat!(
                r#"{"finalized":true,"session":"s","validation":{"mode":"visible","schema":{"ok":true},"#,
                r#""native":{"ok":true,"documentSaved":false},"baseline":{"applicationSaved":true,"changed":2}},"#,
                r#""metrics":{"durationMs":12.5},"#,
                r#""artifacts":[{"type":"spreadsheet","format":"xlsx","fileKind":"xlsx","operation":"edit","path":"C:/docs/a.xlsx"}],"#,
                r#""outputCount":1,"expectedOutputCount":1}"#
            )
        );
    }

    #[test]
    fn the_review_guidance_goes_out_once_per_session() {
        let verdict = || json!({ "ok": true, "review": { "design": { "modelReview": ["a", "b"], "x": 1 } } });
        let mut held = session("pptx");
        let first = run(verdict(), "qa", Some(&mut held));
        assert!(first.contains(r#""modelReview":["a","b"]"#), "{first}");
        let second = run(verdict(), "qa", Some(&mut held));
        assert!(!second.contains("modelReview") && second.contains(r#""x":1"#), "{second}");
    }

    #[test]
    fn a_qa_verdict_drops_what_another_field_carries() {
        let raw = json!({
            "ok": true,
            "issuesBefore": [{ "code": "a" }],
            "issuesAfter": [{ "code": "w", "path": "/p", "message": "m" }],
            "advisoryIssues": [{ "code": "w", "path": "/p", "message": "m" }],
            "preview": { "images": [], "visualCoverage": { "mode": "measure-only" } },
            "review": {
                "images": [1], "output": "o", "quality": { "score": 1 },
                "render": { "pages": [1], "aesthetics": { "confidence": 0.5, "score": 3, "pages": [] } },
                "checklist": {
                    "items": [{ "id": "full-render-coverage", "status": "fail" }, { "id": "k", "status": "pass" }, { "id": "m", "status": "fail" }],
                    "summary": { "total": 3, "failed": 2 }
                }
            }
        });
        assert_eq!(
            run(raw, "qa", None),
            concat!(
                r#"{"ok":true,"issuesAfter":[{"code":"w","path":"/p","message":"m"}],"#,
                r#""preview":{"visualCoverage":{"mode":"measure-only"}},"#,
                r#""review":{"render":{},"checklist":{"items":[{"id":"m","status":"fail"}],"summary":{"total":2,"failed":1}}},"#,
                r#""advisoryCodes":["w"],"metrics":{"durationMs":12.5}}"#
            )
        );
    }

    #[test]
    fn a_delimited_file_carries_no_design_and_a_structural_review() {
        let raw = json!({
            "finalized": true, "design": { "profile": "p" }, "batch": { "design": { "profile": "p" } },
            "review": {
                "ok": true, "issuesAfter": [], "fixes": [], "extra": 1,
                "preview": { "visualCoverage": { "mode": "structural", "gaps": [] }, "images": [] }
            }
        });
        let mut held = session("csv");
        assert_eq!(
            run(raw, "finalize", Some(&mut held)),
            concat!(
                r#"{"finalized":true,"batch":{},"review":{"ok":true,"preview":{"visualCoverage":{"mode":"structural"}}},"#,
                r#""metrics":{"durationMs":12.5},"#,
                r#""artifacts":[{"type":"spreadsheet","format":"csv","fileKind":"csv","operation":"edit","path":"C:/docs/a.csv"}],"#,
                r#""outputCount":1,"expectedOutputCount":1}"#
            )
        );
    }

    #[test]
    fn a_sample_deck_carries_its_disclosure_and_a_secured_pdf_its_artifact() {
        let mut held = ResultSession { facts_mode_sample: true, ..session("pptx") };
        let sampled = run(json!({}), "author", Some(&mut held));
        assert!(sampled.contains(r#""factsMode":"sample","disclosure":"The brief declares facts: sample"#), "{sampled}");
        let secured = run(json!({ "output": "C:/out/s.pdf" }), "secure", None);
        assert!(
            secured.ends_with(
                r#""artifacts":[{"type":"pdf","format":"pdf","fileKind":"pdf","operation":"edit","path":"C:/out/s.pdf"}],"outputCount":1,"expectedOutputCount":1}"#
            ),
            "{secured}"
        );
        assert!(!run(json!({}), "render", None).contains("artifacts"));
    }

    #[test]
    fn a_word_snapshot_drops_what_its_paragraphs_already_say() {
        let document = json!({
            "format": "docx",
            "paragraphs": [
                {
                    "index": 1, "text": "Hello", "runs": [{ "path": "/p", "index": 0, "text": "Hello" }], "start": 0, "end": 5,
                    "pageStart": 1, "pageEnd": 1, "font": { "name": "", "bold": false, "size": 11 }
                },
                { "index": 2, "text": "B", "format": { "alignment": 0, "tabs": [], "leftIndent": 36.0000002 } }
            ],
            "parts": [{ "part": "word/document.xml", "text": "Hello" }, { "part": "word/header1.xml", "text": "H" }],
            "comments": [], "tables": [{ "start": 1, "end": 2, "alignment": 0 }],
            "sections": [{
                "topMargin": 70.9000015258789, "orientation": 1, "columns": 1,
                "stories": [{ "text": "" }, { "text": "a\r\nb", "linkToPrevious": false }]
            }],
            "blockOrder": [
                { "type": "paragraph", "index": 1, "path": "/body/p[1]" },
                { "type": "paragraph", "index": 2, "path": "/body/p[2]" },
                { "type": "table", "index": 1, "path": "/body/tbl[1]" }
            ]
        });
        assert_eq!(
            json_stringify(&office_document_digest(&document)),
            concat!(
                r#"{"format":"docx","paragraphs":[{"index":1,"text":"Hello","pageStart":1,"font":{"size":11}},"#,
                r#"{"index":2,"text":"B","format":{"leftIndent":36}}],"#,
                r#""parts":[{"part":"word/header1.xml","text":"H"}],"tables":[{}],"#,
                r#""sections":[{"topMargin":70.9,"orientation":"landscape","stories":[{"text":"a\nb"}]}],"#,
                r#""blockOrder":["/body/p[1..2]","/body/tbl[1]"]}"#
            )
        );
    }

    #[test]
    fn an_excel_sheet_keeps_only_what_it_reports() {
        let document = json!({
            "format": "xlsx", "defaultStyle": { "fontSize": 11 }, "definedNames": [], "definedNameCount": 0,
            "calculation": { "mode": "", "fullCalcOnLoad": false },
            "sheets": [{
                "name": "S", "visibility": "visible", "tableCount": 0, "cellCount": 0, "charts": [], "note": null,
                "protection": { "sheet": false }, "freezePanes": { "frozen": false },
                "pageSetup": { "orientation": "", "zoom": 100, "paperSize": 9 },
                "cells": [{ "ref": "A1", "value": 1, "formula": "", "style": { "bold": false, "fontSize": 11, "numberFormat": "0.0" } }],
                "formulaLineage": [{
                    "from": "/sheet[S]/cell[B2]",
                    "precedents": [{ "sheet": "S", "ref": "A1" }, { "sheet": "T", "ref": "C3" }]
                }],
                "lineageCount": 1
            }]
        });
        assert_eq!(
            json_stringify(&office_document_digest(&document)),
            concat!(
                r#"{"format":"xlsx","defaultStyle":{"fontSize":11},"sheets":[{"name":"S","cellCount":0,"pageSetup":{"paperSize":9},"#,
                r#""cells":[{"ref":"A1","value":1,"style":{"numberFormat":"0.0"}}],"#,
                r#""formulaLineage":[{"cell":"B2","precedents":["A1","T!C3"]}]}]}"#
            )
        );
    }

    #[test]
    fn a_pdf_read_drops_empty_families_and_rounds_coordinates() {
        let document = json!({
            "format": "pdf", "pageCount": 0, "attachmentCount": 0, "attachments": [], "encrypted": false, "passwordRequired": false,
            "metadata": { "title": "", "author": "A" }, "pagination": { "hasMore": false, "offset": 0 },
            "pages": [{ "number": 1, "width": 595.27559, "height": 841.8899, "rotation": 0 }],
            "fields": [{ "name": "f", "readOnly": false, "value": false, "widgets": [{ "x": 1.23456, "page": 2 }] }]
        });
        assert_eq!(
            json_stringify(&office_document_digest(&document)),
            concat!(
                r#"{"format":"pdf","pageCount":0,"passwordRequired":false,"metadata":{"author":"A"},"#,
                r#""pages":[{"number":1,"width":595.28,"height":841.89}],"#,
                r#""fields":[{"name":"f","value":false,"widgets":[{"x":1.23,"page":2}]}]}"#
            )
        );
    }

    #[test]
    fn a_powerpoint_com_shape_loses_its_defaults() {
        let document = json!({
            "format": "pptx",
            "layouts": [{ "index": null, "name": "Title", "part": "p" }, { "index": 7, "part": "q" }],
            "slides": [{
                "index": 1, "hidden": false, "notes": "", "comments": [], "transition": { "effect": 0, "advanceOnTime": false },
                "shapes": [{
                    "type": 1, "left": 10.123456, "rotation": 0, "geometry": "", "text": "Hi", "mixed": -2147483648, "nothing": null,
                    "textFrame": { "marginLeft": 7.2, "marginTop": 3.6, "wordWrap": true },
                    "font": { "name": "Arial", "size": 18, "bold": 0, "color": "FF0000" },
                    "runs": { "sizes": [18], "colors": [255] },
                    "shadow": { "visible": false }, "fillVisible": false, "fillColor": 1,
                    "chart": { "chartType": 51, "series": [{ "name": "s", "axisGroup": 1, "formula": "", "chartType": 4 }] }
                }],
                "animations": []
            }]
        });
        assert_eq!(
            json_stringify(&office_document_digest(&document)),
            concat!(
                r#"{"format":"pptx","layouts":[{"index":1,"name":"Title"},{"index":7}],"#,
                r#""slides":[{"index":1,"notes":"","shapes":[{"type":1,"left":10.12,"text":"Hi","textFrame":{"wordWrap":true},"#,
                r#""font":{"name":"Arial","size":18,"color":"FF0000"},"#,
                r#""chart":{"chartType":"column","series":[{"name":"s","chartType":"line"}]}}]}]}"#
            )
        );
    }

    #[test]
    fn a_delimited_file_cell_drops_its_row_and_column() {
        let document = json!({ "format": "csv", "sheets": [{ "cells": [{ "ref": "B2", "row": 2, "column": 2, "value": "x" }] }] });
        assert_eq!(
            json_stringify(&office_document_digest(&document)),
            r#"{"format":"csv","sheets":[{"cells":[{"ref":"B2","value":"x"}]}]}"#
        );
    }
}
