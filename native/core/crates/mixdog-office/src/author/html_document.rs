//! `authoring/html-document-author.mjs`: the `author` action for a Word or Excel target. An HTML document laid out by the shared
//! browser and written as native Word (`docx_html_runner`) or Excel (`xlsx_html_runner`), landed over the target once it was
//! written, then opened as an authored document: measured by the inline audit, rendered, and reviewed beside the browser's own
//! picture of the same HTML (its print for a document, each sheet's section for a workbook).

use std::path::Path;

use mixdog_js::value_to_string;
use mixdog_office_author::brief::{html_brief_script, parse_authoring_brief};
use mixdog_office_author::html_browser::RunError;
use mixdog_office_base::formats::document_format;
use mixdog_office_base::values::truthy;
use mixdog_raster::{Blend, Fit, Image, Overlay, Placement, ResizeOptions, composite, ops};
use serde_json::{Map, Value, json};

use super::pptx_session::{AuthorError, land_staged_deck, release_existing_session, release_staging_target, staging_target, throw_if_authoring_cancelled};
use super::{AuthorCall, AuthorHost, flag_is, mark_authored_from_html, opens_with_markup, pick, render_args, replaced_edits_of, requested_path, script_of, script_source};
use crate::session::mode::validate_author_mode;
use crate::session::registry::lock;
use crate::session::working_copy::full_path;

/// The height every comparison image is drawn at, and the gap between its halves.
const HEIGHT: u32 = 1100;
const GAP: u32 = 16;
/// The width of a blank half when the browser's picture of a page is missing.
const BLANK_WIDTH: u32 = 778;

/// What differs between the two document kinds.
struct Kind {
    noun: &'static str,
    skill: &'static str,
    contract: &'static str,
    left: &'static str,
    checks: &'static str,
}

fn kind_of(format: &str) -> Option<Kind> {
    match format {
        "docx" => Some(Kind {
            noun: "a Word file",
            skill: "docx",
            contract: "@page sheet, what becomes a paragraph, a table, a box",
            left: "the HTML as the browser printed it",
            checks: "reading order, page breaks, a box or table that lost its fill or width, type that changed size, a picture that moved",
        }),
        "xlsx" => Some(Kind {
            noun: "an Excel workbook",
            skill: "xlsx",
            contract: "one <section data-sheet> per worksheet, data-formula, data-chart",
            left: "the sheet as the browser drew it",
            checks: "a card or box that lost its fill, a text cut by its column, a figure that should be a number or a formula, a chart off its place, the printed page",
        }),
        _ => None,
    }
}

fn scaled(bytes: &[u8]) -> Result<Image, String> {
    let image = Image::decode(bytes).map_err(|error| error.to_string())?;
    ops::resize(&image, &ResizeOptions { height: Some(HEIGHT), fit: Fit::Cover, ..ResizeOptions::default() }).map_err(|error| error.to_string())
}

fn blank(width: u32) -> Result<Image, String> {
    Image::create(width, HEIGHT, 3, [255, 255, 255, 255]).map_err(|error| error.to_string())
}

/// The comparison image of one page: the browser's picture of the HTML on the left, the Office render on the right, at one
/// height, on grey. A missing half is white (the browser's is as wide as a sheet; the Office one as wide as the left).
pub fn comparison_sheet(left: Option<&[u8]>, right: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let left = match left {
        Some(bytes) => scaled(bytes)?,
        None => blank(BLANK_WIDTH)?,
    };
    let right = match right {
        Some(bytes) => scaled(bytes)?,
        None => blank(left.width())?,
    };
    let sheet = Image::create(left.width() + right.width() + GAP, HEIGHT, 3, [0x80, 0x80, 0x80, 255]).map_err(|error| error.to_string())?;
    let offset = i64::from(left.width() + GAP);
    let overlays = [
        Overlay { image: left, blend: Blend::Over, placement: Placement::At { left: 0, top: 0 } },
        Overlay { image: right, blend: Blend::Over, placement: Placement::At { left: offset, top: 0 } },
    ];
    composite(&sheet, &overlays).to_png().map_err(|error| error.to_string())
}

/// The image of a page in a list of `{ page, path, pages? }`; a path that is missing counts as no image (`image?.path`).
fn path_of_page(images: &[Value], page: u64, single_only: bool) -> Option<String> {
    images
        .iter()
        .find(|image| {
            image.get("page").and_then(Value::as_f64) == Some(page as f64)
                && (!single_only || image.get("pages").and_then(Value::as_array).map_or(1, |pages| if pages.is_empty() { 1 } else { pages.len() }) == 1)
        })
        .and_then(|image| image.get("path").and_then(Value::as_str))
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
}

/// `writeComparisons(target, htmlPages, officePages)`: one image per page, the browser's picture of the HTML on the left, the
/// Office render on the right.
async fn write_comparisons<H: AuthorHost>(host: &H, target: &str, html_pages: &[Value], office_pages: &[Value]) -> Result<Vec<Value>, AuthorError> {
    let count = html_pages.len().max(office_pages.len());
    let mut pairs = Vec::new();
    for page in 1..=count as u64 {
        let left = match path_of_page(html_pages, page, false) {
            Some(path) => Some(host.read_bytes(Path::new(&path)).await?),
            None => None,
        };
        let right = match path_of_page(office_pages, page, true) {
            Some(path) => Some(host.read_bytes(Path::new(&path)).await?),
            None => None,
        };
        let sheet = host.compose_comparison(left, right).await?;
        let path = format!("{target}.mixdog-compare-page-{page}.png");
        host.note_write(Path::new(&path));
        host.write_bytes(Path::new(&path), sheet).await?;
        pairs.push(json!({ "page": page, "path": path }));
    }
    Ok(pairs)
}

async fn run_kind<H: AuthorHost>(host: &H, format: &str, html: &str, staging: &Path, target: &Path, call: &AuthorCall<'_>) -> Result<Value, AuthorError> {
    let run = if format == "docx" {
        host.run_docx_html(html, staging, target, call.signal).await
    } else {
        host.run_xlsx_html(html, staging, target, call.signal).await
    };
    match run {
        Ok(run) => Ok(run),
        Err(RunError::Cancelled) => Err(AuthorError::Abort("Office authoring was cancelled".to_owned())),
        Err(RunError::Failed(message)) => Err(AuthorError::Failed(message)),
    }
}

/// The `author` action for a `.docx` or `.xlsx` target (`authorHtmlDocument`).
pub async fn author_html_document<H: AuthorHost>(host: &H, args: &Value, call: &AuthorCall<'_>) -> Result<Value, AuthorError> {
    let target = full_path(&requested_path(args), call.cwd)?;
    let format = document_format(&target)?;
    let Some(kind) = kind_of(format) else { return Err("author writes .pptx, .pdf, .docx, and .xlsx targets only".into()) };
    let source_path = format!("{target}.mixdog-source.html");
    // Without a script the document is authored again from the HTML kept beside it.
    let from_source = script_of(args).is_empty();
    if from_source && !host.exists(Path::new(&source_path)).await {
        return Err(AuthorError::Failed(format!(
            "author requires script: an HTML document for {} (without one it re-authors from {source_path}, and none is there). Load the `{}` Skill first (Skill name:\"{}\"): it carries the HTML route ({}), then call author again with path and script.",
            kind.noun, kind.skill, kind.skill, kind.contract
        )));
    }
    let html = if from_source { host.read_text(Path::new(&source_path)).await? } else { script_source(args) };
    if !opens_with_markup(&html) {
        return Err(AuthorError::Failed(format!("author writes {} from an HTML document only (a source that opens with <).", kind.noun)));
    }
    let mode = validate_author_mode(args.get("mode"))?;
    let held = host.session_for_document(&target);
    let replaced_edits = replaced_edits_of(held.as_ref());
    if host.exists(Path::new(&target)).await && held.is_none() && !from_source && !flag_is(args, "overwrite", true) {
        return Err(AuthorError::Failed(format!("author target already exists: {target}; pass overwrite:true to replace it")));
    }
    let staging = staging_target(host, Path::new(&target)).await?;
    let landed = stage_and_land(host, args, call, &html, format, &mode, &target, &staging, &source_path).await;
    release_staging_target(host, &staging).await;
    let (run, session) = match landed? {
        Landed::Refused(answer) => return Ok(answer),
        Landed::Opened { run, session } => (run, session),
    };
    mark_authored_from_html(&session, &source_path);
    let brief = parse_authoring_brief(&html_brief_script(&html));
    if brief.get("present") == Some(&Value::Bool(true)) {
        lock(&session).authored.brief = Some(brief);
    }
    let audit = if flag_is(args, "audit", false) { None } else { host.inline_audit(&session, &[]).await };
    let mut result = Map::new();
    {
        let held_session = lock(&session);
        result.insert("ok".into(), json!(true));
        result.insert("session".into(), json!(held_session.id));
        result.insert("mode".into(), json!(held_session.mode.as_str()));
        result.insert("backend".into(), json!(held_session.backend.as_str()));
    }
    result.insert("output".into(), json!(target));
    if let Some(bytes) = run.get("bytes") {
        result.insert("bytes".into(), bytes.clone());
    }
    result.insert("htmlSource".into(), json!(source_path));
    if let Some(logs) = run.get("logs") {
        result.insert("logs".into(), logs.clone());
    }
    if let Some(edits) = replaced_edits {
        result.insert("replacedEdits".into(), edits);
    }
    if let Some(audit) = &audit {
        result.insert("audit".into(), audit.clone());
    }
    if let Some(elapsed) = run.get("elapsedMs") {
        result.insert("elapsedMs".into(), elapsed.clone());
    }
    let audit_failed = audit.as_ref().and_then(|audit| audit.get("status")).and_then(Value::as_str) == Some("fail");
    let audit_next = audit.as_ref().and_then(|audit| audit.get("nextAction")).map(value_to_string).unwrap_or_default();
    if flag_is(args, "render", false) {
        let next = if audit_failed {
            audit_next
        } else {
            "Written and measured, not visually reviewed: call action:render on this session for the page images and reviewToken, then inspect every page before finalizing.".to_owned()
        };
        result.insert("nextAction".into(), Value::String(next));
        return Ok(Value::Object(result));
    }
    lock(&session).active_signal = call.signal.cloned();
    let rendered = render_and_compare(host, &session, args, call.cwd, &target, &run).await;
    lock(&session).active_signal = None;
    let (render, images) = rendered?;
    result.insert("render".into(), Value::Object(render));
    result.insert("_images".into(), images);
    let next = if audit_failed {
        format!("{audit_next} The rendered pages are attached; the visual read starts once the audit passes.")
    } else {
        format!(
            "Inspect every rendered page beside its compare pair ({} on the left, the Office render on the right): {}. Fix the HTML (edit {source_path} and call author with no script) for a material difference, or finalize with design: {{ reviewed: true, reviewToken, critique }}.",
            kind.left, kind.checks
        )
    };
    result.insert("nextAction".into(), Value::String(next));
    Ok(Value::Object(result))
}

/// The page images of the render and, where the browser kept its own pictures, the comparison images beside them.
async fn render_and_compare<H: AuthorHost>(host: &H, session: &crate::session::SessionHandle, args: &Value, cwd: &str, target: &str, run: &Value) -> Result<(Map<String, Value>, Value), AuthorError> {
    let rendered = host.render(session, &render_args(args), Path::new(cwd)).await?;
    let mut render = pick(&rendered, &["output", "pageCount", "visualCoverage", "images", "reviewToken"]);
    let images = match rendered.get("_images") {
        Some(Value::Array(images)) => Value::Array(images.clone()),
        _ => json!([]),
    };
    if let Some(html_pages) = run.get("htmlPages").and_then(Value::as_array).filter(|pages| !pages.is_empty()) {
        let office: Vec<Value> = rendered.get("images").and_then(Value::as_array).cloned().unwrap_or_default();
        render.insert("compare".into(), Value::Array(write_comparisons(host, target, html_pages, &office).await?));
        render.insert("htmlPageCount".into(), json!(html_pages.len()));
    }
    Ok((render, images))
}

enum Landed {
    Refused(Value),
    Opened { run: Value, session: crate::session::SessionHandle },
}

#[allow(clippy::too_many_arguments)]
async fn stage_and_land<H: AuthorHost>(host: &H, args: &Value, call: &AuthorCall<'_>, html: &str, format: &str, mode: &str, target: &str, staging: &Path, source_path: &str) -> Result<Landed, AuthorError> {
    let signal = call.signal;
    throw_if_authoring_cancelled(signal, None)?;
    let run = run_kind(host, format, html, staging, Path::new(target), call).await?;
    throw_if_authoring_cancelled(signal, None)?;
    if run.get("ok").is_none_or(|ok| !truthy(ok)) {
        let mut answer = Map::new();
        answer.insert("ok".into(), json!(false));
        answer.insert("reason".into(), json!("html_failed"));
        answer.insert("output".into(), json!(target));
        answer.insert("htmlSource".into(), json!(source_path));
        if let Some(error) = run.get("error") {
            answer.insert("error".into(), error.clone());
        }
        if let Some(elapsed) = run.get("elapsedMs") {
            answer.insert("elapsedMs".into(), elapsed.clone());
        }
        answer.insert("nextAction".into(), json!("Fix the HTML the error names and call author again."));
        return Ok(Landed::Refused(Value::Object(answer)));
    }
    release_existing_session(host, target, signal).await?;
    land_staged_deck(host, staging, Path::new(target), signal).await?;
    let mut session_args = args.clone();
    if let Value::Object(fields) = &mut session_args {
        fields.insert("mode".into(), Value::String(mode.to_owned()));
    }
    let session = host.create_authored_session(&session_args, target, signal).await?;
    Ok(Landed::Opened { run, session })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_is_found_by_its_number_and_a_shared_image_is_not_one_page() {
        let images = vec![json!({ "page": 1, "path": "a.png" }), json!({ "page": 2, "pages": [2, 3], "path": "b.png" }), json!({ "page": 4, "path": "" })];
        assert_eq!(path_of_page(&images, 1, true), Some("a.png".to_owned()));
        assert_eq!(path_of_page(&images, 2, false), Some("b.png".to_owned()));
        assert_eq!(path_of_page(&images, 2, true), None);
        assert_eq!(path_of_page(&images, 4, false), None);
        assert_eq!(path_of_page(&images, 9, false), None);
    }

    #[test]
    fn a_missing_picture_is_a_white_half_beside_the_other() {
        let page = Image::create(100, 50, 3, [10, 20, 30, 255]).expect("image").to_png().expect("png");
        let sheet = comparison_sheet(Some(&page), None).expect("sheet");
        let decoded = Image::decode(&sheet).expect("decoded");
        assert_eq!(decoded.height(), HEIGHT);
        // The scaled left half is 2200 wide, the white half as wide as it, and the gap between them.
        assert_eq!(decoded.width(), 2200 + GAP + 2200);
        let blank_both = Image::decode(&comparison_sheet(None, None).expect("blank sheet")).expect("decoded");
        assert_eq!(blank_both.width(), BLANK_WIDTH * 2 + GAP);
    }

    #[test]
    fn the_two_kinds_name_their_contract() {
        assert_eq!(kind_of("docx").expect("docx").skill, "docx");
        assert_eq!(kind_of("xlsx").expect("xlsx").noun, "an Excel workbook");
        assert!(kind_of("pptx").is_none());
    }
}
