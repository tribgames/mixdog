//! `authoring/pdf-author-action.mjs`: the `author` action for a `.pdf` target. An HTML document printed by the shared browser,
//! landed over the target only once it printed and passed its checks, then opened as a created PDF for review.
//!
//! Two kinds of document. A flowing one (running text the browser paginates) is checked for what print would cut. Designed
//! pages (one `<section class="slide">` per sheet) go through the deck's own frame first: the same browser measure, geometry
//! gate, facts and plan gates, measured audit and composition receipt the pptx route runs, on a working deck built at the
//! sheet's size and discarded once read; then the browser prints the HTML itself, and finalize asks for the deck's scored
//! critique.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use mixdog_js::{JsRegex, json_number, to_number_of, value_to_string};
use mixdog_office_author::brief::{facts_gate, html_brief_script, parse_authoring_brief, review_brief_promises, review_source_grounding};
use mixdog_office_author::html_browser::RunError;
use mixdog_office_author::pdf_print::pdf_html_source_path;
use mixdog_office_author::pptx_html_runner::has_slide_sections;
use serde_json::{Map, Value, json};

use super::pptx::{Gate, facts_gate_result, gate_staged_deck, geometry_gate_result, plan_gate_result};
use super::pptx_session::{AuthorError, land_staged_deck, release_existing_session, release_staging_target, staging_target, throw_if_authoring_cancelled};
use super::{AuthorCall, AuthorHost, flag_is, mark_authored_from_html, opens_with_markup, pick, render_args, replaced_edits_of, requested_path, script_of, script_source};
use crate::session::SessionHandle;
use crate::session::registry::lock;
use crate::session::working_copy::full_path;

pub const PDF_AUTHOR_NEEDS_SOURCE: &str = "author requires script: an HTML document for a PDF (without one it re-authors from <file>.pdf.mixdog-source.html, and none is there). Load the `pdf` Skill first (Skill name:\"pdf\"): it carries the page contract (@page size and margins, page breaks, fonts), then call author again with path and script.";

const RENDERED_NEXT_ACTION: &str = "Inspect every rendered page for reading order, page breaks (a heading left at a page foot, a table or figure split), clipping, and legibility; fix the HTML and author again for any defect, or finalize with design: { reviewed: true, reviewToken, critique: [one entry per page] }.";

const UNRENDERED_NEXT_ACTION: &str = "Printed and laid out clean, not visually reviewed: call action:render on this session for the page images and reviewToken, then inspect every page before finalizing.";

const FRAME_RENDERED_NEXT_ACTION: &str = "Inspect every rendered page for message visibility, relevant evidence, legibility, and grouping, then read the sequence for coherence; use the receipt to investigate possible defects. Change the HTML only for an observed problem, or finalize with design: { reviewed: true, reviewToken, critique: [one entry per page with page, verdict, hierarchy, balance, legibility, cohesion, evidence, note, fixes, checks] }.";

const FRAME_UNRENDERED_NEXT_ACTION: &str = "Printed, gated, and measured clean, not visually reviewed: call action:render on this session for the page images and reviewToken, then inspect every page before finalizing with the scored critique.";

/// The browser that prints set every line of the PDF; the working deck's PowerPoint text metrics (fit, clipping, box width)
/// describe a renderer the reader never sees.
const BROWSER_SET_TEXT: [&str; 3] = ["text_overflow", "text_clipped", "text_box_too_narrow"];

/// A page counter (`3 / 12`) on a line of its own: chrome, not a figure.
static PAGE_COUNTER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(^|\n)\s*\d+\s*/\s*\d+\s*(?=\n|$)", "g"));

/// What the deck's frame read of designed pages.
struct Framed {
    run: Value,
    audit: Option<Value>,
    receipt: Option<Value>,
    design_issues: Vec<Value>,
    rounds: Option<Value>,
}

/// The frame's answer: a gate or the run refused (`refused`), or the reading that rides on to the printed PDF.
enum Frame {
    Refused(Value),
    Read(Box<Framed>),
}

fn html_failed_result(target: &str, error: Option<&Value>, elapsed: Option<&Value>) -> Value {
    let mut result = Map::new();
    result.insert("ok".into(), json!(false));
    result.insert("reason".into(), json!("html_failed"));
    result.insert("output".into(), json!(target));
    if let Some(error) = error {
        result.insert("error".into(), error.clone());
    }
    if let Some(elapsed) = elapsed {
        result.insert("elapsedMs".into(), elapsed.clone());
    }
    result.insert("nextAction".into(), json!("Fix the HTML the error names and call author again."));
    Value::Object(result)
}

/// Designed pages through the deck's frame: measured on the sheet, gated, audited, and read into a receipt. A gate that holds
/// is the answer to return; otherwise the audit and receipt ride on to the printed PDF.
async fn frame_designed_pages_in<H: AuthorHost>(host: &H, html: &str, target: &str, deck: &Path, brief: &Value, args: &Value, call: &AuthorCall<'_>, prior_audit: Option<Value>) -> Result<Frame, AuthorError> {
    let run = match host.run_pptx_html(html, deck, Path::new(target), call.signal, true).await {
        Ok(run) => run,
        Err(RunError::Cancelled) => return Err(AuthorError::Abort("Office authoring was cancelled".to_owned())),
        Err(RunError::Failed(message)) => return Err(AuthorError::Failed(message)),
    };
    throw_if_authoring_cancelled(call.signal, None)?;
    if run.get("ok") != Some(&Value::Bool(true)) {
        return Ok(Frame::Refused(html_failed_result(target, run.get("error"), run.get("elapsedMs"))));
    }
    if run.get("geometry").and_then(Value::as_array).is_some_and(|pages| !pages.is_empty()) {
        return Ok(Frame::Refused(geometry_gate_result(target, &run)));
    }
    let document = match gate_staged_deck(host, deck, brief).await {
        Gate::Blocked { gate, answer } => {
            let refused = if gate == "plan" { plan_gate_result(target, &answer, &run) } else { facts_gate_result(target, brief, &answer, &run) };
            return Ok(Frame::Refused(refused));
        }
        Gate::Open { document } => document,
    };
    let shadow = host.create_authored_session(&json!({ "mode": "portable" }), &deck.to_string_lossy(), None).await?;
    {
        let mut session = lock(&shadow);
        session.authored.brief = Some(brief.clone());
        // The working deck's pages are paper: its audit holds them to the print type floors.
        session.authored.print_sheet = true;
        if let Some(prior) = prior_audit {
            session.caches.inline_audit = Some(prior);
        }
    }
    let exclude: Vec<String> = BROWSER_SET_TEXT.iter().map(|code| (*code).to_owned()).collect();
    let audit = if flag_is(args, "audit", false) { None } else { host.inline_audit(&shadow, &exclude).await };
    let receipt = host.read_composition_receipt(&shadow).await;
    // The deck's design read against the brief, kept for the PDF's qa: the plan's page count and the facts' locators (the
    // refusing readings already ran as gates).
    let design_issues = match &document {
        Some(document) => {
            let mut issues = review_brief_promises(document, brief);
            issues.extend(review_source_grounding(brief));
            issues
        }
        None => Vec::new(),
    };
    let rounds = lock(&shadow).caches.inline_audit.clone().filter(mixdog_office_base::values::truthy);
    Ok(Frame::Read(Box::new(Framed { run, audit, receipt, design_issues, rounds })))
}

/// `frameDesignedPages`: the frame runs on a working deck in a folder of its own beside the target, released and removed once
/// it was read.
async fn frame_designed_pages<H: AuthorHost>(host: &H, html: &str, target: &str, brief: &Value, args: &Value, call: &AuthorCall<'_>, prior_audit: Option<Value>) -> Result<Frame, AuthorError> {
    let folder = Path::new(target).parent().filter(|parent| !parent.as_os_str().is_empty()).map_or_else(|| PathBuf::from("."), Path::to_path_buf);
    let scratch = host.make_directory(&folder, ".mixdog-pdf-frame-").await?;
    let deck = scratch.join("frame.pptx");
    let framed = frame_designed_pages_in(host, html, target, &deck, brief, args, call, prior_audit).await;
    let _ = release_existing_session(host, &deck.to_string_lossy(), None).await;
    host.remove_dir_all(&scratch).await;
    framed
}

/// A figure the pages show that the brief's facts line does not carry. The gate that refuses a deck only reports here: the
/// document still lands. Page counters (`3 / 12`) are chrome, not figures.
async fn facts_warning<H: AuthorHost>(host: &H, target: &str, brief: &Value) -> Result<Option<Value>, AuthorError> {
    if brief.get("present") != Some(&Value::Bool(true)) || brief.get("factsMode").and_then(Value::as_str) == Some("sample") {
        return Ok(None);
    }
    let pages = host.snapshot_pdf_pages(Path::new(target)).await?;
    let slides: Vec<Value> = pages
        .iter()
        .map(|page| {
            let text = PAGE_COUNTER.replace_all_with(&page.get("text").filter(|text| !text.is_null()).map(value_to_string).unwrap_or_default(), |caps| caps.get(1).unwrap_or("").to_owned());
            json!({ "index": page.get("index").cloned().unwrap_or(Value::Null), "shapes": [{ "text": text }] })
        })
        .collect();
    let gate = facts_gate(&json!({ "slides": slides }), brief);
    if gate.get("blocked") != Some(&Value::Bool(true)) {
        return Ok(None);
    }
    let code = gate.get("code").cloned().unwrap_or(Value::Null);
    let listed: Vec<Value> = gate
        .get("slides")
        .and_then(Value::as_array)
        .map(|entries| entries.iter().map(|entry| json!({ "page": entry.get("slide").cloned().unwrap_or(Value::Null), "figures": entry.get("figures").cloned().unwrap_or(Value::Null) })).collect())
        .unwrap_or_default();
    let message = if code.as_str() == Some("facts_missing") {
        "The document shows figures but its BRIEF comment has no facts line; list each figure with its source (F1 <value> — <source>)."
    } else {
        "These figures appear on the pages but in no fact of the BRIEF comment; add each with its source, or correct the figure."
    };
    Ok(Some(json!({ "code": code, "pages": listed, "message": message })))
}

fn sum_elapsed(first: Option<&Value>, second: Option<&Value>) -> Value {
    json_number(to_number_of(first) + second.map_or(0.0, |value| to_number_of(Some(value))))
}

/// What staging, printing and registering ended with.
enum Printed {
    Refused(Value),
    Landed { run: Value, session: SessionHandle },
}

#[allow(clippy::too_many_arguments)]
async fn stage_print_and_land<H: AuthorHost>(
    host: &H,
    call: &AuthorCall<'_>,
    args: &Value,
    html: &str,
    target: &str,
    staging: &Path,
    html_source: &Path,
    brief: &Value,
    frame: bool,
    target_existed: bool,
    framed: &mut Option<Box<Framed>>,
    prior_audit: Option<Value>,
) -> Result<Printed, AuthorError> {
    let signal = call.signal;
    throw_if_authoring_cancelled(signal, None)?;
    if frame {
        match frame_designed_pages(host, html, target, brief, args, call, prior_audit).await? {
            Frame::Refused(answer) => return Ok(Printed::Refused(answer)),
            Frame::Read(read) => *framed = Some(read),
        }
    }
    let properties = args.get("properties").cloned().unwrap_or(Value::Null);
    let run = match host.print_pdf(html, staging, html_source, &properties, frame, signal).await {
        Ok(run) => run,
        Err(RunError::Cancelled) => return Err(AuthorError::Abort("Office authoring was cancelled".to_owned())),
        Err(RunError::Failed(message)) => return Err(AuthorError::Failed(message)),
    };
    throw_if_authoring_cancelled(signal, None)?;
    let source_text = html_source.to_string_lossy().into_owned();
    let ran = run.get("ok") == Some(&Value::Bool(true));
    if ran && frame {
        let slides = framed.as_ref().and_then(|read| read.run.get("slideCount")).map(|count| to_number_of(Some(count)));
        let pages = to_number_of(run.get("pageCount"));
        if slides.is_none_or(|slides| slides != pages) {
            let slides = value_to_string(framed.as_ref().and_then(|read| read.run.get("slideCount")).unwrap_or(&Value::Null));
            return Ok(Printed::Refused(json!({
                "ok": false,
                "reason": "html_failed",
                "output": target,
                "htmlSource": source_text,
                "error": { "message": format!("{slides} section.slide pages printed onto {} sheets: a page is taller than the sheet, or the CSS hides or stacks pages in print. Keep every section.slide exactly the sheet's size and displayed.", value_to_string(run.get("pageCount").unwrap_or(&Value::Null))) },
                "elapsedMs": run.get("elapsedMs").cloned().unwrap_or(Value::Null),
                "nextAction": "Fix the HTML the error names and call author again.",
            })));
        }
    }
    if !ran {
        let layout = run.get("layout").filter(|layout| mixdog_office_base::values::truthy(layout));
        let mut result = Map::new();
        result.insert("ok".into(), json!(false));
        result.insert("reason".into(), json!(if layout.is_some() { "layout_gate" } else { "html_failed" }));
        result.insert("output".into(), json!(target));
        result.insert("htmlSource".into(), json!(source_text));
        match layout {
            Some(layout) => result.insert("findings".into(), layout.clone()),
            None => result.insert("error".into(), run.get("error").cloned().unwrap_or(Value::Null)),
        };
        result.insert("elapsedMs".into(), run.get("elapsedMs").cloned().unwrap_or(Value::Null));
        result.insert(
            "nextAction".into(),
            json!(if layout.is_some() { "Nothing landed: fix each finding in the HTML (its element and measure are named) and call author again." } else { "Fix the HTML the error names and call author again." }),
        );
        return Ok(Printed::Refused(Value::Object(result)));
    }
    host.release_overwritten_session(target).await?;
    land_staged_deck(host, staging, Path::new(target), signal).await?;
    let receipt = json!({ "pageCount": run.get("pageCount").cloned().unwrap_or(Value::Null), "printableArea": run.get("area").cloned().unwrap_or(Value::Null) });
    let session = host.register_html_pdf_session(args, target, target_existed, receipt)?;
    Ok(Printed::Landed { run, session })
}

/// The `author` action for a `.pdf` target (`authorPdf`).
pub async fn author_pdf<H: AuthorHost>(host: &H, args: &Value, call: &AuthorCall<'_>) -> Result<Value, AuthorError> {
    let target = full_path(&requested_path(args), call.cwd)?;
    // Without a script the PDF is authored again from the HTML kept beside it, so a fix is an edit to that file rather than the
    // whole document sent again.
    let from_source = script_of(args).is_empty();
    let html_source = pdf_html_source_path(Path::new(&target));
    if from_source && !host.exists(&html_source).await {
        return Err(AuthorError::Failed(PDF_AUTHOR_NEEDS_SOURCE.to_owned()));
    }
    let html = if from_source { host.read_text(&html_source).await? } else { script_source(args) };
    if !opens_with_markup(&html) {
        return Err("author writes a PDF from an HTML document only (a source that opens with <).".into());
    }
    let target_existed = host.exists(Path::new(&target)).await;
    let held = host.session_for_document(&target);
    let replaced_edits = replaced_edits_of(held.as_ref());
    // Its own source names its own output: re-authoring from it replaces the file without overwrite:true.
    if target_existed && held.is_none() && !from_source && !flag_is(args, "overwrite", true) {
        return Err(AuthorError::Failed(format!("author target already exists: {target}; pass overwrite:true to replace it")));
    }
    // The browser prints beside the target: a failed print or a refused layout leaves the file on disk and any session holding
    // it untouched.
    let staging = staging_target(host, Path::new(&target)).await?;
    let brief = parse_authoring_brief(&html_brief_script(&html));
    let frame = has_slide_sections(&html);
    let prior_audit = held.as_ref().and_then(|held| lock(held).caches.inline_audit.clone()).filter(mixdog_office_base::values::truthy);
    let mut framed: Option<Box<Framed>> = None;
    let outcome = stage_print_and_land(host, call, args, &html, &target, &staging, &html_source, &brief, frame, target_existed, &mut framed, prior_audit).await;
    release_staging_target(host, &staging).await;
    let (run, session) = match outcome? {
        Printed::Refused(answer) => return Ok(answer),
        Printed::Landed { run, session } => (run, session),
    };
    if brief.get("present") == Some(&Value::Bool(true)) {
        lock(&session).authored.brief = Some(brief.clone());
    }
    mark_authored_from_html(&session, &html_source.to_string_lossy());
    let framed_read = framed.as_deref();
    if let Some(read) = framed_read.filter(|_| frame) {
        // Designed pages are the author's deck on paper: reviewed and finalized as one.
        let mut held_session = lock(&session);
        held_session.authored.authored = true;
        held_session.authored.frame = true;
        held_session.authored.frame_audit = read.audit.clone();
        held_session.authored.frame_receipt = read.receipt.clone();
        held_session.authored.frame_design_issues = Some(Value::Array(read.design_issues.clone()));
        if let Some(rounds) = &read.rounds {
            held_session.caches.inline_audit = Some(rounds.clone());
        }
    }
    // The facts gate already refused a designed page's unlisted figure; a flowing document only reports it.
    let facts = if frame { None } else { facts_warning(host, &target, &brief).await? };
    let mut result = Map::new();
    {
        let held_session = lock(&session);
        result.insert("ok".into(), json!(true));
        result.insert("session".into(), json!(held_session.id));
        result.insert("mode".into(), json!(held_session.mode.as_str()));
        result.insert("backend".into(), json!(held_session.backend.as_str()));
    }
    result.insert("output".into(), json!(target));
    for (key, from) in [("bytes", "bytes"), ("pageCount", "pageCount"), ("printableArea", "area")] {
        if let Some(value) = run.get(from) {
            result.insert(key.to_owned(), value.clone());
        }
    }
    if frame {
        result.insert("designedPages".into(), json!(true));
    }
    result.insert("htmlSource".into(), json!(html_source.to_string_lossy()));
    if let Some(edits) = replaced_edits {
        result.insert("replacedEdits".into(), edits);
    }
    if let Some(warnings) = run.get("warnings") {
        result.insert("warnings".into(), warnings.clone());
    }
    if let Some(logs) = framed_read.filter(|_| frame).and_then(|read| read.run.get("logs")).and_then(Value::as_array).filter(|logs| !logs.is_empty()) {
        result.insert("logs".into(), Value::Array(logs.clone()));
    }
    if let Some(facts) = facts {
        result.insert("facts".into(), facts);
    }
    let audit = framed_read.and_then(|read| read.audit.as_ref());
    if let Some(audit) = audit {
        result.insert("audit".into(), audit.clone());
    }
    result.insert("elapsedMs".into(), sum_elapsed(run.get("elapsedMs"), framed_read.and_then(|read| read.run.get("elapsedMs"))));
    let audit_failed = audit.and_then(|audit| audit.get("status")).and_then(Value::as_str) == Some("fail");
    let audit_next = audit.and_then(|audit| audit.get("nextAction")).map(value_to_string).unwrap_or_default();
    if flag_is(args, "render", false) {
        if let Some(receipt) = framed_read.and_then(|read| read.receipt.as_ref()) {
            result.insert("receipt".into(), host.receipt_for_delivery(&session, receipt));
        }
        let next = if audit_failed { audit_next } else if frame { FRAME_UNRENDERED_NEXT_ACTION.to_owned() } else { UNRENDERED_NEXT_ACTION.to_owned() };
        result.insert("nextAction".into(), Value::String(next));
        return Ok(Value::Object(result));
    }
    lock(&session).active_signal = call.signal.cloned();
    let rendered = host.render(&session, &render_args(args), Path::new(call.cwd)).await;
    lock(&session).active_signal = None;
    let rendered = rendered?;
    let mut render = pick(&rendered, &["output", "pageCount", "visualCoverage", "images", "reviewToken"]);
    // Designed pages: the render read the printed pixels into the receipt and wrote the contact sheet.
    if let Some(sheet) = rendered.get("contactSheet").filter(|sheet| mixdog_office_base::values::truthy(sheet)) {
        render.insert("contactSheet".into(), sheet.clone());
    }
    result.insert("render".into(), Value::Object(render));
    if let Some(receipt) = rendered.get("receipt").filter(|receipt| mixdog_office_base::values::truthy(receipt)) {
        result.insert("receipt".into(), receipt.clone());
    }
    result.insert("_images".into(), match rendered.get("_images") {
        Some(Value::Array(images)) => Value::Array(images.clone()),
        _ => json!([]),
    });
    let next = if audit_failed {
        format!("{audit_next} The rendered pages are attached; the visual read starts once the audit passes.")
    } else if frame {
        FRAME_RENDERED_NEXT_ACTION.to_owned()
    } else {
        RENDERED_NEXT_ACTION.to_owned()
    };
    result.insert("nextAction".into(), Value::String(next));
    Ok(Value::Object(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_counter_on_its_own_line_is_not_a_figure() {
        let text = "Heading\n3 / 12\nBody 4 / 5 stays\n  7/9  \nlast";
        let stripped = PAGE_COUNTER.replace_all_with(text, |caps| caps.get(1).unwrap_or("").to_owned());
        assert_eq!(stripped, "Heading\n\nBody 4 / 5 stays\n\nlast");
    }

    #[test]
    fn elapsed_time_adds_the_frames_run() {
        assert_eq!(sum_elapsed(Some(&json!(120)), Some(&json!(30))), json!(150));
        assert_eq!(sum_elapsed(Some(&json!(120)), None), json!(120));
    }

    #[test]
    fn a_failed_frame_names_the_html_and_has_no_logs() {
        let answer = html_failed_result("/work/a.pdf", Some(&json!({ "message": "bad" })), Some(&json!(7)));
        assert_eq!(
            answer,
            json!({ "ok": false, "reason": "html_failed", "output": "/work/a.pdf", "error": { "message": "bad" }, "elapsedMs": 7, "nextAction": "Fix the HTML the error names and call author again." })
        );
    }
}
