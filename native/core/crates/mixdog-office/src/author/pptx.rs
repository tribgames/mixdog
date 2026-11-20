//! `authoring/pptx-author-action.mjs`: the `author` action for a `.pptx` target.
//!
//! The source is HTML (it opens with markup) or a pptxgenjs script; with neither the deck is built again from
//! `<deck>.pptx.mixdog-source.html`, so a fix is an edit to that file and not the whole deck sent again. The deck is written
//! into a staging path on the target's filesystem and the gates read it there: the HTML's own geometry, the figures against
//! the fact sheet and the pages against the plan that was written before them. It lands over the target only when they hold,
//! and is then opened as a session, measured by the inline audit, rendered, and for an HTML deck held against the browser's
//! own picture of the same page.
//!
//! The design guide lives in the built-in `pptx` skill; the action never serves it, so one copy stays authoritative and
//! user-overridable.

use std::path::{Path, PathBuf};

use mixdog_js::value_to_string;
use mixdog_office_author::brief::{facts_gate, html_brief_script, parse_authoring_brief, plan_gate};
use mixdog_office_author::html_browser::RunError;
use mixdog_office_author::pptx_html_runner::html_artifacts;
use mixdog_office_base::formats::document_format;
use mixdog_office_base::values::truthy;
use mixdog_rt::CancellationToken;
use serde_json::{Map, Value, json};

use super::pptx_session::{
    AuthorError, land_staged_deck, release_existing_session, release_staging_target, reusable_authored_session, staging_target, swap_authored_document,
    throw_if_authoring_cancelled,
};
use super::{
    AuthorCall, AuthorHost, flag_is, mark_authored_from_html, opens_with_markup, pick, render_args, replaced_edits_of, requested_path, script_of, script_source,
};
use crate::session::SessionHandle;
use crate::session::mode::validate_author_mode;
use crate::session::registry::lock;
use crate::session::working_copy::full_path;

/// The reply to a bare author call, before the skill is read.
pub const PPTX_AUTHOR_NEEDS_SOURCE: &str = "author requires script: HTML slides or a pptxgenjs script (without one it re-authors from <deck>.pptx.mixdog-source.html, and none is there). Load the `pptx` Skill first (Skill name:\"pptx\"): it carries the authoring workflow, the HTML contract, the composition grammar, and the device kit, then call author again with path and script.";

const UNRENDERED_NEXT_ACTION: &str = "Written and measured clean, not visually reviewed: call action:render on this session for the page images, contact sheet, receipt, and reviewToken, then inspect every slide before finalizing. action:qa render:false adds the design read (theme, plan promises, facts) without pixels. Re-author only if the script changes.";

const RENDERED_NEXT_ACTION: &str = "Inspect every rendered slide for message visibility, relevant evidence, legibility, and grouping; then read the sequence for coherence (the contact sheet image, attached past four slides). Use the receipt to investigate possible defects, not to require an inventory of charts, pictures, or shapes. Change the script only for an observed problem, or finalize with design: { reviewed: true, reviewToken, critique: [one entry per slide] }.";

/// What the gates made of the staged deck (`gateStagedDeck`).
pub enum Gate {
    /// Nothing refuses the deck. The snapshot rides on a pass so a caller can read the same deck further (a PDF's design
    /// read); it is absent when the reader could not open the package or the brief names nothing.
    Open { document: Option<Value> },
    /// The facts gate or the plan gate refused: the gate's own answer and which one.
    Blocked { gate: &'static str, answer: Value },
}

/// `gateStagedDeck(path, brief)`: the staged deck read with the portable reader whatever backend will hold it; a package the
/// reader cannot open is left to qa, never turned into a refusal. One snapshot answers both: the figures against the fact
/// sheet, then the pages against the plan.
pub async fn gate_staged_deck<H: AuthorHost>(host: &H, path: &Path, brief: &Value) -> Gate {
    if brief.get("present") != Some(&Value::Bool(true)) {
        return Gate::Open { document: None };
    }
    let Ok(document) = host.snapshot_deck(path).await else { return Gate::Open { document: None } };
    let facts = facts_gate(&document, brief);
    if facts.get("blocked") == Some(&Value::Bool(true)) {
        return Gate::Blocked { gate: "facts", answer: facts };
    }
    let plan = plan_gate(&document, brief);
    if plan.get("blocked") == Some(&Value::Bool(true)) {
        return Gate::Blocked { gate: "plan", answer: plan };
    }
    Gate::Open { document: Some(document) }
}

fn describe_plan_slide(entry: &Value) -> String {
    let slide = value_to_string(entry.get("slide").unwrap_or(&Value::Null));
    if let Some(carrier) = entry.get("carrier").filter(|carrier| truthy(carrier)) {
        return format!("slide {slide}: {} ({})", value_to_string(carrier), value_to_string(entry.get("label").unwrap_or(&Value::Null)));
    }
    if let Some(Value::Array(missing)) = entry.get("missing").filter(|missing| truthy(missing)) {
        return format!("slide {slide}: {}", missing.iter().map(value_to_string).collect::<Vec<_>>().join(", "));
    }
    format!("slide {slide}")
}

fn result_object(entries: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key.to_owned(), value);
    }
    Value::Object(map)
}

/// `planGateResult(target, gate, run)`.
pub fn plan_gate_result(target: &str, gate: &Value, run: &Value) -> Value {
    let slides = gate.get("slides").and_then(Value::as_array).cloned().unwrap_or_default();
    let listed = slides.iter().map(describe_plan_slide).collect::<Vec<_>>().join("; ");
    let code = gate.get("code").and_then(Value::as_str).unwrap_or_default();
    let next_action = match code {
        "plan_missing" => "The deck holds more than one slide but the brief has no `// slide plan:` line, so nothing landed. Write one line per slide — `1 job: cover · move: <what the reader now holds> · composition: <the page move> · carriers: statement` — then call author again.".to_owned(),
        "plan_slide_unplanned" => format!("Slides the plan does not cover ({listed}), so nothing landed. Give every slide its plan line, or drop the slides the plan does not want; then call author again."),
        "plan_incomplete" => format!("Plan lines that name no job or carriers ({listed}), so nothing landed. Every line says what the page does and what carries it; then call author again."),
        "plan_promise_missing" => format!("Slides that do not carry what their own plan line named ({listed}), so nothing landed. Draw the carrier the line promises, or change the line to what the page actually carries; then call author again."),
        _ => String::new(),
    };
    let mut entries = vec![
        ("ok", json!(false)),
        ("reason", json!("plan_gate")),
        ("output", json!(target)),
        ("gate", json!({ "code": gate.get("code").cloned().unwrap_or(Value::Null), "slides": gate.get("slides").cloned().unwrap_or(Value::Null) })),
        ("logs", run.get("logs").cloned().unwrap_or(Value::Null)),
        ("elapsedMs", run.get("elapsedMs").cloned().unwrap_or(Value::Null)),
    ];
    // `undefined` is left out of the JSON: a code the table does not know has no next action.
    if !next_action.is_empty() {
        entries.push(("nextAction", Value::String(next_action)));
    }
    strip_undefined(result_object(entries), run)
}

/// `factsGateResult(target, brief, gate, run)`.
pub fn facts_gate_result(target: &str, brief: &Value, gate: &Value, run: &Value) -> Value {
    let slides = gate.get("slides").and_then(Value::as_array).cloned().unwrap_or_default();
    let listed = slides
        .iter()
        .map(|entry| {
            let figures = entry
                .get("figures")
                .and_then(Value::as_array)
                .map(|figures| figures.iter().map(value_to_string).collect::<Vec<_>>().join(", "))
                .unwrap_or_default();
            format!("slide {}: {figures}", value_to_string(entry.get("slide").unwrap_or(&Value::Null)))
        })
        .collect::<Vec<_>>()
        .join("; ");
    let missing = gate.get("code").and_then(Value::as_str) == Some("facts_missing");
    let next_action = if missing {
        format!(
            "The deck shows figures ({listed}) but the brief has no facts line, so nothing landed. Add `// facts: F1 <value> — <source> · …` for every figure the slides show, or declare `// facts: sample — <why no source>` to mark every figure illustrative; then call author again."
        )
    } else {
        format!(
            "Figures with no fact behind them ({listed}), so nothing landed. Add each to the brief facts line with its source, remove it from the slide, or declare `// facts: sample — <why>`; then call author again."
        )
    };
    let facts = brief.get("facts").and_then(Value::as_array).map_or(0, Vec::len);
    let entries = vec![
        ("ok", json!(false)),
        ("reason", json!("facts_gate")),
        ("output", json!(target)),
        (
            "gate",
            json!({ "code": gate.get("code").cloned().unwrap_or(Value::Null), "slides": gate.get("slides").cloned().unwrap_or(Value::Null), "facts": facts }),
        ),
        ("logs", run.get("logs").cloned().unwrap_or(Value::Null)),
        ("elapsedMs", run.get("elapsedMs").cloned().unwrap_or(Value::Null)),
        ("nextAction", Value::String(next_action)),
    ];
    strip_undefined(result_object(entries), run)
}

/// `JSON.stringify` leaves out a key whose value is `undefined`: the run carries `logs` only for a run that wrote some (a
/// frame's HTML run has none for a failed parse), so a key the run did not carry is not in the answer either.
fn strip_undefined(mut result: Value, run: &Value) -> Value {
    if let Value::Object(map) = &mut result {
        for key in ["error", "logs", "elapsedMs"] {
            if run.get(key).is_none() {
                map.shift_remove(key);
            }
        }
    }
    result
}

/// `geometryGateResult(target, run)`: the HTML's own geometry, read in the browser before anything lands: a declared relation
/// that does not hold, or a near miss no declaration covers.
pub fn geometry_gate_result(target: &str, run: &Value) -> Value {
    let pages = run.get("geometry").and_then(Value::as_array).cloned().unwrap_or_default();
    let listed = pages
        .iter()
        .map(|page| {
            let findings = page
                .get("findings")
                .and_then(Value::as_array)
                .map(|findings| findings.iter().map(|finding| value_to_string(finding.get("message").unwrap_or(&Value::Null))).collect::<Vec<_>>().join("; "))
                .unwrap_or_default();
            format!("slide {}: {findings}", value_to_string(page.get("slide").unwrap_or(&Value::Null)))
        })
        .collect::<Vec<_>>()
        .join(" | ");
    let entries = vec![
        ("ok", json!(false)),
        ("reason", json!("geometry_gate")),
        ("output", json!(target)),
        ("gate", json!({ "code": "geometry", "slides": run.get("geometry").cloned().unwrap_or(Value::Null) })),
        ("logs", run.get("logs").cloned().unwrap_or(Value::Null)),
        ("elapsedMs", run.get("elapsedMs").cloned().unwrap_or(Value::Null)),
        (
            "nextAction",
            Value::String(format!(
                "The pages' geometry does not hold ({listed}), so nothing landed. Compute related positions from one source (flex or grid, calc() on shared custom properties, related shapes in one SVG) and declare the relation (data-on, data-inside, data-between, data-align, data-label); mark an offset that is deliberate data-free. Then call author again."
            )),
        ),
    ];
    strip_undefined(result_object(entries), run)
}

fn script_failed_result(target: &str, run: &Value, html: bool) -> Value {
    let entries = vec![
        ("ok", json!(false)),
        ("reason", json!(if html { "html_failed" } else { "script_failed" })),
        ("output", json!(target)),
        ("error", run.get("error").cloned().unwrap_or(Value::Null)),
        ("logs", run.get("logs").cloned().unwrap_or(Value::Null)),
        ("elapsedMs", run.get("elapsedMs").cloned().unwrap_or(Value::Null)),
        (
            "nextAction",
            json!(if html { "Fix the HTML the error names and call author again." } else { "Fix the script at the reported line and call author again." }),
        ),
    ];
    strip_undefined(result_object(entries), run)
}

/// `resolveAuthorTarget(args, cwd)`: the absolute target and the validated mode. A bare author (no path, no script) is a call
/// made before reading the skill: it is pointed there.
fn resolve_author_target(args: &Value, cwd: &str) -> Result<(String, String), AuthorError> {
    let requested = requested_path(args);
    if requested.is_empty() {
        return Err(AuthorError::Failed(if script_of(args).is_empty() { PPTX_AUTHOR_NEEDS_SOURCE.to_owned() } else { "author requires path".to_owned() }));
    }
    let target = full_path(&requested, cwd)?;
    if document_format(&target)? != "pptx" {
        return Err("author writes .pptx and .pdf targets only".into());
    }
    let mode = validate_author_mode(args.get("mode"))?;
    Ok((target, mode))
}

/// What a landed deck is held by.
struct Landed {
    session: Option<SessionHandle>,
    reused_session: bool,
    replaced_session: Option<String>,
}

/// `landAuthoredDeck`: a reusable session swaps its document in place; otherwise the existing session is released before the
/// file moves.
async fn land_authored_deck<H: AuthorHost>(
    host: &H,
    reusable: Option<&SessionHandle>,
    staging: &Path,
    target: &Path,
    signal: Option<&CancellationToken>,
) -> Result<Landed, AuthorError> {
    let target_text = target.to_string_lossy().into_owned();
    if let Some(reusable) = reusable {
        let opened_at = host.now_iso();
        let swapped = swap_authored_document(reusable, staging, signal, &opened_at, |request| async move { host.office_call(&request, signal).await }).await?;
        if swapped {
            return Ok(Landed { session: Some(reusable.clone()), reused_session: true, replaced_session: None });
        }
        release_existing_session(host, &target_text, signal).await?;
        land_staged_deck(host, staging, target, signal).await?;
        return Ok(Landed { session: None, reused_session: false, replaced_session: None });
    }
    let replaced_session = release_existing_session(host, &target_text, signal).await?;
    land_staged_deck(host, staging, target, signal).await?;
    Ok(Landed { session: None, reused_session: false, replaced_session })
}

/// The result of a run that landed (`authoredResult`).
fn authored_result(handle: &SessionHandle, target: &str, run: &Value, landed: &Landed, audit: Option<&Value>) -> Map<String, Value> {
    let session = lock(handle);
    let mut result = Map::new();
    result.insert("ok".into(), json!(true));
    result.insert("session".into(), json!(session.id));
    result.insert("mode".into(), json!(session.mode.as_str()));
    result.insert("backend".into(), json!(session.backend.as_str()));
    result.insert("output".into(), json!(target));
    for key in ["bytes", "elapsedMs", "logs", "kit"] {
        if let Some(value) = run.get(key) {
            result.insert(key.to_owned(), value.clone());
        }
    }
    for key in ["htmlSource", "normalizedParagraphs", "nativeGradients", "vectorIcons"] {
        if let Some(value) = run.get(key).filter(|value| truthy(value)) {
            result.insert(key.to_owned(), value.clone());
        }
    }
    if let Some(replaced) = &landed.replaced_session {
        result.insert("replacedSession".into(), json!(replaced));
    }
    if landed.reused_session {
        result.insert("reusedSession".into(), json!(true));
    }
    if let Some(audit) = audit {
        result.insert("audit".into(), audit.clone());
    }
    result
}

/// The next step the audit gates: its own when it failed, the call's otherwise.
fn audit_failed(audit: Option<&Value>) -> bool {
    audit.and_then(|audit| audit.get("status")).and_then(Value::as_str) == Some("fail")
}

fn audit_next_action(audit: Option<&Value>) -> String {
    audit.and_then(|audit| audit.get("nextAction")).map(value_to_string).unwrap_or_default()
}

/// The render of the landed deck onto the result: page images, review token and receipt, with the next step gated on the
/// inline audit.
async fn render_authored_deck<H: AuthorHost>(
    host: &H,
    handle: &SessionHandle,
    args: &Value,
    cwd: &str,
    result: &mut Map<String, Value>,
    audit: Option<&Value>,
) -> Result<(), AuthorError> {
    let rendered = host.render(handle, &render_args(args), Path::new(cwd)).await?;
    result.insert("render".into(), Value::Object(pick(&rendered, &["output", "pageCount", "visualCoverage", "images", "reviewToken", "contactSheet"])));
    let images = match rendered.get("_images") {
        Some(Value::Array(images)) => Value::Array(images.clone()),
        _ => json!([]),
    };
    result.insert("_images".into(), images);
    if let Some(receipt) = rendered.get("receipt").filter(|receipt| truthy(receipt)) {
        result.insert("receipt".into(), receipt.clone());
    }
    let next = if audit_failed(audit) {
        format!("{} The rendered pages are attached; the visual read starts once the audit passes.", audit_next_action(audit))
    } else {
        RENDERED_NEXT_ACTION.to_owned()
    };
    result.insert("nextAction".into(), Value::String(next));
    Ok(())
}

/// What an HTML deck's render adds: the comparison images and the drift of the render against the HTML.
async fn compare_with_html<H: AuthorHost>(host: &H, target: &str, run: &Value, result: &mut Map<String, Value>) -> Result<(), AuthorError> {
    let images: Vec<Value> = result.get("render").and_then(|render| render.get("images")).and_then(Value::as_array).cloned().unwrap_or_default();
    let shots = run.get("htmlShots").cloned().unwrap_or(Value::Null);
    let compare = host.write_html_comparisons(Path::new(target), &shots, &images).await?;
    let drift = host.measure_html_drift(&shots, run.get("htmlText").unwrap_or(&Value::Null), &images).await?;
    let moved: Vec<String> = drift
        .get("pages")
        .and_then(Value::as_array)
        .map(|pages| {
            pages
                .iter()
                .map(|entry| {
                    let items = entry.get("items").and_then(Value::as_array).map(|items| {
                        items
                            .iter()
                            .map(|item| {
                                format!(
                                    "\"{}\" dy {} dx {}",
                                    value_to_string(item.get("text").unwrap_or(&Value::Null)),
                                    value_to_string(item.get("dy").unwrap_or(&Value::Null)),
                                    value_to_string(item.get("dx").unwrap_or(&Value::Null))
                                )
                            })
                            .collect::<Vec<_>>()
                            .join(", ")
                    });
                    format!("slide {}: {}", value_to_string(entry.get("page").unwrap_or(&Value::Null)), items.unwrap_or_default())
                })
                .collect()
        })
        .unwrap_or_default();
    let threshold = drift.get("threshold").map(value_to_string).unwrap_or_default();
    let drifted = if moved.is_empty() {
        String::new()
    } else {
        format!(
            " html_render_drift: text PowerPoint drew more than {threshold}px from where the HTML put it ({}); open those pages' compare pairs and fix the HTML or report the residue.",
            moved.join("; ")
        )
    };
    let unread = match drift.get("unreadPages").and_then(Value::as_array).filter(|pages| !pages.is_empty()) {
        Some(pages) => format!(
            " Pages {} were rendered in shared images, so their drift was not read; render them in batches of 12 or fewer to read it.",
            pages.iter().map(value_to_string).collect::<Vec<_>>().join(", ")
        ),
        None => String::new(),
    };
    if let Some(Value::Object(render)) = result.get_mut("render") {
        render.insert("compare".into(), Value::Array(compare));
        render.insert("drift".into(), drift);
    }
    let previous = result.get("nextAction").map(value_to_string).unwrap_or_default();
    result.insert(
        "nextAction".into(),
        Value::String(format!("{previous} render.compare holds one image per page, the HTML (left) beside the PPTX render (right): open a page's pair when its render differs from what the HTML drew.{drifted}{unread}")),
    );
    Ok(())
}

async fn finish_authored_deck<H: AuthorHost>(
    host: &H,
    handle: &SessionHandle,
    args: &Value,
    call: &AuthorCall<'_>,
    target: &str,
    run: &Value,
    landed: &Landed,
) -> Result<Value, AuthorError> {
    let audit = if flag_is(args, "audit", false) { None } else { host.inline_audit(handle, &[]).await };
    let mut result = authored_result(handle, target, run, landed, audit.as_ref());
    if flag_is(args, "render", false) {
        if let Some(receipt) = host.read_composition_receipt(handle).await {
            result.insert("receipt".into(), host.receipt_for_delivery(handle, &receipt));
        }
        let next = if audit_failed(audit.as_ref()) { audit_next_action(audit.as_ref()) } else { UNRENDERED_NEXT_ACTION.to_owned() };
        result.insert("nextAction".into(), Value::String(next));
        return Ok(Value::Object(result));
    }
    lock(handle).active_signal = call.signal.cloned();
    let rendered = render_authored_deck(host, handle, args, call.cwd, &mut result, audit.as_ref()).await;
    lock(handle).active_signal = None;
    rendered?;
    let has_shots = run.get("htmlShots").and_then(Value::as_array).is_some_and(|shots| !shots.is_empty());
    let has_images = result.get("render").and_then(|render| render.get("images")).and_then(Value::as_array).is_some_and(|images| !images.is_empty());
    if has_shots && has_images {
        compare_with_html(host, target, run, &mut result).await?;
    }
    Ok(Value::Object(result))
}

/// The session the target already has, if any: a reusable authored session swaps its deck; an existing session hands its audit
/// rounds on. A re-author replaces the session, but the audit fix rounds belong to the deck: the loop keeps counting across
/// passes on the same path.
async fn authoring_session_state<H: AuthorHost>(
    host: &H,
    target: &str,
    mode: &str,
    args: &Value,
    from_source: bool,
) -> Result<(Option<SessionHandle>, Option<Value>), AuthorError> {
    let reusable = reusable_authored_session(host, target, mode);
    let existing = host.session_for_document(target);
    if reusable.is_none() && existing.is_none() && !from_source && host.exists(Path::new(target)).await && !flag_is(args, "overwrite", true) {
        return Err(AuthorError::Failed(format!("author target already exists: {target}; pass overwrite:true to replace it")));
    }
    let prior_audit = match (&reusable, &existing) {
        (None, Some(existing)) => lock(existing).caches.inline_audit.clone().filter(truthy),
        _ => None,
    };
    Ok((reusable, prior_audit))
}

/// What staging and landing ended with.
enum Staged {
    /// A gate or the run refused: the answer to return, nothing landed.
    Refused(Value),
    Landed {
        run: Value,
        landed: Landed,
    },
}

#[allow(clippy::too_many_arguments)]
async fn stage_and_land<H: AuthorHost>(
    host: &H,
    call: &AuthorCall<'_>,
    args: &Value,
    script: &str,
    html: bool,
    brief: &Value,
    mode: &str,
    target: &str,
    staging: &Path,
    reusable: Option<&SessionHandle>,
    keep_staging: &mut bool,
) -> Result<Staged, AuthorError> {
    let signal = call.signal;
    throw_if_authoring_cancelled(signal, None)?;
    let target_path = Path::new(target);
    let run = if html {
        match host.run_pptx_html(script, staging, target_path, signal, false).await {
            Ok(run) => run,
            Err(RunError::Cancelled) => return Err(AuthorError::Abort("Office authoring was cancelled".to_owned())),
            Err(RunError::Failed(message)) => return Err(AuthorError::Failed(message)),
        }
    } else {
        host.run_pptx_script(script, staging, target_path.parent().unwrap_or_else(|| Path::new(""))).await?
    };
    throw_if_authoring_cancelled(signal, None)?;
    if run.get("ok") != Some(&Value::Bool(true)) {
        return Ok(Staged::Refused(script_failed_result(target, &run, html)));
    }
    if run.get("geometry").and_then(Value::as_array).is_some_and(|pages| !pages.is_empty()) {
        return Ok(Staged::Refused(geometry_gate_result(target, &run)));
    }
    // The gates read the staged deck before anything lands: a figure with no fact behind it, and a page that does not carry
    // what its plan line named, are refused here, not reported once the deck is open.
    if let Gate::Blocked { gate, answer } = gate_staged_deck(host, staging, brief).await {
        let refused = if gate == "plan" { plan_gate_result(target, &answer, &run) } else { facts_gate_result(target, brief, &answer, &run) };
        return Ok(Staged::Refused(refused));
    }
    // Keep the valid staged deck recoverable if replacement fails for a non-cancellation reason.
    *keep_staging = true;
    let mut landed = land_authored_deck(host, reusable, staging, target_path, signal).await?;
    throw_if_authoring_cancelled(signal, None)?;
    if landed.session.is_none() {
        let mut session_args = args.clone();
        if let Value::Object(fields) = &mut session_args {
            fields.insert("mode".into(), Value::String(mode.to_owned()));
        }
        landed.session = Some(host.create_authored_session(&session_args, target, signal).await?);
    }
    *keep_staging = false;
    Ok(Staged::Landed { run, landed })
}

/// The `author` action for a `.pptx` target (`authorPptx`).
pub async fn author_pptx<H: AuthorHost>(host: &H, args: &Value, call: &AuthorCall<'_>) -> Result<Value, AuthorError> {
    let (target, mode) = resolve_author_target(args, call.cwd)?;
    // Without a script the deck is authored again from the HTML kept beside it, as a PDF or Word document is: a fix is an edit
    // to that file, not the whole deck sent again.
    let source_path = html_artifacts(Path::new(&target)).source();
    let from_source = script_of(args).is_empty();
    if from_source && !host.exists(&source_path).await {
        return Err(AuthorError::Failed(PPTX_AUTHOR_NEEDS_SOURCE.to_owned()));
    }
    let script = if from_source { host.read_text(&source_path).await? } else { script_source(args) };
    throw_if_authoring_cancelled(call.signal, None)?;
    let replaced_edits = replaced_edits_of(host.session_for_document(&target).as_ref());
    let (reusable, prior_audit) = authoring_session_state(host, &target, &mode, args, from_source).await?;
    // The script always writes beside the target: a failed script or a refused deck leaves the file on disk and the session
    // holding the previous deck untouched.
    let staging: PathBuf = staging_target(host, Path::new(&target)).await?;
    let html = opens_with_markup(&script);
    let brief = parse_authoring_brief(&if html { html_brief_script(&script) } else { script.clone() });
    let mut keep_staging = false;
    let outcome = stage_and_land(host, call, args, &script, html, &brief, &mode, &target, &staging, reusable.as_ref(), &mut keep_staging).await;
    // A refused or cancelled call discards the stage; a failed replacement that is not a cancellation leaves the valid deck
    // recoverable.
    let keep = keep_staging && !call.signal.is_some_and(CancellationToken::is_cancelled) && matches!(&outcome, Err(error) if !error.is_abort());
    if !keep {
        release_staging_target(host, &staging).await;
    }
    let (run, landed) = match outcome? {
        Staged::Refused(answer) => return Ok(answer),
        Staged::Landed { run, landed } => (run, landed),
    };
    let handle = landed.session.clone().ok_or_else(|| AuthorError::Failed("the authored session was not opened".to_owned()))?;
    lock(&handle).authored.brief = Some(brief);
    // A deck from HTML counts the batch edits that land past its kept source; a pptxgenjs deck keeps no source.
    mark_authored_from_html(&handle, run.get("htmlSource").and_then(Value::as_str).unwrap_or(""));
    if let Some(prior) = prior_audit {
        let mut session = lock(&handle);
        if session.caches.inline_audit.is_none() {
            session.caches.inline_audit = Some(prior);
        }
    }
    let mut result = finish_authored_deck(host, &handle, args, call, &target, &run, &landed).await?;
    if let (Some(edits), Value::Object(fields)) = (replaced_edits, &mut result) {
        fields.insert("replacedEdits".into(), edits);
    }
    Ok(result)
}
